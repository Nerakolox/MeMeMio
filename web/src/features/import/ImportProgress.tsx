import { Info, TriangleAlert } from 'lucide-react'
import { STAT_ROW, StatTile } from '../../components/StatTile'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent } from '../../components/ui/card'
import { Progress } from '../../components/ui/progress'
import { ScrollArea } from '../../components/ui/scroll-area'
import { formatBytes } from '../../lib/format'
import { TOUCH } from '../../lib/touch'
import { isSettled, type ImportQueue, type QueueItemState } from './use-import-queue'

/**
 * 服务端可能新增 `result`（http.md §4），查不到就原样显示，不给白屏。
 *
 * `variant` 是**契约**，不是配色偏好（`styling.md`「状态的视觉表达」）：
 * `needs_review` 是正常的中间态、不是故障，**不用错误色**——用错误色会让用户
 * 以为自己做错了什么。只有 `failed` 是终局失败，那一格才给 destructive。
 * （这条在迁移前是缺失的：`.import__item-state--<state>` 这些类在 CSS 里根本不存在，
 * 六个状态长得一模一样。）未知取值退回 `outline`，跟着上面那句兜底走。
 */
const STATE_BADGE: Record<string, { label: string; variant: 'outline' | 'secondary' | 'destructive' }> = {
  waiting: { label: '排队中', variant: 'outline' },
  uploading: { label: '上传中', variant: 'outline' },
  // 「字节已经到 R2，服务端还没给结论」。不写成「处理中」：客户端并不知道服务端
  // 还在不在处理它（这一批可能早就结束了），只写自己确知的那一段。
  uploaded: { label: '已上传', variant: 'outline' },
  imported: { label: '已入库', variant: 'secondary' },
  exact_dup: { label: '跳过重复', variant: 'outline' },
  needs_review: { label: '待确认', variant: 'secondary' },
  failed: { label: '失败', variant: 'destructive' },
}

/**
 * 分阶段的进度与结果。`导入中 237/1000` 看不出卡在哪一步，所以要分成
 * 「上传中 → 处理中 → 已入库 / 跳过重复 / 待你确认」几段（import-ux.md §3）。
 *
 * 两段进度各自一条 `Progress`：上传是客户端自己知道的，处理只有服务端知道，
 * 两个数**不是同一条进度条的两半**，合起来画会得到一个永远在 50% 附近跳的数字。
 */
