import { loadImageEmbedCredentials } from '../data/ai-configs.js'
import { env } from '../env.js'
import { PERSON_EMBED_DIM, PERSON_LONG_EDGE } from '../image/constants.js'
import { truncateAndNormalize } from '../lib/vector.js'
import type { EmbedFailure, EmbedResult } from './embedder.js'
import {
  fetchWithTimeout,
  joinEndpoint,
  resolveCredentials,
  type ProviderCredentials,
} from './provider.js'

/**
 * 图片向量调用（SPEC §5.7.1 / §6.7.5）。**全站一个模型、一份配置**。
 *
 * 与 `embedder.ts`（文本）分开是有意的：两份向量是**两个空间**，配置也分开管
 * （§5.7.1）。换文本 embedding 模型不重算人物向量，反之亦然——共用一个解析函数
 * 就会把这两件事绑死，而表现是换一个模型把另一边的向量也判成过期。
 *
 * ## 上游请求形状（探测实测，硅基流动）
 *
 * ```json
 * { "model": "…", "input": [{ "image": "data:image/png;base64,…" }], "dimensions": 1024 }
 * ```
 *
 * - 图片**只认这一种写法**：字符串、`messages`、`{type:'image_url'}` 三种都被 400 拒
 * - ⚠️ **同一条 input 里不要同时放 `text`**：图会被**静默丢掉**（上游回 `image_tokens: 0`），
 *   拿到的向量是那句文本的向量，而调用方以为它是图的。这正是 `imageInputWorks`
 *   那个探测位存在的理由（§6.7.5）。`instruction` 字段无效，所以图片向量加不了指令
 * - 回来的是原生 4096 维，截到 1024 维后**必须重新 L2 归一化**（本端入口 §4）
 *
 * 参考实现（可跑的探测脚本）：`api/scripts/person-probe.ts`。
 */

export type ImageEmbedderConfig = ProviderCredentials & {
  /** 实测输出维度。未探测时为 null。 */
  nativeDim: number | null
  /** `dimensions` 参数是否生效。未探测时为 null，按最保守路径处理。 */
  dimParamWorks: boolean | null
  /**
   * 图真的被编码了，不是被静默丢掉（§6.7.5）。未探测时为 null。
   *
   * ⚠️ 它是**写配置时的闸门**，不是运行时分支：`resolveImageEmbedConfig` 只认
   *    `true` 的行（部署方默认值那一支是 null，见下面的注释），运行时不再判。
   */
  imageInputWorks: boolean | null
}

/** 单次调用的结果，带原始响应体。`raw` 只给测试连接用。 */
export type ImageEmbedCallResult =
  | { ok: true; vector: number[]; raw: string }
  | { ok: false; reason: EmbedFailure; raw: string }

/**
 * `meme_subjects.embed_model` 存的那串：**模型 + 预处理口径**。
 *
 * 「@768」不是装饰：同一张图送到长边 768 与 512，两份向量的 cosine 可能比两个
 * 不同角色还低（任务 §9.1 发现 1），**改长边与换模型同等对待**——存量全部重算，
 * 比较只在同一口径的向量之间做（§5.7.1）。所以拼接口径这件事只能有一处实现，
 * 就是这里；判定「这张图的向量是不是当前口径」也永远拿它去比。
 */
export function personEmbedModelKey(model: string): string {
  return `${model}@${PERSON_LONG_EDGE}`
}

/**
 * 当前生效的图片向量配置：**全站配置表 → 部署方默认值**。
 *
 * ⚠️ 只认 `image_input_works = true` 且 `verified_at` 非空的行（过滤在
 *    `data/ai-configs.ts`）。**没有这一条，一个把图静默丢掉的上游会让所有人物的
 *    向量慢慢并成一团**，且不报错——见 `imageEmbedConfig` 的注释。
 *
 * 部署方默认值那一支没有探测记录，`dimParamWorks` / `imageInputWorks` 按 null 处理
 * （同 `resolveEmbedConfig` 的口径）：`dimParamWorks` 为 null 时走客户端截断 + 归一化，
 * 那是永远可用的保守路径。
 */
export async function resolveImageEmbedConfig(): Promise<ImageEmbedderConfig | null> {
  const stored = await loadImageEmbedCredentials()
  const resolved = resolveCredentials(stored, env.defaultImageEmbed)
  if (resolved === null) return null

  if (resolved.source === 'user' && stored !== null) {
    return {
      ...resolved.credentials,
      nativeDim: stored.nativeDim,
      dimParamWorks: stored.dimParamWorks,
      imageInputWorks: stored.imageInputWorks,
    }
  }
  return { ...resolved.credentials, nativeDim: null, dimParamWorks: null, imageInputWorks: null }
}

