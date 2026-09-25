import { log } from '../logger.js'
import { embedText, resolveEmbedConfig } from '../ai/embedder.js'
import { rewriteQuery } from '../ai/hyde.js'
import { withInstructPrefix } from '../lib/embed-instruct.js'
import { fuseRankings, type FusedHit, type RankedPath } from '../lib/rrf.js'
import { matchVocabTerms } from '../lib/vocab-match.js'
import type { Db } from '../data/db.js'
import { MAX_LIST_LIMIT, type MemeFilter, type MemeRow } from '../data/memes.js'
import { hasReindexBacklog } from '../data/reindex-jobs.js'
import type { SnapshotInputs } from '../data/search-snapshots.js'
import {
  findMemesForSearch,
  ocrPathCandidates,
  PATH_LIMIT,
  tagPathCandidates,
  vectorPathCandidates,
  type SearchPathOptions,
} from '../data/search.js'

/**
 * 搜索编排（SPEC §6.3.1、agents/rules/retrieval.md）。
 *
 * 三条性质决定了这个文件的形状：
 *
 *   1. **三路同时出发。** 总延迟由最慢的那路决定，串行会把它们加在一起。
 *   2. **任一路失败不牵连其余。** `allSettled` 而不是 `all`——一路挂了不该让整次搜索 500。
 *      降级一律记日志：静默降级和吞掉错误在日志里长得一模一样（code-style.md）。
 *   3. **搜索不写库、不打标。** 全程只有 HyDE 那一次纯文本 LLM 调用（retrieval.md §7）。
 *      例外只有一处：`GET /memes?q=` 会把这次检索的候选名单落成快照
 *      （`services/search-snapshot.ts`），那是分页的实现，不是检索本身。
 *
 * **翻页不重跑这个文件。** 快照冻住了改写与查询向量，后续页只按更大的深度重扫三路
 * （`runSearch` 的 `frozen` 参数），既不调 LLM 也不重新编码。
 */

/**
 * `GET /search` 缺省 `limit`。**它冻结在 50，不是 `GET /memes` 的 40。**
 *
 * SPEC §6.3.3：首页那条路径走的是 `/search` 而且**不传 `limit`**，默认值由服务端说了算；
 * 把它对齐到 §1.3 的 40 等于悄悄改掉首页看到的结果条数，而首页本轮不动（裁定 3）。
 * 「同一个实现」说的是代码路径，不是参数默认值。首页改版、这个入口删掉之后一起消失。
 */
export const DEFAULT_SEARCH_LIMIT = 50

/** 通路标识。`lib/rrf.ts` 只传字符串不认识语义，取值在这里定死，与 SPEC 示例一致。 */
const PATH_VECTOR = 'vector'
const PATH_OCR = 'ocr'
const PATH_TAGS = 'tags'

export type SearchHit = MemeRow & {
  uploaderName: string
  favorited: boolean
  /** 被哪几路召回。**只做展示，不参与排序**（SPEC §6.3.1）。 */
  matchedBy: string[]
}

export type SearchOutcome = {
  items: SearchHit[]
  /**
   * 结果可能不全，前端提示但不阻断展示。两类原因共用这一个布尔：
   *
   *   1. 向量路没跑（没配 embedding 或编码失败）；
   *   2. 向量路跑了，但**只在当前模型的向量里跑**——队列里还有没走完的重算任务，
   *      旧模型那部分召不回来（SPEC §6.3.1、§9.20）。
   *
   * 不拆成两个字段是因为前端的动作是同一个（挂一条「结果可能不全」的提示），
   * 而拆开会让「两个都为真」时的文案变成一道组合题。具体原因写在日志里。
   */
  degraded: boolean
  /**
   * HyDE 改写后的查询，失败时为 null。**只是给用户看的**——它不是结构化的查询理解
   * 结果，也不参与过滤（SPEC §6.3.1）。
   */
  rewritten: string | null
}

/**
 * 冻结的检索输入。**快照翻页靠它重扫三路**（裁定 2）。
 *
 * 不冻住的话每页都要重算一次改写与查询向量：改写逐次不同 → 召回池变化 → 翻页重复或漏，
 * 而且滚一屏就是一次 LLM 调用。这是快照存在的两个理由之一，另一个是排序稳定。
 *
 * 形状**取自 `SnapshotInputs`**（`data/search-snapshots.ts`）而不是在这里另写一遍：
 * 那两个字段就是要落库的那两个，各写一份的话，将来加一个「也要冻住」的东西时
 * 只改一边，另一边静默地每页重算。
 */
export type FrozenInputs = Pick<SnapshotInputs, 'rewritten' | 'vector'>

