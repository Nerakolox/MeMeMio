/**
 * 「按 id 取一个人物 / 一个系列，并允许就地改写」——浏览页那两个筛选头部共用。
 *
 * 三件事必须一起做，拆开写在两个头部里就会各漏一样：
 *   1. **`id` 为 null 时不发请求**（没筛就是没筛，不是「查一个空 id」）；
 *   2. **`id` 变了先清空**再拉，否则换人物时头部会先显示上一个人的名字；
 *   3. **`NOT_FOUND` 不是错误，是空态**（§5.7.4：图全被软删的人物对客户端不存在）。
 *
 * 第 3 条是这里最容易写错的一处：按人物筛的浏览页在那种状态下本来就是空的。
 * 把它当错误渲染，用户看到的是一个红色的「加载失败」，而正确的呈现是「这里暂时没有图」。
 */

import { useCallback, useEffect, useState } from 'react'
import { ApiError, toStateError } from '../../lib/api'
import {
  fetchPerson,
  fetchPersonSuggestions,
  fetchSeriesById,
  type Person,
  type Series,
} from '../../lib/api-persons'

/** 取数的五种结局。`missing` 是**空态**，不是错误——见文件头第 3 条。 */
export type EntityState<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'missing' }
  | { kind: 'error'; error: ApiError }

/**
 * 一个实体外加它的两个写入口。**导出是给 `routes/browse.tsx` 用的**：那一层同时要
 * 这一份数据做两件事——顶部那个「人物」按钮要显示名字，结果列上方的头部要能改它。
 * 两处各拉一次的话会有两个真源，头部改完名之后按钮上还是旧名字（实测就是这一条
 * 促成的这次上提）。
 */
export type Entity<T> = {
  state: EntityState<T>
  /** 就地把服务端刚回的完整对象换上去（写操作的响应就是它，不用再拉一次，§6.7.4）。 */
  apply: (next: T) => void
  /** 重新拉一次。**只在「别人可能改过」时才用**（比如系列成员改完），写完就地 `apply` 更准。 */
  reload: () => void
}

function useEntity<T>(id: string | null, load: (id: string) => Promise<T>): Entity<T> {
  const [state, setState] = useState<EntityState<T>>(
    id === null ? { kind: 'idle' } : { kind: 'loading' },
  )
  /** 自增一次 = 重拉一次。用它而不是把 `load` 放进依赖，见下面的 eslint 注释。 */
  const [token, setToken] = useState(0)

  useEffect(() => {
    if (id === null) {
      setState({ kind: 'idle' })
      return
    }
    // 换了 id 先清空：不清的话头部会拿着上一个人的名字渲染一帧
    setState({ kind: 'loading' })
    let alive = true
    load(id)
      .then((value) => {
        if (alive) setState({ kind: 'ready', value })
      })
      .catch((err: unknown) => {
        if (!alive) return
        const apiErr = toStateError(err)
        // 404 是空态。这两个接口的 404 各自只有一种成因（§5.7.4 / §6.7.3）
        setState(
          apiErr.code === 'NOT_FOUND' ? { kind: 'missing' } : { kind: 'error', error: apiErr },
        )
      })
    return () => {
      alive = false
    }
    // `load` 是模块级函数、引用恒定；写进依赖数组只是形式，反而让人以为它可以随便换
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token])

  const apply = useCallback((next: T) => setState({ kind: 'ready', value: next }), [])
  const reload = useCallback(() => setToken((n) => n + 1), [])

  return { state, apply, reload }
}

/**
 * 一个人物。
 *
 * ⚠️ **写完用 `apply`，不要 `reload` 去「确认一下」**：写接口的响应就是更新后的完整
 * Person（§6.7.4），再拉一次是白跑一趟，而且中间那一帧会闪回旧值。
 */
export function usePerson(id: string | null): Entity<Person> {
  return useEntity(id, fetchPerson)
}

/** 一个系列。空系列照样返回，只有不存在才是 `missing`（§6.7.3）。 */
export function useSeries(id: string | null): Entity<Series> {
  return useEntity(id, fetchSeriesById)
}

/**
 * 「可能是同一个」（§6.7.3）。**只在按人物筛的时候拉。**
 *
 * ⚠️ **一次性取，不轮询**：建议从已存的向量算，不会自己变（§6.7.4）。
 *    「不是同一个」之后把那一格就地摘掉、**不重拉**——重拉会补上新的候选，
 *    看起来像那一下没生效。
 *
 * ⚠️ **拉失败不报错，按空列表处理。** 它只是「顺手可以合并」的提示，不是这一页的主体；
 *    为一个附加提示在头部挂一条红色横幅，代价比收益大。代价是「真的没有建议」和
 *    「这一下没取到」在界面上长得一样——这是有意的取舍。
 */
export function usePersonSuggestions(id: string | null) {
  const [items, setItems] = useState<Person[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (id === null) {
      setItems([])
      return
    }
    setItems([])
    setLoading(true)
    let alive = true
    fetchPersonSuggestions(id)
      .then((page) => {
        if (alive) setItems(page.items)
      })
      .catch(() => {
        if (alive) setItems([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [id])

  return {
    items,
    loading,
    /** 点过「不是同一个」之后就地摘掉那一格。 */
    drop: (otherId: string) => setItems((prev) => prev.filter((p) => p.id !== otherId)),
    /** 合并之后：来源没了，目标换成合并后的那一个。 */
    settle: (merged: Person, sourceIds: string[]) =>
      setItems((prev) =>
        prev.filter((p) => !sourceIds.includes(p.id)).map((p) => (p.id === merged.id ? merged : p)),
      ),
  }
}
