import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { isUuid } from '../lib/uuid.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import { getSeries, listSeriesPage, type SeriesListQuery } from '../services/persons.js'

/**
 * `/api/v1/series/*` —— 系列（SPEC §6.7，`proposed`）。
 *
 * 第一批只有**读**：列表、详情。新建 / 改名 / 改成员 / 删除在第二批，
 * 同一个路由组往下加（不要另开实例，理由见 `routes/config.ts` 顶部）。
 *
 * **系列与人物是两个前缀**，所以是两个 Hono 实例——`app.ts` 的 `.route()` 只接受
 * 一个完整前缀。它们的**服务层是同一个**（`services/persons.ts`）：封面回落、
 * 序列化那套逻辑两边一样，只有「图数怎么算」不同（系列是它下面人物的图数之和）。
 */

/** 与 `routes/persons.ts` 的同名函数逐字同理：形状不合法报 `NOT_FOUND`，不是 400。 */
function requireSeriesId(raw: string | undefined): string {
  if (raw === undefined || !isUuid(raw)) throw new AppError('NOT_FOUND', '这个系列不存在')
  return raw
}

/**
 * GET /api/v1/series —— 系列列表（SPEC §6.7.3）。只接受 `q`，排序与人物相同
 * （`memeCount desc, id`）。
 *
 * **空系列会出现**（§6.7.3：系列不论空不空都在），封面为 null——刚建好、还没挑人物的
 * 系列正是这个状态，把它吞掉的表现是「新建完之后它不见了」，不报错。
 */
export const seriesRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', requireAuth)

  .get('/', async (c) => {
    const limitRaw = c.req.query('limit')
    let limit: number | undefined
    if (limitRaw !== undefined && limitRaw.trim() !== '') {
      limit = Number(limitRaw)
      if (!Number.isInteger(limit) || limit < 1) {
        throw new AppError('VALIDATION_FAILED', 'limit 必须是正整数')
      }
    }

    const query: SeriesListQuery = {
      q: (c.req.query('q') ?? '').trim() || undefined,
      cursor: c.req.query('cursor') ?? undefined,
      limit,
    }

    return c.json(await listSeriesPage(query))
  })

  .get('/:id', async (c) => {
    const series = await getSeries(requireSeriesId(c.req.param('id')))
    if (series === null) throw new AppError('NOT_FOUND', '这个系列不存在')
    return c.json(series)
  })
