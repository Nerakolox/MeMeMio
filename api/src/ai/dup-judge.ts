import { parseDupJudgement, type DupJudgement } from '../lib/dup-verdict.js'
import { classifyHttpFailure, parseChatEnvelope } from '../lib/vision-output.js'
import { log } from '../logger.js'
import { AI_TIMEOUT_MS, fetchWithTimeout, joinEndpoint } from './provider.js'
import type { VisionConfig } from './vision.js'

/**
 * 近似重复判定的视觉调用。SPEC §9.33。
 *
 * 和打标（`vision.ts`）共用**通道解析**与**请求形状**，但提示词与输出解析是另一份：
 * 打标的输出要过词表校验，这里要的是一个三态结论，两者没有可复用的部分。
 *
 * **永不抛异常，也不给「失败」以外的第三种出口**：调用方只需要区分
 * 「拿到了一个合规结论」和「没拿到」，后者一律回落到待确认队列（人看一眼）。
 * 超时、网络错误、HTTP 错误、输出被截断、JSON 不合规、`verdict` 不认识，全是后者。
 */

/** 判重调用的超时。比打标短：它在导入管线里同步等，超时了回落到人工，不值得多等。 */
export const DUP_JUDGE_TIMEOUT_MS = Math.min(AI_TIMEOUT_MS, 12_000)

/**
 * ⚠️ 不对称：`same` 会删掉用户刚传的文件、且不可撤销；`unsure` 只是让人多看一眼。
 * 所以提示词要求「有任何可见差异就不是 same」「拿不准就 unsure」。
 * **提示词是本端实现约束，随便调**——但它没有评测集，调之前先想想 §9.33 的推翻条件。
 */
export const DUP_JUDGE_SYSTEM_PROMPT = [
  '你是表情包库的查重员。用户会给你两张图：第一张是刚上传的新图，第二张是库里已有的图。',
  '你要判断：这两张图是不是**同一张图**（同一个画面，只是尺寸、压缩、格式、画质不同）。',
  '',
  '判定标准，严格从严：',
  '1. 只有画面内容完全一致才算 same——文字、表情、构图、人物、局部细节都一样。',
  '2. **只要有任何可见差异就不是 same**：同一模板但文字不同、同一场景但表情不同、',
  '   裁剪范围不同、多了或少了水印/贴纸/边框，全部是 different。',
  '3. 两张图明显是不同的画面，是 different。',
  '4. 图看不清、被遮挡、或者你拿不准，答 unsure。**拿不准就 unsure，不要猜。**',
  '   误判 same 会让用户的图被直接丢弃，而 unsure 只是让人再看一眼。',
  '',
  '输出格式（严格照抄这个形状）：',
  '{"verdict":"same","reason":""}',
  'verdict 只能是 same、different、unsure 三者之一。reason 用一句中文说明依据，不超过 40 字。',
  '',
  '只输出这个 JSON，不要解释、不要 markdown 围栏、不要任何前后缀。',
].join('\n')

export type DupJudgeResult =
  | { kind: 'judged'; judgement: DupJudgement }
  | { kind: 'unavailable'; why: string }

/**
 * @param fresh 刚上传的那张（PNG）
 * @param existing 库里已有的那张（PNG）
 */
export async function judgeNearDuplicate(
  fresh: Buffer,
  existing: Buffer,
  config: VisionConfig,
): Promise<DupJudgeResult> {
  const content: unknown[] = [
    { type: 'text', text: '第一张是新上传的图，第二张是库里已有的图。' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${fresh.toString('base64')}` } },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${existing.toString('base64')}` } },
  ]

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: DUP_JUDGE_SYSTEM_PROMPT },
      { role: 'user', content },
    ],
  }
  // 能力从配置读，没有探测记录（null）就走保守路径
  if (config.jsonModeWorks === true) body['response_format'] = { type: 'json_object' }

  let response: Response
  try {
    response = await fetchWithTimeout(
      joinEndpoint(config.baseUrl, '/v1/chat/completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // ⚠️ key 只在这一瞬间存在：不进日志、不进返回值
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      DUP_JUDGE_TIMEOUT_MS,
    )
  } catch {
    // 不记 err 原文：某些中转服务会在错误里回显 Authorization 头（error-handling.md §4）
    return { kind: 'unavailable', why: 'unreachable' }
  }

  let text: string
  try {
    text = await response.text()
  } catch {
    text = ''
  }

  if (!response.ok) {
    const failure = classifyHttpFailure(response.status, text)
    // 只记状态码和判定，错误体原文不进日志
    log.warn({ status: response.status, failure, model: config.model }, '近似重复判定调用失败')
    return { kind: 'unavailable', why: failure }
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { kind: 'unavailable', why: 'invalid_output' }
  }

  const envelope = parseChatEnvelope(payload)
  if (envelope === null) return { kind: 'unavailable', why: 'invalid_output' }
  // 被截断的输出即使碰巧是合法 JSON 也不采信：结论可能是半句话拼出来的
  if (envelope.finishReason === 'length') return { kind: 'unavailable', why: 'truncated' }

  const judgement = parseDupJudgement(envelope.content)
  if (judgement === null) return { kind: 'unavailable', why: 'invalid_output' }
  return { kind: 'judged', judgement }
}
