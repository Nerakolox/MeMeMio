import { eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { LIVE_MEME } from './memes.js'
import { memeSubjects } from './schema.js'
import { AppError } from '../lib/app-error.js'
import { containsPattern } from '../lib/like.js'
import { isUuid } from '../lib/uuid.js'

/**
 * 人物与系列（SPEC §5.7 / §6.7，`proposed`）。
 *
 * ## 为什么这个文件里会出现 `memes`
 *
 * `data/memes.ts` 的文件头写着「不允许在别处写涉及 memes 的 SQL」，`data/search.ts`
 * 是那条规则的第一处例外（检索三路各自要 `.where()`）。这里是第二处，而且是**必要**的：
 * §5.7.4 要求「人物的图数 / 封面 / 成员，一切读路径都带 `memes.deleted_at is null`」，
 * 而这里的驱动表是 `persons` / `meme_subjects`，拼不出 `memeQueryConditions`。
 *
 * 所以这一条**不是**「抄一份软删过滤」，而是从 `data/memes.ts` 导入 `LIVE_MEME`——
 * 那个判断全项目只有一份定义。本文件里每一处 join `memes` 都必须带上它。
 *
 * ## 机器与人的分工
 *
 * 机器只做一件事：**给还没归属的图算向量、挂到最近的人物上**（下面的
 * `assignPersonVector`）。它不合并人物、不改已有归属。人做过的决定（`assigned_by`
 * 非空）与机器自己做过的分配（`person_id` 非空）在重算时都原样保留（§5.7.2）。
 */

// ── 类型 ───────────────────────────────────────────────────────────

/**
 * 对外表示所需的全部字段（SPEC §6.7.2）。`coverMemeId` 是**库里那个字段的原值**，
 * 不是回落后的封面——回落要再看一次图片是否还在，那是一次额外的查询，由
 * `resolvePersonCovers` 负责，读列表时才对整页做一次。
 */
export type PersonSummary = {
  id: string
  name: string | null
  seriesId: string | null
  seriesName: string | null
  isHidden: boolean
  memeCount: number
  coverMemeId: string | null
  updatedBy: string | null
  updatedAt: Date | null
}

export type SeriesSummary = {
  id: string
  name: string
  personCount: number
  memeCount: number
  createdBy: string
  createdAt: Date
  updatedBy: string | null
  updatedAt: Date | null
}

/** 封面回落完成后的结果：图 + 它的 `storage_key`（缩略图 URL 由 storage 层派生）。 */
export type LiveCover = { memeId: string; storageKey: string }

// ── 游标 ───────────────────────────────────────────────────────────
//
// 排序固定为 `memeCount desc, id`（SPEC §6.7.3），所以游标就是这一对。
// 形状与 `data/memes.ts` 的 `decodeCursor` 同构但**不共用**：那边的键是
// `(created_at, id)`，把两套塞进一个函数就得先判「这串游标是哪一种」，
// 而判错的表现是翻页静默跳页。两边的编码各自只有一处实现，就够了。

export type PersonListCursor = { memeCount: number; id: string }

export function encodePersonListCursor(cursor: PersonListCursor): string {
  return Buffer.from(`${cursor.memeCount}|${cursor.id}`).toString('base64url')
}

/**
 * 解游标。**解不出来报 `VALIDATION_FAILED`，不当没传**（SPEC §1.3、§9.29）：
 * 客户端拿着坏游标要下一页、服务端给回第一页并被追加渲染，屏幕上会出现重复，
 * 而且没有任何报错。
 */
export function decodePersonListCursor(cursor: string): PersonListCursor {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8')
  const sep = raw.indexOf('|')
  const memeCount = sep < 0 ? Number.NaN : Number(raw.slice(0, sep))
  const id = sep < 0 ? '' : raw.slice(sep + 1)
  if (!Number.isInteger(memeCount) || memeCount < 0 || !isUuid(id)) {
    throw new AppError('VALIDATION_FAILED', '游标无效，请从第一页重新开始')
  }
  return { memeCount, id }
}

// ── 共用 SQL 片段 ──────────────────────────────────────────────────

/**
 * 「每个人物有几张**还在的**图」。**本文件所有计数与封面都从它出发。**
 *
 * `join memes` + `LIVE_MEME` 是这一段存在的全部理由：少了它，一个人物的图全被软删之后
 * 仍然算 1 张、仍然出现在列表里——§5.7.4 明写了「图全被软删的人物不出现」。
 * 而 `meme_subjects` 那一行在软删时**并不消失**（级联只发生在 30 天后的物理删除）。
 *
 * `count(*)::int` 不是 `count(*)`：postgres.js 把 int8 原样给回**字符串**，
 * 而这里的数会直接进 JSON 参与排序与比较（同一个坑在 `data/auth.ts` 记过）。
 */
const liveCountCte = sql`live as (
  select ms.person_id as pid, count(*)::int as cnt
  from meme_subjects ms
  join memes on memes.id = ms.meme_id
  where ${LIVE_MEME}
  group by ms.person_id
)`

/** 人物的筛选条件（`GET /persons` 的五个参数，SPEC §6.7.3）。每一条都是 AND。 */
function personFilterConditions(params: PersonListParams): SQL[] {
  const conditions: SQL[] = []

  // `q` 去首尾空白后为空 = 不传（handler 已经 trim 过）
  if (params.q !== undefined && params.q !== '') {
    conditions.push(sql`p.name ilike ${containsPattern(params.q)}`)
  }

  // `series` 有三个形态：具体 id / `none` / 不传。**没有第四种**
  if (params.series === 'none') {
    conditions.push(sql`p.series_id is null`)
  } else if (params.series !== undefined && params.series !== '') {
    conditions.push(sql`p.series_id = ${params.series}::uuid`)
  }

  if (params.named === true) conditions.push(sql`p.name is not null`)
  else if (params.named === false) conditions.push(sql`p.name is null`)

  // **不传或 false 都只要没隐藏的**（§6.7.3）——`hidden` 是「只看隐藏的」那个开关，
  // 不是「隐藏的也算」。写成 `p.hidden_at is null` 的那一支默认值是 here
  if (params.hidden === true) conditions.push(sql`p.hidden_at is not null`)
  else conditions.push(sql`p.hidden_at is null`)

  return conditions
}

/**
 * 游标条件：`(memeCount desc, id asc)` 这个顺序里，「排在游标之后」。
 *
 * ⚠️ 两个方向**不一样**：数小的在后面（desc），而数相同时 id 大的在后面（asc）。
 *    写成同向就会漏掉或重复整整一档同数的记录，而表现只是翻页少几条。
 */
function personCursorCondition(cursor: PersonListCursor): SQL {
  return sql`(live.cnt < ${cursor.memeCount}
    or (live.cnt = ${cursor.memeCount} and p.id > ${cursor.id}::uuid))`
}

// ── 列表与详情（SPEC §6.7.3） ──────────────────────────────────────

export type PersonListParams = {
  /** 名字包含，不区分大小写。空串按不传处理。 */
  q?: string
  /** 系列 id，或 `none`（不属于任何系列）。 */
  series?: string
  /** true 只要有名字的，false 只要未命名的，不传两种都要。 */
  named?: boolean
  /** **不传或 false 都只要没隐藏的。** */
  hidden?: boolean
  /** 图数下限，默认 1。 */
  minCount?: number
  cursor?: PersonListCursor | null
  limit: number
}

/**
 * 人物列表。**图数为 0 的人物不会出现在这里**——`join live` 是内连接，
 * 不是「查出来再过滤」（那种写法会让分页少给几格，而 cursor 是按图数排的）。
 *
 * 排序固定 `memeCount desc, id`，游标分页。**图数在翻页途中变了可能重复或漏一格**，
 * 不做快照——这是一个浏览面，不是检索（§6.7.3 明说了这一点）。
 */
export async function listPersons(
  params: PersonListParams,
  db: Db = defaultDb,
): Promise<{ items: PersonSummary[]; nextCursor: string | null }> {
  const limit = params.limit
  const minCount = params.minCount ?? 1
  const conditions = personFilterConditions(params)
  conditions.push(sql`live.cnt >= ${minCount}`)
  if (params.cursor !== null && params.cursor !== undefined) {
    conditions.push(personCursorCondition(params.cursor))
  }

  const rows = await db.execute<PersonSummaryRow>(sql`
    with ${liveCountCte}
    select p.id, p.name, p.series_id, s.name as series_name, p.hidden_at,
           p.cover_meme_id, p.updated_by, p.updated_at, live.cnt as meme_count
    from persons p
    join live on live.pid = p.id
    left join series s on s.id = p.series_id
    where ${sql.join(conditions, sql` and `)}
    order by live.cnt desc, p.id asc
    limit ${limit + 1}
  `)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const nextCursor =
    hasMore && last !== undefined
      ? encodePersonListCursor({ memeCount: last.meme_count, id: last.id })
      : null

  return { items: page.map(toPersonSummary), nextCursor }
}

/**
 * `db.execute` 回来的是 Postgres 的**文本**，不是 `Date`——`drizzle` 的列类型只在
 * `select()` 那条路上生效。所以本文件每一个时间列都是 `string`，映射进 `Summary` 时
 * 必须显式转一次。
 *
 * ⚠️ **不转的表现是一句 500，而且现场离根因很远**：`serialize/*` 拿到字符串之后
 *    调 `date.toISOString()`，抛的是 `TypeError: date.toISOString is not a function`
 *    （2026-09-30 写第一批的读接口时就是这么炸的：`GET /series/{id}`，因为空系列的
 *    `created_at` 恒非空，它比人物那条更早暴露；人物那条要等到有人改过名字
 *    ——`updated_at` 非空——才会响）。
 *
 * 同样的坑在 `count(*)` 上记过一次（int8 也是文本，所以那里到处写 `::int`）。
 * 这一处没法靠 SQL 里的 cast 解决：`timestamptz::text` 还是文本。
 *
 * 转不动时报错而不是回一个 `Invalid Date`：后者会一路飘到 `toISOString()`，
 * 表现还是 500，只是更难看懂。
 */
function toDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`时间列解析失败：${String(value)}`)
  return date
}

