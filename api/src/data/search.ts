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
 * HNSW 的搜索宽度，**必须 ≥ `PATH_LIMIT`**。
 *
 * ⚠️ 这个数是 pgvector 一次索引扫描**最多能给出多少条**，和 SQL 的 `LIMIT` 是两件事：
 *    `LIMIT 50` 只说「我要 50 条」，真能给多少由它决定。它的默认值是 **40**，
 *    于是向量路永远少召回 10 条——**不报错、不告警**，只是 RRF 少了 10 条候选，
 *    排序静静地变差。这与过滤条件无关，是 `LIMIT` 和 `ef_search` 之间的关系。
 *
 * 取 `PATH_LIMIT * 2` 而不是刚好相等：`embed_model`、`deleted_at`、排除标签都是
 * **后置过滤**，候选先被索引取出来、再被 where 剔掉。真库实测（强制走索引、带一个
 * 排除词）：默认 40 → **39 条**，`= 50` → 49 条，`= 100` → 50 条。留一倍余量给过滤。
 * 改 `PATH_LIMIT` 时这个跟着走。
 *
 * ⚠️ **不用 `hnsw.iterative_scan`**：那是 pgvector 0.8 才注册的参数。更老的版本上这条
 *    `set_config` 是个永远等不到提升的占位符——**静默忽略**，`LIMIT 50` 照旧被截成 40 条，
 *    和没修一样。`hnsw.ef_search` 自 HNSW 存在（0.5）起就是运行时参数，是版本无关的写法。
 *    本机 0.8.6 上两者都能返满 50 条（实测），所以这不是效果之争，是部署底线之争。
 *
 * ⚠️ **`hnsw.*` 是保留前缀**：pgvector 加载之后，`set_config` 一个它**没注册**的 `hnsw.*`
 *    名字会直接报错（42602 `"hnsw" is a reserved prefix`），而不是静默忽略。
 *    所以这里只用真名字。另一头也实测过：在**尚未加载 pgvector 的**连接上先
 *    `set_config('hnsw.ef_search', …)` 建的是占位符，扩展首次被用到时把它提升上去，
 *    值照样生效（全新连接、强制索引：不设 40 条 → 设 100 后 50 条）。
 */
const HNSW_EF_SEARCH = PATH_LIMIT * 2

/**
 * pg_trgm 的相似度下限。**由会话变量喂给 `%` 运算符**，不再写成 SQL 里的显式比较。
 *
 * 0.1 故意很松：这一路存在的意义是「用户记得图上那句原文」，松一点换来召回，
 * 精确排序交给 RRF 用排名完成。它**不是**判相关的阈值。
 *
 * 为什么必须走会话变量：`%` 是唯一能用上 `memes_text_trgm_idx` 的写法，而它读的
 * 就是 `pg_trgm.similarity_threshold`。写成 `similarity(...) >= 0.1` 能算出同样的
 * 布尔值，却**一个索引都用不上**——尤其是它和 `LIKE` 用 `OR` 连在一起时，
 * 整个 where 只能顺序扫描（实测：把 seqscan 关掉也仍然是 Seq Scan，
 * 见 joint-tasks/2026-09-24-search-media-perf.md 的验收）。
 */
const TRGM_SIMILARITY_THRESHOLD = 0.1
const TRGM_MIN_QUERY_LENGTH = 3

/**
 * 把 GUC 写进**当前事务**，事务一结束自动还原。
 *
 * ⚠️ **必须用 `set_config(..., is_local = true)` 或 `SET LOCAL`，不能用会话级的 `SET`。**
 *    会话级的写法会把阈值留给连接池里的下一个请求——下一个用户拿到一条按别人的
 *    阈值过滤的搜索结果，**不报错**。这也是为什么这一层包在事务里：`is_local` 只在
 *    事务内有效，离开事务它什么都不会留下。
 *
 * 参数化而不拼字符串：`set_config` 收的是 text，`SET` 语句则根本不接受参数，
 * 只能拿 `sql.raw` 拼——那是一条不该开的门。
 */
function setLocalGuc(tx: Db, name: string, value: string): Promise<unknown> {
  return tx.execute(sql`select set_config(${name}, ${value}, true)`)
}

/**
 * 七个数组字段里任意一个包含该词条。**扁平匹配**——词表在 JSON 里分组，
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
 * `search_text` 里拼着七个数组的标签值（SPEC §5.2.3），让 trgm 也匹配它们等于同一个
 * 信号被文本路和标签路各计一次分——一张靠标签沾边的图会压过一张原文精确命中的图
 * （SPEC §9.21 里有算式）。所以这里只拼 `ocr_text` + `description`。
 *
 * ⚠️ **这个表达式和 `memes_text_trgm_idx` 的索引定义必须逐字一致**（`data/schema.ts`），
 *    差一个空格索引就用不上，而查询照样能跑出正确结果——只是慢，不报错。
 */
