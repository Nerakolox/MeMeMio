/**
 * 近似重复判定的输出解析。SPEC §9.33。
 *
 * 纯函数。模型的输出**不可信**（ai-providers.md）：这里的原则是「宁可判 `unsure`，
 * 也不把一句看不懂的话读成 `same`」——`same` 会删掉用户的暂存文件，不可撤销；
 * `unsure` 只是回到待确认队列，让人看一眼。
 */

export type DupVerdict = 'same' | 'different' | 'unsure'

export type DupJudgement = {
  verdict: DupVerdict
  /** 模型给的一句话理由。给人看的，不是给程序分支的。 */
  reason: string
}

/** 理由进库、进 SSE，长度必须有上限，模型不会自觉。 */
export const DUP_REASON_MAX_CHARS = 200

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/

function extractJsonObject(raw: string): string | null {
  const fenced = FENCE.exec(raw)
  const text = (fenced?.[1] ?? raw).trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

/**
 * 解析模型的判定正文。任何不合规的输出都返回 `null`，由调用方落成 `unsure`。
 *
 * `verdict` 只认三个字面值（忽略大小写和首尾空白）。**不做模糊匹配**：
 * 「基本相同」「almost the same」不是 `same`。
 */
export function parseDupJudgement(content: string): DupJudgement | null {
  const json = extractJsonObject(content)
  if (json === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const { verdict, reason } = parsed as { verdict?: unknown; reason?: unknown }
  if (typeof verdict !== 'string') return null

  const normalized = verdict.trim().toLowerCase()
  if (normalized !== 'same' && normalized !== 'different' && normalized !== 'unsure') return null

  const text = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ') : ''
  return { verdict: normalized, reason: text.slice(0, DUP_REASON_MAX_CHARS) }
}
