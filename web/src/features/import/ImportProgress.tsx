import { formatBytes } from '../../lib/format'
import type { ImportQueue, QueueItemState } from './use-import-queue'

/** 服务端可能新增 `result`（http.md §4），查不到就原样显示，不给白屏。 */
const STATE_LABEL: Record<string, string> = {
  waiting: '排队中',
  uploading: '上传中',
  imported: '已入库',
  exact_dup: '跳过重复',
  needs_review: '待确认',
  failed: '失败',
}

/**
 * 分阶段的进度与结果。`导入中 237/1000` 看不出卡在哪一步，所以要分成
 * 「上传中 → 处理中 → 已入库 / 跳过重复 / 待你确认」几行（import-ux.md §3）。
 */
export function ImportProgress({
  queue,
  onReset,
  onOpenReview,
  needsReviewCount,
}: {
  queue: ImportQueue
  onReset: () => void
  onOpenReview: () => void
  /** 队列里累计的总数（跨批次），不是本批的——入口给的是队列，不是这次导入。 */
  needsReviewCount: number
}) {
  const { phase, items, uploadProgress, serverProgress, done, batchError, quotaError, reconnecting } =
    queue

  const uploadedDone =
    items.filter((it) => it.state === 'uploading' || it.state === 'waiting').length === 0

  const processed =
    serverProgress?.done ??
    items.filter((it) => it.state !== 'waiting' && it.state !== 'uploading').length

  const failedItems = items.filter((it) => it.state === 'failed')

  return (
    <section className="import__progress" aria-live="polite">
      {/* 上传阶段是客户端自己知道的进度；处理阶段只有服务端知道 */}
      {phase === 'uploading' && (
        <dl className="import__stages">
          <div className="import__stage">
            <dt>上传中</dt>
            <dd>
              {uploadProgress.uploaded + uploadProgress.failed} / {uploadProgress.total}
            </dd>
          </div>
        </dl>
      )}

      {(phase === 'processing' || phase === 'done') && (
        <dl className="import__stages">
          <div className="import__stage">
            <dt>上传中</dt>
            <dd>
              {uploadedDone ? '完成' : `${uploadProgress.uploaded} / ${uploadProgress.total}`}
            </dd>
          </div>
          <div className="import__stage">
            <dt>处理中</dt>
            <dd>
              {processed}
              {serverProgress ? ` / ${serverProgress.total}` : ''}
            </dd>
          </div>
          <div className="import__stage">
            <dt>已入库</dt>
            <dd>{done?.imported ?? countState(items, 'imported')}</dd>
          </div>
          <div className="import__stage">
            <dt>跳过重复</dt>
            <dd>{done?.exactDup ?? countState(items, 'exact_dup')}</dd>
          </div>
          <div className="import__stage">
            <dt>待你确认</dt>
            <dd>{done?.needsReview ?? countState(items, 'needs_review')}</dd>
          </div>
          <div className="import__stage">
            <dt>失败</dt>
            <dd>{done?.failed ?? failedItems.length}</dd>
          </div>
        </dl>
      )}

      {reconnecting && (
        <p className="import__reconnect" role="status">
          进度连接断开，正在用批次快照补齐并重连——服务端处理不受影响。
        </p>
      )}

      {quotaError && (
        <div className="import__batch-error" role="alert">
          <p>
            存储配额不足，已停止后续上传。
            {quotaError.remaining !== undefined && (
              <> 剩余可用空间：{formatBytes(quotaError.remaining)}。</>
            )}
          </p>
          <p className="import__request-id">
            {quotaError.message}（requestId：{quotaError.requestId ?? '未知'}）
          </p>
        </div>
      )}

      {batchError && !quotaError && (
        <div className="import__batch-error" role="alert">
          <p>{batchError.message}</p>
          <p className="import__request-id">requestId：{batchError.requestId ?? '未知'}</p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="import__item-list">
          {items.map((it) => (
            <li key={it.fileName} className="import__item">
              <span className="import__item-name">{it.fileName}</span>
              <span className={`import__item-state import__item-state--${it.state}`}>
                {STATE_LABEL[it.state] ?? it.state}
              </span>
              <span className="import__item-size">{formatBytes(it.sizeBytes)}</span>
              {it.reason && (
                <span className="import__item-reason">
                  {it.reason}
                  {it.requestId && `（requestId：${it.requestId}）`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {phase === 'done' && done && (
        <div className="import__summary">
          {/* 三个数分开报：「成功 982、失败 18」会让用户以为出了问题，
              而跳过重复是正常且有价值的结果（import-ux.md §6） */}
          <p>
            已入库 {done.imported} 张，跳过 {done.exactDup} 张完全相同的文件，
            {done.needsReview} 张待你确认
            {done.failed > 0 && `，${done.failed} 张失败`}。
          </p>

          {done.imported > 0 && (
            <p className="import__summary-note">
              已入库的图<strong>尚未打标</strong>（队列消费者是独立任务），当前状态为 pending。
              打标结果会进入公共库——想先确认配置可以到设置页。
            </p>
          )}

          <div className="import__summary-actions">
            {needsReviewCount > 0 && (
              <button type="button" className="import__review-link" onClick={onOpenReview}>
                查看待确认（{needsReviewCount}）
              </button>
            )}
            <button type="button" onClick={onReset}>
              继续导入
            </button>
          </div>
        </div>
      )}

      {failedItems.length > 0 && phase === 'done' && (
        <details className="import__failures">
          <summary>失败明细（{failedItems.length}）</summary>
          <ul>
            {failedItems.map((it) => (
              <li key={it.fileName}>
                <span className="import__item-name">{it.fileName}</span>
                {'：'}
                {reasonText(it.reasonCode, it.reason)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
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
