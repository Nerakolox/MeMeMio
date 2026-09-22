import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { memes, users, userFavorites } from './schema.js'
import type { MemeRow } from './memes.js'
import { VOCAB_FIELDS } from '../vocab.js'

/**
 * 检索的**三条通路**（SPEC §9.10）。
 *
 * ⚠️ **这里是三段分别写的 SQL，`deleted_at is null` 三段都要带。**
 *    这是最容易只改一处的地方（agents/rules/database.md §1.1），也是
 *    tests/search.test.ts 为每一路各留一个用例的原因。
 *
 * 三条路都回 id 列表而不是完整行：RRF 只需要排名，融合完再按 id 取一次完整数据。
 * 让每路都 SELECT * 会把三份重复行拉进内存，还多三次 JOIN users 的代价。
 *
 * ⚠️ **三条路的匹配目标必须互不重叠。** 文本路匹配原文、标签路匹配标签、向量路匹配语义。
 *    一旦两条路读同一个字段，RRF 就不再是「两个独立证据」而是「一个证据数了两遍」，
 *    排序会被静默带偏（SPEC §9.21）。
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
 * 六个数组字段里任意一个包含该词条。**扁平匹配**——词表在 JSON 里分组，
 * 在库里是扁平数组，接口里也不保留分组（shared/vocab/README.md 的警告）。
 *
 * 为什么是 OR 而不是「查哪一维就只匹配哪一维」：用户搜「微笑」时不会声明那是
 * `expressions`，查询分词（`lib/vocab-match.ts`）也不知道。维度约束落在**打标和
 * 筛选 UI**上，检索这边一个词命中任意一维都算数。
 */
function anyLabelMatches(term: string): SQL {
  return sql.join(
    VOCAB_FIELDS.map((field) => sql`${memes[field]} @> ARRAY[${term}]::text[]`),
    sql` or `,
  )
}

/**
 * 把「用户明确不要的标签」变成过滤条件。**过滤，不是负分**（SPEC §6.3.1）。
 *
 * `&&` 是数组相交：任一维度里出现了任一个被排除的词，这条就出局。
 * 放在每一路的 WHERE 里而不是融合后统一过滤，是为了让排除发生在取 top-N **之前**——
 * 融合后再滤的话，被剔掉的名额不会有别的图补上来，用户会看到一个莫名其妙变短的列表。
 */
function excludeLabels(terms: string[]): SQL | undefined {
  if (terms.length === 0) return undefined
  const literal = sql`ARRAY[${sql.join(terms.map((t) => sql`${t}`), sql`, `)}]::text[]`
  return sql`not (${sql.join(
    VOCAB_FIELDS.map((field) => sql`coalesce(${memes[field]}, '{}'::text[]) && ${literal}`),
    sql` or `,
  )})`
}

/**
 * 文本通路匹配的目标：**原文，不是 `search_text`**。
 *
 * `search_text` 里拼着六个数组的标签值（SPEC §5.2.3），让 trgm 也匹配它们等于同一个
 * 信号被文本路和标签路各计一次分——一张靠标签沾边的图会压过一张原文精确命中的图
 * （SPEC §9.21 里有算式）。所以这里只拼 `ocr_text` + `description`。
 *
 * ⚠️ **这个表达式和 `memes_text_trgm_idx` 的索引定义必须逐字一致**（`data/schema.ts`），
 *    差一个空格索引就用不上，而查询照样能跑出正确结果——只是慢，不报错。
 */
function textTarget() {
  return sql`(coalesce(${memes.ocrText}, '') || ' ' || coalesce(${memes.description}, ''))`
}

/** 两处文本匹配共用的相关性表达式，orderBy 和 where 都要用同一个。 */
function trgmScore(query: string) {
  return sql`greatest(
    similarity(${textTarget()}, ${query}),
    similarity(coalesce(${memes.originalFilename}, ''), ${query})
  )`
}

