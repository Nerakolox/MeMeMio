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

/**
 * `item.reason` 里的**字面值**。绝大多数 reason 是服务端写好的一句中文
 * （`api/src/services/import.ts` 的 `readableReason`），但配额用满是例外：它是**批次级**
 * 结局（SPEC §3.6），服务端发的是这个 code，好让客户端按字面值认出它。
 *
 * 查不到的**原样显示**：宁可让用户看到一个 code，也不要因为「没见过」把原因吞掉
 * （http.md §4 对未知错误码是同一条）。所以这里不是白名单，只是翻译表。
 */
const ITEM_REASON_TEXT: Record<string, string> = {
  QUOTA_EXCEEDED: '存储空间不足，这个文件没能入库',
}

function itemReasonText(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  return ITEM_REASON_TEXT[reason] ?? reason
}

/**
 * SSE 事件载荷。**`JSON.parse` 会抛**，而抛在事件回调里等于这条消息把这次导入的
 * 后续进度一起带走（EventSource 不会重发）。解析失败记一次、丢掉这一条，
 * 其余事件照常处理；漏掉的那点增量由 `reconcile` 的快照补齐（SPEC §1.4）。
 */
function parseEvent<T>(raw: unknown, label: string): T | null {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    console.warn(`[import] 忽略一条解析不出来的 ${label} 事件`, raw)
    return null
  }
}

/** 每个文件在界面上的一行。状态是 `item` 事件的 `result`，加三个客户端状态。 */
export type QueueItemState =
  | 'waiting'
  | 'uploading'
  /**
   * 字节已经到 R2，**等服务端处理**。
   *
   * 这个状态是 2026-09-24 加的：在此之前行停在「上传中」直到 `item` 事件到达，
   * 而事件可能根本不到（连接还没建好时处理就结束了，见 `reconcile`）——表现是
   * 一次导入明明跑完了，文件行却永远写着「上传中」。
   */
  | 'uploaded'
  | 'imported'
  | 'exact_dup'
  | 'needs_review'
  | 'failed'

/**
 * 这一行**已经有结论了**。
 *
 * `uploaded` / `uploading` / `waiting` 都不算：字节到了 R2 不等于服务端处理完了，
 * 把它算进「已处理」会让顶栏与进度条跑在服务端前面。
 *
 * 写成**排除法**而不是列举四个结论状态：将来服务端新增一种 `result`（http.md §4 允许）
 * 时，这里默认是「没结论」，不会凭空多算一个已完成。
 */
