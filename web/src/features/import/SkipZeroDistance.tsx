import { useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { Button } from '../../components/ui/button'
import { ApiError } from '../../lib/api'
import { resolveReview, type ReviewItem } from '../../lib/api-imports'
import { notifyFailure } from '../../lib/toast'
import { TOUCH } from '../../lib/touch'

/** 逐条调已有接口的并发数：几百条串行太慢，一把全发又会撞限流。 */
const CONCURRENCY = 4
/** 攒够这么多条成功再回写列表，避免每条都让几百张卡重渲一遍。 */
const FLUSH_EVERY = 20

/** 待确认条目的唯一键。条目跨批次，`fileName` 只在批次内唯一。 */
export function reviewKey(item: Pick<ReviewItem, 'batchId' | 'fileName'>): string {
  return `${item.batchId ?? '?'}/${item.fileName}`
}

/**
 * 能被「距离为 0 的全部跳过」处理的条目。
 *
 * **`existing === null` 的不在其内**：库里那张已经被删了，暂存文件是这张图仅剩的一份，
 * 跳过会把它删掉，这一步就不再是「丢掉多余的副本」而是「丢掉唯一的一份」。
 * 这种条目留给人逐条看（SPEC §6.2.3：决定权仍在用户手上）。
 */
export function zeroDistanceCandidates(items: ReviewItem[]): ReviewItem[] {
  return items.filter((i) => i.distance === 0 && i.batchId && i.existing !== null)
}

type Run =
  | { kind: 'idle' }
  | { kind: 'running'; total: number; skipped: number; failed: number }
  | {
      kind: 'done'
      total: number
      skipped: number
      failed: number
      notAttempted: number
    }

/**
 * 「距离为 0 的全部跳过」（任务《近似重复自动判定》§4）。
 *
 * 不是新接口：对每一条调已有的 `POST /imports/reviews/{batchId}/{fileName}`
 * （`action: "skip"`），人点了按钮才做，仍是人在决定（SPEC §9.7 不受影响）。
 *
 * 失败不回滚、不清空已成功的——服务端已经删了暂存文件，回不去；界面如实报
 * 「跳过了 X / 失败了 Y」，失败的留在队列里。
 */
export function SkipZeroDistance({
  candidates,
  onResolved,
  onRunningChange,
}: {
  candidates: ReviewItem[]
  /** 已经在服务端跳过成功的条目，分批回调，父组件据此移出列表。 */
  onResolved: (items: ReviewItem[]) => void
  onRunningChange: (running: boolean) => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [run, setRun] = useState<Run>({ kind: 'idle' })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      // 离开页面就不再发后续请求；已发出的会自己结束
      aliveRef.current = false
    }
  }, [])

  const running = run.kind === 'running'

  async function start() {
    const queue = [...candidates]
    const total = queue.length
    if (total === 0) return

    let skipped = 0
    let failed = 0
    const failures: ApiError[] = []
    let stop = false
    let pendingFlush: ReviewItem[] = []
    let next = 0

    onRunningChange(true)
    setRun({ kind: 'running', total, skipped, failed })

    const flush = () => {
      if (pendingFlush.length === 0) return
      onResolved(pendingFlush)
      pendingFlush = []
    }

    const worker = async () => {
      for (;;) {
        if (stop || !aliveRef.current) return
        const item = queue[next++]
        if (!item || !item.batchId) return
        try {
          await resolveReview(item.batchId, item.fileName, 'skip')
          skipped += 1
          pendingFlush.push(item)
        } catch (err) {
          failed += 1
          if (err instanceof ApiError) {
            failures.push(err)
            // 会话没了，后面的一定也一样：别再发几百个注定失败的请求
            if (err.code === 'UNAUTHENTICATED') stop = true
          }
        }
        if (pendingFlush.length >= FLUSH_EVERY) flush()
        if (aliveRef.current) setRun({ kind: 'running', total, skipped, failed })
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker))
    flush()
    onRunningChange(false)
    // 失败一律弹且不自动消失（feedback.md 判据 2）；带上第一条的 requestId 方便对日志。
    // 放在「页面还在不在」的判断之前：用户中途切走了，也该知道有几张没跳成。
    if (failed > 0) {
      notifyFailure(
        `跳过了 ${skipped} 张，${failed} 张没跳过成功，它们仍在队列里`,
        failures[0]?.requestId,
      )
    }
    if (!aliveRef.current) return

    setRun({
      kind: 'done',
      total,
      skipped,
      failed,
      notAttempted: total - skipped - failed,
    })
  }

  if (candidates.length === 0 && run.kind !== 'done') return null

  return (
    <div className="flex flex-col gap-2">
      {candidates.length > 0 && (
        <div>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            className={TOUCH}
            disabled={running}
            onClick={() => setConfirmOpen(true)}
          >
            距离为 0 的全部跳过（{candidates.length}）
          </Button>
        </div>
      )}

      {run.kind === 'running' && (
        <p role="status" className="text-sm tabular-nums text-muted-foreground">
          正在跳过 {run.skipped + run.failed} / {run.total}…
        </p>
      )}
      {run.kind === 'done' && (
        <p role="status" className="text-sm text-muted-foreground">
          跳过了 {run.skipped} 张
          {run.failed > 0 && `，失败了 ${run.failed} 张（仍在队列里）`}
          {run.notAttempted > 0 && `，${run.notAttempted} 张因登录失效没有处理`}。
        </p>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent
          // 没有 AlertDialogTrigger，Radix 关框时找不到触发器，焦点会掉在 body 上，显式交回
          // （同 `RetagPanel` / `MemeActions`）。按钮被禁用时收不到焦点，那就不动。
          onCloseAutoFocus={() => {
            const btn = triggerRef.current
            if (btn && !btn.disabled) btn.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>跳过这 {candidates.length} 张距离为 0 的图？</AlertDialogTitle>
            <AlertDialogDescription>
              {'距离为 0 表示它们与库里已有的图在画面指纹上完全一致，多半是同一张图的另一份副本。'}
              <br />
              <strong>跳过会删除这些图的暂存文件，不可撤销。</strong>
              {'库里已有的那张不受影响。'}
              <br />
              {'「原图已不存在」的条目、以及你「稍后再说」的条目不在其中，仍留在队列里。'}
              <br />
              {'同一模板换了字的图也可能距离为 0——拿不准的，请先关掉这个框逐条看。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* 默认焦点落在「取消」：删除不可逆，一次误触的回车不该把它们全丢掉 */}
            <AlertDialogCancel className={TOUCH}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className={TOUCH}
              // 点了就关，进度在按钮下方的一行里；不把用户困在一个几百次请求的框里
              onClick={() => void start()}
            >
              确定全部跳过
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