/**
 * OCR / 文件名通路：`pg_trgm` 子串匹配。
 *
 * 匹配 `ocr_text` + `description`，外加 `original_filename`——后者**参与 trgm 但不进
 * `search_text`**，所以要单独提出来匹配：从网上存的表情包，文件名里常常带着梗名（SPEC §9.18）。
 *
 * ⚠️ 中文用 pg_trgm 而不是 `to_tsvector`：PostgreSQL 默认不分中文词，直接用等于没用（SPEC §9.10）。
 *
 * `similarity()` 需要 pg_trgm 的阈值 `%` 语义只对索引扫描有意义，这里用显式比较，
 * 不依赖会话级的 set_limit —— 连接池里别人改过的设置会静默影响这一路的结果。
 *
 * **短于 3 字的查询直接跳过这一路。** trigram 在 1–2 字上几乎没有区分度，跑了也是噪声；
 * 那种查询本来就该由标签路接住（「猫」「谢谢」都是词表里有的），不是这一路的职责。
 */
export async function ocrPathCandidates(
  query: string,
  exclude: string[] = [],
  db: Db = defaultDb,
): Promise<string[]> {
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
          or ${textTarget()} like ${pattern}
          or ${memes.originalFilename} like ${pattern})`,
        excludeLabels(exclude),
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
 *
 * **多词之间是 OR，按命中个数排序**，不是 AND。
 *
 * 这条是 2026-09-22 改的，原先是 AND + 时间倒序。两个理由：
 *
 * 1. **AND 会随维度数量膨胀而塌成空集。** 六个维度之后，「猫 无语 敷衍 加班」这种
 *    很自然的查询要求一张图同时带齐四个标签，库里多半一张都没有——而用户的意思
 *    显然是「越沾边越好」，不是「必须全中」。浏览接口的 AND 是**筛选**，用户看得见
 *    自己勾了几个框；搜索框里的多词是**描述**，两者语义本来就不同（SPEC §6.3.2 管前者）。
 * 2. **时间倒序不是相关性。** RRF 只吃排名，喂给它一个按 `created_at` 排的列表，等于
 *    告诉它「新上传的更相关」。命中 3 个词的图排在命中 1 个词的前面，才是这一路
 *    真正知道的那点信息。
 *
 * `desc(createdAt), desc(id)` 留在后面做 tie-break：命中个数相同的要有稳定顺序，
 * 否则同一个查询两次跑出来的 RRF 排名会不一样。
 */
export async function tagPathCandidates(
  terms: string[],
  exclude: string[] = [],
  db: Db = defaultDb,
): Promise<string[]> {
  if (terms.length === 0) return []

  const matchCount = sql<number>`(${sql.join(
    terms.map((t) => sql`(case when (${anyLabelMatches(t)}) then 1 else 0 end)`),
    sql` + `,
  )})`

  const rows = await db
    .select({ id: memes.id })
    .from(memes)
    .where(
      and(
        isNull(memes.deletedAt),
        sql`(${sql.join(terms.map(anyLabelMatches), sql` or `)})`,
        excludeLabels(exclude),
      ),
    )
    .orderBy(sql`${matchCount} desc`, desc(memes.createdAt), desc(memes.id))
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
 * ⚠️ **`embed_model` 过滤同理**（SPEC §9.20）：稳态下全库都是当前模型，选择率也≈1；
 *    只有换模型期间才下降，而那正是要它生效的时候。两个模型的向量不在同一个空间里，
 *    它们之间的余弦距离不是「更像」，只是噪声——混进 RRF 是把随机排名当成有效排名。
 *    `embedModel` 传 null 表示 embedding 没配置，这一路直接不跑。
 *
 * 查询向量由调用方编码好（embedder 已做截断 + L2 归一化，见 lib/vector.ts）。
 */
export async function vectorPathCandidates(
  vector: number[],
  embedModel: string | null,
  exclude: string[] = [],
  db: Db = defaultDb,
): Promise<string[]> {
  if (vector.length === 0 || embedModel === null) return []

  // 拼成 pgvector 字面量 [a,b,c]。数值来自 JSON 解析，不是用户输入，
  // 但仍然先过一遍 Number.isFinite —— NaN 进 pgvector 会让这一路静默返回空
  const literal = `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`

  const rows = await db
    .select({ id: memes.id })
    .from(memes)
    .where(
      and(
        isNull(memes.deletedAt),
        sql`${memes.embedding} is not null`,
        eq(memes.embedModel, embedModel),
        excludeLabels(exclude),
      ),
    )
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
