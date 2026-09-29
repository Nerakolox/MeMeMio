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
 * 截断到 `dim` 维并**重新归一化**。
 *
 * 截断会让范数小于 1，直接存进 pgvector 的 cosine 空间就是错的。这两步必须成对出现，
 * 所以合成一个函数 —— 调用方没有机会只做前半步。
 *
 * 优先走供应商的 `dimensions` 参数（服务端直接返回目标维度），走不了才调这个。
 * 走哪条由 `*_config.dim_param_works` 决定，那是测试连接实测出来的，不是猜的。
 *
 * ⚠️ **维度是参数，不写死。** 文本向量与人物向量是**两个空间、两份配置**
 *    （SPEC §5.7.1），各自的维度互不推导：把这里的默认值当成唯一口径，
 *    改文本 embedding 的维度就会**静默**改掉人物向量的截断长度——而两者的
 *    `vector(n)` 列是分开的，表现出来的只是余弦值悄悄失真。
 */
export function truncateAndNormalize(vector: number[], dim: number = EMBED_DIM): number[] {
  return l2Normalize(vector.slice(0, dim))
}

/**
 * 余弦相似度。**只给「同一空间、同一口径」的两份向量用**——跨空间（文本 vs 图片、
 * 长边 768 vs 512）比出来的数是噪声，而且不会报错（SPEC §5.7.1）。
 *
 * 任一边范数为 0 时返回 `NaN` 而不是 0：全零向量意味着上游什么都没编码，
 * 「相似度为 0」会让调用方以为那是两张不一样的图。NaN 逼调用方显式处理这一支。
 *
 * 库里那条路不用它（pgvector 的 `<=>` 直接在 SQL 里算），这里是给探测用的：
 * 判「两张明显不同的图是不是算出几乎一样的向量」（§6.7.5）。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.NaN

  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return Number.NaN
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
