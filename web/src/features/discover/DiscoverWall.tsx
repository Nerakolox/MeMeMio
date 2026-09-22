import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { MemeGallery } from '../../components/ImageViewer'
import { MemeCard } from '../../components/MemeCard'
import { ApiError, fetchMemes, toStateError, toggleFavorite, type Meme } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'

/**
 * 一屏 10 张。桌面 5 列 × 2 行，窄屏只降列数、**不降张数**——
 * 少给几张等于让「换一批」在一个更小的池子里换，那和这个按钮的用途正好相反。
 */
const WALL_SIZE = 10

/**
 * 图墙的网格。**列数按容器宽度分档，不按视口**（2026-09-21 从媒体查询改过来的）：
 * 加了侧边导航之后「视口宽度」不再是图墙的宽度——1280px 视口下内容列只有约 976px，
 * 768～1150px 这段更是只剩 120～140px 一格，低于下面那个 160px 底线，而媒体查询在
 * 那个区间不会触发。容器就是这一节的根（`@container` → `container-type: inline-size`）。
 *
 * 手机 2 列是**降列数、不降张数**：5 列在 390px 上是 70px 一张，既看不清也点不准
 * （styling.md：触摸目标 44×44px 起）。手机是这个产品的主场，不为塞满一屏牺牲可点性。
 *
 * ⚠️ 两档写的是 `@max-[900px]:` / `@max-[640px]:`，它生成的是 `@container (width < 900px)`,
 * 与旧 CSS 的 `@container (max-width: 900px)`（`≤`）**只在恰好等于这一刻不同**。
 * 布局宽度取不到整数边界值，不做 `900.02px` 那种补偿，但改这两档时要知道有这笔账。
 */
const WALL_GRID =
  'grid grid-cols-5 gap-3 @max-[900px]:grid-cols-3 @max-[640px]:grid-cols-2'

type WallState =
  | { kind: 'loading' }
  | { kind: 'ok'; items: Meme[] }
  | { kind: 'error'; error: ApiError }

/**
 * 首页的「随便看看」：全库随机抽 10 张。
 *
 * ⚠️ **随机发生在服务端，这是这一屏的全部要害**（SPEC §6.3.2）。客户端也能做出
 * 随机的样子——拉最新 100 条再 `Math.random()` 抽 10 个——但那种「随机」只在
 * 新图里发生：库用上三个月之后，用户按一百次换一批也见不到三个月前那张图，
 * **而它一直能被搜到，只是没有任何入口指向它**。把老图翻出来正是这里唯一的用途。
 */
export function DiscoverWall() {
  const [state, setState] = useState<WallState>({ kind: 'loading' })
  // 每 +1 换一批。
  //
  // 这一批图**不进 URL**，是有意的：随机结果不是可分享的东西——把链接发给别人，
  // 对方看到的是另一批图。state-navigation.md §1 要求进 URL 的是「能放 URL 的」，
  // 随机的一屏不在那一类里，它是纯 UI state。
  const [round, setRound] = useState(0)

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    fetchMemes({ random: true, limit: WALL_SIZE })
      .then((page) => {
        if (!alive) return
        setState({ kind: 'ok', items: page.items })
      })
      .catch((err: unknown) => {
        if (!alive) return
        setState({ kind: 'error', error: toStateError(err) })
      })
    return () => {
      // 快速连点「换一批」时，先发的请求可能后到——不拦住就把新的一批盖回旧的一批
      alive = false
    }
  }, [round])

  /** 收藏走乐观更新，失败回滚（state-navigation.md §8，与搜索页、浏览页一致）。 */
  async function handleFavorite(meme: Meme) {
    const next = !meme.favorited
    setState((prev) =>
      prev.kind === 'ok'
        ? {
            ...prev,
            items: prev.items.map((m) => (m.id === meme.id ? { ...m, favorited: next } : m)),
          }
        : prev,
    )
    try {
      await toggleFavorite(meme.id, next)
    } catch {
      setState((prev) =>
        prev.kind === 'ok'
          ? {
              ...prev,
              items: prev.items.map((m) => (m.id === meme.id ? { ...m, favorited: !next } : m)),
            }
          : prev,
      )
    }
  }

  const busy = state.kind === 'loading'
  const refresh = () => setRound((n) => n + 1)

  return (
    // `@container` 不只是装饰：删了它下面那两档容器查询全部静默失效（图墙永远 5 列）
    <section className="@container mt-6 flex flex-col gap-3" aria-label="随便看看">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">随便看看</span>
        {/*
          请求进行中就禁用。幂等是服务端的安全网，不是让用户重复点的理由（http.md §9）——
          而且换一批不是幂等操作：每次点都是另一批图。
        */}
        <Button variant="secondary" size="sm" className={TOUCH} disabled={busy} onClick={refresh}>
          {busy && <RefreshCw className="animate-spin motion-reduce:animate-none" />}
          {busy ? '正在换…' : '换一批'}
        </Button>
      </div>

      {state.kind === 'loading' && (
        <div className={WALL_GRID} aria-busy="true">
          {Array.from({ length: WALL_SIZE }).map((_, i) => (
            // `motion-reduce:animate-none` 不能省：注册表的 Skeleton 只有 animate-pulse
            <Skeleton
              key={i}
              aria-hidden="true"
              className="aspect-square motion-reduce:animate-none"
            />
          ))}
        </div>
      )}

      {state.kind === 'error' && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>
            <p>{state.error.message}</p>
            {/* requestId 必须露出来，报问题时它是唯一能对上服务端日志的东西（http.md §3） */}
            <p className="font-mono text-xs">requestId: {state.error.requestId}</p>
            <Button variant="outline" size="sm" className={cn(TOUCH, 'mt-2')} onClick={refresh}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* 空库不是错误：新部署的第一天就是这个状态，要有下一步可走。
          入口做成按钮而不是句子里的链接——它是这一屏唯一的下一步，手机上要按得准（44px）。 */}
      {state.kind === 'ok' && state.items.length === 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">库里还没有图</p>
          <Button variant="link" className={TOUCH} asChild>
            <Link to="/import">去导入几张</Link>
          </Button>
        </div>
      )}

      {state.kind === 'ok' && state.items.length > 0 && (
        // 全屏里 ←/→ 翻的就是这一屏随机出来的那批
        <MemeGallery items={state.items}>
          <div className={WALL_GRID}>
            {/* 这一屏只有收藏一个动作，**没有复制 / 下载 / 分享**，是有意的：
                发送路径的入口至今只做到搜索结果与浏览页（见
                joint-tasks/2026-09-19-browse-meme-actions.md 的「明确不做」——
                图墙卡片上那片位置留给后续的「复制 / 发送」）。
                真流程在 src/lib/clipboard.ts，接的时候直接用它，别在这里另写一份。

                要接的时候**不用改卡片**：`MemeCard` 的 `actions` 那个槽就是给它的，
                浏览页往同一个槽里放了「⋯」（components/MemeCard.tsx）。 */}
            {state.items.map((meme) => (
              <MemeCard key={meme.id} meme={meme} onFavorite={handleFavorite} />
            ))}
          </div>
        </MemeGallery>
      )}
    </section>
  )
}
