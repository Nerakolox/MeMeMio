/**
 * 列表与分页。**检索与筛选是同一条列表，所以只有一个 hook**（SPEC §6.3，裁定 1）。
 *
 * 取数的形状**照搬迁移前那份** `routes/browse.tsx`（`doLoad` + 两个 effect）：
 * 换筛选整表重置、IntersectionObserver 在 sentinel 进入视口时追加下一页。
 * 分页形态一个字没动——游标不进 URL、第二页是**追加**不是替换（SPEC §6.3.2）。
 *
 * ## 2026-09-26（合流）：它同时吃 `q`
 *
 * `q` 在 `use-browse-filters` 里就和七个词表维度拼进了同一个 `params`，所以**这里一行都不用
 * 按「搜还是筛」分支**：两个分支服务端回的是同一个形状（§6.3「响应形状恒定」），
 * 差异只在 `degraded` / `rewritten` / `matchedBy` 的取值上，而那三个照收照传。
 * 游标也一样——它有两种含义，但**含义由服务端按请求里有没有 `q` 决定**，
 * 客户端只负责原样回传（http.md §8：不解析游标的内容）。
 *
 * ⚠️ **首页那条路不走这里**，而且它今天**一个列表都不取**：首页是入口页，搜索框只负责
 * 把人送到 `/browse?q=`（SPEC §9.30，2026-09-26 改版）。它自己那两块内容——
 * 随机图墙和两条 rail——都是「取 N 张、不分页」，走 `lib/use-meme-batch.ts`。
 * 本文件是**唯一那条会翻页的列表**。
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

  /**
   * 本次结果的检索元信息（SPEC §6.3.1）。**无 `q` 时是常量**（`false` / `null`），
   * 不是「没有这个字段」——响应形状恒定，所以这里不需要按有没有 `q` 分支（§6.3）。
   *
   * 它们属于**这一批结果**，不属于某一页：换筛选或换搜索词时随第一页一起重置
   * （下面那个重置 effect），翻页时服务端回的同一次快照，值一样。
   */
  const [degraded, setDegraded] = useState(false)
  const [rewritten, setRewritten] = useState<string | null>(null)

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
   * 「刚为游标失效恢复过一次，之后还没有一次成功的翻页」。**只为了在第二次连坏时停下来。**
   *
   * 恢复那一支会把 `failedCursorRef` 清空（那一页已经不要了，它不该再挡自动补拉）——
   * 于是新一页的游标一到手，观察器又会立刻发出下一页的请求。正常情况下这是对的：
   * 恢复后拿到的是**新快照的新游标**，本来就该继续翻。
   *
   * 但**如果服务端对游标是稳定地拒绝**（游标形态对不上、快照 TTL 配错），
   * 「回第一页 → 又拿同一个坏游标 → 再失败」会变成**没有退避的请求长龙**，
   * 每转一圈还弹一次「已回到第一页」——和 2026-09-24 量出来的那条（页底 2 秒 120 次）
   * 是同一个形状：出错的循环比报错本身更糟，用户每次抬眼都是一轮新的加载。
   *
   * 所以**只自动恢复一次**：连续第二次坏就当成普通失败停下来，`error` 交给界面上的
   * 「重试」——那也正好是那条路唯一的出路（观察器被 `failedCursorRef` 挡住了）。
   * 用户点「重试」即重开一次机会（见 `retry`），翻页真成功过一次也清零（见 `load`）。
   */
  const recoveredRef = useRef(false)

  /**
   * 拉一页。`cursor` 有值就是追加，没有就是第一页（整表替换）。
   *
   * ⚠️ **收工只认 `nextCursor`，不认「这一页不满」。** 一页的名单是照快照取的，
   * 而行是取名单时现查的、照样带 `deleted_at is null`（SPEC §3.4）——**这一页里若有条目
   * 在首发之后被删掉，它少给一条而不补**，页就不是满的。按「不满 40 条 = 到底了」收工会
   * 把正常结果截断，而且筛得越窄越容易撞上（§6.3.1）。所以这里唯一的停法就是
   * `page.nextCursor === null`（见下面观察器那段）。
   *
   * `useCallback` 的依赖是 `params`，而它是按 `filtersKey` memo 出来的（见 use-browse-filters），
   * 所以引用只在查询条件真的变了之后才换——两个 effect 因此可以放心依赖它。
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
        setDegraded(page.degraded)
        setRewritten(page.rewritten)
        failedCursorRef.current = undefined
        // 带游标的那一页下来了 = 游标是好的，恢复的这次可以了（见 recoveredRef）
        if (cursor) recoveredRef.current = false
        if (!cursor) setInitialDone(true)
      } catch (err) {
        if (me !== seq.current) return
        // `toStateError` 而不是 `as ApiError`：断网 / 代理挂了时 fetch 抛的是 TypeError，
        // 强转的结果是页面上写「加载失败：undefined / requestId: undefined」（http.md §4）。
        const apiErr = toStateError(err)

        /*
         * 游标坏了 → **丢弃游标、回第一页、说一句**（SPEC §6.3.1 / §2.2，
         * state-navigation.md §6「游标失效」）。
         *
         * 三种成因（解析失败、快照过期、把检索游标接到无 `q` 的请求上）服务端都回
         * `VALIDATION_FAILED`、`details` 里没有额外信息，客户端要做的也是同一件事，
         * **所以这里不区分文案**。判据带上 `cursor !== undefined`：只有**追加那一页**失败
         * 才走这条路——第一页的 `VALIDATION_FAILED` 是别的原因（参数非法），
         * 那时回第一页等于原地打转。
         *
         * 为什么必须自己兜住：服务端**不再静默返回第一页**（老约定已取消）。不兜的话，
         * 无限滚动里的表现是「把第一页又追加一遍」，用户看到的是重复的图而不是一个错误。
         */
        if (cursor !== undefined && apiErr.code === 'VALIDATION_FAILED') {
          /*
            刚恢复过一次又坏 → **停下来**，不再自动回第一页。理由与量级见 `recoveredRef`：
            这一支会清掉 `failedCursorRef`，等于把自动补拉重新武装，稳定被拒的游标
            于是转成没有退避的请求长龙。停下来的样子与其它失败一致：`error` 一亮，
            页底的「重试」就是出路。
          */
          if (recoveredRef.current) {
            failedCursorRef.current = cursor
            setError(apiErr)
            return
          }
          recoveredRef.current = true
          failedCursorRef.current = undefined
          cursorRef.current = null
          setNextCursor(null)
          // ⚠️ 回第一页会把 `items` **缩短**（120 条 → 40 条），而 masonic 按 index 缓存
          // 位置，缩短会错位甚至越界抛错——和删除之后要为同一件事 bump 一次（见 epoch）。
          // 筛选那条路不需要：它走的是 `items → [] → 新 items`，中间那次空态已经把墙卸了。
          setEpoch((e) => e + 1)
          setError(null)
          notifyFailure('翻页已失效，已回到第一页', apiErr.requestId)
          void load()
          return
        }

        // 其余失败：记住是**哪一页**没下来，重试要重拉的就是它（见 failedCursorRef）
        failedCursorRef.current = cursor
        setError(apiErr)
      } finally {
        if (me === seq.current) setLoading(false)
      }
    },
    [params],
  )

  // 换筛选或换搜索词：整表重置后重拉第一页（游标也清掉，不然第二页会拼到新条件的结果后面）
  useEffect(() => {
    setItems([])
    setNextCursor(null)
    cursorRef.current = null // 同步作废，理由见 cursorRef 的注释
    failedCursorRef.current = undefined
    recoveredRef.current = false // 换了查询条件，那一次连坏不算在这个条件头上
    setInitialDone(false)
    setDegraded(false)
    setRewritten(null)
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
        // ⚠️ **`cursor` 就是「还有没有下一页」的全部答案**（SPEC §6.3.1）：它由服务端给，
        // 不要换成「上一页回来不满 40 条就算到底」——一条被软删的条目会让正常的页不满。
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
    // 用户点名要试，恢复那一次机会重开（见 recoveredRef）——不然连坏两次之后就再也
    // 恢复不了了，只能刷新页面
    recoveredRef.current = false
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
    /** 本次结果里向量通路是否覆盖不全（SPEC §6.3.1）。无 `q` 时恒为 false。 */
    degraded,
    /** 本次检索的 HyDE 改写结果，无则 null（SPEC §6.3.1）。无 `q` 时恒为 null。 */
    rewritten,
    epoch,
    sentinelRef,
    retry,
    applyFavorite,
    applyRemoval,
    applyUpdate,
  }
}

export type BrowseList = ReturnType<typeof useBrowseList>
