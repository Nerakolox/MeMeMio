import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { isUuid } from '../lib/uuid.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import {
  getPerson,
  listPersonSuggestions,
  listPersonsPage,
  type PersonListQuery,
} from '../services/persons.js'

/**
 * `/api/v1/persons/*` —— 人物（SPEC §6.7，`proposed`）。
 *
 * 第一批只有**读**：列表、详情、合并建议。改名 / 合并 / 移图那些写在第二批，
 * 它们会是同一个路由组里的 `PATCH` / `POST`——**不要另开一个实例**，`app.ts` 那条链
 * 每断一次 RPC 类型就退化成 `any`（`routes/config.ts` 顶部的注释）。
 *
 * 权限是**所有登录用户**（§6.7.1）：谁认出了这是谁，起个名字对所有人都是净收益。
 * 这里只有 `requireAuth` 一道，没有 `requireAdmin`。
 *
 * 本文件不写 SQL、不判断归属（`AGENTS.md §5`），只做三件事：校验查询参数、
 * 调服务层、把结果按 §6.7.2 发出去（序列化在 `serialize/person.ts`）。
 */

/**
 * `:id` 路径参数的 uuid 形状校验。规则与 `routes/memes.ts` 的 `requireUuidId` 逐字
 * 相同：**不挡的话 `eq(persons.id, 'abc')` 会撞 Postgres 的 `invalid input syntax for
 * type uuid`，那是 500 而不是 404**。报 404 而不是 400：路径上的资源不存在，
 * 而「形状合法但库里没有」对客户端是同一件事。
 */
function requirePersonId(raw: string | undefined): string {
  if (raw === undefined || !isUuid(raw)) throw new AppError('NOT_FOUND', '这个人物不存在')
  return raw
}

/**
 * 三态的布尔查询参数（`named` / `hidden`）。
 *
 * ⚠️ **只认 `true` / `false` 两个字面量，别的值报 `VALIDATION_FAILED`。**
 *    与 `GET /memes` 的 `isAnimated`（非 `true` 一律当 false）**刻意不同**：
 *    那边是既有的线上行为、而且「当 false」对它是无害的保守取值；这边是新端点，
 *    而这里「当没传」的后果是**静默放宽**——`named=1` 会返回未命名的，
 *    `hidden=yes` 会把隐藏的那批人铺满 modal，两个都是客户端看不出自己传错了。
 *
 * 空串按不传：前端清掉筛选时可能留下一个空键（与 `q` 同口径）。
 */
function readTriBool(
  c: { req: { query: (key: string) => string | undefined } },
  field: 'named' | 'hidden',
): boolean | undefined {
  const raw = c.req.query(field)
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (value === '') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new AppError('VALIDATION_FAILED', `${field} 只能是 true 或 false`)
}

/**
 * `series` 有两个形态：具体 id，或 `none`（不属于任何系列，§6.7.3）。
 * **没有第三种**——别的写法是参数写错了，不是「查不到」。
 */
function readSeriesFilter(
  c: { req: { query: (key: string) => string | undefined } },
): string | undefined {
  const raw = c.req.query('series')
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (value === '') return undefined
  if (value === 'none') return 'none'
  if (!isUuid(value)) {
    throw new AppError('VALIDATION_FAILED', 'series 必须是 uuid 或 none')
  }
  return value
}

/** 共用的 `limit` / `minCount` 解析。**形状先挡掉**，负数与小数都不进数据层。 */
function readPositiveInt(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new AppError('VALIDATION_FAILED', `${field} 必须是正整数`)
  }
  return n
}

export const personsRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', requireAuth)

  /**
   * GET /api/v1/persons —— 人物列表（SPEC §6.7.3）。
   *
   * `q` 去首尾空白后为空按不传，与 `GET /memes` 的 `q` 同一个口径：用户清空名字过滤框
   * 是常规操作，不是非法请求。
   *
   * ⚠️ **图数为 0 的人物不在这里过滤**，那是数据层 `join live` 内连接的事。
   *    在这一层再滤一遍会让分页少给几格，而游标是按图数排的。
   */
  .get('/', async (c) => {
    const minCountRaw = c.req.query('minCount')
    const minCount = readPositiveInt(minCountRaw, 'minCount')

    const query: PersonListQuery = {
      q: (c.req.query('q') ?? '').trim() || undefined,
      series: readSeriesFilter(c),
      named: readTriBool(c, 'named'),
      hidden: readTriBool(c, 'hidden'),
      minCount,
      cursor: c.req.query('cursor') ?? undefined,
      limit: readPositiveInt(c.req.query('limit'), 'limit'),
    }

    return c.json(await listPersonsPage(query))
  })

  /**
   * GET /api/v1/persons/{id} —— 单个。**图全被软删时 `NOT_FOUND`**（§5.7.4）：
   * 那个人物的行还在（图被恢复时跟着回来），但它此刻不该出现在任何地方。
   *
   * ⚠️ 这个 handler 与下面的 `/suggestions` **不能靠注册顺序区分**（路径不同），
   *    但别把某天要加的静态子路径（比如 `/persons/unnamed`）注册在它后面——
   *    Hono 按注册顺序匹配，那个坑 `GET /memes/tag-status` 踩过。
   */
  .get('/:id', async (c) => {
    const person = await getPerson(requirePersonId(c.req.param('id')))
    if (person === null) throw new AppError('NOT_FOUND', '这个人物不存在')
    return c.json(person)
  })

  /**
   * GET /api/v1/persons/{id}/suggestions —— 「可能是同一个」（SPEC §6.7.3）。
   *
   * 最多 3 条、最像的在前、可以为空。**响应里没有任何相似度数值**——给的是顺序，
   * 客户端照着渲染就行（§6.7.2：数值一旦外露，前端就会长出第二套阈值）。
   *
   * ⚠️ 这里**先确认这个人物存在**，再算建议。少这一步的话，一个不存在（或图全被软删）
   *    的 id 会拿到一个空数组而不是 `NOT_FOUND`，而这两种情况对客户端是不一样的：
   *    前者要报错，后者要渲染「暂时没有可合并的」。
   */
  .get('/:id/suggestions', async (c) => {
    const id = requirePersonId(c.req.param('id'))
    const person = await getPerson(id)
    if (person === null) throw new AppError('NOT_FOUND', '这个人物不存在')

    return c.json({ items: await listPersonSuggestions(id) })
  })