function textTarget() {
  return sql`(coalesce(${memes.ocrText}, '') || ' ' || coalesce(${memes.description}, ''))`
}

/**
 * OCR 路的排序表达式。**只用于 ORDER BY，不参与 WHERE。**
 *
 * 这两件事必须分开：`%` 能走索引但只给布尔值，排序得靠 `similarity()`；
 * 而 `similarity()` 一旦写进 WHERE，PostgreSQL 就没法把它变成索引条件，
 * 整条 where 退化成顺序扫描（这个项目里踩过一次，见上面的常量注释）。
 *
 * 于是两边天然一致——`%` 的定义就是 `similarity(a, b) >= pg_trgm.similarity_threshold`——
 * 而不需要「orderBy 和 where 用同一个表达式」这种约定来保证。
 */
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
 * **`%` 和 `LIKE` 都要留着**（四个分支，不是三个）：
 * - `%` 是 trgm 相似度，阈值来自会话变量；两边的目标分别是 `ocr_text||description` 和
 *   `original_filename`，各有一个 GIN 索引，所以**必须分开写**，不能先 coalesce 成一个
 *   表达式——那样两个索引都用不上（展开写还有一层原因：NULL 文件名不能让整条 OR 变 NULL，
 *   而 `original_filename % q` 在 NULL 上正好是 NULL，与 `coalesce(…,'')` 的 `%` 等价）。
 * - `LIKE` 是子串兜底：3–4 字的短查询 trigram 太少，`similarity()` 天然偏低，阈值会
 *   挡住正确的召回，而「用户搜的原文确实在库里」这种情况子串匹配必须命中。
 *
 * ⚠️ **四个分支必须全是可索引的，否则整条 where 退化成顺序扫描。**
 *    原来写的是 `similarity(...) >= 0.1`——算得出同样的布尔值，但**用不上任何索引**，
 *    而且它和 LIKE 一用 OR 连起来，连 LIKE 那两条也没得走了。
 *    （实测：`enable_seqscan = off` 之下旧写法仍是 Seq Scan，新写法是
 *    BitmapOr → 两个 trgm 索引，见 joint-tasks/2026-09-24-search-media-perf.md。）
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

  const pattern = `%${escapeLike(query)}%`

  // 阈值只能在事务里改：`%` 读的是会话变量，而会话是**连接池共享**的。
  // setLocalGuc 用 is_local = true，事务结束即还原；写成会话级的话，
  // 下一个复用这条连接的查询会按上一个查询的阈值过滤，不报错。
  return db.transaction(async (tx) => {
    await setLocalGuc(tx, 'pg_trgm.similarity_threshold', String(TRGM_SIMILARITY_THRESHOLD))

    const rows = await tx
      .select({ id: memes.id })
      .from(memes)
      .where(
        and(
          // 软删过滤。三段 SQL 各带一次，漏掉的表现是「删掉的图又出现了」，不报错
          isNull(memes.deletedAt),
          sql`(${textTarget()} % ${query}
            or ${memes.originalFilename} % ${query}
            or ${textTarget()} like ${pattern}
            or ${memes.originalFilename} like ${pattern})`,
          excludeLabels(exclude),
        ),
      )
      .orderBy(sql`${trgmScore(query)} desc`, desc(memes.createdAt))
      .limit(PATH_LIMIT)

    return rows.map((r) => r.id)
  })
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
 * 1. **AND 会随维度数量膨胀而塌成空集。** 维度多了以后，「猫 无语 敷衍 加班」这种
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
 * ⚠️ **必须先把 `hnsw.ef_search` 抬到 `PATH_LIMIT` 以上**（见 `HNSW_EF_SEARCH`）：
 *    这个 `limit(50)` 自己保证不了 50 条，能给多少条是索引扫描宽度说了算。
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

  // `ef_search` 只在事务里改（见 HNSW_EF_SEARCH 与 setLocalGuc 的说明）。
  // 不加这个 set_config 的话，`LIMIT 50` 会被静默截成 40 条——这是本次修复的要点，
  // 而不是顺手加的一个调优参数。
  return db.transaction(async (tx) => {
    await setLocalGuc(tx, 'hnsw.ef_search', String(HNSW_EF_SEARCH))

    const rows = await tx
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
  })
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
