import {
  addPersonRejection,
  assignMemes,
  createSeries,
  decodePersonListCursor,
  deleteSeries,
  findPersonById,
  findPersonSummariesByIds,
  findSeriesById,
  listPersons,
  listSeries,
  listSuggestedPersonIds,
  mergePersons,
  resolvePersonCovers,
  updatePerson,
  updateSeries,
  type AssignmentTarget,
  type LiveCover,
  type PersonListParams,
  type PersonPatch,
  type PersonSummary,
  type SeriesListParams,
  type SeriesSummaryWithCoverPerson,
} from '../data/persons.js'
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, type Actor } from '../data/memes.js'
import { log } from '../logger.js'
import { serializePerson, serializeSeries } from '../serialize/person.js'
import type { SerializedPerson, SerializedSeries } from '../serialize/person.js'

/**
 * 人物与系列的**读路径**编排（SPEC §6.7.3）。
 *
 * 这一层存在的理由与 `services/search.ts` 相同：`routes/` 只做参数校验和 JSON，
 * 而「取一页人物 → 补封面 → 序列化」是三件事，其中一件（补封面）要额外一次查询。
 * 把它写在 handler 里，第二个用到同一形状的 handler（详情、建议、合并响应）就会
 * 各写一遍，然后在「封面那一张刚被软删时怎么办」上分叉。
 *
 * ⚠️ **本文件不写 SQL**：所有查询在 `data/persons.ts`，软删过滤也在那儿
 *    （那里导入 `LIVE_MEME`，全项目唯一的软删判断）。这一层只负责顺序和形状。
 */

export type PersonListQuery = {
  /** 名字包含，去首尾空白。空串按不传（handler 已经 trim 过）。 */
  q?: string
  /** 系列 id、`none`，或 `none` 之外的 uuid。 */
  series?: string
  named?: boolean
  hidden?: boolean
  minCount?: number
  /** **原始游标串**，解码在数据层（解不出来报 VALIDATION_FAILED，不当没传）。 */
  cursor?: string
  limit?: number
}

export type SeriesListQuery = {
  q?: string
  cursor?: string
  limit?: number
}

/** 一页的条数上限与默认值，与 `GET /memes` 共用同一对数（SPEC §1.3）。 */
function clampLimit(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
}

/**
 * 人物列表。
 *
 * ⚠️ **图数为 0 的人物的处理全在数据层**（`join live`，内连接）：这里不做二次过滤，
 *    做了的话分页会少给几格，而游标是按图数排的——表现是翻页越过一整档。
 */
export async function listPersonsPage(
  query: PersonListQuery,
): Promise<{ items: SerializedPerson[]; nextCursor: string | null }> {
  const cursor = query.cursor === undefined ? null : decodePersonListCursor(query.cursor)

  const params: PersonListParams = {
    q: query.q,
    series: query.series,
    named: query.named,
    hidden: query.hidden,
    minCount: query.minCount,
    cursor,
    limit: clampLimit(query.limit),
  }

  const { items, nextCursor } = await listPersons(params)
  return { items: await withCovers(items), nextCursor }
}

/** 单个。图全被软删时返回 null，调用方报 `NOT_FOUND`（§5.7.4 / §6.7.3）。 */
export async function getPerson(id: string): Promise<SerializedPerson | null> {
  const summary = await findPersonById(id)
  if (summary === null) return null

  const [serialized] = await withCovers([summary])
  return serialized ?? null
}

/**
 * 「可能是同一个」（SPEC §6.7.3）：最多 3 条，最像的在前，可以为空。
 *
 * ⚠️ **顺序必须按 `listSuggestedPersonIds` 给的来。** `findPersonSummariesByIds`
 *    是 `where id in (...)`，Postgres 不保证顺序——照它的返回顺序发出去，
 *    「最像的在前」就变成了「随机的在前」，而**没有任何地方会报错**。
 *
 * 不含隐藏的人物、不含点过「不是同一个」的、不含图数归零的：三条都在数据层的
 * WHERE 里（那一条最容易被当成「顺手在这里也判一下」，判了就会和那边漂移）。
 */