function toDateOrNull(value: string | Date | null): Date | null {
  return value === null ? null : toDate(value)
}

type PersonSummaryRow = {
  id: string
  name: string | null
  series_id: string | null
  series_name: string | null
  /** 只判「有没有」，所以不用转（转了也一样，但多一次解析没有意义）。 */
  hidden_at: string | null
  cover_meme_id: string | null
  updated_by: string | null
  updated_at: string | null
  meme_count: number
}

function toPersonSummary(row: PersonSummaryRow): PersonSummary {
  return {
    id: row.id,
    name: row.name,
    seriesId: row.series_id,
    seriesName: row.series_name,
    isHidden: row.hidden_at !== null,
    memeCount: row.meme_count,
    coverMemeId: row.cover_meme_id,
    updatedBy: row.updated_by,
    updatedAt: toDateOrNull(row.updated_at),
  }
}

const personSelectSql = sql`select p.id, p.name, p.series_id, s.name as series_name, p.hidden_at,
       p.cover_meme_id, p.updated_by, p.updated_at, live.cnt as meme_count
  from persons p
  join live on live.pid = p.id
  left join series s on s.id = p.series_id`

/**
 * 单个人物。**图全被软删时返回 null**（§5.7.4：那个人物不该出现在任何地方，
 * 它的行还留着，图被恢复时跟着回来）。调用方据此报 `NOT_FOUND`。
 */
