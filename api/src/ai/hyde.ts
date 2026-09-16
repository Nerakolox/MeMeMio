import { env } from '../env.js'
import { log } from '../logger.js'
import {
  asCredentials,
  fetchWithTimeout,
  HYDE_TIMEOUT_MS,
  joinEndpoint,
} from './provider.js'

/**
 * HyDE：把用户的短口语查询改写成一句库里那种长描述，再拿去做向量检索。
 *
 * 用户输入「今天真的不想上班」是一句短口语，库里存的是「一只趴在桌上的猫，看起来
 * 非常疲惫……」这样的长描述。**短句对长文的向量匹配效果一般**，所以先改写（SPEC §9.10）。
 *
 * ⚠️ **失败不阻断搜索。** 改写是锦上添花：
 *   - 没配置模型 → 直接用原查询，`rewritten: null`
 *   - 超时（2s）→ 同上，**不值得让搜索等它**
 *   - 返回垃圾 → 校验不过就丢弃，不能让一段胡说八道去污染向量检索
 */

/** 与打标提示词一样，词表和固定指令放最前面能吃到服务端前缀缓存（ai-providers.md §6）。 */
const SYSTEM_PROMPT =
  '你把用户的口语化检索意图改写成一句具体的画面描述，用于在表情包库里做语义检索。'
  + '只输出那一句描述本身，不要解释、不要引号、不要分点。中文，40 字以内。'

/** 超过这个长度就不像是「一句画面描述」了，多半是模型在解释自己。 */
const MAX_REWRITE_LENGTH = 120

export function stripRewrite(raw: string): string | null {
  // 模型经常把整句包在引号里，或者带一个「描述：」的前缀
  const text = raw.trim().replace(/^["'「『]|["'」』]$/g, '').replace(/^(描述|改写)[:：]\s*/, '')
  if (text === '' || text.length > MAX_REWRITE_LENGTH) return null
  return text
}

type ChatResponse = {
  choices?: { message?: { content?: unknown } }[]
}

function parseContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const content = (payload as ChatResponse).choices?.[0]?.message?.content
  return typeof content === 'string' ? content : null
}

/**
 * @returns 改写后的查询；**任何一步失败都返回 null**，调用方拿原查询继续走三路。
 */
export async function rewriteQuery(
  query: string,
  requestId: string,
): Promise<string | null> {
  // 用的是**搜索者本人**配置的视觉通道，纯文本调用（retrieval.md §3）。
  // 用户侧的视觉配置存在 user_ai_configs 里，那一层（SPEC §6.5）还没实现，
  // 所以现在只有部署方默认值可回退——和 embedding 一个处境。
  const credentials = asCredentials(env.defaultVision)
  if (credentials === null) {
    log.info({ requestId, reason: 'not_configured' }, 'hyde skipped, falling back to raw query')
    return null
  }

  let response: Response
  try {
    response = await fetchWithTimeout(
      joinEndpoint(credentials.baseUrl, '/v1/chat/completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.apiKey}`,
        },
        body: JSON.stringify({
          model: credentials.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: query },
          ],
        }),
      },
      HYDE_TIMEOUT_MS,
    )
  } catch {
    // 超时和网络错误在这里是同一件事：这一次改写赶不上了。不记 err 原文 ——
    // 中转服务的报错可能回显 Authorization（error-handling.md §4）。
    log.warn({ requestId, reason: 'unreachable' }, 'hyde failed, falling back to raw query')
    return null
  }

  if (!response.ok) {
    log.warn({ requestId, status: response.status }, 'hyde failed, falling back to raw query')
    return null
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    log.warn({ requestId, reason: 'invalid_json' }, 'hyde failed, falling back to raw query')
    return null
  }

  const content = parseContent(payload)
  const rewritten = content === null ? null : stripRewrite(content)
  if (rewritten === null) {
    log.warn({ requestId, reason: 'empty_or_implausible' }, 'hyde discarded')
    return null
  }

  return rewritten
}
