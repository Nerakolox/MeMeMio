import { env } from '../env.js'
import { EMBED_DIM, truncateAndNormalize } from '../lib/vector.js'
import {
  asCredentials,
  fetchWithTimeout,
  joinEndpoint,
  type ProviderCredentials,
} from './provider.js'

/**
 * Embedding 调用。**全站一个模型**（SPEC §9.6）——共享库的硬约束，不是可调参数。
 *
 * 只有 OpenAI 兼容的请求形状（`/v1/embeddings`）。不假设中转服务支持 `dimensions`
 * 参数，也不假设它返回多少维：走哪条路由 `dim_param_works` 决定，那是**测试连接实测
 * 出来的**（SPEC §9.7 / §6.5.1），不是文档说的。
 */

/**
 * `not_configured` 和 `unreachable` 要分开：前者是稳定的降级态（前端一直提示结果可能
 * 不全），后者是这次调用赶上了故障。两者都让搜索返回 `degraded: true`，但日志里要能分辨。
 */
export type EmbedFailure =
  | 'not_configured'
  | 'unreachable'
  | 'invalid_output'

export type EmbedResult =
  | { ok: true; vector: number[] }
  | { ok: false; reason: EmbedFailure }

export type EmbedderConfig = ProviderCredentials & {
  /** 实测输出维度。未探测时为 null。 */
  nativeDim: number | null
  /** `dimensions` 参数是否生效。未探测时为 null，按最保守路径处理。 */
  dimParamWorks: boolean | null
}

/**
 * 当前生效的 Embedding 配置：全站配置表 → 部署方默认值。
 *
 * ⚠️ **DB 那一层还没有实现**：`embed_config` 表存在（SPEC §5.3），但读写它的配置接口
 *    （SPEC §6.5）还没做，所以现在只有部署方默认值这条来源。留成函数是为了接入时
 *    只改这一处，而不是让 `search.ts` 里长出第二个配置来源。
 *
 * 没有探测记录时（刚配好还没测）按 `dim_param_works = null` 处理，也就是走客户端
 * 截断 + 重新归一化 —— 保守路径永远可用，只是多花一次本地计算（ai-providers.md §2）。
 */
export function resolveEmbedConfig(): EmbedderConfig | null {
  const credentials = asCredentials(env.defaultEmbed)
  if (credentials === null) return null
  return { ...credentials, nativeDim: null, dimParamWorks: null }
}

export function isEmbedConfigured(): boolean {
  return resolveEmbedConfig() !== null
}

/** OpenAI 兼容的 embeddings 响应。第三方结构先当 unknown 再校验（code-style.md）。 */
type EmbeddingsResponse = {
  data?: { embedding?: unknown }[]
}

function parseEmbedding(payload: unknown): number[] | null {
  if (typeof payload !== 'object' || payload === null) return null
  const first = (payload as EmbeddingsResponse).data?.[0]?.embedding
  if (!Array.isArray(first)) return null
  // 逐项查 typeof：`as number[]` 是把类型检查关掉，不是把类型改对
  const vector = first.filter((v): v is number => typeof v === 'number')
  return vector.length === first.length && vector.length > 0 ? vector : null
}

/**
 * 把文本编码成 1024 维向量。
 *
 * 失败返回 `{ ok: false }` 而不是抛异常 —— **搜索是降级不是报错**（SPEC §2.4）。
 *
 * 查询侧和文档侧的差别（instruct 前缀）由调用方在 `text` 上体现，见 embed-instruct.ts：
 * `withInstructPrefix(q, model)` 只用在查询那一处，文档侧永远传原文。
 */
export async function embedText(text: string): Promise<EmbedResult> {
  const config = resolveEmbedConfig()
  if (config === null) return { ok: false, reason: 'not_configured' }

  // 能力从配置读。实测支持 dimensions 就直接要 1024 维，从根上没有「截断后忘了归一化」的机会
  const useDimParam = config.dimParamWorks === true
  const result = await request(text, config, useDimParam ? EMBED_DIM : null)
  if (!result.ok) return result

  if (useDimParam) return result

  if (result.vector.length < EMBED_DIM) {
    // 维度不足是配置问题，不是搜索的问题——但此刻仍然降级，而不是把错误抛给搜索者
    return { ok: false, reason: 'invalid_output' }
  }
  return { ok: true, vector: truncateAndNormalize(result.vector) }
}

async function request(
  text: string,
  config: EmbedderConfig,
  dimensions: number | null,
): Promise<EmbedResult> {
  const body: Record<string, unknown> = { model: config.model, input: text }
  if (dimensions !== null) body['dimensions'] = dimensions

  let response: Response
  try {
    response = await fetchWithTimeout(joinEndpoint(config.baseUrl, '/v1/embeddings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ⚠️ 解密后的 key 只在调用这一瞬间存在，不进日志、不进错误 details（SPEC §3.5）
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    })
  } catch {
    // 超时和网络错误都归 unreachable，**不记 err 原文**：中转服务的报错里可能
    // 回显 Authorization 头（error-handling.md §4 的警告）。记状态码和 reason 就够定位。
    return { ok: false, reason: 'unreachable' }
  }

  if (!response.ok) return { ok: false, reason: 'unreachable' }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'invalid_output' }
  }

  const vector = parseEmbedding(payload)
  if (vector === null) return { ok: false, reason: 'invalid_output' }

  return { ok: true, vector }
}
