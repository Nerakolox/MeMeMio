import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import {
  commitImport,
  fetchBatchStatus,
  presignImport,
  uploadToR2,
  type BatchStatus,
  type ImportDoneEvent,
  type ImportFileSpec,
  type ImportItemEvent,
  type ImportProgressEvent,
  type ImportUploadTarget,
} from '../../lib/api-imports'
import type { PickedFile } from './file-picker'

/** 并发上传上限。一千张同时发会把浏览器和网络打爆（import-ux.md §2）。 */
const UPLOAD_CONCURRENCY = 4

/**
 * 本地就能判定的失败文案。服务端对同一件事有自己的 message（§2.3），
 * 两种来源都归到 `failed` 一类，只是 `reason` 不同。
 */
const LOCAL_PROBLEM_TEXT: Record<NonNullable<PickedFile['localProblem']>, string> = {
  not_image: '不是支持的图片格式',
  empty: '文件是空的',
}

/** 每个文件在界面上的一行。状态是 `item` 事件的 `result`，加两个客户端状态。 */
export type QueueItemState =
  | 'waiting'
  | 'uploading'
  | 'imported'
  | 'exact_dup'
  | 'needs_review'
  | 'failed'

export type QueueItem = {
  /** 批次内的唯一标识，也是 reviews 接口的路径参数（SPEC §6.2.3）。 */
  fileName: string
  sizeBytes: number
  state: QueueItemState
  /** `failed` 时的具体原因，不做「失败 37 张」这种笼统报数（import-ux.md §7）。 */
  reason?: string
  /** `failed` 的服务端原因码，用来分支展示 requestId 之类。 */
  reasonCode?: string
  requestId?: string
  memeId?: string
}

type Phase = 'idle' | 'uploading' | 'processing' | 'done'

/** 上传阶段的真实进度。`导入中 237/1000` 看不出卡在哪一步，要分阶段（import-ux.md §3）。 */
export type UploadProgress = { total: number; uploaded: number; failed: number }

export type BatchLevelError = {
  code: string
  message: string
  requestId?: string
  /** `QUOTA_EXCEEDED` 的 `details.remaining`，用来显示剩余配额而不是只说「超了」。 */
  remaining?: number
}

export type ImportQueue = {
  phase: Phase
  items: QueueItem[]
  uploadProgress: UploadProgress
  /** SSE `progress` 推来的处理计数；断线时用快照覆盖。 */
  serverProgress: ImportProgressEvent | null
  done: ImportDoneEvent | null
  /** 批次级失败的 `code`（不是单文件失败），以及 `QUOTA_EXCEEDED` 这类要特殊呈现的。 */
  batchError: BatchLevelError | null
  /** 超配额：剩余文件全部标记失败，**停止后续上传**（http.md §3、import-ux.md §7）。 */
  quotaError: BatchLevelError | null
  /** SSE 断开——已经拿快照补齐过，界面要说明正在重连（import-ux.md §8）。 */
  reconnecting: boolean
  start: (files: PickedFile[]) => void
  reset: () => void
}

/**
 * 导入队列：presign → 直传 R2 → commit → 订阅 SSE。
 *
 * 整个流程只有这一处状态机，多选/拖拽/粘贴/相册四个入口共用它（import-ux.md §1）。
 * 不做成分步向导，也不做成模态——导入期间应用要保持可用（import-ux.md §9）。
 */
