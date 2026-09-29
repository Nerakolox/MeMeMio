import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { parseName, parseNullableName } from '../lib/naming.js'
import { isUuid } from '../lib/uuid.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import { asJsonObject, jsonBody } from '../middleware/json-body.js'
import type {
  AssignmentTarget,
  PersonPatch,
} from '../data/persons.js'
import {
  assignMemesTo,
  getPerson,
  listPersonSuggestions,
  listPersonsPage,
  mergePersonsInto,
  patchPerson,
  rejectPersonPair,
  type PersonListQuery,
} from '../services/persons.js'

/**
 * `/api/v1/persons/*` —— 人物（SPEC §6.7，`proposed`）。
 *
 * 读（列表、详情、合并建议）在第一批，写（改名 / 合并 / 移图）在第二批，**同一个
 * Hono 实例**：`app.ts` 那条 `.route()` 链每断一次 RPC 类型就退化成 `any`
 * （`routes/config.ts` 顶部的注释）。
 *
 * 权限是**所有登录用户**（§6.7.1）：谁认出了这是谁，起个名字对所有人都是净收益。
 * 这里只有 `requireAuth` 一道，没有 `requireAdmin`——包括删除性的 merge：
 * SPEC §6.7.1 把「逐图过 `assertCanMutate`」放在数据层，路由不自己拼归属。
 *
 * 本文件不写 SQL、不判断归属（`AGENTS.md §5`），只做三件事：校验参数与请求体、
 * 调服务层、把结果按 §6.7.2 发出去（序列化在 `serialize/person.ts`）。
 *
 * ⚠️ **每个写接口都挂了 `jsonBody`**，否则 `web` 那边 `InferRequestType` 推不出请求体
 *    形状、只能手写一份（那两份迟早会漂）。它的实现与「为什么不用 `hono/validator`」
 *    写在 `middleware/json-body.ts` 顶部。
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

// ── 请求体（SPEC §6.7.4） ───────────────────────────────────────────
//
// 下面的 `*Body` 类型是**线上形状**，也就是 `web` 那边 `InferRequestType` 拿到的
// 东西。它们与解析结果分开写：解析结果里 `target` 那种判别联合是内部表示，
// 客户端发的是 §6.7.4 那张表里的三种键组合。见 `middleware/json-body.ts` 顶部。

/** `PATCH /persons/{id}` 的请求体。可空字段的 `null` 是「清空」，不是「不传」。 */
export type PersonPatchBody = PersonPatch

/** `POST /persons/{id}/merge` 的请求体。 */
export type MergeBody = { sourceIds: string[] }

/** `POST /persons/{id}/rejections` 的请求体。 */
export type RejectionBody = { otherId: string }

/**
 * `POST /persons/assignments` 的请求体：**三种形状恰好给一种**（§6.7.4）。
 *
 * 写成判别联合而不是「三个可选字段」，是因为后者允许 `{}`（都不给）和
 * `{ personId, none }`（给两种）通过类型检查——那两个正是服务端唯一会拒的形状。
 * 类型能挡掉的东西不要留给运行时。
 */
export type AssignmentsBody =
  | { memeIds: string[]; personId: string }
  | { memeIds: string[]; newPerson: { name?: string } }
  | { memeIds: string[]; none: true }

/** `PATCH /persons/{id}` 能改的四个字段。**别的键一律拒绝**（§0.4）。 */
const PERSON_PATCH_FIELDS = ['name', 'seriesId', 'coverMemeId', 'isHidden'] as const

/**
 * 可空 uuid 字段（`seriesId` / `coverMemeId`）：`null` 是「清空」，与「不传」不同。
 *
 * 形状在这里挡：不挡的话 `eq(persons.series_id, 'abc')` 撞 Postgres 的
 * `invalid input syntax for type uuid`，那是 500 而不是 400——客户端打了个错字，
 * 得到的是「服务器内部错误」。
 */