/** 一次检索的全部产物。快照层拿它落库，其余调用方只取 `fused` 的前 N 条。 */
export type SearchRun = {
  /** 三路各自的有序候选名单。 */
  paths: RankedPath[]
  /** RRF 融合后的有序命中，**未截断**——池子本来就比给出去的多（任务 §2）。 */
  fused: FusedHit[]
  degraded: boolean
  rewritten: string | null
  /** 重扫三路要用的输入，原样交回给 `runSearch` 的 `frozen`。 */
  query: string
  filter: MemeFilter
  actorId: string | null
  frozen: FrozenInputs
}

export type RunSearchParams = {
  /** 去空白之后的查询词。空串不走这里——那是浏览分支（`GET /memes` 的分派）。 */
  query: string
  /** 七个维度 / `isAnimated` / `favorited` / `uploader` / `tagStatus`。 */
  filter?: MemeFilter
  actorId: string | null
  requestId: string
  db: Db
  /** 每路召回深度。默认 `PATH_LIMIT`；快照翻倍预取传新深度。 */
  depth?: number
  /**
   * 快照的时点：只召回这个时刻之前入库的图（SPEC §6.3.1「中途上传的新图也不会出现在
   * 这次检索的后续页里」）。首屏传当下，翻页传快照的 `createdAt`。
   */
  asOf?: Date
  /** 传了就用它重扫（快照翻页）；不传则现算改写与查询向量（首屏）。 */
  frozen?: FrozenInputs
}

/**
 * 三路召回 + RRF 融合。**不取完整行**——取数由调用方按要展示的那一段去做
 * （首屏取前 `limit` 条，翻页只取这一页的那 40 条）。
 *
 * 向量路是唯一需要外部依赖的一路，所以它单独包一层：embedding 没配或调用失败时
 * 这一路空手而归，其余两路照常出结果，只是 `degraded: true`。
 */
export async function runSearch(params: RunSearchParams): Promise<SearchRun> {
  const depth = params.depth ?? PATH_LIMIT
  const { include, exclude } = matchVocabTerms(params.query)
  const filter: MemeFilter = { ...params.filter, exclude }

  // 三路同时出发。OCR 路和标签路吃**原查询**：
  //   - 标签路只做词表精确匹配，改写对它没有意义；
  //   - OCR 路要的是「用户还记得的那句原文」，改写反而会把它抹掉。
  // 只有向量路用改写结果——语义检索才是 HyDE 真正帮得上忙的地方（retrieval.md §3）。
  //
  // `exclude` 是用户明说不要的词条（「猫 不要 真人」）。它**三路都要带**：
  // 排除是过滤不是负分（SPEC §6.3.1），而且必须发生在各路取 top-N **之前**——
  // 融合完再滤的话，被剔掉的名额不会有别的图补上，用户看到的是一个莫名其妙变短的列表。
  const options: SearchPathOptions = {
    filter: params.filter,
    actorId: params.actorId,
    exclude,
    depth,
    asOf: params.asOf,
  }
  const vector =
    params.frozen === undefined
      ? startVectorPath(params.query, options, params.requestId, params.db)
      : frozenVectorPath(params.frozen, options, params.db)

  const [vectorResult, ocrResult, tagResult, backlogResult] = await Promise.allSettled([
    vector.candidates,
    ocrPathCandidates(params.query, options, params.db),
    tagPathCandidates(include, options, params.db),
    // 和三路一起出发，不串在后面：它是存在性查询（`limit 1` 命中 claim 索引，
    // 见 `hasReindexBacklog` 的注释），但再便宜的查询串行也是加一个往返
    hasReindexBacklog(params.db),
  ])

  const paths: RankedPath[] = []

  if (ocrResult.status === 'fulfilled') {
    paths.push({ name: PATH_OCR, ids: ocrResult.value })
  } else {
    log.warn(
      { requestId: params.requestId, err: ocrResult.reason },
      'search: ocr path failed, continuing without it',
    )
  }

  if (tagResult.status === 'fulfilled') {
    paths.push({ name: PATH_TAGS, ids: tagResult.value })
  } else {
    log.warn(
      { requestId: params.requestId, err: tagResult.reason },
      'search: tag path failed, continuing without it',
    )
  }

  // 向量路返回 null 是**正常降级**（没配 embedding），不是故障：接口照常 200，只是标记 degraded
  let degraded = false
  if (vectorResult.status === 'fulfilled' && vectorResult.value !== null) {
    paths.push({ name: PATH_VECTOR, ids: vectorResult.value })
  } else {
    degraded = true
    const reason = vectorResult.status === 'rejected' ? 'failed' : 'not_available'
    log.info({ requestId: params.requestId, reason }, 'search degraded: vector path did not run')
  }

  // 队列里还有没走完的重算任务：向量路**照常参与，但只在当前模型的向量里参与**
  // （`vectorPathCandidates` 的 `embed_model` 过滤）。旧模型那部分这次召不回来，
  // 所以要如实标记。
  //
  // ⚠️ 这里以前写的是「旧向量也是向量，能召回总比召不回强」，那句话是错的：
  //    两个模型的向量不在同一个空间里，它们之间的余弦距离不是「更像」只是噪声，
  //    混进 RRF 等于把随机排名当成有效排名，挤掉的是另外两路的真结果（SPEC §9.20）。
  //
  // 查询本身失败时按「没降级」处理——为了一个提示字段让整次搜索 500 是不划算的
  if (backlogResult.status === 'rejected') {
    log.warn(
      { requestId: params.requestId, err: backlogResult.reason },
      'search: reindex 进度查询失败，按未降级处理',
    )
  } else if (backlogResult.value) {
    degraded = true
    log.info(
      { requestId: params.requestId },
      'search degraded: 队列里还有没走完的重算任务，向量路只覆盖当前模型',
    )
  }

  // 改写与查询向量要等向量路跑完才是最终状态。它自己的超时（2s）封顶，不会拖住响应
  const frozen: FrozenInputs = {
    rewritten: await vector.rewritten,
    vector: await vector.frozen,
  }

  // 融合**不按 limit 截断**：池子（≤ 3 × depth）本来就比任何一页多，
  // 截断在这里会让快照少存一段、翻到那里时凭空到底。
  const fused = fuseRankings(
    paths,
    paths.reduce((total, path) => total + path.ids.length, 0),
  )

  return { paths, fused, degraded, rewritten: frozen.rewritten, query: params.query, filter, actorId: params.actorId, frozen }
}

