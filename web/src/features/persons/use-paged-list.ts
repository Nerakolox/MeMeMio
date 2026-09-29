/**
 * 「取一页、滚到底再取一页」——人物 modal 里那两个 tab 共用的一份。
 *
 * ## 为什么不复用 `use-browse-list`
 *
 * 那一个是**检索**的列表，背着游标失效恢复、快照 TTL、`degraded` / `rewritten`
 * 三样东西，而人物与系列是**浏览面**：SPEC §6.7.3 明写不做快照，翻页途中图数变了
 * 导致重复或漏一格是已知且接受的。合用的代价是这边要背那边全部的复杂度，而那边
 * 每一个分支在这边都执行不到——正是「写了也跑不到」的假分支。
 *
 * 反过来也一样：那边不必知道 `minCount` / `hidden` 这种东西。
 *
 * ## 与 `use-browse-list` 一样要守住的两条
 *
 * 1. **收工只认 `nextCursor === null`**，不认「这一页不满」（§6.7.3：图数在翻页途中
 *    会变，中间少一格是正常的）。按「不满就是到底」收工会把结果截断。
 * 2. **失败过的那一页不再自动补拉**。不挡的话「失败 → loading 转 false → 观察器
 *    重注册 → 它说 sentinel 还可见 → 立刻再发」是没有退避的请求长龙
 *    （2026-09-24 在浏览页量到 2 秒 120 次）。出路是界面上那个「重试」。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toStateError, type ApiError } from '../../lib/api'

/** 一页的形状：`GET /persons` 与 `GET /series` 同形（§6.7.3）。 */
export type Page<T> = { items: T[]; nextCursor: string | null }

export function usePagedList<T>(load: (cursor?: string) => Promise<Page<T>>, restartKey: string) {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  /** 第一页回来过（成功或失败）。空态只在这之后渲染，否则第一帧就闪一下「什么都没有」。 */
  const [initialDone, setInitialDone] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  /** 还有没有下一页。为 `false` 时观察器不再发请求（见文件头第 2 条）。 */
  const [hasMore, setHasMore] = useState(false)

  const sentinelRef = useRef<HTMLDivElement>(null)

  /**
   * `load` 存进 ref、不进依赖：调用点多半写内联箭头（`(c) => fetchPersons({...p, cursor: c})`），
   * 那是每次渲染一个新函数，进依赖数组就等于**每次渲染都重拉第一页**。
   * 真正的重启信号是 `restartKey`（下面那个 effect）。
   */
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })

  /** 只认最后一次发出的请求。换过滤词时前一个请求可能后到，不拦住就把旧结果盖进来。 */
  const seq = useRef(0)

  /**
   * 游标的**同步**副本，观察器只认它。
   * 与 `use-browse-list` 同一个理由：`setHasMore(false)` 要到下一次渲染才生效，
   * 而观察器的闭包揣着上一个 `restartKey` 的游标，重注册时若 sentinel 仍在视口里，
   * 就会拿**旧条件的游标**配**新条件的参数**发一页出去。
   */
  const cursorRef = useRef<string | null>(null)

  /** 上一次失败的是哪一页（第一页是 `undefined`）。重试重拉的是它，自动补拉也被它挡住。 */
  const failedCursorRef = useRef<string | undefined>(undefined)

  const fetchPage = useCallback(async (cursor?: string) => {
    const me = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const page = await loadRef.current(cursor)
      if (me !== seq.current) return
      setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
      cursorRef.current = page.nextCursor
      setHasMore(page.nextCursor !== null)
      failedCursorRef.current = undefined
      if (!cursor) setInitialDone(true)
    } catch (err) {
      if (me !== seq.current) return
      // `toStateError` 而不是 `as ApiError`：断网时 fetch 抛的是 TypeError，
      // 强转的结果是界面上写「加载失败：undefined」（http.md §4）
      failedCursorRef.current = cursor
      setError(toStateError(err))
    } finally {
      if (me === seq.current) setLoading(false)
    }
  }, [])

  // 换查询条件：整表重置后重拉第一页。游标同步作废，理由见 `cursorRef`。
  useEffect(() => {
    setItems([])
    setInitialDone(false)
    setHasMore(false)
    cursorRef.current = null
    failedCursorRef.current = undefined
    void fetchPage()
  }, [restartKey, fetchPage])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        const cursor = cursorRef.current
        if (entries[0]?.isIntersecting && !loading && cursor !== null) {
          if (cursor === failedCursorRef.current) return
          void fetchPage(cursor)
        }
      },
      // 0.1 要求 sentinel **有面积**（是 `h-px` 不是 0 高），零面积元素永远不触发
      { threshold: 0.1 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [loading, hasMore, fetchPage])

  /** 重拉失败的那一页。**列表为空时它不是「再来一次」而是唯一的出路**（观察器被挡着）。 */
  function retry() {
    void fetchPage(failedCursorRef.current)
  }

  /**
   * 就地换掉一条（改名、改系列、合并之后的那个目标）。响应是新的完整对象，
   * 不再拉一次（§6.7.4）。
   *
   * 合并之后来源人物会消失，那件事由调用点自己 `removeItem`，**不在这里猜**：
   * 这个 hook 不知道「哪些 id 没了」。
   */
  function replaceItem(id: string, next: T & { id: string }) {
    setItems((prev) => prev.map((item) => ((item as { id: string }).id === id ? next : item)))
  }

  /** 把一条从列表里摘掉（合并的来源、被删的系列）。**不重拉**：翻过的页不该因此作废。 */
  function removeItem(id: string) {
    setItems((prev) => prev.filter((item) => (item as { id: string }).id !== id))
  }

  return {
    items,
    loading,
    initialDone,
    error,
    hasMore,
    sentinelRef,
    retry,
    replaceItem,
    removeItem,
    /** 外部改完之后强制重拉第一页（比如新建系列成功后）。 */
    reload: () => {
      cursorRef.current = null
      setHasMore(false)
      failedCursorRef.current = undefined
      void fetchPage()
    },
  }
}
