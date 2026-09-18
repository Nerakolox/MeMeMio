import { log } from '../logger.js'
import { embedText, resolveEmbedConfig } from '../ai/embedder.js'
import { rewriteQuery } from '../ai/hyde.js'
import { withInstructPrefix } from '../lib/embed-instruct.js'
import { fuseRankings, type RankedPath } from '../lib/rrf.js'
import { matchVocabTerms } from '../lib/vocab-match.js'
import type { Db } from '../data/db.js'
import type { MemeRow } from '../data/memes.js'
import { hasUnfinishedReindexJobs } from '../data/reindex-jobs.js'
import {
  findMemesForSearch,
  ocrPathCandidates,
  tagPathCandidates,
  vectorPathCandidates,
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
 */

/** SPEC §6.3.1：limit 默认 50，最大 100。搜索**不分页**。 */
export const DEFAULT_SEARCH_LIMIT = 50
export const MAX_SEARCH_LIMIT = 100

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
   * 结果可能不全，前端提示但不阻断展示。两种原因共用这一个布尔：
   *
   *   1. 向量路没参与（没配 embedding 或调用失败）；
   *   2. 还有未完成的重算任务——一部分图的向量是旧模型算的，和查询向量不在同一个
   *      空间里，召回会偏（SPEC §6.5.4）。
   *
   * 不拆成两个字段是因为前端的动作是同一个（挂一条「结果可能不全」的提示），
   * 而拆开会让「两个都为真」时的文案变成一道组合题。具体原因写在日志里。
   */
  degraded: boolean
  /** HyDE 改写后的查询，失败时为 null。 */
  rewritten: string | null
}

/**
 * 三路召回 + RRF 融合 + 取数。
 *
 * 向量路是唯一需要外部依赖的一路，所以它单独包一层：embedding 没配或调用失败时
 * 这一路空手而归，其余两路照常出结果，只是 `degraded: true`。
 */
export async function searchMemes(
  query: string,
  limit: number,
  actorId: string | null,
  requestId: string,
  db: Db,
): Promise<SearchOutcome> {
  const effectiveLimit = Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT)

  // 三路同时出发。OCR 路和标签路吃**原查询**：
  //   - 标签路只做词表精确匹配，改写对它没有意义；
  //   - OCR 路要的是「用户还记得的那句原文」，改写反而会把它抹掉。
  // 只有向量路用改写结果——语义检索才是 HyDE 真正帮上忙的地方（retrieval.md §3）。
  const terms = matchVocabTerms(query)
  const vector = startVectorPath(query, actorId, requestId)

  const [vectorResult, ocrResult, tagResult, reindexResult] = await Promise.allSettled([
    vector.candidates,
    ocrPathCandidates(query, db),
    tagPathCandidates(terms, db),
    // 和三路一起出发，不串在后面：它是存在性查询（`limit 1` 命中 claim 索引，
    // 见 `hasUnfinishedReindexJobs` 的注释），但再便宜的查询串行也是加一个往返
    hasUnfinishedReindexJobs(db),
  ])

  const paths: RankedPath[] = []

  if (ocrResult.status === 'fulfilled') {
    paths.push({ name: PATH_OCR, ids: ocrResult.value })
  } else {
    log.warn({ requestId, err: ocrResult.reason }, 'search: ocr path failed, continuing without it')
  }

  if (tagResult.status === 'fulfilled') {
    paths.push({ name: PATH_TAGS, ids: tagResult.value })
  } else {
    log.warn({ requestId, err: tagResult.reason }, 'search: tag path failed, continuing without it')
  }

  // 向量路返回 null 是**正常降级**（没配 embedding），不是故障：接口照常 200，只是标记 degraded
  let degraded = false
  if (vectorResult.status === 'fulfilled' && vectorResult.value !== null) {
    paths.push({ name: PATH_VECTOR, ids: vectorResult.value })
  } else {
    degraded = true
    log.info(
      { requestId, reason: vectorResult.status === 'rejected' ? 'failed' : 'not_available' },
      'search degraded: vector path did not run',
    )
  }

  // 重算在跑：向量路**照常参与**（旧向量也是向量，能召回总比召不回强），只是标记结果不全。
  // 查询本身失败时按「没在重算」处理——为了一个提示字段让整次搜索 500 是不划算的
  if (reindexResult.status === 'rejected') {
    log.warn({ requestId, err: reindexResult.reason }, 'search: reindex 进度查询失败，按未降级处理')
  } else if (reindexResult.value) {
    degraded = true
    log.info({ requestId }, 'search degraded: 还有未完成的重算任务')
  }

  const fused = fuseRankings(paths, effectiveLimit)
  const rows = await findMemesForSearch(
    fused.map((hit) => hit.id),
    actorId,
    db,
  )

  const byId = new Map(rows.map((row) => [row.id, row]))
  const items: SearchHit[] = []
  for (const hit of fused) {
    const row = byId.get(hit.id)
    // 融合到取数之间那张图被删了。跳过而不是返回一条已删除的（SPEC §3.4）
    if (row === undefined) continue
    items.push({ ...row, matchedBy: hit.matchedBy })
  }

  // 改写要等向量路跑完才是最终状态。它自己的超时（2s）封顶，不会拖住响应
  const rewritten = await vector.rewritten

  return { items, degraded, rewritten }
}

/** 向量路的两个产物。分开暴露是为了让「召回」和「改写」各自失败、互不牵连。 */
type VectorPath = {
  /** 召回的 id 列表；`null` 表示这一路没跑（未配置或 embedding 失败）。 */
  candidates: Promise<string[] | null>
  /** 改写文本；失败或这一路没跑时为 null。 */
  rewritten: Promise<string | null>
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
function startVectorPath(query: string, actorId: string | null, requestId: string): VectorPath {
  const configured = resolveEmbedConfig()

  const rewritten = configured
    .then((config) => (config === null ? null : rewriteQuery(query, actorId, requestId)))
    .catch((err: unknown) => {
      // rewriteQuery 自己已经把所有失败路径收成 null 了。这层是防它将来改坏——
      // 一个漏出来的 rejection 会让整个请求 500，只为了一个展示用的字段，不值得
      log.warn({ requestId, err }, 'search: hyde rewrite threw, treating as no rewrite')
      return null
    })

  const candidates = (async (): Promise<string[] | null> => {
    const config = await configured
    if (config === null) return null

    // 改写失败（null）时退回原查询：改写只是锦上添花，不该让整条向量路跟着消失
    const text = (await rewritten) ?? query

    // 查询侧要 instruct 前缀，文档侧不要。两边都加或都不加会掉点（retrieval.md §4）
    // 配置显式传下去，不让 embedText 再解析一次（同一请求里查两次库，还可能拿到不同结果）
    const embedded = await embedText(withInstructPrefix(text, config.model), config)
    if (!embedded.ok) {
      log.warn({ requestId, reason: embedded.reason }, 'search: embed failed, vector path skipped')
      return null
    }

    return vectorPathCandidates(embedded.vector)
  })()

  return { candidates, rewritten }
}
