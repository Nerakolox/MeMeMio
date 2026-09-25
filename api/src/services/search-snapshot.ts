import { randomUUID } from 'node:crypto'
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, type MemeFilter } from '../data/memes.js'
import {
  createSearchSnapshot,
  findSearchSnapshot,
  saveSearchSnapshot,
  type SnapshotInputs,
  type SnapshotState,
} from '../data/search-snapshots.js'
import type { Db } from '../data/db.js'
import { PATH_LIMIT } from '../data/search.js'
import { appendRankedPaths } from '../lib/ranked-append.js'
import { fuseRankings, type FusedHit } from '../lib/rrf.js'
import { AppError } from '../lib/app-error.js'
import { fetchHits, matchedByOf, runSearch, type SearchHit } from './search.js'

/**
 * `GET /memes?q=` 的翻页（SPEC §6.3.1；设计约束见 agents/rules/retrieval.md §6）。
 *
 * ## 一次检索是一个快照
 *
 * 首屏把三路候选、RRF 融合、HyDE 改写与查询向量一起冻住，落进 `search_snapshots`。
 * 翻页 = 从冻住的东西里取下一段，**不重跑三路、不调任何外部 AI**。
 *
 * 不这么做的话每页都要重算一次改写：改写逐次不同 → 召回池变化 → 页间重复或漏，
 * 而且滚一屏就是一次 LLM 调用。
 *
 * ## 融合分不是游标
 *
 * 游标**不指向名次**，它指向「哪一次快照的第几页」。名次会随数据库变动而移动，名次
 * 做游标就会重复或漏；快照里的页是**发出去就不再变**的（`pages` 只往后 push）。
 * 于是同一个游标重放多少次都得到同一页——客户端在响应丢失后重试不会跳页。
 *
 * ## 滚到底了怎么办：深度翻倍
 *
 * 首屏深度是 `PATH_LIMIT`（每路 50 条，融合池 ≤150），一页只发 40 条。当这一页要的
 * 条数在池子里凑不出来时，**把深度翻一倍重扫三路**，新 id 只追加在旧名单后面
 * （`lib/ranked-append.ts` 讲了为什么不能整体重排）。首屏成本与改造前一致，
 * 只有真的往下滚的人才付钱。
 */

/**
 * 游标版本。**存进去的形状一改，这里就 +1。**
 *
 * 旧版本的游标一律解析失败 → `VALIDATION_FAILED` → 客户端丢弃游标回第一页
 * （SPEC §1.3）。这是一条**故意的**断路：解析器只读它认识的字段，多出来的新字段会被
 * 静默丢掉——而丢掉的若是筛选条件，表现是「结果里混进了我筛掉的东西」，不报错。
 * 版本号让这种改动最多影响 30 分钟内存活的那几个游标。
 */
const CURSOR_VERSION = 's1'

/**
 * 快照的存活时间，**从最后一次用到它算起**（每次翻页续期）。
 *
 * 从创建时刻起算的固定 TTL 会让「慢慢滚了半小时」的人在滚到一半时被判过期——
 * 而他什么也没做错。下滑 TTL 的代价只是一个被遗忘的快照多活 30 分钟，那点空间不算什么。
 */
const SNAPSHOT_TTL_MS = 30 * 60_000

/**
 * 预取深度的上限。到达它就**到头了**：`nextCursor` 变 `null`，不报错。
 *
 * 400 = `PATH_LIMIT` 的 3 次翻倍（50 → 100 → 200 → 400）。再翻一倍是 800，而
 * `ef_search` 取 `深度 × 2`（`data/search.ts` 的 `efSearchFor`），1600 会被 pgvector
 * **直接拒掉**——表现是滚到深处的那一次请求整个 500。400 之下 2 × 400 = 800，
 * 那一倍余量还在。池子 ≤1200 条，一页 40 条，够翻 30 页。
 *
 * SPEC §6.3.1 说「深度没有契约上限」——那说的是契约，这里是**实现**的上限，
 * 落点就是这一行（§6.3.1 末段：能翻多深由 `api` 决定）。
 */
