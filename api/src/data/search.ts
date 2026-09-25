import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { memes, users, userFavorites } from './schema.js'
import {
  anyLabelMatches,
  memeFilterConditions,
  memeQueryConditions,
  type MemeFilter,
  type MemeRow,
} from './memes.js'

/**
 * 检索的**三条通路**（SPEC §9.10）。
 *
 * ⚠️ **这里是三段分别写的 SQL，筛选条件与 `deleted_at is null` 三段都要带。**
 *    条件本身不再是三份手抄的——它们来自 `data/memes.ts` 的 `memeQueryConditions`
 *    （浏览与检索共用同一份，漏一个条件的表现是「我明明筛了」而不是报错）。
 *    但**每一路都要真的把它接进自己的 `.where()`**，这才是最容易只改一处的地方
 *    （agents/rules/database.md §1.1），也是 tests/search.test.ts 为每一路各留一个
 *    用例的原因。
 *
 * 三条路都回 id 列表而不是完整行：RRF 只需要排名，融合完再按 id 取一次完整数据。
 * 让每路都 SELECT * 会把三份重复行拉进内存，还多三次 JOIN users 的代价。
 *
 * ⚠️ **三条路的匹配目标必须互不重叠。** 文本路匹配原文、标签路匹配标签、向量路匹配语义。
 *    一旦两条路读同一个字段，RRF 就不再是「两个独立证据」而是「一个证据数了两遍」，
 *    排序会被静默带偏（SPEC §9.21）。
 */

/** 每路召回条数，也是快照首屏的预取深度。改它要跑评测集（retrieval.md §8）。 */
export const PATH_LIMIT = 50

/**
 * 一次召回要带的所有输入。
 *
 * 写成对象而不是继续加位置参数：五个字段里有四个是「可选的筛选」，位置对了也读不出来
 * 哪一个是哪一个——而漏传 `exclude` 或漏传 `asOf` **都不会报错**，只是召回多出几条
 * 不该有的、或者多出几张这次检索不该看见的新图。
 */
export type SearchPathOptions = {
  /**
   * 筛选条件（七个维度 / `isAnimated` / `favorited` / `uploader` / `tagStatus`）。
   * **在三路取 top-N 之前生效**（SPEC §6.3.1「先过滤后召回」）。
   */
  filter?: MemeFilter
  /** 当前用户。`favorited` 那一条要它。 */
  actorId?: string | null
  /** 用户明说不要的词条。过滤，不是负分。 */
  exclude?: string[]
  /**
   * 快照的时点：只召回这个时刻之前入库的图。
   *
   * 快照翻倍预取时必传（裁定 2：**中途上传的新图不出现在这次检索的后续页里**）。
   * 不传的话重扫会看到新图，它们会被接进候选名单——「快照」就不成立了。
   */
  asOf?: Date
  /** 每路召回条数。默认 `PATH_LIMIT`；快照翻倍时由快照层传新深度。 */
  depth?: number
}

/**
 * 每路的 WHERE：软删 + 筛选（共用那一份）+ 时点 + 这一路自己的条件。
 *
 * 三个通路函数都从这里开头，所以「软删过滤」和「先过滤后召回」不存在漏传的写法。
 */
function pathConditions(options: SearchPathOptions, own: SQL[]): SQL[] {
  return [
    ...memeQueryConditions(
      { ...options.filter, exclude: options.exclude ?? options.filter?.exclude },
      options.actorId ?? null,
    ),
    /*
     * ⚠️ **`asOf` 必须走 drizzle 的列比较，不能手写成 `sql\`${memes.createdAt} <= ${asOf}\``。**
     *
     *    手写片段里的参数没有列类型可依，postgres.js 会挑「字符串」编码器去编码一个 `Date`，
     *    在**绑定参数那一步**抛 `The "string" argument must be of type string`。而这个异常
     *    死在 `services/search.ts` 的 `allSettled` 里——三路**全部失败**、全部只留一条
     *    warn 日志，接口照常 200 且结果为空。「带 q 的检索恒为空」在页面上和「没有匹配」
     *    长得一模一样（同类坑的另一处记录在 `memes.ts` 的 `listStaleEmbeddingMemeIds`）。
     *
     *    `lte()` 由列类型决定编码方式，param 顺着 `timestamptz` 走。
     */
    ...(options.asOf ? [lte(memes.createdAt, options.asOf)] : []),
    ...own,
  ]
}

