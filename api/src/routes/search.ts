import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { optionalAuth, type OptionalAuthVariables } from '../middleware/auth.js'
import { db as defaultDb } from '../data/db.js'
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, searchMemes } from '../services/search.js'
import { serializeMeme } from '../serialize/meme.js'

/**
 * GET /api/v1/search —— 三路融合检索（SPEC §6.3.1）。
 *
 * 与浏览（§6.3.2）是两条独立路径：搜索不分页、不带筛选条件、结果按 RRF 融合分排序。
 * 别把 `cursor` 加进来——融合分不是稳定可续的游标，分页会把 RRF 的排序切坏。
 */

// 浏览接口用 optionalAuth，搜索同理：未登录也能搜，只是 favorited 恒为 false
type Vars = OptionalAuthVariables

export const searchRoutes = new Hono<{ Variables: Vars }>()
  .use('*', optionalAuth)

  .get('/', async (c) => {
    const q = (c.req.query('q') ?? '').trim()
    if (q === '') {
      // 缺 q 和 q 是空白串对客户端是同一件事：没有查询词。都给 400，不要返回全库
      throw new AppError('VALIDATION_FAILED', '缺少查询参数 q')
    }

    const limitRaw = c.req.query('limit')
    let limit = DEFAULT_SEARCH_LIMIT
    if (limitRaw !== undefined) {
      limit = Number(limitRaw)
      if (!Number.isInteger(limit) || limit < 1) {
        throw new AppError('VALIDATION_FAILED', 'limit 必须是正整数')
      }
      // 超过上限时**截断而不是报错**：这是上限，不是校验规则
      if (limit > MAX_SEARCH_LIMIT) limit = MAX_SEARCH_LIMIT
    }

    const actor = c.get('currentUser')
    const requestId = c.get('requestId')

    const outcome = await searchMemes(q, limit, actor?.id ?? null, requestId, defaultDb)

    return c.json({
      items: outcome.items.map((item) => ({ ...serializeMeme(item), matchedBy: item.matchedBy })),
      degraded: outcome.degraded,
      rewritten: outcome.rewritten,
    })
  })