const MAX_PREFETCH_DEPTH = 400

/** 一页取多少条。与浏览分支同一个缺省（SPEC §1.3），上限也同一份。 */
function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)
}

function encodeCursor(snapshotId: string, pageIndex: number): string {
  return Buffer.from(`${CURSOR_VERSION}|${snapshotId}|${pageIndex}`).toString('base64url')
}

/**
 * 游标坏了。**「解不出来」「快照过期」「别人的游标」三种情况同一个码**（SPEC §1.3）：
 * 客户端对它们的动作都是丢弃游标、回第一页、说一句。
 *
 * ⚠️ **不静默返回第一页。** 那条老约定在无限滚动里等于把第一页**追加**到已经渲染的
 *    列表后面，屏幕上出现重复而无报错（SPEC §1.3 记着这次推翻）。
 */
function invalidCursor(): never {
  throw new AppError('VALIDATION_FAILED', '游标无效，请从第一页重新开始')
}

function decodeCursor(cursor: string): { id: string; index: number } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8')
  const [version, id, indexRaw] = raw.split('|')
  if (version !== CURSOR_VERSION || id === undefined || indexRaw === undefined) invalidCursor()

  const index = Number(indexRaw)
  if (!Number.isInteger(index) || index < 1) invalidCursor()

  return { id, index }
}

/** 一页的响应。字段与 `SearchOutcome` 一致，多一个 `nextCursor`——两种模式形状恒定。 */
export type SearchPage = {
  items: SearchHit[]
  nextCursor: string | null
  degraded: boolean
  rewritten: string | null
}

export type SearchFirstPageParams = {
  /** 去空白之后的查询词，**调用方保证非空**（空串走浏览分支）。 */
  query: string
  filter: MemeFilter
  actorId: string
  requestId: string
  /** 不给按 §1.3 的缺省 40。 */
  limit?: number
  db: Db
}

/**
 * 首屏：算一次检索，落快照，发第一页。
 *
 * **没有下一页就不落库。** 落进去也只是让清理任务多删一条——没有游标就没有任何人
 * 引用它。所以 id 先生成（游标里要用），插入放在最后。
 */
export async function searchFirstPage(params: SearchFirstPageParams): Promise<SearchPage> {
  const limit = clampLimit(params.limit)
  // 时点与 id 都要在检索**之前**定下来：时点要塞进三路的 WHERE（`asOf`），
  // id 要塞进返回给客户端的游标
  const asOf = new Date()
  const id = randomUUID()

  const run = await runSearch({
    query: params.query,
    filter: params.filter,
    actorId: params.actorId,
    requestId: params.requestId,
    db: params.db,
    depth: PATH_LIMIT,
    asOf,
  })

  const inputs: SnapshotInputs = {
    query: params.query,
    filter: params.filter,
    actorId: params.actorId,
    degraded: run.degraded,
    rewritten: run.rewritten,
    vector: run.frozen.vector,
  }
  const snapshot = { id, inputs, state: { paths: run.paths, pages: [], depth: PATH_LIMIT }, createdAt: asOf }

  const { page, changed } = await takePage(snapshot, 0, limit, params.requestId, params.db)

  if (changed && page.nextCursor !== null) {
    await createSearchSnapshot(
      {
        id,
        userId: params.actorId,
        inputs,
        state: snapshot.state,
        createdAt: asOf,
        expiresAt: new Date(asOf.getTime() + SNAPSHOT_TTL_MS),
      },
      params.db,
    )
  }

  return page
}

export type SearchNextPageParams = {
  cursor: string
  /** 当前登录用户。**必须与快照的主人一致**，理由见下面的检查。 */
  actorId: string
  requestId: string
  limit?: number
  db: Db
}

