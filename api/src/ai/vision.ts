import { env } from '../env.js'
import { hasAnyVerifiedVisionConfig, loadUserVisionCredentials } from '../data/ai-configs.js'
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
  resolveCredentials,
  type ProviderCredentials,
} from './provider.js'

/**
 * 视觉打标调用。**单次调用产出全部字段，不做独立 OCR 链路**（SPEC §5.2.3）。
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
 * 当前生效的视觉配置：**本人的配置 → 部署方默认值**。
 *
 * 这是 SPEC §6.5 说的三个运行时解析落点之一。`worker.ts` / `hyde.ts` / `tagging.ts`
 * 都不许直接读 `env.defaultVision`，也不许自己写「先查库、查不到用 env」——
 * 那个判断只在 `provider.ts` 的 `resolveCredentials` 里有一份。
 *
 * @param userId **谁的配置**。打标用上传者的（`meme.uploader_id`），
 *               HyDE 用搜索者本人的（ai-providers.md §6）。这个参数不能省成
 *               「当前请求的用户」——打标发生在队列里，那时没有请求。
 *
 * ⚠️ 能力位跟着来源走：用户自己的配置带实测出来的探测位，部署方默认通道**固定 null**。
 *    后者是有意的——部署方通道同样没有测试连接记录，不许因为「这是我们自己配的」
 *    就假设它支持什么。null 时按最保守路径走：不用 json mode、不发多图
 *    （ai-providers.md §2）。
 */
export async function resolveVisionConfig(userId: string): Promise<VisionConfig | null> {
  const stored = await loadUserVisionCredentials(userId)
  const resolved = resolveCredentials(stored, env.defaultVision)
  if (resolved === null) return null

  if (resolved.source === 'user' && stored !== null) {
    return { ...resolved.credentials, jsonModeWorks: stored.jsonModeWorks, multiImage: stored.multiImage }
  }
  return { ...resolved.credentials, jsonModeWorks: null, multiImage: null }
}

/**
 * 全站有没有**任何一条**可用的视觉配置。队列 worker 用它决定要不要进入低频轮询。
 *
 * ⚠️ 这里必须是「部署方配了 **或** 有任何一个用户配了」，不能只看部署方
 *    （任务 E 项）。原来的写法是 `resolveVisionConfig() !== null` 这个纯环境变量判断，
 *    用户自带 key 之后那个前提就不成立了：**部署方没配、用户自己配了**的图会永远
 *    停在 pending——worker 60 秒轮询一次且一条都不取，不报错、不告警。
 *
 * 它只回答「值不值得去取任务」。取到任务之后仍然要按上传者逐条解析，
 * 解析不出来的那条走 `not_configured` 降级——**本函数为真不代表每个人都配了**。
 */
