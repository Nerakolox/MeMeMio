/**
 * 浏览页的列表与分页。
 *
 * 取数的形状**照搬迁移前那份** `routes/browse.tsx`（`doLoad` + 两个 effect）：
 * 换筛选整表重置、IntersectionObserver 在 sentinel 进入视口时追加下一页。
 * 分页形态一个字没动——游标不进 URL、第二页是**追加**不是替换（SPEC §6.3.2）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type ApiError,
  type FetchMemesParams,
  type Meme,
  fetchMemes,
  toggleFavorite,
  toStateError,
} from '../../lib/api'
import { notifyFailure } from '../../lib/toast'

export function useBrowseList(params: FetchMemesParams) {
  const [items, setItems] = useState<Meme[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [initialDone, setInitialDone] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  /**
   * 瀑布流的「重挂代际」。删除会让 `items` 缩短，而 masonic 按 index 缓存位置，
   * items 缩短会错位甚至越界抛错，所以删除成功后 bump 一次、换 key 强制重挂，位置器从零重建。
   * 筛选切换走的是 `items → [] → 新 items`，中间那次空态已经把 `<Masonry>` 整个卸载了，
   * 不需要这里参与。
   */
  const [epoch, setEpoch] = useState(0)

  /**
   * 只认最后一次发出的请求。
   *
   * 换筛选、连点「重试」时前一个请求可能后到——不拦住就把上一组筛选的结果盖进这一组
   * （`DiscoverWall` 记过同一课）。这是本次顺手补的：迁移前那条路径没有这层保护。
   */
  const seq = useRef(0)

  /**
   * 游标的**同步**副本，观察器只认它、不认闭包里的 `nextCursor`。
   *
   * 这是实测抓到的一个真缺陷（迁移前那份也带着，只是这次才有断言量它）：滚到第二页之后
   * 换筛选，重置 effect 里的 `setNextCursor(null)` 要到**下一次渲染**才生效，而观察器
   * 的闭包还揣着上一次的 `nextCursor`。它重注册时若 sentinel 仍在视口里，就会拿**旧筛选的
   * 游标**配**新筛选的参数**发一页出去——游标是不透明的，服务端按旧筛选的那一支解释它，
   * 结果可能整页错配（实测表现为「清除后仍发出带 `cursor` 的请求」）。
   * 写成 ref 就能在重置的那一刻**同步**作废，赶在观察器重新注册之前。
   * `nextCursor` 仍留在下面那个 effect 的依赖里：游标换了要重注册，观察器才拿得到新值。
   */
  const cursorRef = useRef<string | null>(null)

  /**
   * 上一次失败的那一页的游标（第一页是 `undefined`）。**「重试」重拉的是这一页**，
   * 同时**挡住无限滚动的自动补拉**——两个作用都在这一个值上。
   *
   * 不记它的话重试只能从头来：`load()` 无游标 = 整表替换，于是「滚到第 5 页、第 6 页
   * 失败」点一下重试，前 5 页的结果和滚动位置一起没了，用户还得重新滚回来。
   */
  const failedCursorRef = useRef<string | undefined>(undefined)

  /**
   * 拉一页。`cursor` 有值就是追加，没有就是第一页（整表替换）。
   *
   * `useCallback` 的依赖是 `params`，而它是按 `filtersKey` memo 出来的（见 use-browse-filters），
   * 所以引用只在筛选真的变了之后才换——两个 effect 因此可以放心依赖它。
   */
  const load = useCallback(
    async (cursor?: string) => {
      const me = ++seq.current
      setLoading(true)
      setError(null)
      try {
        const page = await fetchMemes({ ...params, cursor })
        if (me !== seq.current) return
        setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
        cursorRef.current = page.nextCursor
        setNextCursor(page.nextCursor)
        failedCursorRef.current = undefined
        if (!cursor) setInitialDone(true)
      } catch (err) {
        if (me !== seq.current) return
        // 记住是**哪一页**没下来，重试要重拉的就是它（见 failedCursorRef）
        failedCursorRef.current = cursor
        // `toStateError` 而不是 `as ApiError`：断网 / 代理挂了时 fetch 抛的是 TypeError，
        // 强转的结果是页面上写「加载失败：undefined / requestId: undefined」（http.md §4）。
        setError(toStateError(err))
      } finally {
        if (me === seq.current) setLoading(false)
      }
    },
    [params],
  )

  // 换筛选：整表重置后重拉第一页（游标也清掉，不然第二页会拼到新筛选的结果后面）
  useEffect(() => {
    setItems([])
    setNextCursor(null)
    cursorRef.current = null // 同步作废，理由见 cursorRef 的注释
    failedCursorRef.current = undefined
    setInitialDone(false)
    void load()
  }, [load])

  // 无限滚动：sentinel 进入视口就拉下一页
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        // 游标读 **ref 不读闭包**：这个回调可能是上一次渲染留下的，而换筛选后 `nextCursor`
        // 的 state 更新还没落地——拿旧的发请求就是上面 cursorRef 那段说的错配。
        const cursor = cursorRef.current
        // `cursor !== null` 不只是优化：没有下一页时仍然发请求会拿到空的一页，
        // 而观察器会把「又可见了」当成新信号反复触发，滚到底就是一条请求长龙。
        //
        // ⚠️ **失败过的那一页不再自动补拉**（`cursor === failedCursorRef.current` 时跳过）。
        // 这一条是 2026-09-24 量出来的：那之前，页底 + 服务端一直出错会变成
        // **每秒几十次的请求长龙**——失败 → `loading` 转 false → 本 effect 因 `loading`
        // 变化重注册 → 观察器初始回调说「sentinel 还可见」→ 立刻再发一次，没有退避。
        // 实测 2 秒 120 次。而且它把出错提示推得看不见：用户每次抬眼都是一轮新的加载。
        // 现在失败就停在那儿，出路是界面上那个「重试」（它调 `load`，不经观察器）。
        if (entries[0]?.isIntersecting && !loading && cursor !== null) {
          if (cursor === failedCursorRef.current) return
          void load(cursor)
        }
      },
      // 0.1 要求 sentinel **有面积**：它是 `mt-6 h-px`，不是 0 高——零面积元素永远不触发
      { threshold: 0.1 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [loading, nextCursor, load])

  /**
   * 出错后重试：**重拉失败的那一页**，不是整表重来。
   *
   * 有游标时 `load` 是**追加**，所以已经翻过的页和滚动位置都还在；第一页失败时
   * 游标是 `undefined`，走的仍然是整表替换（那时也没有别的东西可保）。
   *
   * 失败之后**只有这条路**能再试那一页：观察器被 `failedCursorRef` 挡住了（见那里），
   * 所以「重试」不是锦上添花的按钮，是唯一的出路——界面上必须一直看得见它。
   */
  function retry() {
    void load(failedCursorRef.current)
  }

  /**
   * 收藏走乐观更新：立刻翻，失败回滚（state-navigation.md §8）。
   *
   * 失败**要弹一句**（2026-09-24 改，此前静默）。回滚之后图标自己翻回去，看起来与
   * 「这一下没点中」完全一样——用户会再点一次，而第二次同样失败。回滚是**界面说了谎**
   * 之后的补救，补救本身得被听见。成功不弹：心形填上了就是反馈（`feedback.md` 判据 1）。
   */
  async function applyFavorite(meme: Meme) {
    const next = !meme.favorited
    setItems((prev) => prev.map((m) => (m.id === meme.id ? { ...m, favorited: next } : m)))
    try {
      await toggleFavorite(meme.id, next)
    } catch {
      setItems((prev) => prev.map((m) => (m.id === meme.id ? { ...m, favorited: !next } : m)))
      notifyFailure('收藏失败，请重试')
    }
  }

  /**
   * 删除成功后把那条从列表里摘掉——**不是重拉**：已经翻过的页不该因为一条删除全部作废，
   * 用户的滚动位置也就还在。
   */
  function applyRemoval(id: string) {
    setItems((prev) => prev.filter((m) => m.id !== id))
    setEpoch((e) => e + 1)
  }

  /**
   * 编辑保存成功后**就地**换掉列表里那一条——响应就是新的完整 `Meme`，不再拉一次（SPEC §6.4.1）。
   * 不把响应拼进旧对象：服务端的返回是权威，本地只做替换。
   */
  function applyUpdate(updated: Meme) {
    setItems((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
  }

  return {
    items,
    loading,
    initialDone,
    error,
    epoch,
    sentinelRef,
    retry,
    applyFavorite,
    applyRemoval,
    applyUpdate,
  }
}

export type BrowseList = ReturnType<typeof useBrowseList>
