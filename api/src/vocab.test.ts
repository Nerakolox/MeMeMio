import { describe, expect, it } from 'vitest'
import { isKnownLabel, isKnownTerm, termsOf, vocabulary, VOCAB_FIELDS } from './vocab.js'

/**
 * 词表**自身**的体检，不测任何调用方。
 *
 * SPEC §4.3.2 点名说「这两条由 `api/src/vocab.test.ts` 守住」，说的就是下面的
 * 「一个词只能属于一个维度」和「别名键不能和词条重名」。它们一旦破了，表现都不是报错：
 *
 *   - 一个词同时在两个维度里 → 打标时模型填哪一维都通过校验，筛选 UI 里它出现两次，
 *     检索的标签路会对同一张图的同一个信号计两次分；
 *   - 别名键同时也是正式词条 → `canonicalize` 把它映射走，于是**模型正确输出的词被改掉**，
 *     而日志里看不出任何异常。
 *
 * 所以这份用例不依赖任何具体词条，只依赖结构，词表改成什么样都该继续成立。
 */

describe('词表结构', () => {
  it('六个维度都非空', () => {
    for (const field of VOCAB_FIELDS) {
      expect(termsOf(field).length, field).toBeGreaterThan(0)
    }
  })

  it('一个词只能属于一个维度', () => {
    const owner = new Map<string, string>()
    const collisions: string[] = []

    for (const field of VOCAB_FIELDS) {
      for (const term of termsOf(field)) {
        const previous = owner.get(term)
        if (previous !== undefined) collisions.push(`${term}（${previous} / ${field}）`)
        else owner.set(term, field)
      }
    }

    expect(collisions).toEqual([])
  })

  it('同一个维度内不重复', () => {
    for (const field of VOCAB_FIELDS) {
      const terms = termsOf(field)
      expect(new Set(terms).size, field).toBe(terms.length)
    }
  })

  it('tags 的 subject 和 style 不重叠', () => {
    const subject = new Set(vocabulary.tags.subject)
    expect(vocabulary.tags.style.filter((t) => subject.has(t))).toEqual([])
  })
})

describe('别名', () => {
  const aliases = vocabulary.aliases ?? {}

  it('别名的键不能同时是正式词条', () => {
    // 否则归一化会把一个本来就正确的词映射到别处，而且不报错
    expect(Object.keys(aliases).filter((key) => isKnownTerm(key))).toEqual([])
  })

  it('别名的目标必须是某个维度里真实存在的词条', () => {
    const dangling = Object.entries(aliases)
      .filter(([, canonical]) => !isKnownTerm(canonical))
      .map(([alias, canonical]) => `${alias} → ${canonical}`)

    expect(dangling).toEqual([])
  })

  it('不允许别名链：A → B 时 B 不能再是别名的键', () => {
    // 归一化只做单跳（shared/vocab/README.md）。链式配置的表现是「归一化只走了一半」
    const chained = Object.entries(aliases)
      .filter(([, canonical]) => canonical in aliases)
      .map(([alias, canonical]) => `${alias} → ${canonical} → ${aliases[canonical] ?? ''}`)

    expect(chained).toEqual([])
  })

  it('别名不能指向自己', () => {
    expect(Object.entries(aliases).filter(([alias, canonical]) => alias === canonical)).toEqual([])
  })
})

describe('词条规则（SPEC §4.3.2）', () => {
  it('不超过 6 字', () => {
    const tooLong: string[] = []
    for (const field of VOCAB_FIELDS) {
      for (const term of termsOf(field)) {
        if (term.length > 6) tooLong.push(`${field}.${term}`)
      }
    }
    expect(tooLong).toEqual([])
  })

  it('单字词条只在 tags.subject 里允许', () => {
    const allowed = new Set(vocabulary.tags.subject)
    const offenders: string[] = []

    for (const field of VOCAB_FIELDS) {
      for (const term of termsOf(field)) {
        if (term.length === 1 && !allowed.has(term)) offenders.push(`${field}.${term}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('中文，不混英文', () => {
    // 别名是**用户和模型实际会写的东西**，`ddl`、`emo` 这类允许出现在键上；
    // 正式词条不行——双通道的词汇对齐要求决定了这一条没有例外。
    const latin: string[] = []
    for (const field of VOCAB_FIELDS) {
      for (const term of termsOf(field)) {
        if (/[A-Za-z]/.test(term)) latin.push(`${field}.${term}`)
      }
    }
    expect(latin).toEqual([])
  })
})

describe('校验函数', () => {
  it('isKnownLabel 按维度校验，不是按全表', () => {
    // 这正是拆维度要挡住的错误：`微笑` 是 expressions，填进 emotions 就是越界
    const expression = vocabulary.expressions[0]
    if (expression === undefined) return

    expect(isKnownLabel('expressions', expression)).toBe(true)
    expect(isKnownLabel('emotions', expression)).toBe(false)
  })

  it('isKnownTerm 任一维度命中即可 —— 检索侧不知道用户说的是哪一维', () => {
    for (const field of VOCAB_FIELDS) {
      const term = termsOf(field)[0]
      if (term !== undefined) expect(isKnownTerm(term), `${field}.${term}`).toBe(true)
    }
  })

  it('词表外的值两个函数都拒绝', () => {
    expect(isKnownTerm('这不是一个词条')).toBe(false)
    for (const field of VOCAB_FIELDS) {
      expect(isKnownLabel(field, '这不是一个词条')).toBe(false)
    }
  })
})
