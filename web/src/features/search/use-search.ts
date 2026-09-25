import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useImageViewerOpen } from '../../components/ImageViewer'
import {
  ApiError,
  fetchSearch,
  toStateError,
  toggleFavorite,
  type Meme,
  type SearchResult,
} from '../../lib/api'
import { notifyFailure } from '../../lib/toast'

export type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ok'
      items: SearchResult[]
      degraded: boolean
      rewritten: string | null
    }
  | { kind: 'error'; error: ApiError }

/**
 * 按下键的那一下，焦点是不是**就在某一张结果上**。
 *
 * 只看元素自己有没有 `data-index`，**不看它的祖先**：`closest()` 会把卡片里那些按钮
 * （收藏、图片帧）一起算成「在结果上」，那就又回到「Enter 被谁接走」那个缺陷了。
 */
function focusedOptionIndex(target: EventTarget | null): number | null {
  if (!(target instanceof HTMLElement)) return null
  const raw = target.dataset['index']
  if (raw === undefined) return null
  const index = Number(raw)
  return Number.isInteger(index) ? index : null
}

/**
 * 首页搜索的状态机。**2026-09-21 从 `routes/home.tsx` 原样搬来**——那一版把 state 机、键盘路径
 * 和版式全塞在一个 326 行的文件里（`code-style.md` 的上限是 150），而 `project-structure.md`
 * 的目录表里本来就写着 `features/search/`。搬家只动了位置，逻辑一行没改，**除了「重试」**
 * （见 `retry`）。
 *
 * 搜索词放 URL 不放本地 state——用户会把一次搜索的链接发给别人（「你搜这个，第三张」），
 * 放 state 里就分享不了、刷新也丢（state-navigation.md §1）。
 */
