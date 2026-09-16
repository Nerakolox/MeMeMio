/**
 * RRF（倒数排名融合）。纯函数、零 I/O —— 它在 lib/ 的唯一理由是被测。
 *
 * ⚠️ **不要改成加权求和。** 向量余弦相似度和 pg_trgm 相似度量纲完全不同，权重根本
 *    调不出来；而且管理员换一次 embedding 模型，相似度的绝对值分布就整体漂移一次，
 *    写死的阈值又得重调一轮。RRF 只看排名，换模型不受影响。
 *    见 SPEC §9.10、agents/rules/retrieval.md §2。
 */

/** 业界通用起点。调它之前先跑评测集（retrieval.md §8）。 */
export const RRF_K = 60

/** 单条结果的融合分与它被哪几路召回。 */
export type FusedHit = {
  id: string
  score: number
  /** 通路标识，取值 'vector' | 'ocr' | 'tags'。只做展示，不参与排序。 */
  matchedBy: string[]
}

/** 一路召回的结果，按该路自己的相关性**从好到坏**排序。 */
export type RankedPath = {
  name: string
  ids: string[]
}

/**
 * 融合多路召回结果。
 *
 *     score(doc) = Σ over 通路  1 / (k + rank(doc))
 *
 * `rank` 从 1 开始（不是 0）—— `1/(k+0)` 会让第一名异常突出，且和没进榜的差距拉不开。
 *
 * 排序不稳定性是这里最容易忽略的问题：分数相同的两条如果顺序随机，同样的查询两次
 * 可能给出不同结果。所以**并列时按 id 升序**兜底，让排序完全确定。
 */
export function fuseRankings(paths: RankedPath[], limit: number): FusedHit[] {
  const byId = new Map<string, FusedHit>()

  for (const path of paths) {
    // 一路内部先去重。数据层的三段 SQL 各自带了 limit，理论上不会吐重复 id，
    // 但真吐了的话「同一路里出现两次」会拿到双倍分，把排序整个带偏——
    // 而去重的代价只是一个 Set，便宜到没有理由不做
    const seenInPath = new Set<string>()

    // ⚠️ rank 取 `seenInPath.size + 1`，**不是数组下标**。去重之后两者会分叉：
    //    一路里出现过重复 id 时，下标已经往前走了而排名不该走。用下标会让重复之后
    //    的每一条都白掉一名，不报错、只是排序静静地偏掉。
    path.ids.forEach((id) => {
      if (seenInPath.has(id)) return

      const rank = seenInPath.size + 1
      seenInPath.add(id)
      const hit = byId.get(id) ?? { id, score: 0, matchedBy: [] }
      hit.score += 1 / (RRF_K + rank)
      if (!hit.matchedBy.includes(path.name)) hit.matchedBy.push(path.name)
      byId.set(id, hit)
    })
  }

  return [...byId.values()]
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)))
    .slice(0, limit)
}
