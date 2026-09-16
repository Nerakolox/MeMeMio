import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { memes, users, userFavorites } from './schema.js'
import type { MemeRow } from './memes.js'

/**
 * 检索的**三条通路**（SPEC §9.10）。
 *
 * ⚠️ **这里是三段分别写的 SQL，`deleted_at is null` 三段都要带。**
 *    这是最容易只改一处的地方（agents/rules/database.md §1.1），也是
 *    tests/search.test.ts 为每一路各留一个用例的原因。
 *
 * 三条路都回 id 列表而不是完整行：RRF 只需要排名，融合完再按 id 取一次完整数据。
 * 让每路都 SELECT * 会把三份重复行拉进内存，还多三次 JOIN users 的代价。
 */

/** 每路召回条数。改它要跑评测集（retrieval.md §8）。 */
export const PATH_LIMIT = 50

/**
 * pg_trgm 的相似度下限。
 *
 * 0.1 故意很松：这一路存在的意义是「用户记得图上那句原文」，松一点换来召回，
 * 精确排序交给 RRF 用排名完成。它**不是**判相关的阈值。
 */
const TRGM_THRESHOLD = 0.1
const TRGM_MIN_QUERY_LENGTH = 3

/**
 * 三个数组字段里任意一个包含该词条。**扁平匹配**——词表在 JSON 里分组，
 * 在库里是扁平数组，接口里也不保留分组（shared/vocab/README.md 的警告）。
 */
function anyLabelMatches(term: string) {
  return sql`(${memes.emotions} @> ARRAY[${term}]::text[]
    or ${memes.scenes} @> ARRAY[${term}]::text[]
    or ${memes.tags} @> ARRAY[${term}]::text[])`
}

/** 两路文本匹配共用的相关性表达式，orderBy 和 where 都要用同一个。 */
function trgmScore(query: string) {
  return sql`greatest(
    similarity(coalesce(${memes.searchText}, ''), ${query}),
    similarity(coalesce(${memes.originalFilename}, ''), ${query})
  )`
}

/**
 * OCR / 文件名通路：`pg_trgm` 子串匹配。
 *
 * `search_text` 是 ocr_text + description + 三个数组的派生字段（SPEC §5.2.3）；
 * `original_filename` **参与但不进 search_text**，所以要单独提出来匹配——
 * 从网上存的表情包，文件名里常常带着梗名（SPEC §9.18）。
 *
 * ⚠️ 中文用 pg_trgm 而不是 `to_tsvector`：PostgreSQL 默认不分中文词，直接用等于没用（SPEC §9.10）。
 *
 * `similarity()` 需要 pg_trgm 的阈值 `%` 语义只对索引扫描有意义，这里用显式比较，
 * 不依赖会话级的 set_limit —— 连接池里别人改过的设置会静默影响这一路的结果。
 */
export async function ocrPathCandidates(query: string, db: Db = defaultDb): Promise<string[]> {
  if (query.trim().length < TRGM_MIN_QUERY_LENGTH) return []

  // 短查询（3–4 字）的 trigram 太少，similarity 天然偏低，阈值反而挡住了正确的召回。
  // 补一条 LIKE 兜底：用户搜的原文确实在库里时，子串匹配必须命中。
  const pattern = `%${escapeLike(query)}%`

  const rows = await db
    .select({ id: memes.id })
    .from(memes)
    .where(
      and(
        // 软删过滤。三段 SQL 各带一次，漏掉的表现是「删掉的图又出现了」，不报错
        isNull(memes.deletedAt),
        sql`(${trgmScore(query)} >= ${TRGM_THRESHOLD}
          or ${memes.searchText} like ${pattern}
          or ${memes.originalFilename} like ${pattern})`,
      ),
    )
    .orderBy(sql`${trgmScore(query)} desc`, desc(memes.createdAt))
    .limit(PATH_LIMIT)

  return rows.map((r) => r.id)
}

/** LIKE 里的 % 和 _ 是元字符，用户搜「100%」时必须当成字面量。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/**
 * 标签通路：查询词与词表词条精确匹配，命中则筛出该标签的图。
 *
 * 词条切分在 `lib/vocab-match.ts`（纯函数、有单测），这里只管查。
 * 多词之间是 AND ——「猫 无语」找的是同时有这两个标签的图，与浏览接口的多值语义一致（SPEC §6.3.2）。
 */
export async function tagPathCandidates(terms: string[], db: Db = defaultDb): Promise<string[]> {
  if (terms.length === 0) return []

  const rows = await db
    .select({ id: memes.id })
    .from(memes)
    .where(and(isNull(memes.deletedAt), ...terms.map(anyLabelMatches)))
    // 标签路没有相关性可言，全部并列。用时间倒序给一个稳定的顺序
    .orderBy(desc(memes.createdAt), desc(memes.id))
    .limit(PATH_LIMIT)

  return rows.map((r) => r.id)
}

/**
 * 向量通路：pgvector HNSW cosine 近邻。
 *
 * `<=>` 是 cosine 距离，**升序**就是最相似的在前。
 *
 * ⚠️ 共享库没有 `WHERE uploader_id = ?` 这个过滤条件，HNSW 跑在最舒服的状态；
 *    `deleted_at is null` 选择率接近 1，不构成同类问题（database.md §2）。
 *    但仍然要带——它不是性能问题，是正确性问题。
 *
 * 查询向量由调用方编码好（embedder 已做截断 + L2 归一化，见 lib/vector.ts）。
 */
export async function vectorPathCandidates(
  vector: number[],
  db: Db = defaultDb,
): Promise<string[]> {
  if (vector.length === 0) return []

  // 拼成 pgvector 字面量 [a,b,c]。数值来自 JSON 解析，不是用户输入，
  // 但仍然先过一遍 Number.isFinite —— NaN 进 pgvector 会让这一路静默返回空
  const literal = `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`

  const rows = await db
    .select({ id: memes.id })
    .from(memes)
    .where(and(isNull(memes.deletedAt), sql`${memes.embedding} is not null`))
    .orderBy(sql`${memes.embedding} <=> ${literal}::vector`)
    .limit(PATH_LIMIT)

  return rows.map((r) => r.id)
}

/**
 * 融合之后的取数：按 id 取完整行，带 uploaderName 与当前用户的 favorited。
 *
 * **不保留传入顺序**——排序由调用方按 RRF 分数做，数据层不认识 RRF。
 * 软删过滤照旧（SPEC §3.4）：融合期间那张图被别人删掉了，这里就不该再出现。
 */
export async function findMemesForSearch(
  ids: string[],
  actorId: string | null,
  db: Db = defaultDb,
): Promise<(MemeRow & { uploaderName: string; favorited: boolean })[]> {
  if (ids.length === 0) return []

  const rows = await db
    .select({
      meme: memes,
      uploaderName: users.name,
      favoritedAt: userFavorites.createdAt,
    })
    .from(memes)
    .innerJoin(users, eq(memes.uploaderId, users.id))
    .leftJoin(
      userFavorites,
      actorId
        ? and(eq(userFavorites.memeId, memes.id), eq(userFavorites.userId, actorId))
        : sql`false`,
    )
    .where(and(isNull(memes.deletedAt), inArray(memes.id, ids)))

  return rows.map((r) => ({
    ...r.meme,
    uploaderName: r.uploaderName,
    favorited: r.favoritedAt !== null,
  }))
}
