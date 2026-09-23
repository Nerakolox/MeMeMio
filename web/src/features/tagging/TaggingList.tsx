import { useCallback, useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { MemeGallery } from '../../components/ImageViewer'
import { MemeCard } from '../../components/MemeCard'
import { ApiError, fetchMemes, toStateError, toggleFavorite, type Meme } from '../../lib/api'
import { notifyFailure } from '../../lib/toast'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'

/**
 * 空状态的文案。`needs_manual` 为 0 **是好事**，所以要说清「为什么这里是空的」——
 * 否则用户会以为是没加载出来。见 SPEC §6.6.2、`styling.md`。
 */
const EMPTY_TEXT: Record<string, string> = {
  pending: '没有等待打标的图片。',
  needs_manual: '没有需要人工处理的图片——打标成功的图不在这里。',
}

/**
 * 网格。**用 `auto-fill` 而不是容器查询分档**，与 `DiscoverWall` 的 `WALL_GRID` 不同。
 *
 * 两者要的是同一件事（列数跟着**容器**宽度走、不跟视口），`auto-fill` 是更直接的那条：
 * 列数由浏览器按容器宽度算，不需要任何查询，也就没有「`@container` 类删了、下面几档
 * 一起静默失效」那个坑（`styling.md` 记着）。这里换得动是因为**这一屏不挑列数**——
 * 它是个清点用的列表，一行 4 张还是 5 张都行；首页图墙是「一屏 10 张」的固定量，
 * 列数与张数捆在一起，才需要写死那三档。
 *
 * `minmax(160px, 1fr)` 是底线，与首页、浏览页同一条：手机上 390px 视口减掉外壳只有约
 * 342px，正好 2 列，低于 160 一张的既看不清也点不准。
 */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3'

/** 一次请求一个状态：`tagStatus` 是单值参数（SPEC §6.6.2），不合并成一个查询。 */
export function TaggingList({ status }: { status: string }) {
  const [items, setItems] = useState<Meme[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      setError(null)
      try {
        const page = await fetchMemes({ uploader: 'me', tagStatus: status, cursor })
        setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
        setNextCursor(page.nextCursor)
      } catch (err) {
        // `toStateError` 兜住非 ApiError 的那一支：断网时 `err` 是个 TypeError，
        // 原来那句 `apiErr?.message ?? '加载失败'` 只会说「加载失败」，而这一层能说的是
        // 「连不上服务端，确认 api 是否已启动」（与首页、浏览页同一份文案）。
        setError(toStateError(err))
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
      // 回滚必须说一句，见 `lib/toast.tsx` 的判据 1 / 3：心形自己翻回去不是反馈。
      notifyFailure('收藏失败，请重试')
    }
  }

  if (loading && items.length === 0) {
    return (
      <div className={GRID} aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          // `motion-reduce:animate-none` 不能省：注册表的 Skeleton 只有 animate-pulse
          <Skeleton key={i} aria-hidden="true" className="aspect-square motion-reduce:animate-none" />
        ))}
      </div>
    )
  }

  // 拆开 loading / error / success 三态是硬要求：只写 success 那条的话，
  // 加载失败时页面就是一片空白（code-style.md「异步与加载态」）。
  if (error) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>加载失败：{error.message}</AlertTitle>
        <AlertDescription>
          {/* requestId 必须露出来，报问题时它是唯一能对上服务端日志的东西（http.md §3） */}
          <p className="font-mono text-xs">requestId：{error.requestId}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(TOUCH, 'mt-2')}
            onClick={() => void load()}
          >
            重试
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (items.length === 0) {
    // 空状态按状态说人话，不是干巴巴一句「暂无数据」：用户是来判断「有没有卡着的图」的。
    // 查不到取值时给一句通用的兜底，服务端新增状态不至于让这里输出 undefined（http.md §4）。
    return (
      <p className="text-sm text-muted-foreground">
        {EMPTY_TEXT[status] ?? '没有符合条件的图片。'}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 全屏里 ←/→ 翻的就是已经翻出来的这几页（加载更多之后接着往下翻） */}
      <MemeGallery items={items}>
        <div className={GRID}>
          {/* 角标是这个列表的全部信息量——它的用途就是**看哪张卡卡在哪个状态上**
              （styling.md「状态的视觉表达」）。角标在卡片里（components/MemeCard.tsx）。 */}
          {items.map((meme) => (
            <MemeCard key={meme.id} meme={meme} onFavorite={handleFavorite} />
          ))}
        </div>
      </MemeGallery>

      {/* 翻页用按钮而不是无限滚动：这是个清点用的列表，用户想知道「还有没有」，
          而不是滑到哪算哪。 */}
      {nextCursor && (
        <Button
          type="button"
          variant="outline"
          className={cn(TOUCH, 'self-start')}
          disabled={loading}
          onClick={() => void load(nextCursor)}
        >
          {loading ? '加载中…' : '加载更多'}
        </Button>
      )}
    </div>
  )
}