export function useImportQueue(): ImportQueue {
  const [phase, setPhase] = useState<Phase>('idle')
  const [items, setItems] = useState<QueueItem[]>([])
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    total: 0,
    uploaded: 0,
    failed: 0,
  })
  const [serverProgress, setServerProgress] = useState<ImportProgressEvent | null>(null)
  const [done, setDone] = useState<ImportDoneEvent | null>(null)
  const [batchError, setBatchError] = useState<ImportQueue['batchError']>(null)
  const [quotaError, setQuotaError] = useState<ImportQueue['quotaError']>(null)
  const [reconnecting, setReconnecting] = useState(false)

  const esRef = useRef<EventSource | null>(null)
  const batchIdRef = useRef<string | null>(null)
  /** 组件卸载后 SSE 回调仍会跑，用它挡住 setState。 */
  const aliveRef = useRef(true)
  /** `done` 之后不再重连，否则 EventSource 会自动续上一条已结束的流。 */
  const finishedRef = useRef(false)

  const closeStream = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      // 清理函数必须写，否则路由切走后 SSE 还在跑（http.md §7）
      aliveRef.current = false
      closeStream()
    }
  }, [closeStream])

  const patchItem = useCallback(
    (fileName: string, patch: Partial<QueueItem>) => {
      setItems((prev) =>
        prev.map((it) => (it.fileName === fileName ? { ...it, ...patch } : it)),
      )
    },
    [],
  )

  /** 断线补齐：`GET /imports/{batchId}` 拉当前累计状态。中间漏掉的 item 不会重发。 */
  const reconcile = useCallback(async () => {
    const batchId = batchIdRef.current
    if (!batchId) return
    try {
      const snap: BatchStatus = await fetchBatchStatus(batchId)
      if (!aliveRef.current) return
      setServerProgress({
        total: snap.total,
        done: snap.done,
        skipped: snap.skipped,
        pending: snap.pending,
      })
    } catch {
      // 快照也拿不到时保持旧数字，SSE 自己会重连；不把进度清零吓用户
    }
  }, [])

  const openStream = useCallback(
    (batchId: string) => {
      closeStream()
      // EventSource 不走 fetch，不能放进 lib/api.ts —— 否则「只有这一个文件发请求」的
      // 约束会破一个洞（http.md §1）。直接用原生实现，只在这里 new 一次。
      const es = new EventSource(`/api/v1/imports/${encodeURIComponent(batchId)}/events`)
      esRef.current = es

      es.addEventListener('progress', (e) => {
        if (!aliveRef.current) return
        setReconnecting(false)
        setServerProgress(JSON.parse((e as MessageEvent).data) as ImportProgressEvent)
      })

      es.addEventListener('item', (e) => {
        if (!aliveRef.current) return
        const data = JSON.parse((e as MessageEvent).data) as ImportItemEvent
        // result 是开放取值：服务端新增种类时原样落进 reason，不白屏（http.md §4）
        const known: QueueItemState[] = ['imported', 'exact_dup', 'needs_review', 'failed']
        const state = (known as string[]).includes(data.result)
          ? (data.result as QueueItemState)
          : 'failed'
        patchItem(data.fileName, {
          state,
          reason: data.reason,
          memeId: data.memeId,
        })
      })

      es.addEventListener('done', (e) => {
        if (!aliveRef.current) return
        finishedRef.current = true
        setDone(JSON.parse((e as MessageEvent).data) as ImportDoneEvent)
        setPhase('done')
        setReconnecting(false)
        // `done` 后主动关闭（http.md §7）
        closeStream()
      })

      es.addEventListener('error', (e) => {
        if (!aliveRef.current) return
        // 事件里带 data 的是批次级失败；没有 data 的是连接层断开，两者处理完全不同
        const raw = (e as MessageEvent).data
        if (typeof raw === 'string' && raw.length > 0) {
          const body = JSON.parse(raw) as { code: string; message: string }
          setBatchError({ code: body.code, message: body.message })
          setPhase('done')
          finishedRef.current = true
          closeStream()
          return
        }
        // 连接断了：EventSource 会自己重连，但漏掉的事件不会重发 —— 拉快照补齐（§1.4）
        if (finishedRef.current) return
        setReconnecting(true)
        void reconcile()
      })
    },
    [closeStream, patchItem, reconcile],
  )

  const start = useCallback(
    (picked: PickedFile[]) => {
      if (picked.length === 0) return
      finishedRef.current = false
      setDone(null)
      setBatchError(null)
      setQuotaError(null)
      setReconnecting(false)
      setServerProgress(null)

      const initial: QueueItem[] = picked.map((p) => ({
        fileName: p.file.name,
        sizeBytes: p.file.size,
        state: 'waiting',
        reason: p.localProblem ? LOCAL_PROBLEM_TEXT[p.localProblem] : undefined,
        reasonCode: p.localProblem ? 'UNSUPPORTED_FORMAT' : undefined,
      }))
      setItems(initial)
      setUploadProgress({ total: picked.length, uploaded: 0, failed: 0 })
      setPhase('uploading')

      void (async () => {
        // 本地就能判定的不进网络：格式不对、空文件
        const sendable = initial.filter((it) => it.reason === undefined)
        for (const it of initial) {
          if (it.reason !== undefined) patchItem(it.fileName, { state: 'failed' })
        }
        if (sendable.length === 0) {
          setPhase('done')
          setDone({
            total: picked.length,
            imported: 0,
            exactDup: 0,
            needsReview: 0,
            failed: picked.length,
          })
          return
        }

        const specs: ImportFileSpec[] = sendable.map((it) => ({
          fileName: it.fileName,
          sizeBytes: it.sizeBytes,
        }))

        let presigned
        try {
          presigned = await presignImport(specs)
        } catch (err) {
          const apiErr = err instanceof ApiError ? err : null
          const errBody: BatchLevelError = {
            code: apiErr?.code ?? 'INTERNAL',
            message: apiErr?.message ?? '签发上传地址失败',
            requestId: apiErr?.requestId,
            remaining: readRemaining(apiErr),
          }
          // 超配额是签发的第一道关：整批停在门口，一个文件都没传上去
          if (errBody.code === 'QUOTA_EXCEEDED') setQuotaError(errBody)
          else setBatchError(errBody)
          for (const it of sendable) {
            patchItem(it.fileName, { state: 'failed', reason: errBody.message, reasonCode: errBody.code })
          }
          setPhase('done')
          return
        }
        if (!aliveRef.current) return

        batchIdRef.current = presigned.batchId

        // 直传 R2。并发有上限，一个失败不影响其他文件（import-ux.md §7）。
        const byName = new Map<string, ImportUploadTarget>(
          presigned.uploads.map((u) => [u.fileName, u]),
        )
        const fileByName = new Map(picked.map((p) => [p.file.name, p.file]))
        const uploaded: { fileName: string; tempKey: string }[] = []
        const targetList = sendable.filter((it) => byName.has(it.fileName))

        let cursor = 0
        let uploadedCount = 0
        let failedCount = 0
        /** 超配额后置位：剩余文件不再上传，全部标记失败（http.md §3）。 */
        let quota: BatchLevelError | null = null
        const worker = async () => {
          for (;;) {
            const idx = cursor++
            if (idx >= targetList.length) return
            if (quota) return
            const it = targetList[idx]
            if (!it) return
            const target = byName.get(it.fileName)
            const file = fileByName.get(it.fileName)
            if (!target || !file) return
            if (!aliveRef.current) return

            patchItem(it.fileName, { state: 'uploading' })
            try {
              await uploadToR2(target.uploadUrl, file)
              uploaded.push({ fileName: it.fileName, tempKey: target.tempKey })
              uploadedCount += 1
            } catch (err) {
              const apiErr = err instanceof ApiError ? err : null
              failedCount += 1
              patchItem(it.fileName, {
                state: 'failed',
                reason: apiErr?.message ?? '上传失败',
                reasonCode: apiErr?.code,
                requestId: apiErr?.requestId,
              })
              if (apiErr?.code === 'QUOTA_EXCEEDED') {
                quota = {
                  code: apiErr.code,
                  message: apiErr.message,
                  requestId: apiErr.requestId,
                  remaining: readRemaining(apiErr),
                }
                if (aliveRef.current) setQuotaError(quota)
              }
            }
            if (aliveRef.current) {
              setUploadProgress({
                total: targetList.length,
                uploaded: uploadedCount,
                failed: failedCount,
              })
            }
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(UPLOAD_CONCURRENCY, targetList.length) }, worker),
        )
        if (!aliveRef.current) return

        if (uploaded.length === 0) {
          // 一个都没上去就不必 commit 了；超配额的剩余文件在这里统一落成失败
          if (quota) markUnsentAsFailed(targetList, quota, patchItem)
          setPhase('done')
          setDone({
            total: picked.length,
            imported: 0,
            exactDup: 0,
            needsReview: 0,
            failed: failedCount + (picked.length - targetList.length),
          })
          return
        }
        // 超配额中断时，commit 只带上真正传上去的那些；其余就地失败
        if (quota) markUnsentAsFailed(targetList, quota, patchItem)

        // commit 之前先建流：处理可能在毫秒级完成，晚了会丢掉最初几个 item
        setPhase('processing')
        openStream(presigned.batchId)

        try {
          await commitImport(presigned.batchId, uploaded)
        } catch (err) {
          const apiErr = err instanceof ApiError ? err : null
          setBatchError({
            code: apiErr?.code ?? 'INTERNAL',
            message: apiErr?.message ?? '提交处理失败',
            requestId: apiErr?.requestId,
            remaining: readRemaining(apiErr),
          })
          finishedRef.current = true
          closeStream()
          setPhase('done')
        }
      })()
    },
    [closeStream, openStream, patchItem],
  )

  const reset = useCallback(() => {
    finishedRef.current = true
    closeStream()
    batchIdRef.current = null
    setPhase('idle')
    setItems([])
    setDone(null)
    setBatchError(null)
    setQuotaError(null)
    setServerProgress(null)
    setReconnecting(false)
    setUploadProgress({ total: 0, uploaded: 0, failed: 0 })
    finishedRef.current = false
  }, [closeStream])

  return {
    phase,
    items,
    uploadProgress,
    serverProgress,
    done,
    batchError,
    quotaError,
    reconnecting,
    start,
    reset,
  }
}

/** 超配额时，还没轮到的文件不是「没试过」，而是**明确失败**——摘要里要算进去。 */
function markUnsentAsFailed(
  targets: QueueItem[],
  quota: BatchLevelError,
  patchItem: (fileName: string, patch: Partial<QueueItem>) => void,
): void {
  for (const it of targets) {
    if (it.state === 'waiting') {
      patchItem(it.fileName, {
        state: 'failed',
        reason: `存储空间不足，已停止上传（${quota.message}）`,
        reasonCode: quota.code,
      })
    }
  }
}

/** `QUOTA_EXCEEDED` 的 `details.remaining`——只说「超了」不够，要显示剩余配额。 */
function readRemaining(err: ApiError | null): number | undefined {
  const v = err?.details?.['remaining']
  return typeof v === 'number' ? v : undefined
}
