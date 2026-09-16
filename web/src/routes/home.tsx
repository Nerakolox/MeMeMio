import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ApiError,
  MATCHED_BY_LABELS,
  fetchSearch,
  toggleFavorite,
  type Meme,
  type SearchResult,
} from '../lib/api'
import { MemeCard } from '../components/MemeCard'

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ok'
      items: SearchResult[]
      degraded: boolean
      rewritten: string | null
    }
  | { kind: 'error'; error: ApiError }

/** `matchedBy` 里的通路标识翻成中文标签，未知取值原样显示（服务端可能新增通路）。 */
function matchedBadges(matchedBy: string[]): string[] {
  return matchedBy.map((m) => MATCHED_BY_LABELS[m] ?? m)
}

/**
 * 搜索，主入口。搜索词放 URL 不放组件 state——用户会把一次搜索的链接发给别人
 * （「你搜这个，第三张」），放 state 里就分享不了、刷新也丢（state-navigation.md §1）。
 */
export function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''

  // 输入框里未提交的值——这是纯 UI state 的三类之一（state-navigation.md §3）
  const [draft, setDraft] = useState(q)
  const [state, setState] = useState<SearchState>({ kind: 'idle' })
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [copyNote, setCopyNote] = useState<string | null>(null)

  // 连点两次搜索、或「回车后失焦」都会走 commit，只处理真正变了的情况
  const committedRef = useRef(q)

  // URL 变了（前进/后退、别人分享的链接）就把输入框跟上去
  useEffect(() => {
    setDraft(q)
    committedRef.current = q
  }, [q])

  useEffect(() => {
    if (q.trim() === '') {
      setState({ kind: 'idle' })
      return
    }
    let alive = true
    setState({ kind: 'loading' })
    setSelectedIndex(-1)
    setCopyNote(null)
    fetchSearch(q)
      .then((res) => {
        if (!alive) return
        setState({
          kind: 'ok',
          items: res.items,
          degraded: res.degraded,
          rewritten: res.rewritten,
        })
        // 默认选中第一条，键盘路径不用先按一次 ↓
        setSelectedIndex(res.items.length > 0 ? 0 : -1)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setState({ kind: 'error', error: toStateError(err) })
      })
    return () => {
      alive = false
    }
  }, [q])

  function commit(next: string) {
    const trimmed = next.trim()
    if (trimmed === committedRef.current) return
    committedRef.current = trimmed
    // 搜索词是可分享的状态，用 push 而不是 replace，后退能回到上一次搜索
    setSearchParams(trimmed ? { q: trimmed } : {}, { replace: false })
  }

  const items = state.kind === 'ok' ? state.items : []

  /**
   * 把焦点交给某条结果。**只在用户真的按了键时才调**——写成「跟着 selectedIndex 走的 effect」
   * 会变成抢焦点：items 每次 setState 都是新数组引用，effect 每次都重跑，
   * 于是收藏一次、复制一次就把焦点从输入框拽走，用户想改搜索词得先点回去。
   */
  function focusResult(index: number) {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus({ preventScroll: true })
    })
  }

  /** 收藏走乐观更新，失败回滚（与浏览页一致，state-navigation.md §8）。 */
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

  async function handleActivate(meme: SearchResult) {
    setCopyNote(null)
    try {
      // ⚠️ 临时路径：剪贴板分流尚未实现。动图永远不能走图片写入（SPEC §9.2），
      //    但静图的「fetch 原图 → 转 PNG Blob → ClipboardItem」也还没写，
      //    所以现在两种格式都只复制图片地址，按钮文案如实写「复制地址」。
      //    真正的实现落在 lib/clipboard.ts，见 agents/rules/clipboard-share.md。
      await navigator.clipboard.writeText(meme.url)
      setCopyNote(meme.isAnimated ? '已复制图片地址（动图需下载后发送）' : '已复制图片地址')
    } catch {
      setCopyNote('复制失败，浏览器拒绝了剪贴板写入，可以右键另存')
    }
  }

  /** ↑↓ 选择、Enter 复制、Esc 取消选择（clipboard-share.md §7）。 */
  function handleKeyDown(e: React.KeyboardEvent) {
    const inInput = e.target instanceof HTMLInputElement

    if (e.key === 'Escape') {
      // 在输入框里 Esc 先把光标交出去，再按一次才取消选择
      if (inInput) {
        e.currentTarget.querySelector('input')?.blur()
        return
      }
      setSelectedIndex(-1)
      return
    }

    if (inInput) {
      // 输入框自己要用 ↑↓ 移动光标，不抢；但 ↓ 是「从输入框进结果区」的自然动作。
      // 搜索完就按 ↓ 挑图，是这个工具最常见的连续动作，不给它留一条路就只能去摸鼠标。
      if (e.key === 'ArrowDown' && items.length > 0) {
        e.preventDefault()
        setSelectedIndex(0)
        focusResult(0)
      }
      return
    }

    if (e.key === 'Enter') {
      if (selectedIndex >= 0 && items[selectedIndex]) {
        e.preventDefault()
        void handleActivate(items[selectedIndex])
      }
      return
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (items.length === 0) return
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      // 未选中时 ↓ 从第一条开始、↑ 从最后一条开始
      const from = selectedIndex < 0 ? (dir === 1 ? -1 : items.length) : selectedIndex
      const next = Math.min(Math.max(from + dir, 0), items.length - 1)
      setSelectedIndex(next)
      focusResult(next)
      document.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }

  const trimmedDraft = draft.trim()

  return (
    <section className="search" onKeyDown={handleKeyDown}>
      <form
        className="search__bar"
        onSubmit={(e) => {
          e.preventDefault()
          commit(draft)
        }}
        role="search"
      >
        <input
          className="search__input"
          type="search"
          name="q"
          value={draft}
          placeholder="用一句话描述你要找的图"
          aria-label="搜索表情包"
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          // 失焦也提交一次：输入完直接去点结果是最常见的动作，不该要求先回车
          onBlur={() => commit(draft)}
        />
        <button className="search__submit" type="submit">
          搜索
        </button>
      </form>

      {state.kind === 'error' && (
        <div className="search__error" role="alert">
          <p>搜索失败：{state.error.message}</p>
          {/* requestId 必须露出来，报问题时它是唯一能对上服务端日志的东西 */}
          <p className="search__request-id">requestId: {state.error.requestId}</p>
          <button onClick={() => commit('')} className="search__retry">
            重试
          </button>
        </div>
      )}

      {state.kind === 'loading' && (
        <div className="search__grid" aria-busy="true">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="meme-card meme-card--skeleton" aria-hidden="true" />
          ))}
        </div>
      )}

      {state.kind === 'ok' && (
        <>
          {/* 降级不是错误：照常展示结果，只在顶部说明一句，不遮挡、不阻断（http.md §5） */}
          {state.degraded && (
            <p className="search__degraded" role="status">
              向量通路当前不可用，本次只用了 OCR 和标签匹配，结果可能不全。
            </p>
          )}

          {/* 展示改写结果是为了让用户理解「为什么搜出这些」，可以为 null（SPEC §6.3.1） */}
          {state.rewritten && (
            <p className="search__rewritten">搜索理解为：{state.rewritten}</p>
          )}

          {items.length === 0 ? (
            <p className="search__empty">没有找到相关的图，换个说法试试</p>
          ) : (
            <div className="search__grid" role="listbox" aria-label="搜索结果">
              {items.map((meme, index) => (
                // 服务端 RRF 已排好序，不要按 matchedBy 重排。见 SPEC §6.3.1
                <div
                  key={meme.id}
                  data-index={index}
                  role="option"
                  aria-selected={index === selectedIndex}
                  className="search__result"
                  tabIndex={-1}
                >
                  <MemeCard
                    meme={meme}
                    matchedBy={matchedBadges(meme.matchedBy)}
                    selected={index === selectedIndex}
                    onFavorite={handleFavorite}
                  />
                  {/* 点击卡片与 Enter 同一条路径，行为一致（clipboard-share.md §7） */}
                  <button
                    className="search__card-action"
                    onClick={() => void handleActivate(meme)}
                  >
                    复制地址
                  </button>
                </div>
              ))}
            </div>
          )}

          {copyNote && (
            <p className="search__copy-note" role="status">
              {copyNote}
            </p>
          )}
        </>
      )}

      {state.kind === 'idle' && (
        <p className="search__hint">
          {trimmedDraft ? '按回车搜索' : '输入一句话，用自然语言找图'}
        </p>
      )}
    </section>
  )
}

/** 不是 ApiError 的失败（断网、代理挂了）也要给出能读的状态，不能白屏（http.md §4）。 */
function toStateError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  return new ApiError(0, {
    code: 'NETWORK',
    message: '连不上服务端，确认 api 是否已启动',
    requestId: '无',
  })
}
