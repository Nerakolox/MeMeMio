import { redactSecret } from '../lib/redact.js'
import { EMBED_DIM } from '../lib/vector.js'
import { interpretVisionContent } from '../lib/vision-output.js'
import { vocabAdapter } from '../vocab.js'
import { callEmbeddings } from './embedder.js'
import { probeImagePng } from './probe-image.js'
import type { ProviderCredentials } from './provider.js'
import { callVision } from './vision.js'

/**
 * 测试连接的实测探测（SPEC §6.5.1、§9.7）。
 *
 * **不让用户手填能力、也不假设任何能力，全部实测。** 能力位是运行时分支的唯一依据
 * （`ai-providers.md §2`），而它们只能从这里产生。
 *
 * ## 三条自我约束
 *
 * 1. **不另写 HTTP 路径。** 探测走的是 `callVision` / `callEmbeddings`，也就是打标和
 *    搜索真正会走的那两个函数。另写一份「测试专用」的请求构造，测出来的就不是
 *    生产会走的路——差一个 header、差一个字段，结论就可能相反。
 * 2. **不另写判定。** 正文的解析、词表校验、判空全部交给 `interpretVisionContent`，
 *    词表适配器用 `src/vocab.ts` 那一份。两套判定迟早给出不同结论，表现是
 *    测试连接说能用、打标时全被丢掉。
 * 3. **不按 `baseUrl` 猜供应商**（`ai-providers.md §1`）。这个文件里没有任何域名。
 *
 * ## 原样返回和「key 不出响应」的相撞点
 *
 * `rawResponse` / `rawError` 是这个接口的核心价值，必须原样带回；而 API Key
 * 不许出现在任何响应里（AGENTS.md §5）。两条都不让步，所以**每一条对外的 raw 字段
 * 在离开本文件之前都过一次 `redactSecret(text, apiKey)`**——调用那一刻明文就在手上，
 * 做的是字面替换不是模式猜测，漏不漏是确定的（见 `lib/redact.ts`）。
 *
 * 出口只有 `finish()` 一个，新增 raw 字段时也得从那里走。
 */

// ── 视觉 ───────────────────────────────────────────────────────────

/** SPEC §6.5.1 的视觉测试响应。能力位 null = **没测出来**，不是「不支持」。 */
export type VisionProbeReport = {
  ok: boolean
  canReceiveImage: boolean
  jsonModeWorks: boolean | null
  multiImageWorks: boolean | null
  vocabCompliant: boolean | null
  rawResponse: string
}

/**
 * 跑一遍视觉探测。**最多三次调用**，且后两次只在第一次成功时才发——
 * 第一次就打不通的话，后面两次只是把用户的钱再烧两遍去确认同一件事。
 *
 * ⚠️ 用的是 `vision.ts` 导出的 `SYSTEM_PROMPT`（在 `callVision` 里）和内置测试图，
 *    §9.7 要求的就是「内置测试图 + 正式的打标提示词」。
 */
export async function probeVision(credentials: ProviderCredentials): Promise<VisionProbeReport> {
  const image = probeImagePng()
  const finish = (report: Omit<VisionProbeReport, 'rawResponse'>, raw: string): VisionProbeReport => ({
    ...report,
    rawResponse: redactSecret(raw, credentials.apiKey),
  })

  // 第一次：单图、不开 json mode。这是**最保守的形态**，任何能用的通道都该过得去；
  // 过不去就说明问题在通道本身，不在某个可选能力上
  const baseline = await callVision([image], 'single', {
    ...credentials,
    jsonModeWorks: false,
    multiImage: null,
  })

  if (!baseline.ok) {
    // `canReceiveImage: false` 在 unreachable 这一支里读作「没测出它能收图」。
    // 不给 null 是因为 §6.5.1 把它定成了 boolean；真正的原因在 rawResponse 里
    return finish(
      {
        ok: false,
        canReceiveImage: false,
        jsonModeWorks: null,
        multiImageWorks: null,
        vocabCompliant: null,
      },
      baseline.rawResponse,
    )
  }

  const outcome = interpretVisionContent(
    baseline.envelope.content,
    baseline.envelope.finishReason,
    vocabAdapter,
  )

  // 收到了一个能解析的 envelope = 它确实吃下了这张图并回了话
  if (outcome.kind !== 'ok') {
    // 拒绝或输出不合格：这个通道打标也会是这个结果，判不通过。
    // `vocabCompliant` 给 null 而不是 false——根本没拿到可校验的字段，
    // 报 false 会让用户以为是词表的问题去改提示词
    return finish(
      {
        ok: false,
        canReceiveImage: true,
        jsonModeWorks: null,
        multiImageWorks: null,
        vocabCompliant: null,
      },
      baseline.rawResponse,
    )
  }

  const vocabCompliant = outcome.violations.length === 0

  // 第二、三次可以并发：它们各自是独立的一次调用，互不依赖
  const [jsonModeWorks, multiImageWorks] = await Promise.all([
    probeJsonMode(credentials, image),
    probeMultiImage(credentials, image),
  ])

  return finish(
    { ok: true, canReceiveImage: true, jsonModeWorks, multiImageWorks, vocabCompliant },
    baseline.rawResponse,
  )
}

