import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, fetchMemes, toStateError, toggleFavorite, type Meme } from '../../lib/api'
import { MemeCard } from '../../components/MemeCard'

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
            <div key={i} className="meme-card meme-card--skeleton" aria-hidden="true" />
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
              真流程在 src/lib/clipboard.ts，接的时候直接用它，别在这里另写一份。 */}
          {state.items.map((meme) => (
            <MemeCard key={meme.id} meme={meme} onFavorite={handleFavorite} />
          ))}
        </div>
      )}
    </section>
  )
}
