/**
 * 浏览页的查询条件：**筛选条件 + 查询词**。**URL 是唯一真源**
 * （state-navigation.md §1：用户会把一次筛选或一次检索的链接发给别人，放 state 里就分享不了、刷新也丢）。
 *
 * 这一层只做两件事：URL → 接口参数的翻译，以及五类写操作。列表本身在 `use-browse-list`，
 * 它拿这里的 `params` 去取数——两个 hook 之间只有这一个接口。
 *
 * ## 2026-09-26（裁定 1 合流）：`q` 进了这一层
 *
 * 合流之后**检索与筛选是同一个列表**（[state-navigation.md §6](../../agents/rules/state-navigation.md)），
 * 所以 `q` 和七个词表维度落在同一串参数上、由同一个 `params` 送出去——`use-browse-list`
 * 因此不需要知道「这一次是搜还是筛」，它只认服务端回的形状（那个形状对两种请求都一样）。
 *
 * ⚠️ **`q` 有两条和筛选不同的规矩**，都在下面的写操作里：
 *   - 提交搜索词用 `push`、改筛选用 `replace`（§1 那张表）；
 *   - `q` **不算「筛选项」**：它不进 `activeCount`（那个角标数的是筛选条件），也不该
 *     让「清除」按钮冒出来——清除清的是筛选，不是用户打的字。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { FetchMemesParams } from '../../lib/api'
import { VOCAB_FIELDS, type VocabField } from '../../lib/vocab'

/** 查询词在 URL 里的键名。与接口参数同名，不做第二套映射（state-navigation.md §1）。 */
const QUERY_KEY = 'q'

/** 把当前 query 解析成接口参数。游标在外部传入，**不放 URL**（SPEC §6.3.2，分页游标不是筛选条件）。 */
function buildParams(sp: URLSearchParams): FetchMemesParams {
  const p: FetchMemesParams = {}
  // 空白查询词不传（服务端两种都当浏览处理，SPEC §6.3.1）：`?q=` 与 `?q=%20` 都是
  // 「没在搜」，让它进参数只会多一个什么都不影响的取值
  const q = (sp.get(QUERY_KEY) ?? '').trim()
  if (q) p.q = q
  // 七个维度遍历 `VOCAB_FIELDS`，不逐维手写（SPEC §4.3）。漏掉一维不会报错：
  // URL 里明明有那个参数、角标也数进去了，取数时却不带上——用户看到的是
  // 「我明明筛了表情，结果里还有别的」，而控制台一片干净。
  for (const field of VOCAB_FIELDS) {
    const values = sp.getAll(field)
    if (values.length) p[field] = values
  }
  const ia = sp.get('isAnimated')
  // 三态，不是布尔：键不在 = 不过滤，`=true` / `=false` 才是用户选过。
  // 写成 `sp.get(...) === 'true'` 会把「没选」和「选了 false」混成一件事。
  if (ia !== null) p.isAnimated = ia === 'true'
  // favorited 只有 true 一种写法（没有「只看未收藏」这个筛选），所以这里直接判 true。
  if (sp.get('favorited') === 'true') p.favorited = true
  const upl = sp.get('uploader')
  if (upl) p.uploader = upl
  const ts = sp.get('tagStatus')
  if (ts) p.tagStatus = ts
  return p
}

/**
 * 不是词表维度的那些筛选键（两个开关 + 两个下拉）。
 *
 * **与 `VOCAB_FIELDS` 合成一份「筛选键」的清单**，`countActive` 与 `clear` 都认它——
 * 两处各写一份就会漂，而漂的表现是「角标数 3、清完还剩 1 个」。
 */
const SINGLE_KEYS = ['isAnimated', 'favorited', 'uploader', 'tagStatus'] as const

/**
 * 生效中的筛选项**个数**（窄屏工具条那个角标用它）。
 *
 * 数的是「用户勾了几个条件」而不是「URL 里有几个参数」：同样三个 chip，
 * 按参数数永远是 3（emotions 是一个重复键），按勾选数是用户心里那个数。
 *
 * ⚠️ **`q` 不在这里**：这个角标标的是筛选抽屉，查询词不藏在抽屉里——
 * 它就在结果列顶上的输入框里，谁都看得见。
 */
function countActive(sp: URLSearchParams): number {
  let n = 0
  for (const field of VOCAB_FIELDS) n += sp.getAll(field).length
  for (const key of SINGLE_KEYS) {
    if (sp.get(key) !== null) n += 1
  }
  return n
}

/**
 * 只看**筛选条件**那一份 query string（`q` 摘掉）。**只给 `hasFilters` 用。**
 *
 * 只搜了词、还没筛任何东西时，清除按钮不该出现——它清的本来就是筛选，
 * 出现了点下去什么都不会变。
 *
 * ⚠️ **不要拿它当 `clear()` 的底**。它摘掉的正是 `clear()` 要留的那个键；
 * 2026-09-26 的浏览器验收就是这么抓到的：「清除」点下去 `q` 没了、筛选还在，
 * 与按名字理解的语义正好相反（见 `clear`）。
 */
function filtersOnly(sp: URLSearchParams): string {
  const next = new URLSearchParams(sp)
  next.delete(QUERY_KEY)
  return next.toString()
}

/** 七个维度当前选中的值，键一个不少——`VocabSections` 要的就是这个形状。 */
function readLabels(sp: URLSearchParams): Record<VocabField, string[]> {
  const out = {} as Record<VocabField, string[]>
  for (const field of VOCAB_FIELDS) out[field] = sp.getAll(field)
  return out
}

