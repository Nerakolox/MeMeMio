import { env } from '../env.js'
import { loadEmbedCredentials } from '../data/ai-configs.js'
import { EMBED_DIM, truncateAndNormalize } from '../lib/vector.js'
import {
  fetchWithTimeout,
  joinEndpoint,
  resolveCredentials,
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

/** 单次调用的结果，带原始响应体。`raw` 只给测试连接用，见 `callEmbeddings`。 */
export type EmbedCallResult =
  | { ok: true; vector: number[]; raw: string }
  | { ok: false; reason: EmbedFailure; raw: string }

export type EmbedderConfig = ProviderCredentials & {
  /** 实测输出维度。未探测时为 null。 */
  nativeDim: number | null
  /** `dimensions` 参数是否生效。未探测时为 null，按最保守路径处理。 */
  dimParamWorks: boolean | null
}

/**
 * 当前生效的 Embedding 配置：**全站配置表 → 部署方默认值**。
 *
 * 三个运行时解析落点之一（SPEC §6.5）。「DB 优先」那一步在 `provider.ts` 的
 * `resolveCredentials` 里，这里不重写。
 *
 * ⚠️ 只认 `verified_at` 非空的配置行——测过但没通过的行不能进生产
 *    （过滤在 `data/ai-configs.ts`，那是唯一看得见那一列的地方）。
 *
 * 没有探测记录时（部署方默认通道就永远是这种）按 `dimParamWorks = null` 处理，
 * 也就是走客户端截断 + 重新归一化——保守路径永远可用，只是多花一次本地计算
 * （ai-providers.md §2）。
 */
export async function resolveEmbedConfig(): Promise<EmbedderConfig | null> {
  const stored = await loadEmbedCredentials()
  const resolved = resolveCredentials(stored, env.defaultEmbed)
  if (resolved === null) return null

  if (resolved.source === 'user' && stored !== null) {
    return { ...resolved.credentials, nativeDim: stored.nativeDim, dimParamWorks: stored.dimParamWorks }
  }
  return { ...resolved.credentials, nativeDim: null, dimParamWorks: null }
}

export async function isEmbedConfigured(): Promise<boolean> {
  return (await resolveEmbedConfig()) !== null
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
 *
 * @param config **显式传进来**，不在函数内部再解析一次。调用方（搜索、打标、重算）
 *               本来就已经解析过配置——它们要拿 `model` 去写 `embed_model`、
 *               要拿它做 instruct 前缀判断。内部再解析一遍的结果是同一次请求里
 *               查两次库，而且两次之间配置可能刚好被改掉，那时写进 `embed_model`
 *               的模型名和真正算向量的模型对不上，**不报错**，只是那条记录
 *               从此被当成「已经是新模型了」永远不再重算。
 */
export async function embedText(text: string, config: EmbedderConfig): Promise<EmbedResult> {
  // 能力从配置读。实测支持 dimensions 就直接要 1024 维，从根上没有「截断后忘了归一化」的机会
  const useDimParam = config.dimParamWorks === true
  const result = await callEmbeddings(text, config, useDimParam ? EMBED_DIM : null)
  if (!result.ok) return { ok: false, reason: result.reason }

  if (useDimParam) return { ok: true, vector: result.vector }

  if (result.vector.length < EMBED_DIM) {
    // 维度不足是配置问题，不是搜索的问题——但此刻仍然降级，而不是把错误抛给搜索者
    return { ok: false, reason: 'invalid_output' }
  }
  return { ok: true, vector: truncateAndNormalize(result.vector) }
}

/**
 * 单次 `/v1/embeddings` 调用。
 *
 * `raw` 是**原始响应体文本**，给测试连接的 `rawError` 用（SPEC §6.5.1）。
 * 和视觉那边同一个理由：探测不许另写一套 HTTP 路径，否则测的就不是打标/搜索
 * 真正会走的路。
 *
 * ⚠️ `raw` **绝不能进日志**：中转服务可能在错误体里回显 Authorization 头
 *    （error-handling.md §4）。交给用户之前要过 `redactSecret`。
 */
export async function callEmbeddings(
  text: string,
  config: ProviderCredentials,
  dimensions: number | null,
): Promise<EmbedCallResult> {
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
    return { ok: false, reason: 'unreachable', raw: '' }
  }

  let raw: string
  try {
    raw = await response.text()
  } catch {
    raw = ''
  }

  if (!response.ok) return { ok: false, reason: 'unreachable', raw }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'invalid_output', raw }
  }

  const vector = parseEmbedding(payload)
  if (vector === null) return { ok: false, reason: 'invalid_output', raw }

  return { ok: true, vector, raw }
}