export function ImportProgress({
  queue,
  onReset,
  onOpenReview,
  onOpenTagging,
  needsReviewCount,
}: {
  queue: ImportQueue
  onReset: () => void
  onOpenReview: () => void
  onOpenTagging: () => void
  /** 队列里累计的总数（跨批次），不是本批的——入口给的是队列，不是这次导入。 */
  needsReviewCount: number
}) {
  const { phase, items, uploadProgress, serverProgress, done, batchError, quotaError, reconnecting } =
    queue

  const uploadedDone =
    items.filter((it) => it.state === 'uploading' || it.state === 'waiting').length === 0

  // 服务端的数优先（它知道每一行的结论）；没有它时按**有结论的行**数，
  // 「已上传」不算——字节到了 R2 不等于服务端处理完了，算进去进度会跑在它前面。
  const processed = serverProgress?.done ?? items.filter((it) => isSettled(it.state)).length

  const failedItems = items.filter((it) => it.state === 'failed')
  const failedCount = done?.failed ?? failedItems.length

  return (
    <section className="flex flex-col gap-4" aria-live="polite">
      <Card>
        <CardContent className="flex flex-col gap-5">
          {/* 上传阶段是客户端自己知道的进度；处理阶段只有服务端知道 */}
          <Stage
            label="上传中"
            text={
              phase === 'uploading'
                ? `${uploadProgress.uploaded + uploadProgress.failed} / ${uploadProgress.total}`
                : uploadedDone
                  ? '完成'
                  : `${uploadProgress.uploaded} / ${uploadProgress.total}`
            }
            percent={uploadedDone ? 100 : percent(uploadProgress.uploaded, uploadProgress.total)}
          />

          {(phase === 'processing' || phase === 'done') && (
            <>
              <Stage
                label="处理中"
                text={`${processed}${serverProgress ? ` / ${serverProgress.total}` : ''}`}
                percent={serverProgress ? percent(processed, serverProgress.total) : undefined}
              />

              {/* 四个数分开报：「成功 982、失败 18」会让用户以为出了问题，
                  而跳过重复是正常且有价值的结果（import-ux.md §6） */}
              <dl className={STAT_ROW}>
                <StatTile label="已入库" value={done?.imported ?? countState(items, 'imported')} />
                <StatTile label="跳过重复" value={done?.exactDup ?? countState(items, 'exact_dup')} />
                <StatTile
                  label="待你确认"
                  value={done?.needsReview ?? countState(items, 'needs_review')}
                />
                {/* `danger` 只给终局失败：待你确认是正常中间态，不用错误色 */}
                <StatTile label="失败" value={failedCount} danger={failedCount > 0} />
              </dl>
            </>
          )}
        </CardContent>
      </Card>

      {reconnecting && (
        // 断开是常态不是错误（import-ux.md §8），所以是中性提示，`role="status"` 而非 alert
        <Alert role="status">
          <Info />
          <AlertDescription>
            进度连接断开，正在用批次快照补齐并重连——服务端处理不受影响。
          </AlertDescription>
        </Alert>
      )}

      {quotaError && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>
            存储配额不足，已停止后续上传。
            {quotaError.remaining !== undefined && (
              <> 剩余可用空间：{formatBytes(quotaError.remaining)}。</>
            )}
          </AlertTitle>
          <AlertDescription>
            {/* requestId 必须露出来，报问题时它是唯一能对上服务端日志的东西（http.md §3） */}
            <p className="font-mono text-xs">
              {quotaError.message}（requestId：{quotaError.requestId ?? '未知'}）
            </p>
          </AlertDescription>
        </Alert>
      )}

      {batchError && !quotaError && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{batchError.message}</AlertTitle>
          <AlertDescription>
            <p className="font-mono text-xs">requestId：{batchError.requestId ?? '未知'}</p>
          </AlertDescription>
        </Alert>
      )}

      {items.length > 0 && (
        // 限高 + 内部滚动，理由同 FilePicker 的待上传列表：一千张图时这一列会把
        // 下面的摘要和按钮顶到几万像素之外。条目本身仍全渲染。
        <ScrollArea className="h-72 rounded-2xl border">
          <ul className="divide-y">
            {items.map((it) => {
              const badge = STATE_BADGE[it.state]
              return (
                <li
                  key={it.fileName}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm" title={it.fileName}>
                    {it.fileName}
                  </span>
                  <Badge variant={badge?.variant ?? 'outline'} className="shrink-0">
                    {badge?.label ?? it.state}
                  </Badge>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatBytes(it.sizeBytes)}
                  </span>
                  {it.reason && (
                    // 失败要具体（import-ux.md §7），所以原话整条显示；`basis-full` 让它
                    // 独占一行，不去挤文件名那一行。
                    <span className="basis-full text-xs text-muted-foreground">
                      {it.reason}
                      {it.requestId && `（requestId：${it.requestId}）`}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}

      {phase === 'done' && done && (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <p>
              已入库 {done.imported} 张，跳过 {done.exactDup} 张完全相同的文件，
              {done.needsReview} 张待你确认
              {done.failed > 0 && `，${done.failed} 张失败`}。
            </p>

            {done.imported > 0 && (
              <p className="text-sm text-muted-foreground">
                已入库的图会在后台依次打标，进度和失败情况在「打标」页签里。
                打标结果会进入公共库——想先确认配置可以到设置页。
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {needsReviewCount > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  className={TOUCH}
                  onClick={onOpenReview}
                >
                  查看待确认（{needsReviewCount}）
                </Button>
              )}
              {/* 打标是异步的：导入结束时这些图大多还没标完，入口比数字有用（SPEC §6.6） */}
              {done.imported > 0 && (
                <Button type="button" variant="outline" className={TOUCH} onClick={onOpenTagging}>
                  查看打标状态
                </Button>
              )}
              <Button type="button" variant="outline" className={TOUCH} onClick={onReset}>
                继续导入
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {failedItems.length > 0 && phase === 'done' && (
        // 原生 `<details>` 而不是 Accordion：折叠里装的是一份渲染完就不再变的内容，
        // 但它不需要状态管理，而 Accordion 的折叠高度是「展开那一刻量一次」的快照
        // （`styling.md` 那条警告），能不用就不用。
        <details className="rounded-2xl border px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            失败明细（{failedItems.length}）
          </summary>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm">
            {failedItems.map((it) => (
              <li key={it.fileName} className="flex flex-wrap gap-x-2">
                <span className="min-w-0 break-all">{it.fileName}</span>
                <span className="text-muted-foreground">
                  {reasonText(it.reasonCode, it.reason)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/**
 * 一段进度：标签在左、数字在右，下面一条进度条。
 *
 * `percent` 为 `undefined` 时不画进度条——服务端的 `progress` 事件还没来之前，
 * 「处理中 12」这个数只有分子、没有分母，画一条 0% 的条是在编一个不存在的信息。
 */
function Stage({ label, text, percent }: { label: string; text: string; percent?: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-sm font-medium tabular-nums">{text}</span>
      </div>
      {percent !== undefined && <Progress value={percent} />}
    </div>
  )
}

function percent(done: number, total: number): number {
  // total 为 0 时不给 NaN（`<Progress value={NaN}>` 会渲染出 translateX(NaN%)）
  if (total <= 0) return 0
  return Math.min(100, Math.round((done / total) * 100))
}

function countState(items: { state: QueueItemState }[], state: QueueItemState): number {
  return items.filter((it) => it.state === state).length
}

/**
 * 失败要具体，不要只说「失败 37 张」（import-ux.md §7）。
 * 这里只做**短标签**区分，服务端原话仍然完整显示在后面。
 */
const REASON_LABEL: Record<string, string> = {
  UNSUPPORTED_FORMAT: '格式不支持',
  FILE_TOO_LARGE: '文件太大',
  QUOTA_EXCEEDED: '超出存储配额',
  DUPLICATE_EXACT: '内容完全相同',
  VALIDATION_FAILED: '请求字段不合法',
  INTERNAL: '服务端异常',
}

function reasonText(code: string | undefined, reason: string | undefined): string {
  const text = reason ?? '未说明原因'
  if (!code) return text
  const label = REASON_LABEL[code]
  if (!label) return text
  return text.startsWith(label) ? text : `${label}：${text}`
}
