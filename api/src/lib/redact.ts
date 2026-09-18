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

/**
 * 从一段**要原样返回给用户**的外部文本里抹掉 key。
 *
 * 这是 SPEC §6.5.1 的「`rawResponse` / `rawError` 原样带回」和 AGENTS.md §5 的
 * 「API Key 不出响应」正面相撞的唯一一处，两条都不能让步，所以解法必须是精确的：
 *
 * - 原始返回里一般**没有** key。但 error-handling.md §4 明写：**某些中转服务会在
 *   错误体里回显 Authorization 头**。那正好是测试连接最常触发的路径——填错 key、
 *   拿 401，而 401 的错误体恰恰最可能把 key 抄回来。
 * - 调用那一刻 key 就在手上，所以这里不用猜、不用正则找「看起来像 key 的串」，
 *   直接拿明文做字面替换。**能不能漏**这件事因此是确定的：只要外部文本里出现了
 *   这把 key，它就一定被换掉；没出现就一个字节都不动。
 *
 * 替换成脱敏串而不是删掉，是为了让用户看得出「这里本来是你的 key」——
 * 那本身就是「中转服务把你的 key 回显了」这条重要信息。
 *
 * ⚠️ 只抹 key，**不做任何别的过滤**。`settings-ux.md §5` 要求原文不截断、不包装，
 *    顺手再删点别的会把用户真正需要的那行错误信息弄没。
 *
 * @param secret 明文 key。空串直接返回原文——空串是 `String.replaceAll` 的病态输入
 *               （会在每个字符间插入替换串），而「没有 key」本来也没什么可抹的。
 */
export function redactSecret(text: string, secret: string): string {
  if (secret === '') return text
  const replacement = maskApiKey(secret) ?? MASK
  return text.split(secret).join(replacement)
}
