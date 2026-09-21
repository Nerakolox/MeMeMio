import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Heart } from 'lucide-react'
import { ApiError, fetchMemes, toStateError, toggleFavorite, type Meme } from '../../lib/api'
import { tagStatusLabel } from '../../lib/tag-status'

/**
 * 一屏 10 张。桌面 5 列 × 2 行，窄屏只降列数、**不降张数**——
 * 少给几张等于让「换一批」在一个更小的池子里换，那和这个按钮的用途正好相反。
 */
const WALL_SIZE = 10

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

  return (
    <section className="discover" aria-label="随便看看">
      <div className="discover__header">
        <span>随便看看</span>
        {/*
          请求进行中就禁用。幂等是服务端的安全网，不是让用户重复点的理由（http.md §9）——
          而且换一批不是幂等操作：每次点都是另一批图。
        */}
        <button
          className="discover__refresh"
          onClick={() => setRound((n) => n + 1)}
          disabled={busy}
        >
          {busy ? '正在换…' : '换一批'}
        </button>
      </div>

      {state.kind === 'loading' && (
        <div className="discover__grid" aria-busy="true">
          {Array.from({ length: WALL_SIZE }).map((_, i) => (
            <div
              key={i}
              aria-hidden="true"
              className="aspect-square animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
            />
          ))}
        </div>
      )}

      {state.kind === 'error' && (
        <div className="discover__error" role="alert">
          <p>加载失败：{state.error.message}</p>
          {/* requestId 必须露出来，报问题时它是唯一能对上服务端日志的东西 */}
          <p className="discover__request-id">requestId: {state.error.requestId}</p>
          <button className="discover__refresh" onClick={() => setRound((n) => n + 1)}>
            重试
          </button>
        </div>
      )}

      {/* 空库不是错误：新部署的第一天就是这个状态，要有下一步可走 */}
      {state.kind === 'ok' && state.items.length === 0 && (
        <p className="discover__empty">
          库里还没有图，<Link to="/import">去导入</Link>几张
        </p>
      )}

      {state.kind === 'ok' && state.items.length > 0 && (
        <div className="discover__grid">
          {/* 这一屏只有收藏一个动作，**没有复制 / 下载 / 分享**，是有意的：
              发送路径的入口这次只做到搜索结果与浏览页（见
              joint-tasks/2026-09-19-browse-meme-actions.md 的「明确不做」——
              图墙卡片上那片位置留给后续的「复制 / 发送」）。
              真流程在 src/lib/clipboard.ts，接的时候直接用它，别在这里另写一份。

              ⚠️ 2026-09-21 起这里是**裸图**：卡片层（圆角卡片 / hover 浮层 / 骨架切换 /
              加载失败兜底）随样式返工删掉了，卡片重做是单独任务。角标留着是硬要求，
              不是装饰——GIF 的发送路径与静图不同（styling.md「动图」），
              pending / needs_manual 要让用户一眼看出（同文件「状态的视觉表达」）。 */}
          {state.items.map((meme) => (
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
                    // pending / needs_manual 是正常的中间态，**不给错误色**——用错误色
                    // 会让用户以为自己哪里做错了（styling.md）。统一深色玻璃底。
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
              {/* 收藏。深色玻璃底的理由和角标一样：底下是什么颜色的图不知道。 */}
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
      )}
    </section>
  )
}
