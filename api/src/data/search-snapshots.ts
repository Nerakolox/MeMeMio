import { and, eq, gt, lt, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { searchSnapshots } from './schema.js'
import { AppError } from '../lib/app-error.js'
import type { RankedPath } from '../lib/rrf.js'
import { VOCAB_FIELDS } from '../vocab.js'
import type { MemeFilter } from './memes.js'

/**
 * 检索快照的存取（SPEC §6.3.1；设计见 agents/rules/retrieval.md §6）。
 *
 * 一次带 `q` 的检索会把它算出来的东西**冻结**在这里，后面的页只按这份冻住的东西
 * 往下取，不再重跑三路、不再调任何外部 AI。这就是「翻页排序稳定、中途上传的新图
 * 不出现在后续页里」的实现方式（[检索与筛选合流](../../../joint-tasks/2026-09-26-检索筛选合一.md) 裁定 2）。
 *
 * 这个文件只负责读写**一行 JSON**，不认识 HTTP、不认识游标长什么样。分页怎么翻、
 * 深度怎么涨在 `services/search-snapshot.ts`。
 *
 * ## 为什么整行塞 jsonb 而不是拆成子表
 *
 * 内容是**一份只追加的候选名单**（三路各一串 id + 已发出的每一页），读的时候永远
 * 整份一起读、写的时候整份一起写，没有任何一条查询需要按 id 反查某个元素。
 * 拆成子表等于为一个纯缓存造一套关系模型，收益是零，代价是每次翻页多几次往返。
 *
 * ## 形状变了怎么办
 *
 * 游标里带着版本号（`services/search-snapshot.ts` 的 `CURSOR_VERSION`）。
 * **改了下面任何一个形状就要把版本号 +1**，否则旧快照会被新解析器读歪——
 * 解析器只校验「读得到的字段」，多出来的新字段会被静默丢掉，表现是「筛选条件少了一条，
 * 结果变多」，不报错。版本号一改，旧游标一律 `VALIDATION_FAILED`，客户端的动作是
 * 丢掉游标、回第一页（SPEC §1.3），干净。
 */

/**
 * 冻结的检索输入。**翻页时要原样交回 `runSearch`**，所以这里存的就是它要的那几个参数。
 *
 * `rewritten` / `vector` 冻结的是 HyDE 改写与查询向量：不冻住的话每页都要重算一次
 * 改写（滚一屏一次 LLM 调用），而且逐次改写不同 → 召回池变化 → 翻页重复或漏。
 *
 * `asOf` 用的是快照的 `createdAt`（不另存一份）：它就是「这次检索看到的数据库时点」。
 */
export type SnapshotInputs = {
  query: string
  /**
   * 筛选条件。**不含 `exclude`**：那几条（「猫 不要 真人」）由查询词推导，
   * `runSearch` 每次都会用同一个 query 重新算出来，存一份反而多一个会不一致的地方。
   */
  filter: MemeFilter
  actorId: string
  /** 首屏那次检索的 `degraded`。**冻结它**：一次检索的快照只有一个答案。 */
  degraded: boolean
  rewritten: string | null
  vector: { values: number[]; model: string } | null
}

/**
 * 只追加的状态。
 *
 * ⚠️ **`paths` 与 `pages` 都只能往后接，不能重排、不能删。**
 *    重排会让已经发出去的页边界移动——页间重复或漏正落在那里（retrieval.md §5）。
 */
export type SnapshotState = {
  /** 三路各自的有序候选名单。深度翻倍时**只把没见过的新 id 接在后面**。 */
  paths: RankedPath[]
  /** 已经发出去的每一页。游标重放时照这一页原样再给一次。 */
  pages: SnapshotPage[]
  /** 当前预取深度。只增不减；翻倍由 `services/search-snapshot.ts` 决定。 */
  depth: number
}

/**
 * 发出去过的一页。
 *
 * `more` 一起存下来，是为了**重放同一个游标时能给出完全一样的响应**：它记的是
 * 「这一页发出去的时候后面还有没有」。不存的话只能靠「后面还有没有别的页」去猜，
 * 而那个判断在重放时会往前走（后来真的又翻了一页），于是同一个游标第一次说「到底了」、
 * 第二次说「还有」。
 */
export type SnapshotPage = {
  ids: string[]
  /** 发这一页时后面还有下一段候选。为真的页一定非空（空的页一定收工）。 */
  more: boolean
}

export type SearchSnapshot = {
  id: string
  userId: string
  inputs: SnapshotInputs
  state: SnapshotState
  createdAt: Date
  expiresAt: Date
}

/**
 * 快照坏了。**与「游标无效」「快照过期」共用一个错误码**（SPEC §1.3 / §2.2）——
 * 客户端对三者的动作是同一个：丢弃游标、回第一页、说一句。
 *
 * 走到这里说明库里那一行的 JSON 不是我们写进去的形状（改过形状但没升游标版本，
 * 或者有人手工改过库）。它不该发生，所以不降级、不猜，直接当坏游标。
 */
function invalidSnapshot(): never {
  throw new AppError('VALIDATION_FAILED', '游标无效，请从第一页重新开始')
}

export async function createSearchSnapshot(
  input: {
    id: string
    userId: string
    inputs: SnapshotInputs
    state: SnapshotState
    /** 这次检索的时点（= 首屏扫描用的 `asOf`）。理由见 schema 里 `createdAt` 的注释。 */
    createdAt: Date
    expiresAt: Date
  },
  db: Db = defaultDb,
): Promise<void> {
  await db.insert(searchSnapshots).values({
    id: input.id,
    userId: input.userId,
    inputs: input.inputs,
    state: input.state,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  })
}

/** 写回翻过页的 state 与续期。**主键定位，不做归属判断**——那是服务层的事。 */
export async function saveSearchSnapshot(
  id: string,
  state: SnapshotState,
  expiresAt: Date,
  db: Db = defaultDb,
): Promise<void> {
  await db.update(searchSnapshots).set({ state, expiresAt }).where(eq(searchSnapshots.id, id))
}

/**
 * 按 id 取一行。**找不到、过期、形状不对都返回 null**，由服务层统一变成那个错误码。
 *
 * `now` 可注入只为测试：过期判据要用得上一个「已经过去的时刻」。
 */
export async function findSearchSnapshot(
  id: string,
  db: Db = defaultDb,
  now: Date = new Date(),
): Promise<SearchSnapshot | null> {
  const rows = await db
    .select()
    .from(searchSnapshots)
    .where(and(eq(searchSnapshots.id, id), gt(searchSnapshots.expiresAt, now)))

  const row = rows[0]
  if (row === undefined) return null

  // `inputs` / `state` 是 jsonb，drizzle 只能给出 `unknown`。**校验，不强转**：
  // 强转是把类型检查关掉，这里恰恰是「库里那行可能不是我们写的形状」的地方。
  return {
    id: row.id,
    userId: row.userId,
    inputs: parseInputs(row.inputs),
    state: parseState(row.state),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

/**
 * 数一数现在有多少条已过期，**一条都不删**。这就是 `queue.md §6` 要的 dry-run，
 * 也是清理任务「先记日志再删」的那一步：日志里的条数来自删除**之前**的这一次计数。
 *
 * 一次计数只走 `expires_at` 索引，扫不到东西时它是空的（每 5 分钟一次）。
 */
export async function countExpiredSearchSnapshots(
  db: Db = defaultDb,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(searchSnapshots)
    .where(lt(searchSnapshots.expiresAt, now))
  return rows[0]?.count ?? 0
}

/**
 * 删掉已过期的快照，返回删掉的条数。清理任务调它（`queue/cleanup.ts`）。
 *
 * 判据与读路径的过期判据是同一条（`findSearchSnapshot` 的 `expires_at > now`），
 * 被删的每一行在删除之前**已经**是坏游标了——所以 dry-run 数出来的就是将要删的，
 * 不需要在删除时再挑一遍。
 */
export async function deleteExpiredSearchSnapshots(
  db: Db = defaultDb,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .delete(searchSnapshots)
    .where(lt(searchSnapshots.expiresAt, now))
    .returning({ id: searchSnapshots.id })
  return rows.length
}

// ── JSON 形状校验 ──────────────────────────────────────────────────
//
// 全部是 `unknown` 进、typed 出，**没有一个 `as`**（code-style.md）。

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number')
}

function parseStringArray(value: unknown): string[] {
  if (!isStringArray(value)) invalidSnapshot()
  return value
}

function parseBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidSnapshot()
  return value
}

function parsePaths(raw: unknown): RankedPath[] {
  if (!Array.isArray(raw)) invalidSnapshot()
  return raw.map((item) => {
    if (!isRecord(item)) invalidSnapshot()
    const { name, ids } = item
    if (typeof name !== 'string' || !isStringArray(ids)) invalidSnapshot()
    return { name, ids }
  })
}

function parsePages(raw: unknown): SnapshotPage[] {
  if (!Array.isArray(raw)) invalidSnapshot()
  return raw.map((item) => {
    if (!isRecord(item)) invalidSnapshot()
    const { ids, more } = item
    if (!isStringArray(ids) || typeof more !== 'boolean') invalidSnapshot()
    return { ids, more }
  })
}

/**
 * 筛选条件。**空的七维、`undefined` 的布尔都是合法状态**（那是「没筛这一项」），
 * 所以逐项判 `undefined` 而不是要求齐备。
 */
function parseFilter(raw: unknown): MemeFilter {
  if (!isRecord(raw)) invalidSnapshot()

  const filter: MemeFilter = {}
  for (const field of VOCAB_FIELDS) {
    const value = raw[field]
    if (value !== undefined) filter[field] = parseStringArray(value)
  }

  const { isAnimated, favorited, uploader, tagStatus, exclude } = raw
  if (isAnimated !== undefined) filter.isAnimated = parseBoolean(isAnimated)
  if (favorited !== undefined) filter.favorited = parseBoolean(favorited)
  if (uploader !== undefined) {
    if (typeof uploader !== 'string') invalidSnapshot()
    filter.uploader = uploader
  }
  if (tagStatus !== undefined) {
    if (typeof tagStatus !== 'string') invalidSnapshot()
    filter.tagStatus = tagStatus
  }
  if (exclude !== undefined) filter.exclude = parseStringArray(exclude)

  return filter
}

function parseVector(raw: unknown): SnapshotInputs['vector'] {
  if (raw === null || raw === undefined) return null
  if (!isRecord(raw)) invalidSnapshot()
  const { values, model } = raw
  if (!isNumberArray(values) || typeof model !== 'string') invalidSnapshot()
  return { values, model }
}

function parseInputs(raw: unknown): SnapshotInputs {
  if (!isRecord(raw)) invalidSnapshot()
  const { query, filter, actorId, degraded, rewritten, vector } = raw

  if (typeof query !== 'string' || typeof actorId !== 'string') invalidSnapshot()
  if (typeof degraded !== 'boolean') invalidSnapshot()
  if (rewritten !== null && typeof rewritten !== 'string') invalidSnapshot()

  return {
    query,
    filter: parseFilter(filter),
    actorId,
    degraded,
    rewritten,
    vector: parseVector(vector),
  }
}

function parseState(raw: unknown): SnapshotState {
  if (!isRecord(raw)) invalidSnapshot()
  const { paths, pages, depth } = raw

  // 深度必须是正整数：它是 `PATH_LIMIT` 的若干次翻倍，`0` 或负数会让三路都白跑
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1) invalidSnapshot()

  return { paths: parsePaths(paths), pages: parsePages(pages), depth }
}
