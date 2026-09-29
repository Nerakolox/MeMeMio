/**
 * LIKE / ILIKE 的字面量转义。纯函数、零 I/O。
 *
 * `%` 和 `_` 是 LIKE 的元字符，用户搜「100%」时必须当成字面量。**不转义也不报错**：
 * 那个查询会多召回一批（`%` 匹配任意串），看起来只是「搜出来的东西不太对」。
 *
 * 从 `data/search.ts` 挪到这里是因为人物 / 系列的列表（`data/persons.ts`）也要按名字
 * 做同样的包含匹配，而**两份 escapeLike 迟早有一份忘了转义 `_`**。
 */

/** 转义 `\` `%` `_`。反斜杠要排在最前，否则会把后面刚加上的转义符再转义一次。 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/**
 * 「包含」匹配用的模式串（外部再交给 `like` / `ilike`）。
 *
 * 前缀 `%` 会让 B-tree 索引失效，这是包含匹配的固有代价；**trgm 索引照常可用**
 * （`gin_trgm_ops` 支持 `%` 模式），所以名字上那两套索引不是白建的。
 */
export function containsPattern(value: string): string {
  return `%${escapeLike(value)}%`
}