/**
 * 一次检索取前 `limit` 条（`GET /search` 那条路，以及测试）。
 *
 * `GET /memes?q=` 不走它——那条要落快照、要翻页，走 `services/search-snapshot.ts`。
 * 两者共用上面的 `runSearch` 与下面的 `findMemesForSearch`，**召回与融合只有一份实现**。
 */
export async function searchMemes(
  query: string,
  limit: number,
  actorId: string | null,
  requestId: string,
  db: Db,
  filter: MemeFilter = {},
): Promise<SearchOutcome> {
  const effectiveLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT)

  const run = await runSearch({ query, filter, actorId, requestId, db })
  const items = await fetchHits(run.fused.slice(0, effectiveLimit), actorId, db)

  return { items, degraded: run.degraded, rewritten: run.rewritten }
}

/**
 * 按融合顺序取完整行。
 *
 * 融合到取数之间那张图可能被删了。跳过而不是返回一条已删除的（SPEC §3.4）——
 * `findMemesForSearch` 带着软删过滤，取不到的就在这里消失。
 *
 * 参数只要 `{ id, matchedBy }`，**不收整个 `FusedHit`**：快照翻页那条路手上没有融合分
 * （名单是冻住的），它的 `matchedBy` 现算（`matchedByOf`）。写成整个 `FusedHit` 会逼着
 * 它编一个假的分数出来——那种「为了过类型而填的字段」下一个人不敢删。
 */
export async function fetchHits(
  hits: { id: string; matchedBy: string[] }[],
  actorId: string | null,
  db: Db,
): Promise<SearchHit[]> {
  if (hits.length === 0) return []

  const rows = await findMemesForSearch(
    hits.map((hit) => hit.id),
    actorId,
    db,
  )
  const byId = new Map(rows.map((row) => [row.id, row]))

  const items: SearchHit[] = []
  for (const hit of hits) {
    const row = byId.get(hit.id)
    if (row === undefined) continue
    items.push({ ...row, matchedBy: hit.matchedBy })
  }
  return items
}

/**
 * 一个 id 被哪几路召回过。**翻页时按快照的候选名单现算**，不额外存一份。
 *
 * 名单是只追加的（`services/search-snapshot.ts`），所以同一条命中在它被发出去的那一页
 * 算出来的 `matchedBy` 是确定的；而「后面的页算出来多了一路」不会造成前后矛盾——
 * 一条命中只会被发出去一次。
 */
export function matchedByOf(id: string, paths: RankedPath[]): string[] {
  return paths.filter((path) => path.ids.includes(id)).map((path) => path.name)
}

/** 向量路的三个产物。分开暴露是为了让「召回」「改写」「冻结的向量」各自失败、互不牵连。 */
type VectorPath = {
  /** 召回的 id 列表；`null` 表示这一路没跑（未配置或 embedding 失败）。 */
  candidates: Promise<string[] | null>
  /** 改写文本；失败或这一路没跑时为 null。 */
  rewritten: Promise<string | null>
  /** 冻结的查询向量，快照翻页重扫时要用。没跑时为 null。 */
  frozen: Promise<FrozenInputs['vector']>
}

