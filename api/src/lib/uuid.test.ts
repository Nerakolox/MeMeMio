import { describe, expect, it } from 'vitest'
import { isUuid } from './uuid.js'

describe('isUuid', () => {
  it('认标准 uuid，大小写都算', () => {
    expect(isUuid('0193f0a2-7c1e-7b3d-9a44-1f2e3d4c5b6a')).toBe(true)
    expect(isUuid('0193F0A2-7C1E-7B3D-9A44-1F2E3D4C5B6A')).toBe(true)
  })

  it('挡掉会变成 Postgres 22P02 的串', () => {
    // 这条是它的全部理由：这些值进到 `where id = ...` 里，报的是 500 而不是 404
    for (const bad of ['abc', '123', '1', '-1', 'null', 'undefined', '', '再次', '1; drop table users']) {
      expect(isUuid(bad)).toBe(false)
    }
  })

  it('挡掉形状接近但不是 uuid 的串', () => {
    // 少一段、多一段、段长不对、分隔符不对、带花括号
    expect(isUuid('0193f0a2-7c1e-7b3d-9a44')).toBe(false)
    expect(isUuid('0193f0a2-7c1e-7b3d-9a44-1f2e3d4c5b6a-extra')).toBe(false)
    expect(isUuid('0193f0a-7c1e-7b3d-9a44-1f2e3d4c5b6a')).toBe(false)
    expect(isUuid('0193f0a2_7c1e_7b3d_9a44_1f2e3d4c5b6a')).toBe(false)
    expect(isUuid('{0193f0a2-7c1e-7b3d-9a44-1f2e3d4c5b6a}')).toBe(false)
  })

  it('挡掉非十六进制字符', () => {
    expect(isUuid('0193f0a2-7c1e-7b3d-9a44-1f2e3d4c5b6g')).toBe(false)
  })
})
