/**
 * 只追加地合并两批排名名单。纯函数、零 I/O —— 它在 lib/ 的唯一理由是被测。
 *
 * 用于检索快照的**深度翻倍预取**（SPEC §6.3.1；设计见 agents/rules/retrieval.md §6）。
 *
 * ## 为什么不能整体替换
 *
 * 深度翻倍之后重扫三路，拿到的是**一整份新的排名**，而不是旧名单的超集：同一查询在
 * `ef_search = 40` 与 `= 100` 下返回的**集合不同**（2026-09-26 实测：40 条 vs 50 条）。
 * 直接替换会让**已经发出去的页边界移动**——第 12 条从第 1 页挪到第 2 页，用户看到的是
 * 重复；反过来则是有东西**再也翻不到**。两种都不报错。
 *
 * 所以规则是：**每条通路一旦定下前缀就不再改**，深扫只把没见过的新 id 按新扫里的
 * 相对顺序接在后面。已发出项的路径排名因此不变 → RRF 分不变 → 旧页新页天然对齐。
 *
 * ## 「在后面」为什么够用
 *
 * 新 id 的路径排名必然差于旧名单里的同路项（旧名单就是新扫的前缀），所以它拿到的
 * 每一路贡献都更小。**跨路的例外存在**：新 id 被三路同时召回（3 × 1/(k+301)）可以
 * 高过旧 id 只被一路召回（1/(k+300)）。那不会造成重复或漏——翻页取的是「融合序里
 * 还没发过的前 N 条」（`services/search-snapshot.ts`），已经发过的 id 一律跳过，
 * 所以被插到前面的新 id 只是**晚一点**出现，不会顶掉谁。**别把它改成「整体重排再
 * 按下标切页」**，那才会坏。
 */

/** 与 `lib/rrf.ts` 的 `RankedPath` 同形。这里不 import 它，是为了让 lib 保持零 import。 */
type Path = { name: string; ids: string[] }

export type AppendResult = {
  /** 合并后的名单：旧的前缀原样保留，新的只接在后面。 */
  paths: Path[]
  /** 一共接上去多少条新 id（含新出现的一整路）。`0` 表示三路都已经给不出新东西了。 */
  added: number
}

export function appendRankedPaths(stored: Path[], fresh: Path[]): AppendResult {
  const merged = stored.map((path) => ({ name: path.name, ids: [...path.ids] }))
  const byName = new Map(merged.map((path) => [path.name, path]))
  let added = 0

  for (const path of fresh) {
    const target = byName.get(path.name)
    if (target === undefined) {
      // 这一路首屏没跑成、这次跑成了（比如 embedding 中途配好了）。**整路接上**，
      // 不是丢掉：丢掉等于让这次检索在后续页里少一路召回，而它看起来只是「结果变少」
      merged.push({ name: path.name, ids: [...path.ids] })
      added += path.ids.length
      continue
    }

    // 去重按「已经在这个路里的全部 id」判，不是按前缀判：深扫之间也可能重复吐同一条
    const seen = new Set(target.ids)
    for (const id of path.ids) {
      if (seen.has(id)) continue
      seen.add(id)
      target.ids.push(id)
      added += 1
    }
  }

  return { paths: merged, added }
}