function parseNullableUuid(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new AppError('VALIDATION_FAILED', `${field} 必须是 uuid 或 null`)
  }
  return value
}

/** `isHidden` 只认真正的布尔值。`"true"` 这类字符串**不转换**：见下面那段理由。 */
function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AppError('VALIDATION_FAILED', `${field} 必须是布尔值`)
  }
  return value
}

/**
 * `{ name?, seriesId?, coverMemeId?, isHidden? }`，**部分更新**（§6.7.4）。
 *
 * ⚠️ **`"true"` 不当 `true`。** 查询参数那边（`readTriBool`）认字面量，因为 URL 里
 *    只有字符串；请求体里 JSON 有真布尔值，接受字符串等于承认两种写法，而
 *    `isHidden: "false"` 被当成字符串判真**会把一个人物隐藏起来**——客户端传错类型，
 *    界面上的表现是「这个人物不见了」。
 *
 * 四个字段全不传（`{}`）是合法的空操作，返回当前的人物，与 `PATCH /memes/{id}` 同口径。
 */
function parsePersonPatch(raw: unknown): PersonPatch {
  const body = asJsonObject(raw)

  for (const key of Object.keys(body)) {
    if (!(PERSON_PATCH_FIELDS as readonly string[]).includes(key)) {
      throw new AppError('VALIDATION_FAILED', `不可编辑的字段：${key}`)
    }
  }

  const patch: PersonPatch = {}
  if (body['name'] !== undefined) patch.name = parseNullableName(body['name'], 'name')
  if (body['seriesId'] !== undefined) {
    patch.seriesId = parseNullableUuid(body['seriesId'], 'seriesId')
  }
  if (body['coverMemeId'] !== undefined) {
    patch.coverMemeId = parseNullableUuid(body['coverMemeId'], 'coverMemeId')
  }
  if (body['isHidden'] !== undefined) patch.isHidden = parseBoolean(body['isHidden'], 'isHidden')
  return patch
}

/** 合并的上限（§6.7.4 的 1–20）。一次合掉几十组的界面不会存在，超了就是客户端出了问题。 */
const MERGE_MAX_SOURCES = 20

/** 一次移图的上限（§6.7.4 的 1–100）。 */
const ASSIGN_MAX_MEMES = 100

/**
 * 一组 uuid，**去重前的原样给出**，交给调用方判「有没有重复」。
 *
 * 重复必须报错而不是去重，两个接口都是：`merge` 里同一个来源给两次，客户端以为合了三组、
 * 实际合了两组，而响应是正确的——它只能靠自己数；`assignments` 里同一张图给两次，
 * `movedCount` 会报一个比实际改动多的数。**去重会让这两处静默地说谎。**
 */
function parseUuidArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) {
    throw new AppError('VALIDATION_FAILED', `${field} 必须是数组`)
  }
  if (value.length < 1) {
    throw new AppError('VALIDATION_FAILED', `${field} 不能为空`)
  }
  if (value.length > max) {
    throw new AppError('VALIDATION_FAILED', `${field} 最多 ${max} 个`)
  }
  for (const item of value) {
    if (typeof item !== 'string' || !isUuid(item)) {
      throw new AppError('VALIDATION_FAILED', `${field} 的每一项必须是 uuid`)
    }
  }
  const ids = value as string[]
  if (new Set(ids).size !== ids.length) {
    throw new AppError('VALIDATION_FAILED', `${field} 里不能有重复`)
  }
  return ids
}

/**
 * `{ sourceIds }`（§6.7.4）。
 *
 * **只判形状**，「里面有没有目标自己」留给 handler：`jsonBody` 的解析函数在
 * 注册路由时就固定了，拿不到 `:id`。这不是缺陷——`{id}` 是路径上的东西，
 * 而解析器只管请求体。
 */
