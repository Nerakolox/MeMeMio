import { useCallback, useEffect, useState } from 'react'
import { Heart } from 'lucide-react'
import { ApiError, fetchMemes, toggleFavorite, type Meme } from '../../lib/api'
import { tagStatusLabel } from '../../lib/tag-status'

/**
 * 空状态的文案。`needs_manual` 为 0 **是好事**，所以要说清「为什么这里是空的」——
 * 否则用户会以为是没加载出来。见 SPEC §6.6.2、`styling.md`。
 */
const EMPTY_TEXT: Record<string, string> = {
  pending: '没有等待打标的图片。',
  needs_manual: '没有需要人工处理的图片——打标成功的图不在这里。',
}

/** 一次请求一个状态：`tagStatus` 是单值参数（SPEC §6.6.2），不合并成一个查询。 */
export function TaggingList({ status }: { status: string }) {
  const [items, setItems] = useState<Meme[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ message: string; requestId: string } | null>(null)

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      setError(null)
      try {
        const page = await fetchMemes({ uploader: 'me', tagStatus: status, cursor })
        setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
        setNextCursor(page.nextCursor)
      } catch (err) {
        const apiErr = err instanceof ApiError ? err : null
        setError({
          message: apiErr?.message ?? '加载失败',
          requestId: apiErr?.requestId ?? '未知',
        })
      } finally {
        setLoading(false)
      }
    },
    [status],
  )

  // 换状态就整段换掉、不合并：两个状态的列表没有交集，留着上一段的条目会张冠李戴。
  // 游标也不跨状态复用。
  useEffect(() => {
    void load()
  }, [load])

  /** 收藏乐观更新、失败回滚（state-navigation.md §8）。列表在本地，真相在服务端。 */
  async function handleFavorite(meme: Meme) {
    const next = !meme.favorited
    setItems((prev) => prev.map((m) => (m.id === meme.id ? { ...m, favorited: next } : m)))
    try {
      await toggleFavorite(meme.id, next)
    } catch {
      setItems((prev) => prev.map((m) => (m.id === meme.id ? { ...m, favorited: !next } : m)))
    }
  }

  if (loading && items.length === 0) {
    return (
      <div className="tagging__grid" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="aspect-square animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
          />
        ))}
      </div>
    )
  }

  // 拆开 loading / error / success 三态是硬要求：只写 success 那条的话，
  // 加载失败时页面就是一片空白（code-style.md「异步与加载态」）。
  if (error) {
    return (
      <div className="tagging__error" role="alert">
        <p>加载失败：{error.message}</p>
        <p className="tagging__request-id">requestId：{error.requestId}</p>
        <button type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    )
  }

  if (items.length === 0) {
    // 空状态按状态说人话，不是干巴巴一句「暂无数据」：用户是来判断「有没有卡着的图」的。
    // 查不到取值时给一句通用的兜底，服务端新增状态不至于让这里输出 undefined（http.md §4）。
    return <p className="tagging__empty">{EMPTY_TEXT[status] ?? '没有符合条件的图片。'}</p>
  }

  return (
    <>
      <div className="tagging__grid">
        {/* ⚠️ 2026-09-21 起这里是**裸图**（同 DiscoverWall）：卡片层随样式返工删掉了。
            角标必须留——这个列表的用途就是**看哪张卡在哪个状态上**，
            没了角标这张图等于没信息（styling.md「状态的视觉表达」）。 */}
        {items.map((meme) => (
          <div key={meme.id} className="relative">
            <img
              className="aspect-square w-full rounded-lg bg-muted object-cover"
              src={meme.thumbUrl ?? meme.url}
              alt={meme.description ?? meme.originalFilename ?? meme.id}
              loading="lazy"
              width={meme.width ?? undefined}
              height={meme.height ?? undefined}
            />
            {(meme.tagStatus !== 'ok' || meme.isAnimated) && (
              <div className="pointer-events-none absolute left-1.5 top-1.5 z-10 flex flex-wrap gap-1">
                {meme.tagStatus !== 'ok' && (
                  <span className="rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                    {tagStatusLabel(meme.tagStatus)}
                  </span>
                )}
                {meme.isAnimated && (
                  <span className="rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold leading-none tracking-wide text-white backdrop-blur-sm">
                    GIF
                  </span>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => void handleFavorite(meme)}
              aria-label={meme.favorited ? '取消收藏' : '收藏'}
              aria-pressed={meme.favorited}
              className="absolute bottom-1.5 right-1.5 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/85 max-sm:h-11 max-sm:w-11"
            >
              <Heart className="h-4 w-4" fill={meme.favorited ? 'currentColor' : 'none'} />
            </button>
          </div>
        ))}
      </div>

      {/* 翻页用按钮而不是无限滚动：这是个清点用的列表，用户想知道「还有没有」，
          而不是滑到哪算哪。 */}
      {nextCursor && (
        <button
          type="button"
          className="tagging__more"
          disabled={loading}
          onClick={() => void load(nextCursor)}
        >
          {loading ? '加载中…' : '加载更多'}
        </button>
      )}
    </>
  )
}
