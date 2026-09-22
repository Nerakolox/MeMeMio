import { describe, expect, it } from 'vitest'
import { matchVocabTerms } from './vocab-match.js'
import { vocabulary } from '../vocab.js'

/**
 * 标签路的切词。**不硬编码任何具体词条**：词表当前是 `proposed`（`shared/vocab/vocab.json`），
 * 写死一个「无语」就会在词表修订时变成债。所以用例从词表里现取真实词条。
 *
 * 取词时避开别名键——它会被归一化成别的词条，让一条本来在测「切词」的用例其实在测别名。
 * 也避开带结构助词的词条（`得意`、`得逞`），它们有自己那条用例。
 */
function pick(predicate: (term: string) => boolean): string {
  const aliases = vocabulary.aliases ?? {}
  const found = allTerms().find(
    (term) => term.length >= 2 && !(term in aliases) && !/[的地得]/.test(term) && predicate(term),
  )
  if (found === undefined) throw new Error('词表里找不到符合要求的词条，用例需要更新')
  return found
}

function allTerms(): string[] {
  return [
    ...vocabulary.expressions,
    ...vocabulary.emotions,
    ...vocabulary.tones,
    ...vocabulary.purposes,
    ...vocabulary.scenes,
    ...vocabulary.tags.subject,
    ...vocabulary.tags.style,
    // ratings 也要在池子里，否则它永远不进 `pick()` 的样本——
    // 加维度时漏掉这一行的表现是那一维在检索里**没有任何用例覆盖**，而套件全绿
    ...vocabulary.ratings,
  ]
}

const first = pick(() => true)
const second = pick((t) => t !== first)
const longTerm = vocabulary.tags.style.find((t) => t.length > 2) ?? '表情包模板'

/** `{ include, exclude }` 里只关心 include 的用例用它，省掉一半样板。 */
function included(query: string): string[] {
  return matchVocabTerms(query).include
}

describe('matchVocabTerms', () => {
  it('命中词表里的词条', () => {
    expect(matchVocabTerms(first)).toEqual({ include: [first], exclude: [] })
  })

  it('切分空白与常见中文标点', () => {
    const separators = [' ', ',', '，', '、', ';', '；', '/', '|', '+']
    for (const separator of separators) {
      expect(included(`${first}${separator}${second}`)).toEqual([first, second])
    }
  })

  it('不在词表里的词直接丢掉，不猜', () => {
    // 查不到就是没命中，交给另外两路 —— 猜错的代价是召回一堆无关的图
    expect(matchVocabTerms('今天真的不想上班')).toEqual({ include: [], exclude: [] })
  })

  it('整串里嵌着词条不算命中 —— 只按分隔符切，不做子串匹配', () => {
    // 「微笑今天真不想上班」是一个 token，不在词表里，也不含结构助词。
    // 如果哪天真要做模糊匹配，那是词表的事，不是这里偷偷加一条 includes
    expect(included(`${first}今天真不想上班`)).toEqual([])
  })

  it('别名归一到正式词条', () => {
    const entry = Object.entries(vocabulary.aliases ?? {})[0]
    if (entry === undefined) return
    const [alias, canonical] = entry

    // 用户搜「服了」，模型产出的是「无语」，两边必须落到同一个标签上
    expect(included(alias)).toEqual([canonical])
  })

  it('去重但保持用户输入顺序', () => {
    expect(included(`${first} ${second} ${first}`)).toEqual([first, second])
    expect(included(`${second} ${first}`)).toEqual([second, first])
  })

  it('重复词条只保留一个', () => {
    expect(included(`${first} ${first}`)).toHaveLength(1)
    expect(included(`${first}、${first}、${first}`)).toHaveLength(1)
  })

  it('多字词条正常命中', () => {
    expect(included(longTerm)).toEqual([longTerm])
  })

  it('空查询和纯分隔符返回空', () => {
    for (const query of ['', '   ', '，、 ']) {
      expect(matchVocabTerms(query)).toEqual({ include: [], exclude: [] })
    }
  })

  // ── 单字词条 ─────────────────────────────────────────────────────

  it('单字词条能命中 —— MIN_TERM_LENGTH 已经删掉了', () => {
    // 曾经有一条 `MIN_TERM_LENGTH = 2`，理由是「单字查询在全库乱命中」。
    // 代价是搜「猫」时标签路一条都不召回，而「猫」正是词表里的正式词条，
    // 也是最高频的查询之一。现在按词表判断：在词表里就算数，不看长度。
    const singleChar = allTerms().filter((t) => t.length === 1)
    if (singleChar.length === 0) return

    for (const term of singleChar) {
      expect(included(term)).toEqual([term])
    }
  })

  // ── 结构助词兜底 ─────────────────────────────────────────────────

  it('助词切分：「A的B」拆成两个词条', () => {
    expect(included(`${first}的${second}`)).toEqual([first, second])
  })

  it('⚠️ 助词切分是兜底，整串先查一次词表', () => {
    // `得意`、`得逞` 自己带着「得」。把助词当一级分隔符会把它们切成两个查不到的碎片，
    // 而表现只是「搜得意搜不到」，不报错。所以顺序不能反：先整串，再助词。
    const withParticle = allTerms().find((t) => /[的地得]/.test(t))
    if (withParticle === undefined) return

    expect(included(withParticle)).toEqual([withParticle])
  })

  it('助词切出来的碎片查不到就丢掉，不猜', () => {
    expect(included(`随便什么的${first}`)).toEqual([first])
  })

  // ── 排除 ─────────────────────────────────────────────────────────

  it('贴着词的明确排除算数：「排除X」「去掉X」「除了X」', () => {
    for (const negator of ['排除', '去掉', '去除', '不含', '不带', '除了', '非']) {
      expect(matchVocabTerms(`${first} ${negator}${second}`)).toEqual({
        include: [first],
        exclude: [second],
      })
    }
  })

  it('一元减号前缀：「猫 -真人」', () => {
    expect(matchVocabTerms(`${first} -${second}`)).toEqual({
      include: [first],
      exclude: [second],
    })
  })

  it('「不要」独立成词时算排除', () => {
    expect(matchVocabTerms(`${first} 不要 ${second}`)).toEqual({
      include: [first],
      exclude: [second],
    })
  })

  it('⚠️ 「不要」贴着词时不算排除 —— 宁可漏一个排除，也不能删掉用户想搜的东西', () => {
    // 「不想上班」是心情，不是「排除上班」。SPEC §9.10 拿的就是这句当例子。
    // 代价记清楚：「不要真人」这种写法这里一个词都不出，向量路和文本路照常跑。
    expect(matchVocabTerms(`不要${second}`)).toEqual({ include: [], exclude: [] })
  })

  it('否定只作用于紧接着的下一个词，不会一路传染', () => {
    expect(matchVocabTerms(`不要 ${first} ${second}`)).toEqual({
      include: [second],
      exclude: [first],
    })
  })

  it('同一个词既被要又被排除时，排除赢', () => {
    // 用户写死的条件优先于顺带提到的词
    expect(matchVocabTerms(`${first} 排除${first}`)).toEqual({ include: [], exclude: [first] })
  })

  it('排除的词也走别名归一化', () => {
    const entry = Object.entries(vocabulary.aliases ?? {})[0]
    if (entry === undefined) return
    const [alias, canonical] = entry

    // 否则「排除服了」会过滤不掉标着「无语」的图，而且不报错
    expect(matchVocabTerms(`排除${alias}`)).toEqual({ include: [], exclude: [canonical] })
  })
})