export async function listPersonSuggestions(id: string): Promise<SerializedPerson[]> {
  const ids = await listSuggestedPersonIds(id)
  if (ids.length === 0) return []

  const summaries = await findPersonSummariesByIds(ids)
  const byId = new Map(summaries.map((s) => [s.id, s]))
  const ordered = ids
    .map((suggestedId) => byId.get(suggestedId))
    .filter((s): s is PersonSummary => s !== undefined)

  return withCovers(ordered)
}

/** 系列列表。**空系列照样出现**（§6.7.3），数据层用 `left join` 保证。 */
export async function listSeriesPage(
  query: SeriesListQuery,
): Promise<{ items: SerializedSeries[]; nextCursor: string | null }> {
  const cursor = query.cursor === undefined ? null : decodePersonListCursor(query.cursor)

  const params: SeriesListParams = { q: query.q, cursor, limit: clampLimit(query.limit) }
  const { items, nextCursor } = await listSeries(params)
  return { items: await withSeriesCovers(items), nextCursor }
}

/** 单个系列。**空系列照样返回**，只有不存在才是 null。 */
export async function getSeries(id: string): Promise<SerializedSeries | null> {
  const summary = await findSeriesById(id)
  if (summary === null) return null

  const [serialized] = await withSeriesCovers([summary])
  return serialized ?? null
}

// ── 写路径编排（SPEC §6.7.4） ──────────────────────────────────────
//
// 写接口的编排比读接口少一层：数据层已经把「不存在」表达成 `null`（人物）或
// 抛 `AppError`（引用校验），服务层只剩**把结果补上封面并序列化**。所以这一节里
// 每个函数都只有几行，那几行里唯一有内容的是 `serializeOne` 的取舍，见它自己的注释。

/**
 * 把一个人物序列化出去，**补不上封面时返回 null**。
 *
 * 写接口的响应与 `GET /persons/{id}` 用同一条口径：`Person.cover` 非空
 * （§6.7.2），凑不出封面就说明这个人物对客户端不存在，调用方报 `NOT_FOUND`。
 * 正常的写路径**不会**走到那一支（能改能合并的人物至少有 1 张还在的图，§5.7.4），
 * 走到就是「改的这一刻它最后一张图被软删了」——那正是该说 404 的时候。
 */
async function serializeOne(summary: PersonSummary | null): Promise<SerializedPerson | null> {
  if (summary === null) return null
  const [serialized] = await withCovers([summary])
  return serialized ?? null
}

/** `PATCH /persons/{id}`。`null` = 这个人物不存在或已空（§5.7.4）。 */
export async function patchPerson(
  id: string,
  patch: PersonPatch,
  actor: Actor,
): Promise<SerializedPerson | null> {
  return serializeOne(await updatePerson(id, patch, actor))
}

/** `POST /persons/{id}/merge`。目标是 `null` 时整个请求在数据层就抛了 `NOT_FOUND`。 */
export async function mergePersonsInto(
  targetId: string,
  sourceIds: string[],
  actor: Actor,
): Promise<SerializedPerson | null> {
  return serializeOne(await mergePersons(targetId, sourceIds, actor))
}

/** `POST /persons/{id}/rejections`。**没有返回值**，路由固定给 204（§6.7.4）。 */
export async function rejectPersonPair(
  id: string,
  otherId: string,
  actor: Actor,
): Promise<void> {
  await addPersonRejection(id, otherId, actor)
}

/**
 * `POST /persons/assignments`（§6.7.4）。
 *
 * ⚠️ 数据层返回的 `person` 已经是在**那个事务里**读出来的，所以这里只补封面。
 *    让路由拿着 `movedCount` 和 `person` 直接组响应，中间不再查库。
 */