/**
 * 启动向量路。
 *
 * HyDE 只在**向量路真的要跑**时才调用——它是为语义检索服务的，embedding 没配时
 * 调它纯属浪费一次外部请求，还会让响应里的 `rewritten` 指向一个没有发生过的检索。
 *
 * embedding 失败时用原查询再试一次是没意义的（同一个配置、同一个供应商，会话级故障
 * 不会因为少一次改写就好），所以直接放弃这一路，交给另外两路。
 *
 * ⚠️ **本函数不是 async，这是有意的。** `resolveEmbedConfig()` 现在要查库（配置表优先于
 *    环境变量，SPEC §6.5），如果把它 await 在函数体顶上，调用方就得先 await 整个
 *    `startVectorPath`，OCR 路和标签路要等这次查库回来才出发——三路并发变成串行，
 *    **不报错，只是每个搜索请求多一个往返**。所以配置解析留成 Promise，两个产物
 *    各自 `await` 它。
 */
function startVectorPath(
  query: string,
  options: SearchPathOptions,
  requestId: string,
  db: Db,
): VectorPath {
  const configured = resolveEmbedConfig()

  const rewritten = configured
    .then((config) => (config === null ? null : rewriteQuery(query, options.actorId ?? null, requestId)))
    .catch((err: unknown) => {
      // rewriteQuery 自己已经把所有失败路径收成 null 了。这层是防它将来改坏——
      // 一个漏出来的 rejection 会让整个请求 500，只为了一个展示用的字段，不值得
      log.warn({ requestId, err }, 'search: hyde rewrite threw, treating as no rewrite')
      return null
    })

  /** 查询向量。快照把它冻住之后，翻页不再调这些外部依赖。 */
  const frozen = (async (): Promise<FrozenInputs['vector']> => {
    const config = await configured
    if (config === null) return null

    const input = embedInput(query, await rewritten)

    // 查询侧要 instruct 前缀，文档侧不要。两边都加或都不加会掉点（retrieval.md §4）
    // 配置显式传下去，不让 embedText 再解析一次（同一请求里查两次库，还可能拿到不同结果）
    const embedded = await embedText(withInstructPrefix(input, config.model), config)
    if (!embedded.ok) {
      log.warn({ requestId, reason: embedded.reason }, 'search: embed failed, vector path skipped')
      return null
    }

    return { values: embedded.vector, model: config.model }
  })().catch((err: unknown) => {
    // 上面的失败路径都收成了 null。这层是防 `resolveEmbedConfig` 将来抛出来——
    // 让它冒出去的话整个请求 500，而这次检索其实还有另外两路可以走
    log.warn({ requestId, err }, 'search: vector path threw, treating as not available')
    return null
  })

  const candidates = frozen.then((vector) =>
    vector === null
      ? null
      : vectorPathCandidates(vector.values, vector.model, options, db),
  )

  return { candidates, rewritten, frozen }
}

/**
 * 用**冻住的那一份**重扫向量路（快照翻页）。不调 HyDE、不调 embedding。
 *
 * `rewritten` 直接回抛传入的值：调用方（快照层）存着它，不需要再算一遍，
 * 也不能再算一遍——再算一次就是「滚一屏一次 LLM 调用」，而且结果会不同。
 */
function frozenVectorPath(
  frozen: FrozenInputs,
  options: SearchPathOptions,
  db: Db,
): VectorPath {
  return {
    candidates:
      frozen.vector === null
        ? Promise.resolve(null)
        : vectorPathCandidates(frozen.vector.values, frozen.vector.model, options, db),
    rewritten: Promise.resolve(frozen.rewritten),
    frozen: Promise.resolve(frozen.vector),
  }
}

/**
 * 喂给 embedding 的文本：**原查询 + 改写，不是只有改写**。
 *
 * 改写是补充不是替代。只编码改写的代价是「改写丢掉的东西就永久丢掉了」，而它最爱丢的
 * 正是否定和语气——「不要真人」被改写成「一个真人在摆手」之后，向量路会兴高采烈地召回
 * 一整屏用户明说不要的图，**没有任何地方会报错**。原查询留在输入里，至少那几个字还在。
 *
 * 拼接顺序是原查询在前：它是用户真正打的字，改写是模型的猜测；截断发生在尾部
 * （见 lib/vector.ts），该被砍掉的应该是猜测那一半。
 *
 * 改写失败（null）时退回原查询，向量路照跑——改写只是锦上添花，不该让整条路跟着消失。
 */
function embedInput(query: string, rewritten: string | null): string {
  return rewritten === null ? query : `${query} ${rewritten}`
}