/**
 * HNSW 的搜索宽度：**一次扫描用多宽的 `ef_search`**。深度 `d` 取 `d * 2`
 * （首屏就是 `PATH_LIMIT * 2`），上限由 pgvector 定。
 *
 * ⚠️ 这个数是 pgvector 一次索引扫描**最多能给出多少条**，和 SQL 的 `LIMIT` 是两件事：
 *    `LIMIT 50` 只说「我要 50 条」，真能给多少由它决定。它的默认值是 **40**，
 *    于是向量路永远少召回 10 条——**不报错、不告警**，只是 RRF 少了 10 条候选，
 *    排序静静地变差。这与过滤条件无关，是 `LIMIT` 和 `ef_search` 之间的关系。
 *
 * 取 `d * 2` 而不是刚好相等：`embed_model`、`deleted_at`、排除标签都是**后置过滤**，
 * 候选先被索引取出来、再被 where 剔掉。真库实测（强制走索引、带一个排除词）：
 * 默认 40 → **39 条**，`= 50` → 49 条，`= 100` → 50 条。留一倍余量给过滤。
 *
 * ⚠️ **这个余量只在选择率 ≥ 0.5 时成立。** 带筛的检索掉的不止一点：筛后子集落到 3%
 *    时它**归零**（2026-09-26 实测，见下面 `vectorPathCandidates` 里的那段）。
 *    所以带筛的召回还有第二条路，`ef_search` 不是唯一的防线。
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
 *
 * ⚠️ **上限 1000 必须显式夹住**，不能靠「我们的深度到不了那么大」：快照翻倍预取每次把
 *    深度乘 2，第 5 次翻倍就是 1600，`2 × 1600 = 3200` 会被 pgvector **直接拒掉**
 *    （不是截断到 1000）——表现是滚到深处的那一次请求整个 500，而前面的页全是好的。
 *
 *    夹住之后的语义是「这一路到此为止」：`LIMIT 深度` 超过索引扫描宽度时这一路给不满，
 *    自然收敛到 `nextCursor: null`，不报错。
 */
const HNSW_EF_SEARCH_MAX = 1000

function efSearchFor(depth: number): number {
  return Math.min(depth * 2, HNSW_EF_SEARCH_MAX)
}

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
 * 见 任务 2026-09-24-search-media-perf 的验收）。
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
 *    BitmapOr → 两个 trgm 索引，见 任务 2026-09-24-search-media-perf。）
 *
 * **短于 3 字的查询直接跳过这一路。** trigram 在 1–2 字上几乎没有区分度，跑了也是噪声；
 * 那种查询本来就该由标签路接住（「猫」「谢谢」都是词表里有的），不是这一路的职责。
 */