export function useSearch() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''

  /**
   * 打开全屏阅览用的那一份 `open`。**列表必须自己传**——这一层在 `<MemeGallery>` **之外**，
   * 走 `useImageViewer()` 读到的是空 context，`open(meme, [])` 会静默退回单张阅览
   * （翻页按钮与缩略图轨道全没有，且不报错）。见 `useImageViewerOpen` 的注释。
   */
  const openViewer = useImageViewerOpen()

  // 输入框里未提交的值——这是纯 UI state 的三类之一（state-navigation.md §3）
  const [draft, setDraft] = useState(q)
  const [state, setState] = useState<SearchState>({ kind: 'idle' })
  const [selectedIndex, setSelectedIndex] = useState(-1)

  /**
   * 同一个搜索词的重跑计数，只有「重试」会动它。
   *
   * 加它是因为**旧实现的「重试」什么都不重试**：那句 `commit('')` 把搜索词置空，
   * 于是 URL 一变就回到 `idle`，用户看到的是图墙——搜索失败的提示连着一句
   * 「重试」，点下去却把他的话删了。现在 q 不变、只换这个计数，effect 照常重跑。
   */
  const [attempt, setAttempt] = useState(0)

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
  }, [q, attempt])

  function commit(next: string) {
    const trimmed = next.trim()
    if (trimmed === committedRef.current) return
    committedRef.current = trimmed
    // 搜索词是可分享的状态，用 push 而不是 replace，后退能回到上一次搜索
    setSearchParams(trimmed ? { q: trimmed } : {}, { replace: false })
  }

  /** 原样重跑当前搜索词。**不动 `q`**，所以不会把用户的话清掉，也不会多一条历史记录。 */
  function retry() {
    setAttempt((n) => n + 1)
  }

  const items = state.kind === 'ok' ? state.items : []

  /**
   * 把焦点交给某条结果。**只在用户真的按了键时才调**——写成「跟着 selectedIndex 走的 effect」
   * 会变成抢焦点：items 每次 setState 都是新数组引用，effect 每次都重跑，
   * 于是收藏一次、复制一次就把焦点从输入框拽走，用户想改搜索词得先点回去。
   *
   * ⚠️ **`root` 不是可有可无的，选择器必须从结果区那棵子树里找。** 挂着 `data-index`
   * 的不止结果项：**sonner 的 toast `<li>` 也带 `data-index`**（它是第几条提示），而且
   * 它 `tabIndex: 0`、真的能接焦点；`<Toaster />` 又挂在 `Routes` **之前**（`App.tsx`）。
   * 于是只要有提示在屏幕上，`document.querySelector('[data-index="0"]')` 先撞上的是
   * **那条提示**——「按 ↓ 从输入框进结果区」把焦点交给了一条 toast，键盘用户看到的是
   * 自己哪一格都选不中。这一条不报错，只是按键没反应，是 `verify-toast-feedback.mjs`
   * 里 Esc 那条断言（先弹过 toast 的 1264 档红、没弹过的 390 档绿）才暴露出来的。
   *
   * `root` 传的是 `handleKeyDown` 的 `e.currentTarget`（整页那个 `<section>`），必须在
   * 同步阶段取出来——React 的合成事件在 handler 返回后会把 `currentTarget` 置空，
   * 进了 `requestAnimationFrame` 再读就是 `null`。
   */
  function focusResult(root: HTMLElement | null, index: number) {
    requestAnimationFrame(() => {
      root?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus({ preventScroll: true })
    })
  }

  /**
   * 收藏走乐观更新，失败回滚（与浏览页一致，state-navigation.md §8）。
   *
   * 回滚**必须说一句**：心形自己翻回去看起来像「点了没生效」，用户会再点一次。
   * 成功不提示——心形填上了就是反馈（`feedback.md` 判据 1）。
   */
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
      notifyFailure('收藏失败，请重试')
    }
  }

  /**
   * 打开全屏阅览。**2026-09-26（裁定 4）起 `Enter` 不再是「发送这一张」。**
   *
   * 发送改由**可见的**入口发起：卡片上是「⋯」菜单里那一项（合并后统一走
   * `MemeActions`），全屏阅览里是那枚新加的按钮。撤掉卡片上原来那枚全宽按钮的同时
   * 把 `Enter` 指过来，是因为**它指向的行为必须在界面上看得见**——一个界面上不存在、
   * 只有按下去才知道发生了什么的键，比没有这个键更坏（clipboard-share.md §3）。
   *
   * ⚠️ 与旧实现同一条：这里曾经复制的是图片地址（临时实现），而用户按下它时的意图是
   * **发图**，拿到的却是一段 URL。同一个动作两套行为是本端最不能犯的错。
   */
  function handleActivate(meme: SearchResult) {
    openViewer(meme, items)
  }

  /** ↑↓ 选择、Enter 打开全屏阅览、Esc 取消选择（clipboard-share.md §7）。 */
  function handleKeyDown(e: React.KeyboardEvent) {
    const inInput = e.target instanceof HTMLInputElement
    /** 结果区那棵子树。`e.currentTarget` 出了 handler 就没了，所以在这儿先取下来。 */
    const root = e.currentTarget as HTMLElement

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
        focusResult(root, 0)
      }
      return
    }

    if (e.key === 'Enter') {
      // ⚠️ **只在焦点真正落在某张结果上时才算「打开这一张」**，判据是那个元素本身
      // 带着 `data-index`（`SearchResults` 的 `ResultItem`），不是「谁没挡冒泡」。
      //
      // 这个 handler 挂在整页的 `<section>` 上，而卡片里的图片帧、收藏按钮
      // 都在冒泡链上。靠下游 `stopPropagation` 是挡不完的：收藏按钮就没挡，于是
      // 「Tab 到第 5 张、按 Enter 收藏」会被这里接走，`selectedIndex` 默认是 0，
      // 变成打开第 1 张——**键盘用户根本收藏不了**，而且屏幕上什么提示都没有。
      //
      // 焦点在图片帧上时不归这里管：那是个真 `<button>`，原生 Enter 会直接点它，
      // 落到 `MemeImage` → `useImageViewer()`，效果与这里一致（那条路的列表来自
      // `<MemeGallery>`）。**两条路都开阅览，所以不会打架**。
      const index = focusedOptionIndex(e.target)
      const meme = index === null ? undefined : items[index]
      if (meme) handleActivate(meme)
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
      focusResult(root, next)
      // 同一个理由：`document` 那一版会滚到 toast 上去（它是 `position: fixed`，看不出来）
      root.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }

  return {
    draft,
    setDraft,
    state,
    selectedIndex,
    /** 有输入但还没提交（没回车、也没失焦）时提示一句，见 `routes/home.tsx`。 */
    trimmedDraft: draft.trim(),
    commit,
    retry,
    handleKeyDown,
    handleFavorite,
  }
}