export async function findPersonById(
  id: string,
  db: Db = defaultDb,
): Promise<PersonSummary | null> {
  const rows = await db.execute<PersonSummaryRow>(sql`
    with ${liveCountCte}
    ${personSelectSql}
    where p.id = ${id}::uuid
    limit 1
  `)
  const row = rows[0]
  return row === undefined ? null : toPersonSummary(row)
}

/**
 * 按 id 批量取人物。**顺序不保证**——调用方（合并建议）要的是「最像的在前」，
 * 那是相似度给的顺序，不是这张表给的，必须由调用方按自己的 id 序列重排。
 *
 * 同样过滤图数为 0 的人物：建议里出现一个列表上根本不存在的人物，
 * 用户点进去会得到 `NOT_FOUND`。
 */
export async function findPersonSummariesByIds(
  ids: string[],
  db: Db = defaultDb,
): Promise<PersonSummary[]> {
  if (ids.length === 0) return []
  const rows = await db.execute<PersonSummaryRow>(sql`
    with ${liveCountCte}
    ${personSelectSql}
    where p.id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)
  return rows.map(toPersonSummary)
}

// ── 封面回落（SPEC §5.7.4） ────────────────────────────────────────

/**
 * 把人物列表里的封面补全成「一张**还在的**图」。
 *
 * 规则（§5.7.4）：`cover_meme_id`；为 null **或那张已软删**时，取成员里 `created_at`
 * 最新的一张。所以「人指定了封面、后来那张图被删了」不是一个需要人去修的坏状态，
 * 读的时候自然回落。
 *
 * 两次查询而不是一次 join：显式封面是**每行一个不同的 id**，用 join 表达要写
 * `cover_meme_id = meme_id` 的相关条件，而「这张图还在」那一条还得再带一遍。
 * 拆开之后，第一条只判「还在不在」，第二条只解决「谁最新」，各自都只有一件事。
 *
 * @param entries 人物的 `(id, coverMemeId)` 对，`coverMemeId` 是库里那个原值。
 */
export async function resolvePersonCovers(
  entries: { id: string; coverMemeId: string | null }[],
  db: Db = defaultDb,
): Promise<Map<string, LiveCover>> {
  const out = new Map<string, LiveCover>()
  if (entries.length === 0) return out

  // 1. 显式封面里还活着的那几张
  const explicit = entries.filter(
    (e): e is { id: string; coverMemeId: string } => e.coverMemeId !== null,
  )
  if (explicit.length > 0) {
    const rows = await db.execute<{ id: string; storage_key: string }>(sql`
      select id, storage_key from memes
      where id in (${sql.join(
        explicit.map((e) => sql`${e.coverMemeId}::uuid`),
        sql`, `,
      )})
        and ${LIVE_MEME}
    `)
    const byMemeId = new Map(rows.map((r) => [r.id, r.storage_key]))
    for (const entry of explicit) {
      const storageKey = byMemeId.get(entry.coverMemeId)
      if (storageKey !== undefined) {
        out.set(entry.id, { memeId: entry.coverMemeId, storageKey })
      }
    }
  }

  // 2. 剩下的（没有显式封面，或那张已软删）取成员里最新的一张
  const remaining = entries.filter((e) => !out.has(e.id)).map((e) => e.id)
  if (remaining.length > 0) {
    // `distinct on` 每组只留一行。`order by` 的第一列必须是 distinct on 的那一列，
    // 后面两项才是「最新」的判定；`id desc` 做 tie-breaker，`created_at` 同值时
    // 顺序不定会让同一个页面两次刷新给出不同的封面。
    //
    // ⚠️ `memes` **不加别名**：`LIVE_MEME` 展开成 `"memes"."deleted_at" is null`，
    //    给表起个 `m` 之后那一列就引用不到了（Postgres 报
    //    `invalid reference to FROM-clause entry for table "memes"`）。
    const rows = await db.execute<{ pid: string; id: string; storage_key: string }>(sql`
      select distinct on (ms.person_id) ms.person_id as pid, memes.id, memes.storage_key
      from meme_subjects ms
      join memes on memes.id = ms.meme_id
      where ms.person_id in (${sql.join(
        remaining.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        and ${LIVE_MEME}
      order by ms.person_id, memes.created_at desc, memes.id desc
    `)
    for (const row of rows) {
      out.set(row.pid, { memeId: row.id, storageKey: row.storage_key })
    }
  }

  return out
}

// ── 系列（SPEC §6.7.3） ────────────────────────────────────────────

export type SeriesListParams = {
  q?: string
  cursor?: PersonListCursor | null
  limit: number
}

/**
 * 系列列表。
 *
 * ⚠️ **`left join` 与 `coalesce` 不能省。** 空系列（刚建、还没挑人物）必须出现，
 * 而它是 `live` 里一行都没有的——内连接会把它整个吞掉，表现是「刚建的系列不见了」，
 * 不报错。SPEC §6.7.3：系列不论空不空都在。
 *
 * `personCount` 只数**图数 ≥ 1** 的人物（§5.7.4），这一条由 `live` 的取值天然保证：
 * 它只有图数 ≥ 1 的行。
 *
 * 封面取「图数最多那个人物的封面」，这里只给 id，缩略图那条回落与人物共用
 * `resolvePersonCovers`。
 */
export async function listSeries(
  params: SeriesListParams,
  db: Db = defaultDb,
): Promise<{ items: SeriesSummaryWithCoverPerson[]; nextCursor: string | null }> {
  const limit = params.limit
  const conditions: SQL[] = []
  if (params.q !== undefined && params.q !== '') {
    conditions.push(sql`s.name ilike ${containsPattern(params.q)}`)
  }
  if (params.cursor !== null && params.cursor !== undefined) {
    conditions.push(sql`(coalesce(stat.meme_count, 0) < ${params.cursor.memeCount}
      or (coalesce(stat.meme_count, 0) = ${params.cursor.memeCount} and s.id > ${params.cursor.id}::uuid))`)
  }
  if (conditions.length === 0) conditions.push(sql`true`)

  const rows = await db.execute<SeriesSummaryRow>(sql`
    with ${liveCountCte},
    stat as (
      select p.series_id as sid,
             count(*)::int as person_count,
             sum(live.cnt)::int as meme_count
      from persons p
      join live on live.pid = p.id
      where p.series_id is not null
      group by p.series_id
    )
    select s.id, s.name, s.created_by, s.created_at, s.updated_by, s.updated_at,
           coalesce(stat.person_count, 0)::int as person_count,
           coalesce(stat.meme_count, 0)::int as meme_count,
           (select p2.id from persons p2
              join live l2 on l2.pid = p2.id
             where p2.series_id = s.id
             order by l2.cnt desc, p2.id asc
             limit 1) as cover_person_id
    from series s
    left join stat on stat.sid = s.id
    where ${sql.join(conditions, sql` and `)}
    order by coalesce(stat.meme_count, 0) desc, s.id asc
    limit ${limit + 1}
  `)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const nextCursor =
    hasMore && last !== undefined
      ? encodePersonListCursor({ memeCount: last.meme_count, id: last.id })
      : null

  return { items: page.map(toSeriesSummary), nextCursor }
}

/** 两个时间列是**文本**，不是 `Date`——理由见 `toDate` 的注释。 */
type SeriesSummaryRow = {
  id: string
  name: string
  created_by: string
  created_at: string
  updated_by: string | null
  updated_at: string | null
  person_count: number
  meme_count: number
  cover_person_id: string | null
}

/** 系列列表里的封面人物 id。它不是 `series` 表的字段，所以不塞进 `SeriesSummary`。 */
export type SeriesSummaryWithCoverPerson = SeriesSummary & { coverPersonId: string | null }

function toSeriesSummary(row: SeriesSummaryRow): SeriesSummaryWithCoverPerson {
  return {
    id: row.id,
    name: row.name,
    personCount: row.person_count,
    memeCount: row.meme_count,
    createdBy: row.created_by,
    createdAt: toDate(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: toDateOrNull(row.updated_at),
    coverPersonId: row.cover_person_id,
  }
}

/** 单个系列。**空系列照样返回**（§6.7.3），只有不存在才是 null。 */
export async function findSeriesById(
  id: string,
  db: Db = defaultDb,
): Promise<SeriesSummaryWithCoverPerson | null> {
  const rows = await db.execute<SeriesSummaryRow>(sql`
    with ${liveCountCte},
    stat as (
      select p.series_id as sid,
             count(*)::int as person_count,
             sum(live.cnt)::int as meme_count
      from persons p
      join live on live.pid = p.id
      where p.series_id is not null
      group by p.series_id
    )
    select s.id, s.name, s.created_by, s.created_at, s.updated_by, s.updated_at,
           coalesce(stat.person_count, 0)::int as person_count,
           coalesce(stat.meme_count, 0)::int as meme_count,
           (select p2.id from persons p2
              join live l2 on l2.pid = p2.id
             where p2.series_id = s.id
             order by l2.cnt desc, p2.id asc
             limit 1) as cover_person_id
    from series s
    left join stat on stat.sid = s.id
    where s.id = ${id}::uuid
    limit 1
  `)
  const row = rows[0]
  return row === undefined ? null : toSeriesSummary(row)
}

// ── 合并建议（SPEC §6.7.3） ────────────────────────────────────────

/**
 * 挂人物的相似度阈值（余弦）。
 *
 * **取 0.825 的依据在任务文件 §9.1**：整图向量、长边 768、截到 1024 维那一组参数下，
 * 0.825 在两轮探测里都是**零误合并**的最低阈值；0.800 已经有灰区。
 *
 * ⚠️ **它是「人与机器分工」的那条线，不是调参口味。** 调低会让不同的角色并成一组
 *    （误合并比碎片伤人，§5.7.2），调高只是多几个未命名的小组。
 *
 * ⚠️ **这个数只在同口径的向量之间有意义**（§5.7.1）。换了长边或换了模型，它是另一条
 *    曲线上的数——重算时要一起复核。
 *
 * 合并建议用的是**同一个数**：比它更远的一对，挂都不该挂，拿去问人只会是噪声。
 */
export const PERSON_ATTACH_THRESHOLD = 0.825

/** 一个成员向量找多少个最近邻。见 `listSuggestedPersonIds` 里对「近似」的说明。 */
const SUGGESTION_NEIGHBOR_DEPTH = 30

/** §6.7.3：最多 3 条。 */
const MAX_SUGGESTIONS = 3

/**
 * `GET /persons/{id}/suggestions` 的候选：**和它最像的其他人物，最像的在前**。
 *
 * 相似度取「两组里最像的那一对图」（单链，任务 §9.1 的 `suggest()`），不是质心——
 * 一个角色碎成两组、每组各自内部很齐的时候，质心之间的距离会把它们判远，
 * 而单链要的正是「这两组里有没有一对几乎一样的图」。
 *
 * 排除：隐藏的人物、点过「不是同一个」的一对、图数已经归零的人物（§6.7.3、§5.7.4）。
 *
 * ⚠️ **近似之处：每个成员只看最近的 `SUGGESTION_NEIGHBOR_DEPTH` 条。** 真正的
 *    「组间最近对」要在全库上算，那是每张图扫一次全表。阈值 0.825 对应的候选不可能
 *    排在某个成员的 30 名开外，所以截断只影响结果里的顺序而非取舍。HNSW 索引正是
 *    为这个「按距离取前 N」的形状建的（见 `memeSubjects` 的索引注释）。
 *
 * @param limit 上限，默认 3（§6.7.3）。探测里按组给几乎全对，所以**不做全站的合并清单**。
 */
export async function listSuggestedPersonIds(
  personId: string,
  limit: number = MAX_SUGGESTIONS,
  db: Db = defaultDb,
): Promise<string[]> {
  const rows = await db.execute<{ pid: string }>(sql`
    with ${liveCountCte},
    near as (
      select ms2.person_id as pid, min(ms2.embedding <=> mine.embedding) as dist
      from meme_subjects mine
      join lateral (
        select person_id, embedding
        from meme_subjects
        where embedding is not null
          and person_id is not null
          and person_id <> mine.person_id
          and embed_model = mine.embed_model
        order by embedding <=> mine.embedding
        limit ${SUGGESTION_NEIGHBOR_DEPTH}
      ) ms2 on true
      where mine.person_id = ${personId}::uuid
        and mine.embedding is not null
      group by ms2.person_id
    )
    select n.pid
    from near n
    join persons p on p.id = n.pid
    where n.dist <= ${1 - PERSON_ATTACH_THRESHOLD}
      and p.hidden_at is null
      and exists (select 1 from live l where l.pid = n.pid)
      and not exists (
        select 1 from person_rejections r
        where r.person_id = least(${personId}::uuid, n.pid)
          and r.other_person_id = greatest(${personId}::uuid, n.pid)
      )
    order by n.dist asc
    limit ${limit}
  `)
  return rows.map((r) => r.pid)
}

// ── 机器分配（SPEC §5.7.2） ────────────────────────────────────────

/**
 * 分配那一步的串行锁。**全站一把。**
 *
 * 不加锁会出现这样的交错：两个 worker 同时处理两张其实是同一个角色的图，各自都没找到
 * 够近的人物，于是**各自建了一个新人物**——同一个人碎成两组，而且不报错。
 * §5.7.2 的「机器只挂不并」意味着碎掉的组不会自己合回来，只能等人去合。
 *
 * ⚠️ **锁只圈住这一小段事务，不圈 embedding 调用。** 调用要几百毫秒到几秒，
 *    圈进来等于把全站的人物分配排成一条队。分配本身是几条索引查询，微秒级。
 *
 * 数值本身没有含义（只要全站唯一、不去撞 `routes/auth.ts` 那个首用户锁）。
 */
const PERSON_ASSIGN_LOCK_KEY = 825032_2026

export type PersonAssignOutcome = {
  /** 分配后这张图挂在谁下面。`null` 只会出现在「人判定它不属于任何人物」的行上。 */
  personId: string | null
  /** 这次新建了一个人物（阈值内没有可挂的）。 */
  createdPerson: boolean
  /** 归属是既有的、机器没碰（人做过决定，或机器此前已经分过）。 */
  keptAssignment: boolean
}

/**
 * 把一张图挂到最像的人物上，挂不上就自成一个新的未命名人物（§5.7.2）。
 *
 * 三步，**必须在同一个事务里**（这也是锁的边界）：
 *
 * 1. 已经分配过的行 → **只换向量**，归属原样返回。「已经分配过」的判据是
 *    `person_id is not null or assigned_by is not null`：前者是机器分过的，
 *    后者是人分过（或人明确移出过，此时 `person_id` 为 null）。重算不能改这两类，
 *    否则被人移出的图过两天会自己回来（§5.7.2）。
 * 2. 没分配过 → 和**每个人物的质心**比（同口径的向量才算，§5.7.1），取最近的。
 *    质心 = 成员向量的平均后再 L2 归一化，与探测脚本 `cluster()` 的口径逐字一致
 *    （那边是 `dot(v, sum)/|sum|`，同一个数）。**不这么归一化的话，成员越多的人物质心
 *    越短，`<=>` 算出来的余弦会被这个长度带偏**——不报错，只是人物越大的越难吸到新图。
 * 3. 最近的也在阈值内 → 挂上去；否则建一个新人物。**隐藏的人物照样参与**（§5.7.2）：
 *    否则被隐藏的那组会在下一张图进来时重新长出来。
 *
 * `assigned_by` 写 null：这是机器分的，不是人分的。写进去等于伪造了一条留痕，
 * 而它的后果是**这张图从此再也不会被重算改归属**。
 *
 * @param embedding **必须已经 L2 归一化**（`ai/image-embedder.ts` 保证）。
 */
export async function assignPersonVector(
  memeId: string,
  embedding: number[],
  modelKey: string,
  db: Db = defaultDb,
): Promise<PersonAssignOutcome> {
  const vector = toVectorLiteral(embedding)

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PERSON_ASSIGN_LOCK_KEY})`)

    const existing = await tx
      .select({ personId: memeSubjects.personId, assignedBy: memeSubjects.assignedBy })
      .from(memeSubjects)
      .where(eq(memeSubjects.memeId, memeId))
      .limit(1)

    const current = existing[0]
    if (current !== undefined && (current.personId !== null || current.assignedBy !== null)) {
      await tx
        .update(memeSubjects)
        .set({ embedding, embedModel: modelKey })
        .where(eq(memeSubjects.memeId, memeId))
      return { personId: current.personId, createdPerson: false, keptAssignment: true }
    }

    /*
     * `having ... < 1` 挡住 NaN。质心是零向量时（成员向量两两抵消）`<=>` 回 NaN，
     * 而 Postgres 的 NaN **比任何数都大**——`order by dist asc` 不会把它排在最后，
     * `dist <= 0.175` 也是 false，两种写法都不对劲。让它在 SQL 层就出局最干净。
     */
    const best = await tx.execute<{ person_id: string; dist: number }>(sql`
      select p.id as person_id,
             l2_normalize(avg(ms.embedding)) <=> ${vector}::vector as dist
      from persons p
      join meme_subjects ms on ms.person_id = p.id
      where ms.embedding is not null and ms.embed_model = ${modelKey}
      group by p.id
      having (l2_normalize(avg(ms.embedding)) <=> ${vector}::vector) < 1
      order by dist asc
      limit 1
    `)

    const candidate = best[0]
    const matched =
      candidate !== undefined && Number(candidate.dist) <= 1 - PERSON_ATTACH_THRESHOLD

    let personId: string
    let createdPerson = false
    if (matched) {
      personId = candidate.person_id
    } else {
      const created = await tx.execute<{ id: string }>(sql`insert into persons default values returning id`)
      const row = created[0]
      if (row === undefined) throw new AppError('INTERNAL', '创建人物失败')
      personId = row.id
      createdPerson = true
    }

    /*
     * `on conflict` 的两条 `case` 是**冗余的防线**：走到这里时那一行要么不存在，
     * 要么正是上面判过的「随便改」状态（同一事务、同一把锁）。写出来的理由是
     * §5.7.2 那条规则是硬边界，让它在写语句里也看得见——**归属只在
     * `person_id is null and assigned_by is null` 时被机器改写**，
     * 别人改这段 SQL 时会撞上它。
     */
    await tx.execute(sql`
      insert into meme_subjects (meme_id, embedding, embed_model, person_id, assigned_by, assigned_at)
      values (${memeId}::uuid, ${vector}::vector, ${modelKey}, ${personId}::uuid, null, now())
      on conflict (meme_id) do update set
        embedding = excluded.embedding,
        embed_model = excluded.embed_model,
        person_id = case
          when meme_subjects.person_id is null and meme_subjects.assigned_by is null
            then excluded.person_id
          else meme_subjects.person_id
        end,
        assigned_at = case
          when meme_subjects.person_id is null and meme_subjects.assigned_by is null
            then excluded.assigned_at
          else meme_subjects.assigned_at
        end
    `)

    return { personId, createdPerson, keptAssignment: false }
  })
}

/**
 * 向量字面量 `[1,2,3]`，给手写 SQL 里的 `${...}::vector` 用。
 *
 * ⚠️ **必须逐项检查有限性。** 上游回一个含 `NaN` / `Infinity` 的向量时，
 *    拼出来的字面量 Postgres 会拒（`invalid input syntax`），那时的表现是「这张图的
 *    向量任务失败」，而真正的原因在几百行之外的 JSON 里。这里当场抛，理由写在错误里。
 *
 * 走 drizzle 的列类型写库不会经过它（那边由列类型序列化）。
 */
function toVectorLiteral(embedding: number[]): string {
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new AppError('INTERNAL', '上游返回的向量里含非有限数值')
    }
  }
  return `[${embedding.join(',')}]`
}
