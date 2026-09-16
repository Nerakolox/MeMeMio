import { describe, expect, it } from 'vitest'
import { matchVocabTerms } from './vocab-match.js'
import { vocabulary } from '../vocab.js'

/**
 * 标签路的切词。**不硬编码任何具体词条**：词表当前是 `proposed`（`shared/vocab/vocab.json`），
 * 写死一个「无语」就会在词表修订时变成债。所以用例从词表里现取真实词条。
 *
 * 取词时避开单字词条和别名键——前者当前会被 `MIN_TERM_LENGTH` 丢掉（见最后两条用例），
 * 后者会被归一化成别的词条，两者都会让一条本来在测「切词」的用例其实在测别的东西。
 */
function pick(predicate: (term: string) => boolean): string {
  const aliases = vocabulary.aliases ?? {}
  const all = [
    ...vocabulary.emotions,
    ...vocabulary.scenes,
    ...vocabulary.tags.subject,
    ...vocabulary.tags.style,
  ]
  const found = all.find((term) => term.length >= 2 && !(term in aliases) && predicate(term))
  if (found === undefined) throw new Error('词表里找不到符合要求的词条，用例需要更新')
  return found
}

const emotion = pick(() => true)
const scene = pick((t) => t !== emotion)
const longTerm = vocabulary.tags.style.find((t) => t.length > 2) ?? '翻白眼'

describe('matchVocabTerms', () => {
  it('命中词表里的词条', () => {
    expect(matchVocabTerms(emotion)).toEqual([emotion])
  })

  it('切分空白与常见中文标点', () => {
    const separators = [' ', ',', '，', '、', ';', '；', '/', '|', '+']
    for (const separator of separators) {
      expect(matchVocabTerms(`${emotion}${separator}${scene}`)).toEqual([emotion, scene])
    }
  })

  it('不在词表里的词直接丢掉，不猜', () => {
    // 查不到就是没命中，交给另外两路 —— 猜错的代价是召回一堆无关的图
    expect(matchVocabTerms('今天真的不想上班')).toEqual([])
  })

  it('整串里嵌着词条不算命中 —— 只按分隔符切，不做子串匹配', () => {
    // 「开心今天真的不想上班」是一个 token，不在词表里。
    // 如果哪天真要做模糊匹配，那是词表的事，不是这里偷偷加一条 includes
    expect(matchVocabTerms(`${emotion}今天真的不想上班`)).toEqual([])
  })

  it('别名归一到正式词条', () => {
    const entry = Object.entries(vocabulary.aliases ?? {})[0]
    if (entry === undefined) return
    const [alias, canonical] = entry

    // 用户搜「服了」，模型产出的是「无语」，两边必须落到同一个标签上
    expect(matchVocabTerms(alias)).toEqual([canonical])
  })

  it('去重但保持用户输入顺序', () => {
    expect(matchVocabTerms(`${emotion} ${scene} ${emotion}`)).toEqual([emotion, scene])
    expect(matchVocabTerms(`${scene} ${emotion}`)).toEqual([scene, emotion])
  })

  it('重复词条不会让标签路变成 AND 自己', () => {
    // 不去重的话 tagPathCandidates 会给同一个条件 AND 两遍
    expect(matchVocabTerms(`${emotion} ${emotion}`)).toHaveLength(1)
    expect(matchVocabTerms(`${emotion}、${emotion}、${emotion}`)).toHaveLength(1)
  })

  it('多字词条正常命中', () => {
    expect(matchVocabTerms(longTerm)).toEqual([longTerm])
  })

  it('空查询和纯分隔符返回空数组', () => {
    expect(matchVocabTerms('')).toEqual([])
    expect(matchVocabTerms('   ')).toEqual([])
    expect(matchVocabTerms('，、 ')).toEqual([])
  })

  it('⚠️ 单字词条当前匹配不到 —— 这是 MIN_TERM_LENGTH = 2 的下场', () => {
    // 词表里有「猫」「狗」「熊」「猪」这样的单字词条，但切词会先把它们丢掉，
    // 因为单字查询在全库乱命中。结果是：搜「猫」时标签路不召回，只能靠 trgm 和向量。
    // 这条用例不是「期望如此」，是把现状钉住——改了 MIN_TERM_LENGTH 或词表里
    // 出现了单字词条时要看见它。
    const singleChar = [
      ...vocabulary.tags.subject,
      ...vocabulary.emotions,
      ...vocabulary.scenes,
    ].filter((t) => t.length === 1)
    if (singleChar.length === 0) return

    const term = singleChar[0]
    expect(matchVocabTerms(term ?? '')).toEqual([])
  })
})