export async function isVisionConfigured(): Promise<boolean> {
  if (asCredentials(env.defaultVision) !== null) return true
  return hasAnyVerifiedVisionConfig()
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
 * 词条数的开销远小于一次废掉的调用。v0.1.0 是 163 条，v0.2.0 拆成六个维度后约 285 条，
 * v0.3.0 加到七个维度是 **191 条**（拆维度时做了同义词合并，总数反而比 v0.1.0 只多一点），结论不变。
 *
 * ⚠️ **加 `ratings` 是与「不重试 vs 重试」那条规则无关的独立风险**：对这一维的提问本身
 *    可能抬高整体的拒绝率（SPEC §9.23 记了这条，且**没有实测支撑**）。真出现的话，
 *    按 §9.23 的推翻条件处理——把这一维从提示词里撤掉，只保留人工编辑。
 *
 * **提示词是本端实现约束，不是 SPEC**，随便调——但改完必须跑评测集（api/AGENTS.md §5）。
 */
function buildSystemPrompt(): string {
  const { expressions, emotions, tones, purposes, scenes, tags, ratings } = vocabulary
  return [
    '你是表情包库的打标器。看图，输出一个 JSON 对象，只包含下面九个键：',
    'ocrText、description、expressions、emotions、tones、purposes、scenes、tags、ratings。',
    '',
    'ocrText：图里出现的全部文字，原样抄写，多行用空格连接；没有文字就给空字符串。',
    'description：一句话描述画面，中文，30 到 60 字，写清楚主体、表情和动作。',
    '',
    '六个标签维度问的是六件不同的事，**不要互相推导**：',
    'expressions（面部表情）：脸上是什么样。这是看得见的事实。',
    'emotions（情绪）：他心里在感受什么。**微笑不等于开心**——一张笑脸配上',
    '  「你说得都对」，脸是微笑，心里是什么图上没说，这时 emotions 就该是空数组。',
    'tones（表达语气）：这张图**怎么**说话，跟说的内容无关。',
    '  「敷衍」是不想接着聊，「阴阳怪气」是说反话，两个不是一回事，可以同时成立。',
    'purposes（聊天用途）：发图的人**想完成什么交流动作**，不是文字的字面意思。',
    '  「你说得都对」的用途是「表面附和」，不是「赞同」。',
    'scenes（生活情境）：和什么现实场合有关（上班、考试、没钱这类），跟交流动作无关。',
    'tags（主体与风格）：图里是什么、长什么样。',
    '',
    '还有一个**不在这六个里**的维度：',
    'ratings（内容分级）：这张图适不适合在公开场合出现。词表里只有「成人向」一个词条——',
    '  画面本身是成人向内容时才填，**拿不准就留空**。它和上面六维互不影响：填了它不代表',
    '  别的维度要跟着改，别的维度是空也不代表这一维该填。它不参与上面那条「互相推导」的规则。',
    '',
    '选词规则：',
    '1. **只能从下面的词表里原样选词**，不在词表里的词一个都不要写，也不要自造。',
    '2. 一个词只属于一个维度，不要把某一维的词填到另一维里。',
    '3. **证据不足就给空数组。** 猜一个比留空更坏——猜错的标签会让这张图在别人搜',
    '   完全不相干的东西时冒出来，而没人知道那个标签是猜的。',
    '4. expressions / emotions / scenes / tags 每维最多 4 个。',
    '5. **tones 和 purposes 每维最多 2 个**，只填最有把握的。这两维靠推断，宁缺毋滥。',
    '6. **ratings 最多 1 个**，它只有这一个词条；留空是常态。',
    '',
    '词表（闭集，不可扩展）：',
    `expressions = ${expressions.join('、')}`,
    `emotions = ${emotions.join('、')}`,
    `tones = ${tones.join('、')}`,
    `purposes = ${purposes.join('、')}`,
    `scenes = ${scenes.join('、')}`,
    `tags.subject = ${tags.subject.join('、')}`,
    `tags.style = ${tags.style.join('、')}`,
    `ratings = ${ratings.join('、')}`,
    '',
    '输出格式（严格照抄这个形状）：',
    '{"ocrText":"","description":"","expressions":[],"emotions":[],"tones":[],'
      + '"purposes":[],"scenes":[],"tags":{"subject":[],"style":[]},"ratings":[]}',
    '',
    '只输出这个 JSON，不要解释、不要 markdown 围栏、不要任何前后缀。',
    '不确定就给空字符串或空数组——看不清就别标，比编一个更有用。',
  ].join('\n')
}

/**
 * 进程内算一次就够，词表在运行期不变（改词表要重启，见 shared/vocab/README.md）。
 *
 * **导出是给测试连接用的**（SPEC §9.7：测试要发「内置测试图 + 正式的打标提示词」）。
 * 探测必须用这一份，不许另抄一份简化版——两份提示词迟早分叉，那时测试连接
 * 测的就不是打标真正会走的路径了。
 */
export const SYSTEM_PROMPT = buildSystemPrompt()

/** 多帧时告诉模型这些是同一个动图的连续帧，否则它会当成好几张不相干的图各描述一遍。 */
const FRAMES_HINT = '下面是同一个动态表情包按时间顺序抽出的若干帧，请合并成一条描述。'
/** 不写死「四帧 2×2」：格子数跟着实际帧数走（见 image/decode.ts 的 composeCollage）。 */
const COLLAGE_HINT = '下面是同一个动态表情包的若干帧拼成的一张网格图（从左上到右下按时间顺序），'
  + '请合并成一条描述。'

export type VisionPayloadMode = 'single' | 'frames' | 'collage'

// ── 调用 ───────────────────────────────────────────────────────────

export type VisionCallResult =
  | { ok: true; envelope: ChatEnvelope; rawResponse: string }
  | { ok: false; failure: VisionFailure; rawResponse: string }

/**
 * 发一次视觉调用。
 *
 * @param images **只会是 PNG**（image-pipeline.md）。动图已经在上游抽过帧，
 *               这一层不认识 GIF，也不该认识。
 * @param signal 任务级整体超时（queue.md §5）。和单次调用超时叠加，不是覆盖。
 *
 * `rawResponse` 是**原始响应体文本**，成功失败都带。它只有一个消费者——
 * 测试连接（`ai/probe.ts`，SPEC §6.5.1「失败时把模型的原始返回原样展示出来」）。
 * 打标路径拿到就丢。
 *
 * ⚠️ **它绝不能进日志**：某些中转服务会在错误体里回显 Authorization 头
 *    （error-handling.md §4）。返回给调用方和写进日志是两件事——
 *    交给用户之前要过 `redactSecret`，而日志没有那一步，所以下面只记状态码。
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
    return { ok: false, failure: 'unreachable', rawResponse: '' }
  }

  const rawResponse = await safeText(response)

  if (!response.ok) {
    const failure = classifyHttpFailure(response.status, rawResponse)
    // 只记状态码和判定结果。**错误体原文不进日志**，同上
    log.warn({ status: response.status, failure, model: config.model }, '视觉调用失败')
    return { ok: false, failure, rawResponse }
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawResponse)
  } catch {
    return { ok: false, failure: 'invalid_output', rawResponse }
  }

  const envelope = parseChatEnvelope(payload)
  if (envelope === null) return { ok: false, failure: 'invalid_output', rawResponse }

  return { ok: true, envelope, rawResponse }
}

/** 响应体读不出来时当空串——判定函数对空串的处置是确定的（归 unsupported，不重试）。 */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
