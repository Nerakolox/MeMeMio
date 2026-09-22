/**
 * 浏览页的筛选条件。**URL 是唯一真源**（state-navigation.md §1：用户会把一次筛选的链接
 * 发给别人，放 state 里就分享不了、刷新也丢）。
 *
 * 这一层只做两件事：URL → 接口参数的翻译，以及四类写操作。列表本身在 `use-browse-list`，
 * 它拿这里的 `params` 去取数——两个 hook 之间只有这一个接口。
 */

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { FetchMemesParams } from '../../lib/api'
import { VOCAB_FIELDS, type VocabField } from '../../lib/vocab'

/** 把当前 query 解析成接口参数。游标在外部传入，**不放 URL**（SPEC §6.3.2，分页游标不是筛选条件）。 */
function buildParams(sp: URLSearchParams): FetchMemesParams {
  const p: FetchMemesParams = {}
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
 * 生效中的筛选项**个数**（窄屏工具条那个角标用它）。
 *
 * 数的是「用户勾了几个条件」而不是「URL 里有几个参数」：同样三个 chip，
 * 按参数数永远是 3（emotions 是一个重复键），按勾选数是用户心里那个数。
 */
function countActive(sp: URLSearchParams): number {
  let n = 0
  for (const field of VOCAB_FIELDS) n += sp.getAll(field).length
  for (const key of ['isAnimated', 'favorited', 'uploader', 'tagStatus']) {
    if (sp.get(key) !== null) n += 1
  }
  return n
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
   * `filtersKey` 是**字符串**、`params` 由它 memo 出来，所以两者都是「筛选没变就不换引用」的，
   * 可以直接当 effect 依赖。
   *
   * 不能拿 `searchParams` 对象或每次现算的 `params` 当依赖：那两个每次渲染都是新引用，
   * 取数 effect 会每次渲染都重跑（并且互相触发成环）。
   */
  const filtersKey = searchParams.toString()
  const params = useMemo(() => buildParams(new URLSearchParams(filtersKey)), [filtersKey])

  /*
   * 四类写操作**全部带 `{ replace: true }`**：筛选是「把当前这一屏看得更细」，不是一次导航。
   * 进历史的话，手机用户连点几个 chip 之后按返回键会一层层退回「全库」，而他想的其实是回上一页。
   * URL 里仍然有筛选（§1 要的是这个），只是不占历史。
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

  function clear() {
    setSearchParams(new URLSearchParams(), { replace: true })
  }

  return {
    params,
    /** 筛选条件的规范化字符串。取数 effect 认它，不认对象引用。 */
    filtersKey,
    hasFilters: filtersKey !== '',
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