export async function ocrPathCandidates(
  query: string,
  options: SearchPathOptions = {},
  db: Db = defaultDb,
): Promise<string[]> {
  if (query.trim().length < TRGM_MIN_QUERY_LENGTH) return []

  const depth = options.depth ?? PATH_LIMIT
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
          ...pathConditions(options, [
            sql`(${textTarget()} % ${query}
              or ${memes.originalFilename} % ${query}
              or ${textTarget()} like ${pattern}
              or ${memes.originalFilename} like ${pattern})`,
          ]),
        ),
      )
      // 最后一级 `id` 是 tie-breaker，**不是排序口味**：同分同秒的记录如果顺序不定，
      // 取 top-N 就会在边界上随机切一刀——快照翻倍预取时那一刀切在哪两页之间，
      // 表现就是「翻页接缝处重复或漏了一条」。
      .orderBy(sql`${trgmScore(query)} desc`, desc(memes.createdAt), desc(memes.id))
      .limit(depth)

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
  options: SearchPathOptions = {},
  db: Db = defaultDb,
): Promise<string[]> {
  if (terms.length === 0) return []

  const depth = options.depth ?? PATH_LIMIT

  const matchCount = sql<number>`(${sql.join(
    terms.map((t) => sql`(case when (${anyLabelMatches(t)}) then 1 else 0 end)`),
    sql` + `,
  )})`

  const rows = await db
    .select({ id: memes.id })
    .from(memes)
    .where(
      and(
        ...pathConditions(options, [
          sql`(${sql.join(terms.map(anyLabelMatches), sql` or `)})`,
        ]),
      ),
    )
    .orderBy(sql`${matchCount} desc`, desc(memes.createdAt), desc(memes.id))
    .limit(depth)

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
  options: SearchPathOptions = {},
  db: Db = defaultDb,
): Promise<string[]> {
  if (vector.length === 0 || embedModel === null) return []

  const depth = options.depth ?? PATH_LIMIT

  // 拼成 pgvector 字面量 [a,b,c]。数值来自 JSON 解析，不是用户输入，
  // 但仍然先过一遍 Number.isFinite —— NaN 进 pgvector 会让这一路静默返回空
  const literal = `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`

  /*
   * 「这次带筛了吗」——**只看筛选条件，不算软删那一档**。
   *
   * `memeQueryConditions` 的头一条永远是软删，它的选择率≈1、不构成后置过滤的压力；
   * 真正会把 HNSW 候选吃光的是 `tags=猫` 这类筛选。判据用同一个函数的返回值，
   * 不另写一份字段清单——另写一份的话，将来多一个筛选维度就会有一半的人忘记更新它，
   * 而那种漏的表现是「新维度的筛选悄悄退回后置过滤」，不报错。
   */
  const narrowed = memeFilterConditions(
    { ...options.filter, exclude: options.exclude ?? options.filter?.exclude },
    options.actorId ?? null,
  ).length > 0

  // `ef_search` 只在事务里改（见 HNSW_EF_SEARCH 与 setLocalGuc 的说明）。
  // 不加这个 set_config 的话，`LIMIT 50` 会被静默截成 40 条——这是本次修复的要点，
  // 而不是顺手加的一个调优参数。
  return db.transaction(async (tx) => {
    const conditions = pathConditions(options, [
      sql`${memes.embedding} is not null`,
      eq(memes.embedModel, embedModel),
    ])
    const query = () =>
      tx
        .select({ id: memes.id })
        .from(memes)
        .where(and(...conditions))
        // `id` 是 tie-breaker，方向无所谓，要的是确定性（见 ocrPathCandidates 的注释）
        .orderBy(sql`${memes.embedding} <=> ${literal}::vector`, asc(memes.id))
        .limit(depth)

    await setLocalGuc(tx, 'hnsw.ef_search', String(efSearchFor(depth)))
    const rows = await query()
    if (rows.length >= depth || !narrowed) return rows.map((r) => r.id)

    /*
     * ⚠️ **带筛的向量召回：HNSW 的后置过滤会归零，所以这里退回「精确扫筛后子集」。**
     *
     *    pgvector 的索引扫描**最多**吐出 `ef_search` 条按距离排好的元组，`WHERE` 是在
     *    那之后才滤的。于是这一路的产出约等于 `ef_search × 选择率`，要凑够 `depth` 条
     *    就得 `ef_search ≈ depth / p`。`PATH_LIMIT * 2` 那个余量只在 `p ≥ 0.5` 时成立。
     *
     *    2026-09-26 实测（真表 1811 行 / 放大到 48900 行的独立表，强制走 HNSW，
     *    `ef_search = 100`、`LIMIT 50`）：
     *      - `tags=猫`（p≈0.03）在 48900 行上返回 **0 条**，而筛后真有 1458 条；
     *        1811 行上返回 1 条。`scenes=上班`（p≈0.008）同样返回 0 条。
     *      - 这不是「掉一点」，是**归零**。而它和「这张图没打标」在界面上长得一模一样。
     *      - 线上没暴露只是运气：选择率低时规划器自己会改走 Bitmap/SeqScan 精确路径
     *        兜住。那个兜底随表长大而消失，而那时后置过滤恰好最毁结果。
     *
     *    结构性事实是**「精确扫子集的代价」与「后置过滤的损失」由同一个变量控制——筛后
     *    行数**。子集小 → 精确扫又准又快；子集大 → 选择率高、后置过滤够用。所以判据不必
     *    是选择率，也不必先 count 一遍：**没凑够就说明子集小到精确扫得起**。
     *
     *    实测代价（48900 行、`LIMIT 50`）：筛后 1458 条 29ms、378 条 21ms；1811 行的真表上
     *    2–8ms。没带筛或凑够了的那一半路径一次都不走这里，首屏成本与改造前一致。
     *
     *    另一条出路 `hnsw.iterative_scan = relaxed_order` 实测同样能返满 50 条，但它是
     *    pgvector 0.8 才注册的参数，与上面 `HNSW_EF_SEARCH` 那段写下的部署底线冲突，**不用**。
     */
    await tx.execute(sql`set local enable_indexscan = off`)
    const exact = await query()
    return exact.map((r) => r.id)
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
