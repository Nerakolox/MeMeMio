import { useCallback, useEffect, useRef, useState } from 'react'
import { type ApiError, type FetchMemesParams, type Meme, fetchMemes, toStateError } from './api'

/**
 * 首页那条路上的「取 N 张」：**一次请求、不带游标、不分页**。
 *
 * 三个消费者形状相同——图墙（`{random: true, limit: 10}`）、我的收藏
 * （`{favorited: true, limit: 8}`）、最近上传（`{limit: 8}`）——区别只在参数上。
 * 三份各自写一遍就是三份「三态 + 竞态守卫 + 重试」，而这类代码漂开之后不报错，
 * 只是其中一处偶尔把旧结果盖在新结果上（首页改版任务 §3 要求抽这一份）。
 *
 * ## 它不做什么
 *
 * **没有游标、没有 `nextCursor`、没有追加。** 翻页是 `/browse` 的事
 * （`features/browse/use-browse-list.ts`），首页每条只给 N 张，全部走「查看全部 →」。
 * 把它做成「带分页的通用取数」会让两个页面的翻页语义混在一起——那正是 2026-09-26
 * 合流要解决的那种混乱。
 *
 * **不进 URL、不读 URL。** 随机的一批图不是可分享的状态（[state-navigation.md §1]：
 * 只有「能放 URL 的」才放 URL），收藏与最近上传这条也是「首页给你看一眼」，
 * 筛选的真源在 `/browse`。
 *
 * ## 参数可以写成字面量
 *
 * 调用点写 `useMemeBatch({ random: true, limit: 10 })` 是安全的：**依赖的是参数的
 * 内容，不是对象引用**。每次渲染都新造一个对象字面量，引用必然不同，effect 若直接依赖它
 * 就会每次渲染都重新取数——首页会变成一台请求机器。所以这里自己把参数压成一个稳定的
 * key（见 `queryKey`），effect 依赖的是那个字符串。
 *
 * ## `reload` 同时是「换一批」和「重试」
 *
 * 两者要做的事逐字相同：丢掉手上这批、重新取、期间显示加载态。图墙那个按钮和错误态的
 * 「重试」因此共用一个函数，不再各自维护一个 `round` 计数器。
 */
export type BatchState =
  | { kind: 'loading' }
  | { kind: 'ok'; items: Meme[] }
  | { kind: 'error'; error: ApiError }

export function useMemeBatch(params: FetchMemesParams): {
  state: BatchState
  /** 重新取一批（换一批 / 重试）。见文件头。 */
  reload: () => void
  /**
   * 就地改这一批（收藏是乐观更新：先改本地、失败再回滚，state-navigation.md §8）。
   * 非 `ok` 态下是空操作——没有列表可改。
   */
  patchItems: (patch: (items: Meme[]) => Meme[]) => void
} {
  const [state, setState] = useState<BatchState>({ kind: 'loading' })
  const [round, setRound] = useState(0)

  /*
    最新一次渲染的参数。effect 依赖的是 `key`（内容），而 effect 体里需要的是**对象本身**
    ——把两者接起来的就是这个 ref：key 变了说明内容变了，此时 ref 里必然已经是新的那一份。
    渲染期写 ref 在这里是安全的：它不是状态、不参与绘制，只是给 effect 读的一个信箱。
  */
  const latest = useRef(params)
  latest.current = params
  const key = queryKey(params)

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    fetchMemes(latest.current)
      .then((page) => {
        if (alive) setState({ kind: 'ok', items: page.items })
      })
      .catch((err: unknown) => {
        if (alive) setState({ kind: 'error', error: toStateError(err) })
      })
    return () => {
      // 连点「换一批」时先发的请求可能后到——不拦住就把新的一批盖回旧的一批。
      // 参数变了（key 变）走的是同一条路：旧请求的 setState 必须作废。
      alive = false
    }
  }, [key, round])

  const reload = useCallback(() => setRound((n) => n + 1), [])

  const patchItems = useCallback((patch: (items: Meme[]) => Meme[]) => {
    setState((prev) => (prev.kind === 'ok' ? { ...prev, items: patch(prev.items) } : prev))
  }, [])

  return { state, reload, patchItems }
}

/**
 * 参数 → 稳定字符串。**只用于判断「变没变」，不用于发请求**（真请求还是拿原对象）。
 *
 * 排序是必须的：`{limit: 8, favorited: true}` 与 `{favorited: true, limit: 8}` 是同一个
 * 请求，不排序会让两个写法判成两次变更。数组值（词表维度）按原序 join——那是
 * **可重复键**，顺序不同在服务端是同一条查询，但首页这三个调用点都不传词表维度，
 * 不为一个还不存在的场景去做集合化。
 */
function queryKey(params: FetchMemesParams): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? [...v].sort().join(',') : String(v)}`)
    .join('&')
}