export async function isImageEmbedConfigured(): Promise<boolean> {
  return (await resolveImageEmbedConfig()) !== null
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
 * 把一张 PNG 编码成 1024 维向量。
 *
 * 失败返回 `{ ok: false }` 而不是抛异常——**人物是附加能力**（§5.7.2）：
 * 调用失败、超时、这一步整个出问题，图照样入库、打标、能被搜到，
 * 只是暂时不属于任何人物。
 *
 * @param config **显式传进来**，理由与 `embedText` 逐字相同：调用方本来就已经解析过
 *               配置，它要拿 `model` 去写 `embed_model` 做口径比对；内部再解析一遍
 *               的结果是同一次任务里查两次库，而两次之间配置可能刚好被改掉，
 *               那时写进 `embed_model` 的口径和真正算出来的向量就对不上——
 *               **不报错**，只是那条记录从此被当成「已经是新口径了」永远不再重算。
 */
export async function embedImage(
  png: Buffer,
  config: ImageEmbedderConfig,
  signal?: AbortSignal,
): Promise<EmbedResult> {
  // 能力从配置读，与文本侧同一套路：实测支持 dimensions 就直接要 1024 维
  const useDimParam = config.dimParamWorks === true
  const result = await callImageEmbeddings(png, config, useDimParam ? PERSON_EMBED_DIM : null, signal)
  if (!result.ok) return { ok: false, reason: result.reason }

  if (useDimParam) return { ok: true, vector: result.vector }

  if (result.vector.length < PERSON_EMBED_DIM) {
    // 维度不足是配置问题。**截断本身不是问题，忘了归一化才是**（本端入口 §4），
    // 所以走 truncateAndNormalize 而不是 slice
    return { ok: false, reason: 'invalid_output' }
  }
  return { ok: true, vector: truncateAndNormalize(result.vector, PERSON_EMBED_DIM) }
}

/**
 * 单次 `/v1/embeddings` 调用（图片形态）。
 *
 * 和文本侧分开写，是因为**请求体不一样**（`input` 是对象数组而不是字符串），
 * 而不是为了「将来可能不一样」——探测脚本验证过的就是这一个形状，
 * 共用函数里塞一个 `typeof text === 'string'` 的分支只会让两条路互相牵制。
 *
 * `raw` 是**原始响应体文本**，给测试连接的 `rawError` 与 `imageInputWorks` 判定用。
 * ⚠️ 它**绝不能进日志**：中转服务可能在错误体里回显 Authorization 头
 * （error-handling.md §4）。交给用户之前要过 `redactSecret`。
 */
export async function callImageEmbeddings(
  png: Buffer,
  config: ProviderCredentials,
  dimensions: number | null,
  signal?: AbortSignal,
): Promise<ImageEmbedCallResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    // ⚠️ 只放 image，**不要顺手加 text**：同一条 input 里带 text 时图会被静默丢掉
    input: [{ image: `data:image/png;base64,${png.toString('base64')}` }],
  }
  if (dimensions !== null) body['dimensions'] = dimensions

  let response: Response
  try {
    response = await fetchWithTimeout(
      joinEndpoint(config.baseUrl, '/v1/embeddings'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // ⚠️ 解密后的 key 只在调用这一瞬间存在，不进日志、不进错误 details（SPEC §3.5）
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        // 任务整体超时之后 worker 会 abort，让在途的这次调用别再烧钱
        signal,
      },
    )
  } catch {
    // 超时和网络错误都归 unreachable，**不记 err 原文**（中转服务的报错里可能
    // 回显 Authorization 头）。记状态码和 reason 就够定位。
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

/**
 * 上游报的图片 token 数。**只看 `usage.image_tokens`，找不到就返回 null。**
 *
 * 它是 `imageInputWorks` 的第二个判据（§6.7.5）：上游把图丢掉时会明说
 * `image_tokens: 0`。字段名不做穷举猜测——**只有探测里真见过的这一个**，
 * 猜出来的字段名会把「没有这个字段」判成「图被丢了」，那会把能用的供应商判死。
 */
export function readImageTokens(raw: string): number | null {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const usage = (payload as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return null
  const tokens = (usage as { image_tokens?: unknown }).image_tokens
  return typeof tokens === 'number' ? tokens : null
}