/** 翻一页。快照没了或过期了都是 `VALIDATION_FAILED`。 */
export async function searchNextPage(params: SearchNextPageParams): Promise<SearchPage> {
  const limit = clampLimit(params.limit)
  const { id, index } = decodeCursor(params.cursor)

  // 过期由查询自己判掉（`expires_at > now()`），不用取回来再比一遍——两处判据
  // 分开写的话迟早会有一处忘了改，而「过期了还能用」的表现是没有表现
  const row = await findSearchSnapshot(id, params.db)
  if (row === null) invalidCursor()

  /*
   * ⚠️ **游标是别人给的也得挡。** 快照里冻着 `actorId`（`favorited`、`uploader=me`
   *    这两条筛选都要它），拿别人的游标翻页等于**用别人的筛选条件**去查——不是读到
   *    别人的图，而是拿到一份按别人收藏过滤过的名单，客户端看不出错。
   *
   *    报 `VALIDATION_FAILED` 而不是 `FORBIDDEN`：对客户端这仍然是「这个游标不能用」，
   *    动作与过期完全一样（丢弃、回第一页）。报 403 会把它变成一个要解释的权限故事。
   */
  if (row.userId !== params.actorId) invalidCursor()

  const snapshot = { id: row.id, inputs: row.inputs, state: row.state, createdAt: row.createdAt }
  const { page, changed } = await takePage(snapshot, index, limit, params.requestId, params.db)

  // 重放（`changed === false`）不动库：状态没变，写回去只是白写一次
  if (changed) {
    await saveSearchSnapshot(
      row.id,
      snapshot.state,
      new Date(Date.now() + SNAPSHOT_TTL_MS),
      params.db,
    )
  }

  return page
}

/** 快照的内存视图。首屏时它还没落库，翻页时它是取回来的那一行。 */
type Snapshot = {
  id: string
  inputs: SnapshotInputs
  state: SnapshotState
  /** 这次检索的时点，重扫三路的上界。 */
  createdAt: Date
}

/** 池子为什么停下来了。它决定 `nextCursor`，所以要分得清「发满了」与「没有了」。 */
type StopReason = 'filled' | 'saturated' | 'max_depth'

type TakeResult = {
  page: SearchPage
  /** 这次调用改动了快照状态（取了新的一页、或重扫过）。重放时为 false。 */
  changed: boolean
}

/**
 * 取第 `index` 页。**已经发出去过的页原样重放**——它是幂等的，客户端的重试不会跳页。
 */
async function takePage(
  snapshot: Snapshot,
  index: number,
  limit: number,
  requestId: string,
  db: Db,
): Promise<TakeResult> {
  const { state } = snapshot

  // ① 这一页发出去过 → 照着存下来的那一页**原样**再给一次。不重算、不改状态。
  //    这是游标幂等：客户端在响应丢失后重试同一个游标，不会跳页
  const sent = state.pages[index]
  if (sent !== undefined) {
    const nextCursor = sent.more ? encodeCursor(snapshot.id, index + 1) : null
    return { page: await render(sent.ids, snapshot, db, nextCursor), changed: false }
  }

  // ② 编号跳空。游标里的编号是我们自己写进去的，跳空只可能是客户端编的——
  //    猜一个「大概是第几页」就是静默返回一页错的，直接当坏游标
  if (index > state.pages.length) invalidCursor()

  // ③ 现算这一页
  const published = new Set(state.pages.flatMap((page) => page.ids))
  let stop: StopReason = 'max_depth'
  let fresh: FusedHit[] = []

  for (;;) {
    fresh = fuseRankings(state.paths, countIds(state.paths)).filter((hit) => !published.has(hit.id))
    if (fresh.length >= limit) {
      stop = 'filled'
      break
    }
    if (state.depth >= MAX_PREFETCH_DEPTH) {
      stop = 'max_depth'
      break
    }

    const added = await grow(snapshot, requestId, db)
    // **三路一条新 id 都给不出来了 → 再翻倍也没有意义。** 这是「到头了」的判据，
    // 不是精确的饱和证明：它可能**提前**停下（理论上更深的扫描还能挖出新东西），
    // 而提前停下的代价只是「翻不到那么深」，不会重复、不会漏、不会报错
    if (added === 0) {
      stop = 'saturated'
      break
    }
  }

  const ids = fresh.slice(0, limit).map((hit) => hit.id)
  if (ids.length === 0) {
    // 空页一定是最后一页。**不把空页存进 pages**：存了它就是一个「发过一页空的」的记录，
    // 而它对应的游标从来没发给过任何人（空页的 nextCursor 恒为 null）
    return { page: await render([], snapshot, db, null), changed: true }
  }

  // 「发满了」才可能有下一页。另外两种是**这一路到此为止**（SPEC §6.3.1：筛得越窄
  // 越早到底，那不是错误）。发满时也未必真有下一页——下一回翻页会翻倍去确认，
  // 那一次会发一个空页 + `nextCursor: null`，客户端据此收工
  const more = stop === 'filled'
  state.pages.push({ ids, more })

  return {
    page: await render(ids, snapshot, db, more ? encodeCursor(snapshot.id, index + 1) : null),
    changed: true,
  }
}

