import { describe, expect, it } from 'vitest'
import { DUP_REASON_MAX_CHARS, parseDupJudgement } from './dup-verdict.js'

describe('parseDupJudgement', () => {
  it('三个合法结论', () => {
    for (const verdict of ['same', 'different', 'unsure'] as const) {
      expect(parseDupJudgement(JSON.stringify({ verdict, reason: '理由' }))).toEqual({
        verdict,
        reason: '理由',
      })
    }
  })

  it('大小写与首尾空白不影响，reason 缺席按空串', () => {
    expect(parseDupJudgement('{"verdict":" SAME "}')).toEqual({ verdict: 'same', reason: '' })
  })

  it('围栏与前后缀都能抠出 JSON', () => {
    expect(parseDupJudgement('```json\n{"verdict":"different","reason":"字不同"}\n```')).toEqual({
      verdict: 'different',
      reason: '字不同',
    })
    expect(parseDupJudgement('结论：{"verdict":"unsure","reason":"x"} 以上。')?.verdict).toBe('unsure')
  })

  it('reason 折叠空白并限长', () => {
    const parsed = parseDupJudgement(
      JSON.stringify({ verdict: 'same', reason: `a\n\n b ${'x'.repeat(DUP_REASON_MAX_CHARS * 2)}` }),
    )
    expect(parsed?.reason.startsWith('a b ')).toBe(true)
    expect(parsed?.reason.length).toBe(DUP_REASON_MAX_CHARS)
  })

  it('任何不合规的输出都是 null，包括「像 same 的话」', () => {
    const bad = [
      '',
      '看起来一样',
      '{}',
      '{"verdict":"identical"}',
      '{"verdict":"基本相同"}',
      '{"verdict":true}',
      '{"verdict":["same"]}',
      '{"verdict":"same"',
      '{"verdict": same}',
    ]
    for (const content of bad) expect(parseDupJudgement(content)).toBeNull()
  })

  it('reason 不是字符串时忽略而不是判无效', () => {
    expect(parseDupJudgement('{"verdict":"different","reason":123}')).toEqual({
      verdict: 'different',
      reason: '',
    })
  })
})
