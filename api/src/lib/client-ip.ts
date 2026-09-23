/**
 * 从请求里取**真实客户端 IP**，供限流分桶用。纯函数、零 import。
 *
 * ## 为什么不能直接用 socket 地址
 *
 * 部署在 Caddy / nginx 后面（[docs/deployment.md §4](../../../docs/deployment.md) 的拓扑），
 * **每个请求的 socket 地址都是反代的**。按它分桶的话，全站所有用户共用一个计数器——
 * 一个人密码输错几次，所有人都被锁在门外。这不是「限流不准」，是把登录口关掉了。
 *
 * ## 只信任反代那一跳
 *
 * 反代（Caddy 的 `reverse_proxy`、nginx 的 `proxy_add_x_forwarded_for`）把**收到连接的
 * 地址追加在 `X-Forwarded-For` 末尾**。所以：
 *
 *   `X-Forwarded-For: 1.2.3.4, 5.6.7.8`
 *    └─ 客户端自己填的，可以是任何东西   └─ 反代亲手写的，客户端伪造不了
 *
 * 取**最后一项**，前面的项一项都不能信。`TRUSTED_PROXY_HOPS` 就是「我们前面有几层是
 * 自己的反代」，它必须和实际拓扑一致：
 *
 * - 前面多了（比如再挂一层 CDN）→ 最后一项变成 CDN 的地址，所有用户又回到一个桶里
 * - 前面少了（反代被绕过、直接暴露 app）→ 攻击者自己填 XFF 就能换桶绕开限流，
 *   那种部署应当改成 0（只用 socket 地址）
 *
 * 取不到合法地址时退回 socket，再取不到就用 `unknown`——**共用一个桶是故意的**：
 * 宁可把可疑请求挤在一起，也不能让一个伪造的头换到一个免费的新桶。
 */

/** 「我们前面有几层自己的反代」。见文件头，改它之前先确认拓扑。 */
export const TRUSTED_PROXY_HOPS = 1

/** 连 socket 地址都没有时的键（测试环境、以及拿不到 conninfo 的场景）。 */
export const UNKNOWN_CLIENT = 'unknown'

/** 最长的 IP 字面量是带 zone 的 IPv6，45 个字符足够；更长的只可能是垃圾。 */
const MAX_LITERAL_LEN = 45

/** `1.2.3.4`，允许尾随 `:port`。 */
const IPV4_WITH_PORT_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d{1,5})?$/

/** `[2001:db8::1]:443` 或 `[2001:db8::1]`。 */
const BRACKETED_IPV6_RE = /^\[([^\]]+)\](?::\d{1,5})?$/

export function pickClientIp(
  forwardedFor: string | null | undefined,
  socketAddress: string | null | undefined,
): string {
  const chain = (forwardedFor ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')

  // 反代那一跳的位置。链比 hops 短时说明这一跳不在（没有反代，或反代没写），
  // 那就只剩 socket 地址可用了——**不要**退而取链里其它项，那些都是客户端写的
  const fromProxy = chain[chain.length - TRUSTED_PROXY_HOPS]
  if (chain.length >= TRUSTED_PROXY_HOPS && fromProxy !== undefined) {
    const literal = parseIpLiteral(fromProxy)
    if (literal !== null) return literal
  }

  return (socketAddress === null || socketAddress === undefined
    ? null
    : parseIpLiteral(socketAddress)) ?? UNKNOWN_CLIENT
}

/**
 * 是 IP 字面量就返回归一化后的形式，否则 null。
 *
 * 归一化只做一件必要的事：**IPv6 转小写**。同一个地址写成 `::FFFF:1.2.3.4` 和
 * `::ffff:1.2.3.4` 是同一个人，分在两个桶里等于给他双倍的次数。
 */
function parseIpLiteral(raw: string): string | null {
  const text = raw.trim()
  if (text === '' || text.length > MAX_LITERAL_LEN) return null

  const bracketed = BRACKETED_IPV6_RE.exec(text)
  if (bracketed !== null) {
    const inner = bracketed[1] ?? ''
    return isIpv6(inner) ? inner.toLowerCase() : null
  }

  const v4 = IPV4_WITH_PORT_RE.exec(text)
  if (v4 !== null) {
    const octets = v4.slice(1, 5).map(Number)
    return octets.every((n) => n <= 255) ? octets.join('.') : null
  }

  return isIpv6(text) ? text.toLowerCase() : null
}

/**
 * 宽松的 IPv6 判定。**不做完整压缩形式校验**——这里要挡的是「明显不是地址的串」
 * （空串、带空格、带路径的 URL、注入尝试），不是替 `net.isIP()` 重写一遍。
 * 严格过头反而危险：误判成「非法」会退回 socket 地址，而那正是全站一个桶的故障。
 */
function isIpv6(text: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(text)) return false
  const colons = (text.match(/:/g) ?? []).length
  if (colons < 2 || text.includes(':::')) return false
  return (text.match(/::/g) ?? []).length <= 1
}