/**
 * `response_format: json_object` 是不是真的生效。
 *
 * 判据是**这次调用的正文仍然能解析成合格的打标结果**，不是「服务端没报错」：
 * 不少中转把不认识的字段直接丢掉，请求照样 200，那种情况下开不开都一样，
 * 按 false 走保守路径不会错。
 */
async function probeJsonMode(
  credentials: ProviderCredentials,
  image: Buffer,
): Promise<boolean | null> {
  const result = await callVision([image], 'single', {
    ...credentials,
    jsonModeWorks: true,
    multiImage: null,
  })
  // 这一次没打通（超时、网络）说明什么都没测出来，不是「不支持」
  if (!result.ok) return result.failure === 'unreachable' ? null : false

  const outcome = interpretVisionContent(
    result.envelope.content,
    result.envelope.finishReason,
    vocabAdapter,
  )
  return outcome.kind === 'ok'
}

/**
 * 一次能不能发多张图。
 *
 * 发的是**同一张测试图两份**：探的是「接不接受多图」这个能力，不是模型能不能分辨
 * 两张不同的图。用两张不同的图要再内置一张，收益为零。
 *
 * ⚠️ 这个探测**探不出上限是几张**（`image-pipeline.md §3`）。true 只意味着
 *    「2 张可以」，运行时仍然要保留降帧梯子——所以 `tagging.ts` 里那条
 *    「先降帧，不降通道」不因为这里探到 true 就可以删掉。
 */
async function probeMultiImage(
  credentials: ProviderCredentials,
  image: Buffer,
): Promise<boolean | null> {
  const result = await callVision([image, image], 'frames', {
    ...credentials,
    jsonModeWorks: false,
    multiImage: null,
  })
  if (result.ok) return true
  // image_limit 就是它亲口说的「一次发不了这么多」——这是最明确的 false
  if (result.failure === 'unreachable') return null
  return false
}

// ── Embedding ──────────────────────────────────────────────────────

/** SPEC §6.5.1 的 embedding 测试响应。 */
export type EmbedProbeReport = {
  ok: boolean
  nativeDim: number | null
  dimParamWorks: boolean | null
  /** 需要客户端截断 + 重新归一化。**由实测维度推出**，不是单独问出来的。 */
  willTruncate: boolean | null
  rawError: string | null
}

/**
 * 探测用的文本。内容无所谓，长度和语种要像真实的 `search_text`——
 * 那是这条通道将来真正要编码的东西。
 */
const EMBED_PROBE_TEXT = '一只趴在桌上的猫，看起来非常疲惫 疲惫 生无可恋 上班摸鱼 猫 手绘'

/**
 * 跑一遍 embedding 探测。两次调用：一次不带 `dimensions`，一次带。
 *
 * ⚠️ `dim_param_works` 的判据是「**带上参数之后拿到的就是 1024 维**」，不是
 *    「服务端没拒绝这个参数」。中转忽略未知参数是常态，只看状态码会把
 *    「它压根没理这个参数」判成生效，然后运行时拿着一个没归一化的长向量去写库。
 *
 *    本模型原生就是 1024 维时，这个判据分不出「照办了」和「忽略了」——**也不需要分**：
 *    两种情况下拿到的都是 1024 维，运行时行为完全一样。
 */
export async function probeEmbed(credentials: ProviderCredentials): Promise<EmbedProbeReport> {
  const native = await callEmbeddings(EMBED_PROBE_TEXT, credentials, null)
  if (!native.ok) {
    return {
      ok: false,
      nativeDim: null,
      dimParamWorks: null,
      willTruncate: null,
      rawError: redactSecret(native.raw, credentials.apiKey),
    }
  }

  const nativeDim = native.vector.length

  const withParam = await callEmbeddings(EMBED_PROBE_TEXT, credentials, EMBED_DIM)
  const dimParamWorks = withParam.ok && withParam.vector.length === EMBED_DIM

  return {
    ok: true,
    nativeDim,
    // 走不了 dimensions 参数、而原生维度又比 1024 长，就得在客户端截断再归一化。
    // 截断本身不是问题（支持 MRL 的模型基本无损，SPEC §9.6），**忘了归一化才是**
    willTruncate: !dimParamWorks && nativeDim > EMBED_DIM,
    dimParamWorks,
    // 成功时没有错误可带。不要把成功的响应体塞进来——那里面是 1024 个浮点数，
    // 对用户没有任何信息量，只会把界面撑爆
    rawError: null,
  }
}
