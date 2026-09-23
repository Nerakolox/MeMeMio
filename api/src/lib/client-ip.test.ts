import { describe, expect, it } from 'vitest'
import { TRUSTED_PROXY_HOPS, UNKNOWN_CLIENT, pickClientIp } from './client-ip.js'

/**
 * 这组用例盯的是「反代后面全站共用一个桶」那个故障——它不报错，只是所有人一起被锁死。
 * 判据全部落在「取到的是不是那个特定的人」上，不是「取到了东西」。
 */
describe('pickClientIp', () => {
  it('反代写的那一跳是最后一个，取它', () => {
    expect(pickClientIp('203.0.113.7', '172.18.0.5')).toBe('203.0.113.7')
  })

  it('客户端自己填的 XFF 不算数——它填几项都改变不了结果', () => {
    // 客户端发 `X-Forwarded-For: 1.1.1.1`，反代把真实地址追加在后面。
    // 取最后一项才是真实客户端；取第一项就等于让攻击者随便换桶
    expect(pickClientIp('1.1.1.1, 203.0.113.7', '172.18.0.5')).toBe('203.0.113.7')
    expect(pickClientIp('1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7', '172.18.0.5')).toBe('203.0.113.7')
  })

  it('两个人取到两个不同的桶，反代地址一个都不出现', () => {
    // 「全站共用一个计数器」的直接反证：同一个 socket 地址（反代），两个客户端
    const a = pickClientIp('203.0.113.7', '172.18.0.5')
    const b = pickClientIp('198.51.100.9', '172.18.0.5')
    expect(a).not.toBe(b)
    expect(a).not.toBe('172.18.0.5')
  })

  it('没有 XFF 时退回 socket 地址（前面没有反代的那种部署）', () => {
    expect(pickClientIp(null, '203.0.113.7')).toBe('203.0.113.7')
    expect(pickClientIp(undefined, '203.0.113.7')).toBe('203.0.113.7')
    expect(pickClientIp('', '203.0.113.7')).toBe('203.0.113.7')
  })

  it('两样都没有时是 unknown——共用一个桶，不是「放行」', () => {
    expect(pickClientIp(null, null)).toBe(UNKNOWN_CLIENT)
    // 空串和空白不算地址，不能变成空字符串当键
    expect(pickClientIp('  ', '   ')).toBe(UNKNOWN_CLIENT)
  })

  it('最后一项是垃圾时**绝不退而取前面的项**，退回 socket', () => {
    // 前面那些是客户端写的。这里宁可共用 socket 桶，也不给它一个自己挑的键
    expect(pickClientIp('1.1.1.1, 不是地址', '172.18.0.5')).toBe('172.18.0.5')
    expect(pickClientIp('1.1.1.1, http://evil.example/x', '172.18.0.5')).toBe('172.18.0.5')
  })

  it('IPv4 带端口和超范围八位组', () => {
    expect(pickClientIp('203.0.113.7:51234', null)).toBe('203.0.113.7')
    expect(pickClientIp('999.0.113.7', '172.18.0.5')).toBe('172.18.0.5')
  })

  it('IPv6 归一化成小写——大小写不同不是两个人', () => {
    expect(pickClientIp('2001:DB8::1', null)).toBe('2001:db8::1')
    expect(pickClientIp('::1', null)).toBe('::1')
    expect(pickClientIp('[2001:db8::1]:443', null)).toBe('2001:db8::1')
  })

  it('长成路径或注入尝试的串被挡掉', () => {
    for (const bad of ['a'.repeat(46), '/api/v1/memes', '1.2.3.4;drop table users', 'localhost']) {
      expect(pickClientIp(bad, '172.18.0.5')).toBe('172.18.0.5')
    }
  })

  it('信任跳数就是文件头那个常数——它是这个函数唯一的前提', () => {
    expect(TRUSTED_PROXY_HOPS).toBe(1)
  })
})
