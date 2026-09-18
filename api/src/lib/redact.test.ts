import { describe, expect, it } from 'vitest'
import { isMaskedApiKey, maskApiKey, redactSecret } from './redact.js'

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

describe('redactSecret', () => {
  const KEY = 'sk-proj-THIS-MUST-NOT-LEAK-9876'

  it('中转服务回显了 Authorization 头时，key 被换成脱敏串', () => {
    // error-handling.md §4 说的就是这种错误体
    const body = `{"error":{"message":"Invalid Authorization header: Bearer ${KEY}","code":401}}`
    const safe = redactSecret(body, KEY)
    expect(safe).not.toContain(KEY)
    expect(safe).not.toContain('THIS-MUST-NOT-LEAK')
    expect(safe).toContain('Bearer ****9876')
  })

  it('出现多次就全部抹掉', () => {
    const body = `${KEY} ... ${KEY} ... ${KEY}`
    const safe = redactSecret(body, KEY)
    expect(safe).not.toContain('THIS-MUST-NOT-LEAK')
    expect(safe.split('****9876')).toHaveLength(4)
  })

  it('没出现 key 时一个字节都不动——原文不截断、不包装（settings-ux.md §5）', () => {
    const body = '{"error":{"message":"model not found","type":"invalid_request_error"}}'
    expect(redactSecret(body, KEY)).toBe(body)
  })

  it('空 key 不触发 split("") 的病态行为', () => {
    expect(redactSecret('abc', '')).toBe('abc')
  })
})