export function useBrowseFilters() {
  const [searchParams, setSearchParams] = useSearchParams()

  /*
   * `filtersKey` 是**字符串**、`params` 由它 memo 出来，所以两者都是「查询条件没变就不换引用」的，
   * 可以直接当 effect 依赖。
   *
   * 不能拿 `searchParams` 对象或每次现算的 `params` 当依赖：那两个每次渲染都是新引用，
   * 取数 effect 会每次渲染都重跑（并且互相触发成环）。
   *
   * ⚠️ **`filtersKey` 含 `q`**（它是「取数参数」那一份），而 `hasFilters` 用的是摘掉
   * `q` 的 `filtersOnly`——两个不是一个东西，别顺手换。换错的表现是「只搜了个词，
   * 清除按钮就冒出来了」。
   */
  const filtersKey = searchParams.toString()
  const params = useMemo(() => buildParams(new URLSearchParams(filtersKey)), [filtersKey])
  const query = (searchParams.get(QUERY_KEY) ?? '').trim()

  /**
   * 输入框里未提交的值——**纯 UI state**（state-navigation.md §3 的第一类）。
   *
   * 它不进 URL，因为「用户正在打、还没按回车」不是可分享的状态；已提交的 `query`
   * 才进 URL。这与首页那个搜索框是同一套写法（那边更彻底：草稿是它唯一的 state，
   * 提交之后就变成这一页的 `q` 了，SPEC §9.30）。
   */
  const [draft, setDraft] = useState(query)

  /**
   * 上一次**已提交**的词。挡「连点两次搜索」「回车后失焦又提交一次」——
   * 没有它，每次提交都会 `push` 一条一模一样的历史记录。
   */
  const committedRef = useRef(query)

  // URL 变了（前进 / 后退、别人分享的链接）就把输入框跟上去
  useEffect(() => {
    setDraft(query)
    committedRef.current = query
  }, [query])

  /*
   * 四类**筛选**写操作**全部带 `{ replace: true }`**：筛选是「把当前这一屏看得更细」，
   * 不是一次导航。进历史的话，手机用户连点几个 chip 之后按返回键会一层层退回「全库」，
   * 而他想的其实是回上一页。URL 里仍然有筛选（§1 要的是这个），只是不占历史。
   *
   * 它们都用 `new URLSearchParams(searchParams)` 起手，所以 **`q` 自动跟着走**——
   * 筛着筛着不会把查询词丢掉。
   */

  /** 整组改写一个重复键（词表 chip 用）。`values` 为空就是删掉这个键。 */
  function setMulti(key: VocabField, values: string[]) {
    const next = new URLSearchParams(searchParams)
    next.delete(key)
    values.forEach((v) => next.append(key, v))
    setSearchParams(next, { replace: true })
  }

  /** 只写 `true` / 删键。不写 `=false`：那与「没选」在 URL 里长得一样但含义不同，徒增两种写法。 */
  function toggleBool(key: string) {
    const next = new URLSearchParams(searchParams)
    if (next.get(key) === 'true') next.delete(key)
    else next.set(key, 'true')
    setSearchParams(next, { replace: true })
  }

  /** 单值参数（两个下拉）。传 null / 空串即删键，与接口的「不传 = 全部」对齐。 */
  function setString(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    setSearchParams(next, { replace: true })
  }

  /**
   * 提交搜索词。**`push` 而不是 `replace`**（§1 那张表）：一次检索是可分享的状态，
   * 后退要能回到上一次检索的结果，而不是回到「上一次我勾的筛选」。
   *
   * 只动 `q` 这一个键，筛选项原样带着——「在筛好的范围里再搜一下」是最常见的连续动作。
   * 词为空就是**删键**（回到浏览），不是留一个 `q=`：两者服务端都当浏览处理（SPEC §6.3.1），
   * 但留个空键会让「这次到底搜了没有」在 URL 上看不出来。
   */
  function commitQuery() {
    const trimmed = draft.trim()
    if (trimmed === committedRef.current) return
    committedRef.current = trimmed
    const next = new URLSearchParams(searchParams)
    if (trimmed) next.set(QUERY_KEY, trimmed)
    else next.delete(QUERY_KEY)
    setSearchParams(next, { replace: false })
  }

  /**
   * 清空**筛选**。⚠️ **`q` 留着**：这个按钮长在筛选面板的标题行上、名字就叫「清除」，
   * 它清的是筛选条件。把用户的搜索词一起删掉是另一件事，得由那个输入框自己做
   * （清空输入框再提交就走 `commitQuery` 的删键那一支）。
   */
  function clear() {
    const next = new URLSearchParams(searchParams)
    for (const field of VOCAB_FIELDS) next.delete(field)
    for (const key of SINGLE_KEYS) next.delete(key)
    setSearchParams(next, { replace: true })
  }

  return {
    params,
    /** 取数参数的规范化字符串（**含 `q`**）。取数 effect 认它，不认对象引用。 */
    filtersKey,
    /** 已提交的查询词，空串 = 没在搜 */
    query,
    draft,
    setDraft,
    commitQuery,
    hasFilters: filtersOnly(searchParams) !== '',
    activeCount: countActive(searchParams),
    /**
     * 七个维度当前选中的值，**一个对象而不是逐维字段**。
     * 摊开成一个个返回值的话，加一维就要同时改这里和每个调用点，而漏掉不报错。
     */
    labels: readLabels(searchParams),
    isAnimated: searchParams.get('isAnimated') === 'true',
    favorited: searchParams.get('favorited') === 'true',
    uploader: searchParams.get('uploader'),
    tagStatus: searchParams.get('tagStatus'),
    setMulti,
    toggleBool,
    setString,
    clear,
  }
}

export type BrowseFiltersState = ReturnType<typeof useBrowseFilters>
