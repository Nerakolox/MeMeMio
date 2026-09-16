/**
 * Embedding 的 instruct 前缀。纯函数、零 import —— 规则本身很短，但**两侧不对称**，
 * 而「两边都加或都不加会损失几个点」（agents/rules/retrieval.md §4）。
 * 放在 lib/ 是为了让这条规则有个唯一落点并且能被测。
 *
 * Qwen3-Embedding 一类 instruction-aware 模型的正确用法：
 *
 *     查询侧：Instruct: {任务描述}\nQuery: 今天真的不想上班
 *     文档侧：一只趴在桌上的猫，看起来非常疲惫……（原文，无前缀）
 *
 * ⚠️ **跟随 Embedding 配置，不要写死在代码里。** 这条只对 instruction-aware 模型成立，
 *    管理员换成别的模型时这个行为应该跟着变。判断依据是模型的文档，不是 baseUrl ——
 *    按域名猜供应商是被明令禁止的（agents/rules/ai-providers.md §1）。
 */

/** 检索任务描述。换模型时和 `instructPrefix` 的启用条件一起复核。 */
export const RETRIEVAL_TASK = '给定一句口语化或含糊的中文描述，检索出语义上最接近的表情包'

/**
 * 判断某个 embedding 模型是否需要 instruct 前缀。
 *
 * 目前按模型名匹配已知的 instruction-aware 家族。这是一份**已知清单**，不是能力探测——
 * 探测不出「模型期不期待前缀」这件事，误判的代价只是几个点的召回率，不会报错。
 */
export function needsInstructPrefix(model: string): boolean {
  const name = model.toLowerCase()
  return name.includes('qwen3-embedding') || name.includes('qwen3-embed')
}

/**
 * 给查询侧文本加 instruct 前缀。
 *
 * **文档侧永远不加** —— 调用这个函数的地方只有搜索服务里的查询编码那一处。
 * 模型不需要前缀时原样返回，所以调用方可以直接用它，不必自己分支。
 */
export function withInstructPrefix(query: string, model: string): string {
  if (!needsInstructPrefix(model)) return query
  return `Instruct: ${RETRIEVAL_TASK}\nQuery: ${query}`
}