function parseMergeBody(raw: unknown): { sourceIds: string[] } {
  const body = asJsonObject(raw)
  for (const key of Object.keys(body)) {
    if (key !== 'sourceIds') throw new AppError('VALIDATION_FAILED', `无法识别的字段：${key}`)
  }

  if (body['sourceIds'] === undefined) {
    throw new AppError('VALIDATION_FAILED', 'sourceIds 是必填的')
  }
  return { sourceIds: parseUuidArray(body['sourceIds'], 'sourceIds', MERGE_MAX_SOURCES) }
}

/** `{ otherId }`（§6.7.4）。同样只判形状，「和自己相同」在 handler 里判。 */
function parseRejectionBody(raw: unknown): { otherId: string } {
  const body = asJsonObject(raw)
  for (const key of Object.keys(body)) {
    if (key !== 'otherId') throw new AppError('VALIDATION_FAILED', `无法识别的字段：${key}`)
  }

  const otherId = body['otherId']
  if (typeof otherId !== 'string' || !isUuid(otherId)) {
    throw new AppError('VALIDATION_FAILED', 'otherId 必须是 uuid')
  }
  return { otherId }
}

/**
 * `POST /persons/assignments` 的请求体（§6.7.4）：三种去处**恰好给一种**。
 *
 * 判的是**键在不在**，不是值真不真：`{ memeIds, none: false }` 不是「都不给」，
 * 它是一个客户端以为自己在表达「设成不属于任何人物」之外的什么东西的请求。
 * 与 `parseRetagBody` 里 `memeIds: []` 那条同一个道理——「字段没内容」和「字段没给」
 * 在请求体里长得一样，而它们的后果完全不同。
 *
 * `newPerson.name` 可以不给（建一个未命名的人物，随后再命名）。
 */