/** 融合池里一共多少条候选。`fuseRankings` 的第二个参数是上限，不能给少了。 */
function countIds(paths: { ids: string[] }[]): number {
  return paths.reduce((total, path) => total + path.ids.length, 0)
}

/**
 * 深度翻倍，重扫三路，把没见过的 id 接在后面。
 *
 * `asOf` 传快照的 `createdAt`：重扫只该看到「首屏那一刻之前入库」的图，否则中途上传的
 * 新图会被接进候选名单，从后面的页里冒出来——那就不是快照了（SPEC §6.3.1）。
 *
 * 返回一共接上多少条新 id。**0 表示三路都给不出新东西了。**
 */
async function grow(snapshot: Snapshot, requestId: string, db: Db): Promise<number> {
  const depth = Math.min(snapshot.state.depth * 2, MAX_PREFETCH_DEPTH)

  const run = await runSearch({
    query: snapshot.inputs.query,
    filter: snapshot.inputs.filter,
    actorId: snapshot.inputs.actorId,
    requestId,
    db,
    depth,
    asOf: snapshot.createdAt,
    // 冻住的那一份改写与查询向量：重扫**不调** HyDE、**不调** embedding
    frozen: { rewritten: snapshot.inputs.rewritten, vector: snapshot.inputs.vector },
  })

  const { paths, added } = appendRankedPaths(snapshot.state.paths, run.paths)
  snapshot.state.paths = paths
  snapshot.state.depth = depth

  return added
}

/**
 * 按 id 名单取完整行，组装成一页。
 *
 * `matchedBy` 由**当前**的候选名单现算。名单只追加，所以一条命中被发出去的那一页算出来的
 * 值是确定的；重放同一个游标时它可能多一路（那之后才扫到），那只影响提示文案——
 * 一条命中只会被发出去一次，除非客户端重放，而重放是重试。
 */
async function render(
  ids: string[],
  snapshot: Snapshot,
  db: Db,
  nextCursor: string | null,
): Promise<SearchPage> {
  const items = await fetchHits(
    ids.map((id) => ({ id, matchedBy: matchedByOf(id, snapshot.state.paths) })),
    snapshot.inputs.actorId,
    db,
  )

  // `degraded` / `rewritten` 用**冻住的首屏值**，不重算：一次检索的快照只有一个答案。
  // 翻页时重判一次的话，同一串结果会前后带着不一样的降级提示
  return {
    items,
    nextCursor,
    degraded: snapshot.inputs.degraded,
    rewritten: snapshot.inputs.rewritten,
  }
}
