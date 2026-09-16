import { env } from '../env.js'
import {
  classifyHttpFailure,
  parseChatEnvelope,
  type ChatEnvelope,
  type VisionFailure,
} from '../lib/vision-output.js'
import { log } from '../logger.js'
import { vocabulary } from '../vocab.js'
import {
  asCredentials,
  fetchWithTimeout,
  joinEndpoint,
  type ProviderCredentials,
} from './provider.js'

/**
 * 视觉打标调用。**单次调用产出全部五个字段，不做独立 OCR 链路**（SPEC §5.2.3）。
 *
 * 只允许出现 OpenAI 兼容的请求形状（`/v1/chat/completions`）。
 * **禁止任何供应商特有的分支**，尤其禁止按 `baseUrl` 猜能力——`baseUrl` 是用户填的
 * 一个字符串，中转服务的域名和它背后是什么模型毫无关系（ai-providers.md §1）。
 *
 * 返回值不抛异常：失败是降级不是错误（SPEC §2.4），由调用方按重试矩阵处置。
 */

export type VisionConfig = ProviderCredentials & {
  /** `response_format: json_object` 是否真的生效。未探测时为 null。 */
  jsonModeWorks: boolean | null
  /** 是否支持一次发多张图。未探测时为 null，动图回退拼图。 */
  multiImage: boolean | null
}

/**
 * 当前生效的视觉配置。**worker 不许直接读 `env.defaultVision`**——
 * 接入点收在这一个函数里，配置任务（SPEC §6.5：用户自带 key + AES-GCM 解密 +
 * 测试连接）上线后只改这一处。类比 `ai/embedder.ts` 的 `resolveEmbedConfig()`。
 *
 * ⚠️ 本任务**只用部署方默认通道**（joint-tasks/2026-09-16-tag-queue.md「范围裁定」）。
 *    用户自带配置存在 `user_ai_configs` 里，读写那张表是另一个跨端任务。
 *
 * ⚠️ 两个能力位固定返回 null，这是**有意的**：部署方默认通道同样没有测试连接记录，
 *    不许因为「这是我们自己配的」就假设它支持什么。没有探测记录时按最保守路径走——
 *    不用 json mode、不发多图、客户端截断（ai-providers.md §2）。
 */
export function resolveVisionConfig(): VisionConfig | null {
  const credentials = asCredentials(env.defaultVision)
  if (credentials === null) return null
  return { ...credentials, jsonModeWorks: null, multiImage: null }
}

export function isVisionConfigured(): boolean {
  return resolveVisionConfig() !== null
}

// ── 提示词 ─────────────────────────────────────────────────────────

/**
 * 词表和固定指令放在消息**最前面**（ai-providers.md §6）：服务端前缀缓存会自动命中，
 * 这部分几乎免费。变化的部分（图片）放后面。
 *
 * ⚠️ 词表是**闭集**，整份塞进提示词是有理由的：实测样本
 * （`docs/fixtures/responses/api.deepseek.com-2026-09-14.json`）里探测用的提示词只说了
 * 「标签必须来自项目词表」却没给词表，模型在 reasoning 里反复纠结「用户没有提供词表」，
 * 结果 30 条里 23 条把输出预算烧光、正文全空，剩下 7 条的词表命中率是 **0**。
 * 163 个词条的开销远小于一次废掉的调用。
 *
 * **提示词是本端实现约束，不是 SPEC**，随便调——但改完必须跑评测集（api/AGENTS.md §5）。
 */
