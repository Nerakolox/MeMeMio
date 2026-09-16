import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../../lib/api'
import { fetchReviews, resolveReview, type ReviewItem } from '../../lib/api-imports'
import { ReviewCard } from './ReviewCard'

/** 服务端超过 7 天连同暂存文件一起清理（import-ux.md §5），界面上要说明。 */
const REVIEW_TTL_DAYS = 7

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; items: ReviewItem[] }
  | { kind: 'error'; message: string; requestId: string }

/**
 * 待确认队列。跨批次累积，`GET /imports/reviews` 拿全部（SPEC §6.2.3）。
 *
 * **队列只有 1 条时就是弹窗**——不是另做一套逻辑，而是同一个列表只有一项。
 * 单张上传的场景因此天然得到即时反馈（import-ux.md §4）。
 */
export function ReviewQueue({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  /** 正在提交决策的条目，用来禁用按钮——防止「点头像了没反应」而被连点两次。 */
  const [busy, setBusy] = useState<string | null>(null)
  const [rowError, setRowError] = useState<Record<string, string>>({})
  /**
   * 「稍后再说」只是本次会话里不显示，**不发请求、也不从队列里删**——
   * 条目还在服务端，下次进来还会出现。用户导入完三千张后不想当场判，是正常需求。
   */
  const [deferred, setDeferred] = useState<string[]>([])

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const items = await fetchReviews()
      setState({ kind: 'ok', items })
      onCountChange?.(items.length)
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null
      setState({
        kind: 'error',
        message: apiErr?.message ?? '加载待确认条目失败',
        requestId: apiErr?.requestId ?? '未知',
      })
    }
  }, [onCountChange])

  useEffect(() => {
    void load()
  }, [load])

  async function decide(item: ReviewItem, action: 'import' | 'skip') {
    const batchId = item.batchId
    if (!batchId) {
      setRowError((prev) => ({ ...prev, [item.fileName]: '条目缺少 batchId，无法提交决策' }))
      return
    }
    setBusy(item.fileName)
    setRowError((prev) => {
      const next = { ...prev }
      delete next[item.fileName]
      return next
    })
    try {
      await resolveReview(batchId, item.fileName, action)
      // 决策成功后移出列表：真相在服务端，这里只是就地更新缓存（state-navigation.md §2）
      setState((prev) => {
        if (prev.kind !== 'ok') return prev
        const items = prev.items.filter((i) => i.fileName !== item.fileName)
        onCountChange?.(items.length)
        return { kind: 'ok', items }
      })
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null
      setRowError((prev) => ({
        ...prev,
        [item.fileName]: apiErr
          ? `${apiErr.message}（requestId：${apiErr.requestId}）`
          : '提交失败，请重试',
      }))
    } finally {
      setBusy(null)
    }
  }

  if (state.kind === 'loading') return <p>加载中…</p>

  if (state.kind === 'error') {
    return (
      <div className="import__review-error" role="alert">
        <p>{state.message}</p>
        <p className="import__request-id">requestId：{state.requestId}</p>
        <button type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    )
  }

  if (state.items.length === 0) {
    return (
      <section className="import__review-empty">
        <p>没有待确认的图片。</p>
        <p className="import__note">
          导入时发现与库里已有图片很像的文件会攒到这里，让你自己判断要不要留。
        </p>
      </section>
    )
  }

  const visible = state.items.filter((i) => !deferred.includes(i.fileName))
  const single = state.items.length === 1

  // 「稍后再说」全按掉之后不要变成空白页——那会让人以为队列出问题了
  if (visible.length === 0) {
    return (
      <section className="import__review-empty">
        <p>这次先不看。已推迟的 {deferred.length} 张仍在队列里，下次进来还会出现。</p>
        <button type="button" onClick={() => setDeferred([])}>
          重新展开
        </button>
      </section>
    )
  }

  return (
    <section className="import__review" aria-label="待确认队列">
      <header className="import__review-head">
        <p className="import__review-count">
          {single ? '有 1 张图需要你确认' : `${state.items.length} 张图待你确认`}
          {deferred.length > 0 && `（已推迟 ${deferred.length} 张）`}
        </p>
        <p className="import__note">
          这些图与库里已有的图很像，<strong>还没有打标、也还没占技能额度</strong>。
          你选「仍然导入」之后才会进打标队列。
        </p>
        <p className="import__note">
          超过 {REVIEW_TTL_DAYS} 天未处理的条目会被服务端连同暂存文件一起清理。
          「稍后再说」不会丢，它只是留在这里等你。
        </p>
      </header>

      <ul className="import__review-list">
        {visible.map((item) => (
          <li key={`${item.batchId ?? '?'}/${item.fileName}`}>
            <ReviewCard
              item={item}
              busy={busy === item.fileName}
              error={rowError[item.fileName] ?? null}
              onDecide={(action) => void decide(item, action)}
              onLater={() => setDeferred((prev) => [...prev, item.fileName])}
            />
          </li>
        ))}
      </ul>

      {single && (
        <p className="import__note">
          只有一条时它就以这种即时面板的形式出现——和批量导入用的是同一个接口、同一套数据，
          不需要为单张上传另走一条路径。
        </p>
      )}
    </section>
  )
}
