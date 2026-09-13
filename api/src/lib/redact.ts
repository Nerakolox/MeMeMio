/**
 * API Key 脱敏。
 *
 * 纯函数、零 import。三条硬边界之一（AGENTS.md §5）：
 * **任何接口都不返回完整 API Key**，对外一律 "****" + 后四位。
 *
 * 放在 lib/ 是为了让序列化层强制调用它，而不是靠每个 handler 记得。
 * 客户端把这个字符串原样回传时视为「不修改」，见 SPEC §3.5 / §5.3。
 */

const MASK = '****'
const VISIBLE_TAIL = 4

/**
 * @returns key 为空时返回 null（表示「没有配置」，和「配了但不给看」是两件事）
 */
export function maskApiKey(key: string | null | undefined): string | null {
  if (key === null || key === undefined) return null
  const trimmed = key.trim()
  if (trimmed === '') return null
  // 短到没有可隐藏的部分时整条打码，不要退化成明文
  if (trimmed.length <= VISIBLE_TAIL) return MASK
  return MASK + trimmed.slice(-VISIBLE_TAIL)
}

/** 客户端回传脱敏串 = 不修改。判断放在这里，避免每个配置接口各写一遍。 */
export function isMaskedApiKey(value: string): boolean {
  return value.startsWith(MASK)
}