function buildSystemPrompt(): string {
  const { emotions, scenes, tags } = vocabulary
  return [
    '你是表情包库的打标器。看图，输出一个 JSON 对象，只包含下面五个键：',
    'ocrText、description、emotions、scenes、tags。',
    '',
    'ocrText：图里出现的全部文字，原样抄写，多行用空格连接；没有文字就给空字符串。',
    'description：一句话描述画面，中文，30 到 60 字，写清楚主体、表情和动作。',
    'emotions、scenes、tags.subject、tags.style：**只能从下面的词表里原样选词**，',
    '不在词表里的词一个都不要写，宁可少选也不要自造；选不出来就给空数组。',
    '',
    '词表（闭集，不可扩展）：',
    `emotions = ${emotions.join('、')}`,
    `scenes = ${scenes.join('、')}`,
    `tags.subject = ${tags.subject.join('、')}`,
    `tags.style = ${tags.style.join('、')}`,
    '',
    '输出格式（严格照抄这个形状）：',
    '{"ocrText":"","description":"","emotions":[],"scenes":[],'
      + '"tags":{"subject":[],"style":[]}}',
    '',
    '只输出这个 JSON，不要解释、不要 markdown 围栏、不要任何前后缀。',
    '不确定就给空字符串或空数组——看不清就别标，比编一个更有用。',
  ].join('\n')
}

/** 进程内算一次就够，词表在运行期不变（改词表要重启，见 shared/vocab/README.md）。 */
const SYSTEM_PROMPT = buildSystemPrompt()

/** 多帧时告诉模型这些是同一个动图的连续帧，否则它会当成好几张不相干的图各描述一遍。 */
const FRAMES_HINT = '下面是同一个动态表情包按时间顺序抽出的若干帧，请合并成一条描述。'
/** 不写死「四帧 2×2」：格子数跟着实际帧数走（见 image/decode.ts 的 composeCollage）。 */
const COLLAGE_HINT = '下面是同一个动态表情包的若干帧拼成的一张网格图（从左上到右下按时间顺序），'
  + '请合并成一条描述。'

export type VisionPayloadMode = 'single' | 'frames' | 'collage'

// ── 调用 ───────────────────────────────────────────────────────────

export type VisionCallResult =
  | { ok: true; envelope: ChatEnvelope }
  | { ok: false; failure: VisionFailure }

/**
 * 发一次视觉调用。
 *
 * @param images **只会是 PNG**（image-pipeline.md）。动图已经在上游抽过帧，
 *               这一层不认识 GIF，也不该认识。
 * @param signal 任务级整体超时（queue.md §5）。和单次调用超时叠加，不是覆盖。
 */
export async function callVision(
  images: Buffer[],
  mode: VisionPayloadMode,
  config: VisionConfig,
  signal?: AbortSignal,
): Promise<VisionCallResult> {
  const hint = mode === 'frames' ? FRAMES_HINT : mode === 'collage' ? COLLAGE_HINT : null

  const content: unknown[] = []
  if (hint !== null) content.push({ type: 'text', text: hint })
  for (const png of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
    })
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      // 固定部分在最前面，吃前缀缓存
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
  }
  // 能力从配置读。没有探测记录（null）时不用 json mode——保守路径永远可用
  if (config.jsonModeWorks === true) body['response_format'] = { type: 'json_object' }

  let response: Response
  try {
    response = await fetchWithTimeout(
      joinEndpoint(config.baseUrl, '/v1/chat/completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // ⚠️ 解密后的 key 只在调用这一瞬间存在：不进日志、不进错误 details、不进响应
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
    )
  } catch {
    // 超时和网络错误都归 unreachable。**不记 err 原文**——某些中转服务会在错误体里
    // 回显 Authorization 头（error-handling.md §4）
    return { ok: false, failure: 'unreachable' }
  }

  if (!response.ok) {
    const text = await safeText(response)
    const failure = classifyHttpFailure(response.status, text)
    // 只记状态码和判定结果。**错误体原文不进日志**，同上
    log.warn({ status: response.status, failure, model: config.model }, '视觉调用失败')
    return { ok: false, failure }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, failure: 'invalid_output' }
  }

  const envelope = parseChatEnvelope(payload)
  if (envelope === null) return { ok: false, failure: 'invalid_output' }

  return { ok: true, envelope }
}

/** 错误体读不出来时当空串——判定函数对空串的处置是确定的（归 unsupported，不重试）。 */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