export async function assignMemesTo(
  memeIds: string[],
  target: AssignmentTarget,
  actor: Actor,
): Promise<{ movedCount: number; person: SerializedPerson | null }> {
  const outcome = await assignMemes(memeIds, target, actor)
  return { movedCount: outcome.movedCount, person: await serializeOne(outcome.person) }
}

/** `POST /series`。系列永远序列化得出来（封面可空），所以不返回 `null`。 */
export async function createNewSeries(
  name: string,
  personIds: string[],
  actor: Actor,
): Promise<SerializedSeries> {
  const [serialized] = await withSeriesCovers([await createSeries(name, personIds, actor)])
  if (serialized === undefined) throw new Error('系列序列化失败')
  return serialized
}

/** `PATCH /series/{id}`。`null` = 不存在。 */
export async function patchSeries(
  id: string,
  patch: { name?: string; personIds?: string[] },
  actor: Actor,
): Promise<SerializedSeries | null> {
  const summary = await updateSeries(id, patch, actor)
  if (summary === null) return null
  const [serialized] = await withSeriesCovers([summary])
  return serialized ?? null
}

/** `DELETE /series/{id}`：权限与「已删」都在数据层，`FORBIDDEN` / `NOT_FOUND` 由它抛。 */
export async function removeSeries(id: string, actor: Actor): Promise<void> {
  await deleteSeries(id, actor)
}

// ── 封面 ───────────────────────────────────────────────────────────

/**
 * 给一页人物补上「一张还活着的封面」。
 *
 * ⚠️ **取不到封面的那一格被丢掉。** 它不是不可能发生的：图数、封面是两次查询，
 *    中间有人把这个人物最后一张图软删了，封面就没了（§5.7.4 的规则是「图全被软删
 *    的人物不出现」——那一格现在正是这个状态）。
 *
 *    丢一格而不是报错：这一页的其余内容仍然是对的，而 500 会让整个浏览面打不开。
 *    **也不能给 `cover: null`**：Person 的 `cover` 在 SPEC §6.7.2 里是非空的，
 *    放宽它等于让前端每个消费点都多一个分支，去处理一个它本来就该看不见的人物。
 *    少见但会发生，所以留一条 warn——它是「列表比预期少一格」的唯一痕迹。
 */
async function withCovers(summaries: PersonSummary[]): Promise<SerializedPerson[]> {
  if (summaries.length === 0) return []

  const covers = await resolvePersonCovers(
    summaries.map((s) => ({ id: s.id, coverMemeId: s.coverMemeId })),
  )

  const out: SerializedPerson[] = []
  for (const summary of summaries) {
    const cover = covers.get(summary.id)
    if (cover === undefined) {
      log.warn({ personId: summary.id }, '这个人物已经没有还在的图了，本页跳过（图可能刚被软删）')
      continue
    }
    out.push(serializePerson(summary, cover))
  }
  return out
}

/**
 * 给一页系列补封面：取「图数最多那个人物的封面」。
 *
 * 封面人物是数据层算好的 `coverPersonId`，这里只把它的封面取回来。**空系列
 * （`coverPersonId` 为 null）和封面人物刚好被删空的情况都给 `cover: null`**——
 * 与人物那条相反，系列的封面在 SPEC §6.7.2 里本来就是可空的。
 */
async function withSeriesCovers(
  summaries: SeriesSummaryWithCoverPerson[],
): Promise<SerializedSeries[]> {
  if (summaries.length === 0) return []

  const coverPersonIds = summaries
    .map((s) => s.coverPersonId)
    .filter((id): id is string => id !== null)

  const covers: Map<string, LiveCover> =
    coverPersonIds.length === 0
      ? new Map()
      : await resolvePersonCovers(coverPersonIds.map((id) => ({ id, coverMemeId: null })))

  return summaries.map((summary) =>
    serializeSeries(
      summary,
      summary.coverPersonId === null ? null : (covers.get(summary.coverPersonId) ?? null),
    ),
  )
}
