import { describe, expect, it } from 'vitest'
import { isMaskedApiKey, maskApiKey } from './redact.js'

describe('maskApiKey', () => {
  it('只留后四位', () => {
    expect(maskApiKey('sk-abcdefghijklmnop1234')).toBe('****1234')
  })

  it('没配置时是 null，不是空串', () => {
    expect(maskApiKey(null)).toBeNull()
    expect(maskApiKey(undefined)).toBeNull()
    expect(maskApiKey('   ')).toBeNull()
  })

  it('短 key 整条打码，不退化成明文', () => {
    expect(maskApiKey('ab')).toBe('****')
    expect(maskApiKey('abcd')).toBe('****')
    expect(maskApiKey('abcd')).not.toContain('abcd')
  })

  it('输出里不含原 key 的前缀', () => {
    const key = 'sk-proj-THIS-MUST-NOT-LEAK-9876'
    const masked = maskApiKey(key)
    expect(masked).not.toBeNull()
    expect(masked).not.toContain('THIS-MUST-NOT-LEAK')
    expect(masked).not.toContain('sk-')
  })
})

describe('isMaskedApiKey', () => {
  it('认得出自己产出的串', () => {
    expect(isMaskedApiKey(maskApiKey('sk-abcdefgh1234') ?? '')).toBe(true)
  })

  it('真 key 不会被误判成脱敏串', () => {
    expect(isMaskedApiKey('sk-abcdefgh1234')).toBe(false)
  })
})
