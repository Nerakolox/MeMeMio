import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { parseName } from '../lib/naming.js'
import { isUuid } from '../lib/uuid.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import { asJsonObject, jsonBody } from '../middleware/json-body.js'
import {
  createNewSeries,
  getSeries,
  listSeriesPage,
  patchSeries,
  removeSeries,
  type SeriesListQuery,
} from '../services/persons.js'

/**
 * `/api/v1/series/*` —— 系列（SPEC §6.7，`proposed`）。
 *
 * 读（列表、详情）在第一批，写（新建 / 改名 / 改成员 / 删除）在第二批，**同一个
 * Hono 实例**：每断一次 `.route()` 链 RPC 类型就退化成 `any`（`routes/config.ts` 顶部）。
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
 * `POST /series` 的请求体（线上形状）：`personIds` 不给 = 空系列。
 *
 * 与下面的 `PatchSeriesBody` **分开写而不是共用一个 `{name?, personIds?}`**：
 * 新建时 `name` 是必填的，改名时可以不给。合并成一个类型得靠服务端在运行时补回这条
 * 区别，而客户端会在编译期就以为自己可以不写名字。
 */
export type CreateSeriesBody = { name: string; personIds?: string[] }

/** `PATCH /series/{id}` 的请求体：两个字段都可以只给一个，**`name` 不能是 `null`**。 */
export type PatchSeriesBody = { name?: string; personIds?: string[] }

/**
 * `personIds`：成员名单，**可以给空数组**（把所有人移出系列，§6.7.4）。
 *
 * 与 `merge` / `assignments` 那两个数组**刻意不同**：那里空数组是「客户端没选东西」，
 * 是一次误操作；这里是「这个系列暂时不放了」，是一个正常的中间状态——刚建好的系列
 * 正是空的（§6.7.3：空系列照样出现在列表里）。
 */
function parsePersonIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AppError('VALIDATION_FAILED', 'personIds 必须是数组')
  }
  for (const item of value) {
    if (typeof item !== 'string' || !isUuid(item)) {
      throw new AppError('VALIDATION_FAILED', 'personIds 的每一项必须是 uuid')
    }
  }
  const ids = value as string[]
  if (new Set(ids).size !== ids.length) {
    throw new AppError('VALIDATION_FAILED', 'personIds 里不能有重复')
  }
  return ids
}

/** `POST /series`：`{ name, personIds? }`（§6.7.4）。 */
function parseCreateSeriesBody(raw: unknown): { name: string; personIds: string[] } {
  const body = asJsonObject(raw)
  for (const key of Object.keys(body)) {
    if (key !== 'name' && key !== 'personIds') {
      throw new AppError('VALIDATION_FAILED', `无法识别的字段：${key}`)
    }
  }

  if (body['name'] === undefined) throw new AppError('VALIDATION_FAILED', 'name 是必填的')
  return {
    name: parseName(body['name'], 'name'),
    personIds: body['personIds'] === undefined ? [] : parsePersonIds(body['personIds']),
  }
}

/** `PATCH /series/{id}`：`{ name?, personIds? }`，两个都可以只给一个。 */
function parsePatchSeriesBody(raw: unknown): { name?: string; personIds?: string[] } {
  const body = asJsonObject(raw)
  for (const key of Object.keys(body)) {
    if (key !== 'name' && key !== 'personIds') {
      throw new AppError('VALIDATION_FAILED', `无法识别的字段：${key}`)
    }
  }

  const patch: { name?: string; personIds?: string[] } = {}
  // 系列名**不能清空**（它是系列的标识，`null` 没有意义），所以这里用 `parseName`
  // 而不是 `parseNullableName`：`name: null` 报 400，而不是静默当成「不改」。
  if (body['name'] !== undefined) patch.name = parseName(body['name'], 'name')
  if (body['personIds'] !== undefined) patch.personIds = parsePersonIds(body['personIds'])
  return patch
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

  /**
   * POST /api/v1/series —— 新建（SPEC §6.7.4）。
   *
   * 状态码是 **200**，与 `POST /admin/invites` 的 201 刻意不同：SPEC 只在需要的时候
   * 写明状态码（204 出现在 rejections 与 DELETE 上），别的端点一律 200。`POST /series`
   * 没有写，就按 200 走——凭据是「不引入 SPEC 里没有的东西」（`AGENTS.md §4`）。
   *
   * 名字撞车是 `CONFLICT`（§2.3），不是 400：字面没问题，是这个值已经被占了。
   */
  .post('/', jsonBody<CreateSeriesBody, { name: string; personIds: string[] }>(parseCreateSeriesBody), async (c) => {
    const actor = c.get('currentUser')
    const { name, personIds } = c.req.valid('json')
    return c.json(await createNewSeries(name, personIds, actor))
  })

  /**
   * PATCH /api/v1/series/{id} —— 改名 / 改成员（SPEC §6.7.4）。
   *
   * ⚠️ **`personIds` 是完整成员名单，不是增量**：没列出的原成员移出系列。界面上是
   *    「勾选哪些人物属于它」，整份提交与之对应。当成增量的话，界面上取消勾选一个人物
   *    会**什么都没发生**——不报错，只是那个人物还在系列里。
   */
  .patch('/:id', jsonBody<PatchSeriesBody>(parsePatchSeriesBody), async (c) => {
    const actor = c.get('currentUser')
    const id = requireSeriesId(c.req.param('id'))

    const updated = await patchSeries(id, c.req.valid('json'), actor)
    if (updated === null) throw new AppError('NOT_FOUND', '这个系列不存在')
    return c.json(updated)
  })

  /**
   * DELETE /api/v1/series/{id} —— 204（SPEC §6.7.4）。
   *
   * **权限是「创建者或 admin」**，与删图同一个不对称（§6.7.1）：删掉的是别人挑选人物的
   * 工作，而且不可撤销。判定在 `data/persons.ts` 的 `deleteSeries` 里，**这里不重复判**
   * （`AGENTS.md §5`）——写对了也是错的，下一个人会照着它再写一遍。
   *
   * 删的只是 `series` 这一行：其下人物的 `series_id` 由外键置空，人物与图都不动。
   */
  .delete('/:id', async (c) => {
    const actor = c.get('currentUser')
    await removeSeries(requireSeriesId(c.req.param('id')), actor)
    return c.body(null, 204)
  })