function parseAssignmentBody(raw: unknown): { memeIds: string[]; target: AssignmentTarget } {
  const body = asJsonObject(raw)
  for (const key of Object.keys(body)) {
    if (key !== 'memeIds' && key !== 'personId' && key !== 'newPerson' && key !== 'none') {
      throw new AppError('VALIDATION_FAILED', `无法识别的字段：${key}`)
    }
  }

  if (body['memeIds'] === undefined) {
    throw new AppError('VALIDATION_FAILED', 'memeIds 是必填的')
  }
  const memeIds = parseUuidArray(body['memeIds'], 'memeIds', ASSIGN_MAX_MEMES)

  const given = (['personId', 'newPerson', 'none'] as const).filter((k) => body[k] !== undefined)
  if (given.length !== 1) {
    throw new AppError('VALIDATION_FAILED', 'personId、newPerson、none 必须恰好给一个')
  }

  if (body['none'] !== undefined) {
    if (body['none'] !== true) {
      throw new AppError('VALIDATION_FAILED', 'none 只能是 true')
    }
    return { memeIds, target: { kind: 'none' } }
  }

  if (body['personId'] !== undefined) {
    const personId = body['personId']
    if (typeof personId !== 'string' || !isUuid(personId)) {
      throw new AppError('VALIDATION_FAILED', 'personId 必须是 uuid')
    }
    return { memeIds, target: { kind: 'person', personId } }
  }

  const newPerson = asJsonObject(body['newPerson'])
  for (const key of Object.keys(newPerson)) {
    if (key !== 'name') throw new AppError('VALIDATION_FAILED', `无法识别的字段：newPerson.${key}`)
  }
  const name = newPerson['name'] === undefined ? null : parseName(newPerson['name'], 'newPerson.name')
  return { memeIds, target: { kind: 'new', name } }
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

  /**
   * POST /api/v1/persons/assignments —— 把几张图放进 / 拆出 / 移出人物（SPEC §6.7.4）。
   *
   * ⚠️ **注册在 `/:id/...` 那两条之前**，与 `GET /memes/tag-status` 同一个理由：
   *    Hono 按注册顺序匹配，而 `/assignments` 与 `/:id` 长的是一段路径——今天没有
   *    `POST /:id` 所以撞不上，但那天加了它，`/assignments` 会被当成一个 id
   *    （`requirePersonId` 判它形状不合法，回 `NOT_FOUND`），而**没有任何测试会红**。
   *
   * `movedCount` 是这次请求涉及几张图，不是改动了几行：**同一张图放回原处也算**。
   * 客户端拿它显示「已移动 N 张」，报的是它请求的范围。
   */
  .post(
    '/assignments',
    jsonBody<AssignmentsBody, { memeIds: string[]; target: AssignmentTarget }>(
      parseAssignmentBody,
    ),
    async (c) => {
      const actor = c.get('currentUser')
      const { memeIds, target } = c.req.valid('json')
      return c.json(await assignMemesTo(memeIds, target, actor))
    },
  )

  /**
   * PATCH /api/v1/persons/{id} —— 改名 / 改系列 / 指定封面 / 隐藏（SPEC §6.7.4）。
   *
   * 响应是**更新后的完整 Person**，与 `GET /{id}` 同形：客户端据此就地更新列表，
   * 不用再拉一次。人物不存在（或图全被软删）是 `NOT_FOUND`，与 `GET` 同一条判据。
   *
   * 归属判定**不在这里**，也不在服务层：这些是人物自己的属性，逐图的操作才过
   * `assertCanMutate`（在 `data/persons.ts` 的 `assignMemes` 里）。handler 里
   * 「顺手补一个检查」哪怕写对了也是错的（`AGENTS.md §5`）。
   */
  .patch('/:id', jsonBody<PersonPatchBody>(parsePersonPatch), async (c) => {
    const actor = c.get('currentUser')
    const id = requirePersonId(c.req.param('id'))

    const updated = await patchPerson(id, c.req.valid('json'), actor)
    if (updated === null) throw new AppError('NOT_FOUND', '这个人物不存在')

    return c.json(updated)
  })

  /**
   * POST /api/v1/persons/{id}/merge —— 把几组合到这一组（SPEC §6.7.4）。
   *
   * **不可撤销**，而且它删掉的是别人挑过的分组。响应是合并后的目标 Person，
   * 客户端拿它替换掉那几个来源。
   *
   * 整个请求在一个事务里：任何一个人物不存在就 `NOT_FOUND` 且**什么都不改**
   * （半合并的状态是这里最坏的失败——图搬过去了、来源还在，两边各显示一部分）。
   */
  .post('/:id/merge', jsonBody<MergeBody>(parseMergeBody), async (c) => {
    const actor = c.get('currentUser')
    const id = requirePersonId(c.req.param('id'))
    const { sourceIds } = c.req.valid('json')

    // 「sourceIds 里有自己」与「有重复」是同一类错：客户端把选中项拼错了。
    // 含自己在内也会让数据层去删目标自己，所以这一条必须在进事务之前挡掉。
    if (sourceIds.includes(id)) {
      throw new AppError('VALIDATION_FAILED', 'sourceIds 里不能有自己')
    }

    const merged = await mergePersonsInto(id, sourceIds, actor)
    if (merged === null) throw new AppError('NOT_FOUND', '这个人物不存在')

    return c.json(merged)
  })

  /**
   * POST /api/v1/persons/{id}/rejections —— 记一条「不是同一个」（SPEC §6.7.4）。
   *
   * `204`，**幂等**：重复记同一条不是错误，客户端双击、重试都该成功。
   * 与 DELETE 那两条刻意不同——那些是不幂等的（§6.4.2）。
   */
  .post('/:id/rejections', jsonBody<RejectionBody>(parseRejectionBody), async (c) => {
    const actor = c.get('currentUser')
    const id = requirePersonId(c.req.param('id'))
    const { otherId } = c.req.valid('json')

    if (otherId === id) {
      throw new AppError('VALIDATION_FAILED', 'otherId 不能和自己相同')
    }

    await rejectPersonPair(id, otherId, actor)
    return c.body(null, 204)
  })
