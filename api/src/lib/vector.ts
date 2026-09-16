/**
 * 向量数学。纯函数、零 I/O。
 *
 * ⚠️ **本项目最隐蔽的一个 bug 形态就在这个文件里。** 见 SPEC §9.6、agents/rules/database.md §2：
 *    截断向量后忘记重新 L2 归一化，**不报错、不崩溃**，只是余弦相似度静默失真、
 *    搜索结果慢慢变差，几周后才在评测集上暴露。所以必须有单测（见 vector.test.ts）。
 */

/** 全站固定维度。不是每条记录的属性，所以表里没有 embed_dim 字段（SPEC §5.2.4）。 */
export const EMBED_DIM = 1024

/**
 * L2 归一化。零向量原样返回 —— 除以 0 会得到全 NaN，那一进 pgvector 就是
 * 「这条记录永远搜不到」，而日志里什么都不会出现。
 */
export function l2Normalize(vector: number[]): number[] {
  let sumOfSquares = 0
  for (const value of vector) sumOfSquares += value * value

  const norm = Math.sqrt(sumOfSquares)
  if (norm === 0) return vector

  return vector.map((value) => value / norm)
}

/**
 * 截断到 EMBED_DIM 维并**重新归一化**。
 *
 * 截断会让范数小于 1，直接存进 pgvector 的 cosine 空间就是错的。这两步必须成对出现，
 * 所以合成一个函数 —— 调用方没有机会只做前半步。
 *
 * 优先走供应商的 `dimensions` 参数（服务端直接返回 1024 维），走不了才调这个。
 * 走哪条由 `embed_config.dim_param_works` 决定，那是测试连接实测出来的，不是猜的。
 */
export function truncateAndNormalize(vector: number[]): number[] {
  return l2Normalize(vector.slice(0, EMBED_DIM))
}