export function isSettled(state: QueueItemState): boolean {
  return state !== 'waiting' && state !== 'uploading' && state !== 'uploaded'
}

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

  /**
   * 用批次快照补齐，并**用它判定收尾**。
   *
   * `GET /imports/{batchId}` 一直只被当作「断线补齐」（SPEC §1.4）。但同一句话还有
   * 另一半：**不能把 SSE 当作唯一的结果来源**。这条流是在 commit 之前建的，服务端
   * 只补发一条 `progress`，**不补发 `done` 和 `item`**——而一张精确重复的图几毫秒就
   * 处理完，那时连接可能还没建立。于是 `phase` 永远停在「处理中」：顶栏「导入 x/y」
   * 常驻、文件行卡在「上传中」，而服务端其实早就干完了。中途断线错过 `done` 也一样。
   *
   * 所以每次连上（含每次重连）都拉一次快照：`committed && pending === 0` 就是这一批
   * 已经处理完，用快照里的数把界面收尾。
   */
  const reconcile = useCallback(async () => {
    const batchId = batchIdRef.current
    if (!batchId || finishedRef.current) return
    let snap: BatchStatus
    try {
      snap = await fetchBatchStatus(batchId)
    } catch {
      // 快照也拿不到时保持旧数字，SSE 自己会重连；不把进度清零吓用户
      return
    }
    if (!aliveRef.current || finishedRef.current) return
    setServerProgress({
      total: snap.total,
      done: snap.done,
      skipped: snap.skipped,
      pending: snap.pending,
    })
    setReconnecting(false)

    const finished = doneFromSnapshot(snap)
    if (finished === null) return
    finishedRef.current = true
    setDone(finished)
    setPhase('done')
    // `done` 后主动关闭（http.md §7）
    closeStream()
  }, [closeStream])

  const openStream = useCallback(
    (batchId: string) => {
      closeStream()
      // EventSource 不走 fetch，不能放进 lib/api.ts —— 否则「只有这一个文件发请求」的
      // 约束会破一个洞（http.md §1）。直接用原生实现，只在这里 new 一次。
      const es = new EventSource(`/api/v1/imports/${encodeURIComponent(batchId)}/events`)
      esRef.current = es

      /*
        连上了就对齐一次。这里不是「断线补齐」那件事——第一次连上时根本没有断过。

        服务端在建立连接时**只补发一条 `progress` 快照，不补发 `done` 和 `item`**
        （`api/src/routes/imports.ts` 的连接处理①）。而这条流是在 commit 之前建的，
        快照里的 `pending` 这时多半还没归零，于是它就到此为止了：那一批处理完，
        `done` 早就在一个不存在的订阅者上发过了。表现是一次导入跑完了，
        顶栏却一直写着「正在处理」。
        `open` 与每次重连都会走到这里，所以两条路一次覆盖。
      */
      es.addEventListener('open', () => {
        if (!aliveRef.current) return
        setReconnecting(false)
        void reconcile()
      })

      es.addEventListener('progress', (e) => {
        if (!aliveRef.current) return
        const data = parseEvent<ImportProgressEvent>((e as MessageEvent).data, 'progress')
        if (data === null) return
        setReconnecting(false)
        setServerProgress(data)
        /*
          `pending === 0` 意味着服务端那边已经没有待处理的行了。正常情况紧跟着就是
          `done`（下面那条），可**连接刚建好、处理已经结束**时收到的那条快照本身就是
          pending 0、后面不会再有 `done`——服务端①②之间那一瞬，正好也是这次要修的场景。
          再拉一次快照，`committed && pending === 0` 就会把它收尾。
          正常路径上这次多出来的 GET 是白花的，但一次导入只多这一条请求。
        */
        if (data.pending === 0) void reconcile()
      })

      es.addEventListener('item', (e) => {
        if (!aliveRef.current) return
        const data = parseEvent<ImportItemEvent>((e as MessageEvent).data, 'item')
        if (data === null) return
        // result 是开放取值：服务端新增种类时原样落进 reason，不白屏（http.md §4）
        const known: QueueItemState[] = ['imported', 'exact_dup', 'needs_review', 'failed']
        const state = (known as string[]).includes(data.result)
          ? (data.result as QueueItemState)
          : 'failed'
        patchItem(data.fileName, {
          state,
          // reason 里多数是服务端写好的中文，只有批次级的 code（配额）要在这里翻
          reason: itemReasonText(data.reason),
          memeId: data.memeId,
        })
      })

      es.addEventListener('done', (e) => {
        if (!aliveRef.current) return
        const data = parseEvent<ImportDoneEvent>((e as MessageEvent).data, 'done')
        if (data === null) return
        finishedRef.current = true
        setDone(data)
        setPhase('done')
        setReconnecting(false)
        // `done` 后主动关闭（http.md §7）
        closeStream()
      })

      es.addEventListener('error', (e) => {
        if (!aliveRef.current) return
        // 事件里带 data 的是批次级失败；没有 data 的是连接层断开，两者处理完全不同
        const raw = (e as MessageEvent).data
        const body =
          typeof raw === 'string' && raw.length > 0
            ? parseEvent<{ code: string; message: string }>(raw, 'error')
            : null
        if (body !== null) {
          setBatchError({ code: body.code, message: body.message })
          setPhase('done')
          finishedRef.current = true
          closeStream()
          return
        }
        // 连接断了：EventSource 会自己重连，但漏掉的事件不会重发 —— 拉快照补齐（§1.4）
        // （解析不出来的那条 `error` 也走这里：内容读不了，但连接本身的事是真的，
        //   当作连接层处理，快照会把数字对齐，总好过凭一条读不懂的载荷宣告批次失败）
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
              // 字节到了就前进一格，**不等 `item` 事件**：事件可能根本不来
              // （连上之前那张图就处理完了，见 `reconcile`），而这一行会一直写着「上传中」
              patchItem(it.fileName, { state: 'uploaded' })
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

/**
 * 快照能不能算「这一批已经处理完」。**不能**就返回 null。
 *
 * 两个条件缺一不可：`committed`（这一批确实被提交过，不是还没开始）与
 * `pending === 0`（每一行都有结论了）。只判 `pending === 0` 的话，一个还停在
 * presign 阶段、一行没提交的批次会被当成「0 张失败」的完成态。
 *
 * 快照里**没有** `imported` / `exactDup`（服务端只给 `skipped` / `needsReview` /
 * `failed` 三个计数，见 `api/src/routes/imports.ts`），所以那几个数由总数减出来。
 * `Math.max(0, …)` 是防御性的：真出现负数说明三个计数加起来超过了总数，
 * 那时显示「-1 张已入库」比少显示一张更糟。
 */
function doneFromSnapshot(snap: BatchStatus): ImportDoneEvent | null {
  if (!snap.committed || snap.pending > 0) return null
  return {
    total: snap.total,
    imported: Math.max(0, snap.total - snap.skipped - snap.needsReview - snap.failed),
    exactDup: snap.skipped,
    needsReview: snap.needsReview,
    failed: snap.failed,
  }
}

/** `QUOTA_EXCEEDED` 的 `details.remaining`——只说「超了」不够，要显示剩余配额。 */
function readRemaining(err: ApiError | null): number | undefined {
  const v = err?.details?.['remaining']
  return typeof v === 'number' ? v : undefined
}
