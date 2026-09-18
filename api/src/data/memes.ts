import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { memes, users, userFavorites } from './schema.js'
import { splitHash } from '../lib/phash.js'
import { buildSearchText } from '../lib/vision-output.js'
import { AppError } from '../lib/app-error.js'

/**
 * memes 的**唯一入口**。
 *
 * ⚠️ 本项目三条硬边界里的两条落在这个文件里（AGENTS.md §5、agents/rules/database.md）：
 *
 *   1. 读路径强制 deleted_at is null —— 不靠调用方记得传参数
 *   2. 写路径强制 assertCanMutate    —— 判断在函数内部，调用方不自己拼条件
 *
 * 不允许在别处写涉及 memes 的 SQL。绕过一次，这两条保证就不再成立了。
 */

export type MemeRow = typeof memes.$inferSelect
export type NewMeme = typeof memes.$inferInsert

/**
 * 一条记录 + 两个**不属于这张表**的字段：`uploaderName` 来自 join `users`，
 * `favorited` 来自 join `user_favorites`（当前登录用户，未登录恒 false）。
 *
 * 浏览、详情、编辑三处给的是同一个形状，所以它只写一遍——三份的话，
 * 迟早有一处少一个字段，而那表现为「同一个对象在不同接口里字段不一样」。
 */
export type MemeView = MemeRow & { uploaderName: string; favorited: boolean }

/** 当前操作者。role 取值见 SPEC §3.2。 */
export type Actor = { id: string; role: string }

export type MutateAction = 'edit' | 'delete' | 'retag'

/**
 * 三个 action 规则不同，见 SPEC §3.3：
 *
 *   edit   —— **所有登录用户**
 *   delete —— 上传者或 'User'
 *   retag  —— 上传者或 'User'
 *
 * ⚠️ edit 全员开放是有意的不对称，不是漏写。标签在共享库里是公共品，谁发现标错了
 *    顺手改掉对所有人都是净收益。**不要「顺手补一个归属检查」** —— 那会把共享库
 *    最核心的一条产品决策改掉。见 SPEC §9.1。
 */
export function assertCanMutate(meme: MemeRow, actor: Actor, action: MutateAction): void {
  if (action === 'edit') return

  const isUploader = meme.uploaderId === actor.id
  const isAdmin = actor.role === 'admin'
  if (isUploader || isAdmin) return

  const what = action === 'delete' ? '删除' : '重新打标'
  throw new AppError('FORBIDDEN', `只有上传者或管理员才能${what}`)
}

/** 永远不返回软删的记录。 */
export async function findMemeById(id: string, db: Db = defaultDb): Promise<MemeRow | null> {
  const rows = await db
    .select()
    .from(memes)
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * 同 `findMemeById`，但**加行锁**（`select ... for update`），**只能在事务里用**。
 *
 * 存在的理由是 `updateMemeContent` 是一次**读-改-写**：没传的字段要保留原值，
 * 而 `search_text` 又必须按五个字段重算。不加锁的话会这样交错——
 * T1 读到旧标签 → T2 写完自己的标签 → T1 拿**旧标签**拼出 search_text 写回，
 * 库里于是留下 T2 的标签配 T1 的文本。那正是 SPEC §5.2.3 说的「文本与标签对不上」，
 * 而且**不报错**。撞上后台打标写回（`applyTagResult`）也是同一种交错。
 *
 * 加锁之后两个写者按顺序排开，晚到的那个读到的是前一个提交后的行。
 * 「最后写入者赢」照样成立（SPEC §6.4.1），只是不再有半新半旧的派生字段。
 *
 * ⚠️ **故意不导出**：这是本文件里唯一需要锁的读，多一个调用方就多一处持锁时间。
 */
async function findMemeByIdForUpdate(id: string, db: Db): Promise<MemeRow | null> {
  const rows = await db
    .select()
    .from(memes)
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
    .for('update')
    .limit(1)
  return rows[0] ?? null
}

// ── 导入去重（SPEC §6.2.2 / §1.5） ─────────────────────────────────
//
// 两个查询都刻意留在这里而不是 `data/imports.ts`：它们查的是 `memes`，
// 而 `memes` 只有一个入口。挪出去就等于在第二个文件里手写一遍软删过滤。

/**
 * SHA-256 精确去重。返回已有记录（含软删的）或 null。
 *
 * ⚠️ **这里故意不过滤 `deleted_at`**，是全项目唯一一处。原因：`content_hash` 上有唯一约束，
 * 一条软删记录仍占着那个哈希位。如果这里看不见它，同一份文件再传一次会在 insert 时
 * 撞唯一索引报 500，而不是被识别成重复。
 *
 * 「看不见软删记录」这条规则防的是**把已删的图当有效图返回**；这里返回给调用方的用途
 * 是判定「字节完全相同的记录已存在」，不是展示。调用方据 `deletedAt` 决定是否告知用户
 * 「这张你删过」。
 */
export async function findMemeByContentHash(
  contentHash: string,
  db: Db = defaultDb,
): Promise<MemeRow | null> {
  const rows = await db.select().from(memes).where(eq(memes.contentHash, contentHash)).limit(1)
  return rows[0] ?? null
}

/** 近似重复的候选：库里与之最接近的一张，带 Hamming 距离。 */
export type PhashNeighbor = { meme: MemeRow; distance: number }

/**
 * pHash 全库 Hamming 扫描。见 agents/rules/database.md §3。
 *
 * `bit_count(bigint)` 在本项目的 PostgreSQL 17 上**不存在**（只有 `bit` 和 `bytea` 重载）。
 * 所以把 64 位哈希拆成两个 32 位肢体分别 `bit_count`，再相加——结果相同。
 * 拆分由 `lib/phash.ts` 的 `splitHash` 做，**它给的是有符号 int4**：无符号的半个哈希
 * 有一半概率超过 2147483647，`$1::int` 会在 Bind 阶段就报
 * `value "3480189747" is out of range for type integer`，一行数据都没有照样炸。
 * 列这一侧的 `& 4294967295` 则是为了消掉算术右移带来的符号扩展——两侧都只剩位模式，
 * `::bit(32)` 之后异或出来的结果与符号无关。
 *
 * 不建 BK-tree、不做专用索引：几万行仍在毫秒级，现在就上是提前优化（同一节的结论）。
 * `deleted_at is null` 是必须的——已删的图不该参与「你重复了这张」的判断。
 */
export async function findNearestByPhash(
  hash: bigint,
  maxDistance: number,
  db: Db = defaultDb,
): Promise<PhashNeighbor | null> {
  const { hi, lo } = splitHash(hash)
  const distance = sql<number>`bit_count(((${memes.phash} >> 32) & 4294967295)::bit(32) # ${hi}::int::bit(32))
    + bit_count((${memes.phash} & 4294967295)::bit(32) # ${lo}::int::bit(32))`

  const rows = await db
    .select({ meme: memes, distance: distance.as('distance') })
    .from(memes)
    .where(and(isNull(memes.deletedAt), sql`${distance} <= ${maxDistance}`))
    .orderBy(sql`distance`)
    .limit(1)

  const row = rows[0]
  if (row === undefined) return null
  return { meme: row.meme, distance: Number(row.distance) }
}

/**
 * 管理员「已删除」视图专用。
 *
 * 方法名带 includeDeleted 是故意的：**它在 code review 里必须是显眼的**。
 * 漏掉软删过滤的表现是「删掉的图又出现了」，不报错、不崩溃，比漏权限检查更隐蔽。
 */
export async function findMemeByIdIncludeDeleted(
  id: string,
  db: Db = defaultDb,
): Promise<MemeRow | null> {
  const rows = await db.select().from(memes).where(eq(memes.id, id)).limit(1)
  return rows[0] ?? null
}

export async function createMeme(input: NewMeme, db: Db = defaultDb): Promise<MemeRow> {
  const rows = await db.insert(memes).values(input).returning()
  const row = rows[0]
  if (row === undefined) throw new AppError('INTERNAL', '写入失败')
  return row
}

/** 软删。物理删除由定时任务在 30 天后做，见 SPEC §5.2.5。 */
export async function softDeleteMeme(
  id: string,
  actor: Actor,
  db: Db = defaultDb,
): Promise<void> {
  const meme = await findMemeById(id, db)
  if (meme === null) throw new AppError('NOT_FOUND', '这张表情不存在')

  assertCanMutate(meme, actor, 'delete')

  await db
    .update(memes)
    .set({ deletedAt: new Date() })
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
}

// ── 打标写回（SPEC §5.2.3） ────────────────────────────────────────

/**
 * 一次打标的全部产出。**五个字段一次写完**——单次视觉调用产出全部内容，
 * 没有独立的 OCR 链路（SPEC §5.2.3），也就不存在「先写 ocr_text 再补 description」。
 */
export type TagResult = {
  ocrText: string
  description: string
  emotions: string[]
  scenes: string[]
  tags: string[]
  /** 派生字段，由 `lib/vision-output.ts` 的 `buildSearchText` 算。见下方警告。 */
  searchText: string
  visionModel: string
}

/**
 * 写回打标结果。
 *
 * ⚠️ **`search_text` 必须和五个来源字段在同一条 UPDATE 里**（schema 里那句「任一来源变更时
 *    必须重算」）。拆成两条语句的话，中间崩掉就留下一条 search_text 和标签对不上的记录，
 *    而这不报错——只是那张图在文本检索里搜不到或搜出错的东西。**将来的 `PATCH /memes/:id`
 *    改标签时同样要走这个函数，不要在 handler 里手写一遍 UPDATE。**
 *
 * `deleted_at is null` 同样是硬条件：打标是异步的，图可能在 AI 调用期间被删掉，
 * 这时写回等于让一条已删记录悄悄复活出内容。返回 false 让调用方知道白跑了一趟。
 *
 * **不写 `edited_by` / `edited_at`**：那两列记的是「人改过」，机器打标不是人工编辑。
 */
export async function applyTagResult(
  id: string,
  result: TagResult,
  db: Db = defaultDb,
): Promise<boolean> {
  const rows = await db
    .update(memes)
    .set({
      ocrText: result.ocrText,
      description: result.description,
      emotions: result.emotions,
      scenes: result.scenes,
      tags: result.tags,
      searchText: result.searchText,
      visionModel: result.visionModel,
      tagStatus: 'ok',
    })
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
    .returning({ id: memes.id })
  return rows.length > 0
}

/**
 * 只改 `tag_status`。终局失败时用（refused / needs_manual）。
 *
 * 取值见 SPEC §5.2.3：pending | ok | refused | needs_manual。**不校验取值**——
 * 这一层不认识状态机，传错值是调用方的 bug，加一个运行时白名单只会把它藏起来。
 */
export async function setTagStatus(
  id: string,
  tagStatus: string,
  db: Db = defaultDb,
): Promise<boolean> {
  const rows = await db
    .update(memes)
    .set({ tagStatus })
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
    .returning({ id: memes.id })
  return rows.length > 0
}

/**
 * 单独写 embedding。
 *
 * ⚠️ **和打标写回分开是有意的，不要合并成一条语句。** embedding 失败不回滚打标
 *    （queue.md §3）：标已经打好了，向量没算出来只是让这张图暂时进不了向量路，
 *    把 tag_status 一起退回 pending 等于扔掉一次已经付过钱的视觉调用。
 *
 * ⚠️ 传进来的向量必须**已经**截断并重新 L2 归一化（database.md）。这一层不做归一化——
 *    在写库这一步补救等于承认上游可能传进没归一化的向量，那才是真正危险的假设。
 */
export async function applyEmbedding(
  id: string,
  embedding: number[],
  embedModel: string,
  db: Db = defaultDb,
): Promise<boolean> {
  const rows = await db
    .update(memes)
    .set({ embedding, embedModel })
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
    .returning({ id: memes.id })
  return rows.length > 0
}

// ── 人工编辑（SPEC §6.4.1） ────────────────────────────────────────

/**
 * `PATCH /memes/{id}` 的请求体，**只认这四个字段**。`ocrText` 不在里面（§6.4.1）。
 *
 * 键**不出现** = 不改这个字段；`description: null` = 清空描述；`tags: []` = 清空该维度。
 * 三种传法含义不同，所以判据是「键在不在对象里」，不是「值是不是 undefined」。
 * 类型上写成可选正是为了让「没传」能表达出来——词表和字段名校验在 handler
 * （`routes/memes.ts`），这一层拿到的已经是归一化过的规范词条。
 */
export type MemeContentPatch = {
  description?: string | null
  emotions?: string[]
  scenes?: string[]
  tags?: string[]
}

/**
 * 写回人工编辑，返回更新后的完整视图（与 `GET /memes/{id}` 同形，SPEC §6.4.1）。
 *
 * **权限是所有人**：`assertCanMutate(meme, actor, 'edit')` 第一个分支直接放行。
 * 这是 SPEC §9.1 有意的不对称（标签是公共品，谁看见标错了顺手改掉对所有人是净收益），
 * **不要「顺手补一个归属检查」** —— 那会把共享库最核心的一条产品决策改掉。
 *
 * 四件事在这个函数里一次做完，缺一不可：
 *
 * 1. **内容字段、`search_text`、`edited_by` / `edited_at` 全在一条 UPDATE 里**。
 *    `search_text` 拆出去单独写的话，中间崩掉会留下一条文本与标签对不上的记录——
 *    表现是那张图在文本检索里搜不到或搜出错的东西，**不报错**（SPEC §5.2.3）。
 * 2. `search_text` 用 `lib/vision-output.ts` 的 `buildSearchText` 重算，**和打标写回
 *    `applyTagResult` 是同一份实现**。这里再拼一次的表现是「手动改过的图搜不到」。
 * 3. **不碰 `embedding` / `embed_model`，也不入队。** 这不是漏做，是 SPEC §9.19 写下的
 *    取舍：embedding 走部署方的 key 而编辑对全员开放，「编辑一次重算一次」是一条
 *    任何人都能走的烧钱路径。**不要「顺手补上」**——真要改，落点是「编辑后入队一条
 *    重算任务」，不是同步重算。
 * 4. **不动 `tag_status`**：§6.4.1 的请求体和写入清单里都没有它。人工补标签不改变
 *    「这次打标是模型做的还是失败的」这个事实。
 *
 * 软删记录够不着这里：`findMemeByIdForUpdate` 先查（带 `deleted_at is null`）再判权限，
 * 查不到就把 `NOT_FOUND` 抛出去，归属检查根本没机会跑（SPEC §6.4.2）。
 *
 * 整段在一个事务里、以**加锁的读**开头：见 `findMemeByIdForUpdate` 的解释。
 * 这次读-改-写不加锁，就会在并发编辑（或撞上后台打标写回）时留下
 * 「文本与标签对不上」的记录，而它不报错。
 */
export async function updateMemeContent(
  id: string,
  actor: Actor,
  patch: MemeContentPatch,
  db: Db = defaultDb,
): Promise<MemeView> {
  // 一个字段都没传：不写库、不动 `edited_at`。空 PATCH 不该留下「有人编辑过」的痕迹。
  const touches =
    patch.description !== undefined ||
    patch.emotions !== undefined ||
    patch.scenes !== undefined ||
    patch.tags !== undefined

  return await db.transaction(async (tx) => {
    const meme = await findMemeByIdForUpdate(id, tx)
    if (meme === null) throw new AppError('NOT_FOUND', '这张表情不存在')

    assertCanMutate(meme, actor, 'edit')

    if (touches) {
      const description = patch.description === undefined ? meme.description : patch.description
      const emotions = patch.emotions ?? meme.emotions ?? []
      const scenes = patch.scenes ?? meme.scenes ?? []
      const tags = patch.tags ?? meme.tags ?? []

      // ocr_text 取的**永远是库里那一个**：它不可编辑（§6.4.1），人工改它会让文本和图
      // 不再对应，而 search_text 会忠实转发这个错。要重来只能靠 retag，不是靠手改。
      const searchText = buildSearchText({
        ocrText: meme.ocrText ?? '',
        description: description ?? '',
        emotions,
        scenes,
        tags,
      })

      // 内容字段、search_text、edited_by / edited_at 全在这一条里——
      // 拆成两条的话中间崩掉会留下文本与标签对不上的记录（SPEC §5.2.3 / §6.4.1）。
      //
      // 不加 `returning`：下面那次 `getMemeById` 既是响应内容的读取，也是
      // 「这一条还在不在」的检查。`deleted_at is null` 是写路径的硬条件（§3.4），
      // 少了它已删的记录会被改活——行锁让并发删除挡在锁外，但不构成省掉它的理由。
      await tx
        .update(memes)
        .set({
          description,
          emotions,
          scenes,
          tags,
          searchText,
          editedBy: actor.id,
          editedAt: new Date(),
        })
        .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
    }

    const updated = await getMemeById(id, actor.id, tx)
    if (updated === null) throw new AppError('NOT_FOUND', '这张表情不存在')
    return updated
  })
}

// ── 重建索引（SPEC §6.5.4） ────────────────────────────────────────
//
// ⚠️ 这一组存在的唯一理由是「`memes` 的 SQL 只许出现在本文件」。重算队列
//    （`data/reindex-jobs.ts`）需要知道哪些图的向量过期了、进度是多少，
//    但它**不能自己去查 `memes`**——在队列表上 join `memes` 会绕过
//    `deleted_at is null`（queue.md §8），表现是给已删除的图重算向量。
//    所以 id 从这里查出来，再传给那一层。

/**
 * 库里有没有已经向量化的记录。`PUT /config/embed` 换模型时用它决定要不要
 * `EMBED_MODEL_CHANGED`——**没数据就没必要拦**，第一次配置不该被一个 409 挡住。
 *
 * 存在性查询，不是 count：只需要知道「有没有」。
 */
export async function hasEmbeddedMemes(db: Db = defaultDb): Promise<boolean> {
  const rows = await db
    .select({ id: memes.id })
    .from(memes)
    .where(and(isNull(memes.deletedAt), sql`${memes.embedding} is not null`))
    .limit(1)
  return rows.length > 0
}

/**
 * 向量过期的记录 id：有 `search_text` 可以重算，但 `embed_model` 不是当前模型
 * （含 `embed_model is null` ——打标成功、向量化失败的那些，SPEC §6.3.1）。
 *
 * **只取 id，不取 search_text。** 一次重算几万条，把文本全拉进内存没有意义；
 * worker 取到任务后按 id 单条回查。
 *
 * `search_text` 为空的跳过：重算是「从 search_text 重新算向量」（§6.5.4），
 * 没有 search_text 就没有可算的东西，排进队列只会得到一条必然失败的任务。
 *
 * @param offset 分批取。入队**不会**让这些行不再过期（`embed_model` 要等算完才改），
 *               所以不能反复取第一页——那是个死循环。按 `created_at` 排序 + offset
 *               往后翻，中途有图被删会漏掉几条，再点一次「重建索引」就能补上
 *               （入队幂等）。
 */
export async function listStaleEmbeddingMemeIds(
  currentModel: string,
  limit: number,
  offset = 0,
  db: Db = defaultDb,
): Promise<string[]> {
  const rows = await db
    .select({ id: memes.id })
    .from(memes)
    .where(
      and(
        isNull(memes.deletedAt),
        sql`${memes.searchText} is not null and ${memes.searchText} <> ''`,
        or(isNull(memes.embedModel), sql`${memes.embedModel} <> ${currentModel}`),
      ),
    )
    .orderBy(memes.createdAt)
    .limit(limit)
    .offset(offset)
  return rows.map((row) => row.id)
}

/** 重算要用的原文。**只读 `search_text`，不碰 AI 产出字段**（§6.5.4：重算不重跑视觉）。 */
export async function getSearchTextForEmbedding(
  id: string,
  db: Db = defaultDb,
): Promise<string | null> {
  const [row] = await db
    .select({ searchText: memes.searchText })
    .from(memes)
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
    .limit(1)
  const text = row?.searchText ?? null
  return text === '' ? null : text
}

export type EmbeddingProgress = { total: number; done: number; stale: number }

/**
 * `GET /admin/reindex/status` 的 `total` / `done` / `stale`（§6.5.4：进度必须来自库里的
 * 真实计数，不能是进程内存里的计数器——重启后内存计数归零，进度条会从头开始，那是假的）。
 *
 * 三个数**一次扫表算完**，不是三条查询。分三次查的话三个数各自是不同时刻的快照，
 * 管理员会看到 `done + stale > total` 这种自相矛盾的进度。
 *
 * ⚠️ `stale` 的口径必须和 `listStaleEmbeddingMemeIds` 的 WHERE **逐字一致**——
 *    它是「还会被排进队列的条数」。两边写岔了的表现是进度条停在某个数不动，
 *    而队列其实已经空了。
 *
 * 这里是**唯一**允许 count 全表的地方：它只在管理员盯着进度条时被调用，
 * 不落在搜索请求上。搜索侧的 `degraded` 走存在性查询，见 `data/reindex-jobs.ts`。
 */
export async function countEmbeddingProgress(
  currentModel: string,
  db: Db = defaultDb,
): Promise<EmbeddingProgress> {
  const [row] = await db
    .select({
      total: sql<number>`count(*) filter (where ${memes.embedding} is not null)::int`,
      done: sql<number>`count(*) filter (
        where ${memes.embedding} is not null and ${memes.embedModel} = ${currentModel}
      )::int`,
      stale: sql<number>`count(*) filter (
        where ${memes.searchText} is not null and ${memes.searchText} <> ''
          and (${memes.embedModel} is null or ${memes.embedModel} <> ${currentModel})
      )::int`,
    })
    .from(memes)
    .where(isNull(memes.deletedAt))
  return { total: row?.total ?? 0, done: row?.done ?? 0, stale: row?.stale ?? 0 }
}

// ── 收藏（SPEC §5.4 / §6.4） ───────────────────────────────────────
//
// ⚠️ **收藏是人和图的关系，不是图的属性。** 所以它写 `user_favorites`，
//    一个字节都不碰 `memes`：没有 favorite_count、不动 edited_by、不动 updated_at。
//    「顺手在 memes 上加个计数缓存」会立刻引出「谁来保证它和 user_favorites 一致」，
//    而不一致的表现是数字错了但没人报错。
//
//    也因此**收藏不走 `assertCanMutate`**：那三条规则管的是改动图本身（SPEC §3.3），
//    而收藏别人的图是共享库的正常用法，不是对那张图的改动。

/**
 * 收藏。**幂等**：已收藏再调一次是空操作，不报错、不改 created_at。
 *
 * PUT 是幂等动词（SPEC §6.4），前端双击、断网重发、离线队列重放都会来第二次。
 * 返回值区分「这次真加上了」和「本来就有」，只给日志用，接口响应两者相同。
 *
 * 软删过滤在这里是一条独立查询而不是 insert ... select：`user_favorites.meme_id`
 * 上的外键只保证图存在，**不保证它没被软删**，少了这一步就能收藏一张已删的图。
 */
export async function addFavorite(
  userId: string,
  memeId: string,
  db: Db = defaultDb,
): Promise<boolean> {
  const meme = await findMemeById(memeId, db)
  if (meme === null) throw new AppError('NOT_FOUND', '这张表情不存在')

  const rows = await db
    .insert(userFavorites)
    .values({ userId, memeId })
    .onConflictDoNothing({ target: [userFavorites.userId, userFavorites.memeId] })
    .returning({ memeId: userFavorites.memeId })
  return rows.length > 0
}

/**
 * 取消收藏。**幂等**：没收藏过也返回成功。
 *
 * 图已软删时仍然报 NOT_FOUND 而不是静默成功：这两个接口是一对，一个能操作另一个不能
 * 会让前端的乐观更新状态对不上。取消一张已删的图本来也没有意义——列表里根本看不到它。
 */
export async function removeFavorite(
  userId: string,
  memeId: string,
  db: Db = defaultDb,
): Promise<boolean> {
  const meme = await findMemeById(memeId, db)
  if (meme === null) throw new AppError('NOT_FOUND', '这张表情不存在')

  const rows = await db
    .delete(userFavorites)
    .where(and(eq(userFavorites.userId, userId), eq(userFavorites.memeId, memeId)))
    .returning({ memeId: userFavorites.memeId })
  return rows.length > 0
}

// ── 浏览接口（SPEC §6.3.2） ─────────────────────────────────────────

export type ListMemesParams = {
  emotions?: string[]
  scenes?: string[]
  tags?: string[]
  isAnimated?: boolean
  /** true 时只返回 actorId 收藏的记录。 */
  favorited?: boolean
  /** 'me' 或具体 user id。 */
  uploader?: string
  /** pending | ok | refused | needs_manual。仅本人或 admin 可传，否则抛 FORBIDDEN。SPEC §3.3 */
  tagStatus?: string
  cursor?: string
  limit?: number
  /**
   * 在筛选之后做全库随机抽样。SPEC §6.3.2
   *
   * ⚠️ **它不是「排个随机序然后照常分页」**——随机序没有下一页，所以这条路径不吃
   * `cursor`、`nextCursor` 恒为 `null`。handler 负责挡住 `random` + `cursor` 的组合。
   */
  random?: boolean
}

/**
 * 游标解码结果。游标是 base64(created_at ISO + '|' + id)，不透明，客户端不解析。SPEC §1.3
 *
 * 用 created_at + id 双字段确保同秒上传的多张图也有稳定游标。
 */
function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const sep = raw.indexOf('|')
    if (sep < 0) return null
    const createdAt = new Date(raw.slice(0, sep))
    const id = raw.slice(sep + 1)
    if (isNaN(createdAt.getTime()) || id === '') return null
    return { createdAt, id }
  } catch {
    return null
  }
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url')
}

/**
 * 浏览全库，带游标分页与多条件过滤。
 *
 * tagStatus 参数的权限检查在调用方（handler）完成——数据层只负责查询，
 * 不重复做授权判断，但调用方必须先验，否则普通用户能查到他人的待处理图。
 *
 * 软删过滤硬编码在这里，调用方不能绕过。SPEC §3.4
 */
export async function listMemes(
  params: ListMemesParams,
  actorId: string | null,
  db: Db = defaultDb,
): Promise<{ items: MemeView[]; nextCursor: string | null }> {
  const limit = Math.min(params.limit ?? 40, 100)

  const conditions: SQL[] = [isNull(memes.deletedAt)]

  // 多值 AND 过滤——每个值必须在对应数组里出现
  if (params.emotions && params.emotions.length > 0) {
    for (const e of params.emotions) {
      conditions.push(sql`${memes.emotions} @> ARRAY[${e}]::text[]`)
    }
  }
  if (params.scenes && params.scenes.length > 0) {
    for (const s of params.scenes) {
      conditions.push(sql`${memes.scenes} @> ARRAY[${s}]::text[]`)
    }
  }
  if (params.tags && params.tags.length > 0) {
    for (const t of params.tags) {
      conditions.push(sql`${memes.tags} @> ARRAY[${t}]::text[]`)
    }
  }

  if (params.isAnimated !== undefined) {
    conditions.push(eq(memes.isAnimated, params.isAnimated))
  }

  if (params.uploader) {
    if (params.uploader === 'me' && actorId) {
      conditions.push(eq(memes.uploaderId, actorId))
    } else if (params.uploader !== 'me') {
      conditions.push(eq(memes.uploaderId, params.uploader))
    }
  }

  if (params.tagStatus) {
    conditions.push(eq(memes.tagStatus, params.tagStatus))
  }

  // 游标分页：按 created_at desc, id desc；游标取「上一页最后一条」之后
  //
  // 随机路径**不吃游标**：随机序没有「下一页」（SPEC §6.3.2）。handler 已经把
  // `random` + `cursor` 的组合挡成了 VALIDATION_FAILED，这里是第二道。
  if (params.cursor && params.random !== true) {
    const decoded = decodeCursor(params.cursor)
    if (decoded) {
      // (created_at < cursor_ts) OR (created_at = cursor_ts AND id < cursor_id)
      conditions.push(
        or(
          lt(memes.createdAt, decoded.createdAt),
          and(eq(memes.createdAt, decoded.createdAt), lt(memes.id, decoded.id)),
        ) as SQL,
      )
    }
  }

  // 收藏过滤走 INNER JOIN `user_favorites`（「只看收藏」就是要求那条关系存在）。
  //
  // ⚠️ **join 的选择只在这一处**，下面随机与分页两条路径共用它。分成两份的话，
  //    必然有一份会先改——而 `favorited` 筛错的代价是一张不该出现的图出现在列表里，
  //    不报错。这个 bug 形态和漏 `deleted_at` 是同一类。
  const favoriteFilter = params.favorited === true && actorId !== null
  /** 收藏关系的 join 条件。`actorId` 为 null 时根本不该构造它——见下面的三元。 */
  const favoriteJoin = (userId: string) =>
    and(eq(userFavorites.memeId, memes.id), eq(userFavorites.userId, userId))

  const selected = {
    meme: memes,
    uploaderName: users.name,
    favoritedAt: userFavorites.createdAt,
  }
  const base = db
    .select(selected)
    .from(memes)
    .innerJoin(users, eq(memes.uploaderId, users.id))

  // `favoriteFilter && actorId !== null` 里的第二个判断是为了让 TS 收窄 `actorId`；
  // 语义上是冗余的（`favoriteFilter` 已蕴含它），类型系统看不见这层蕴含。
  const joined =
    favoriteFilter && actorId !== null
      ? base.innerJoin(userFavorites, favoriteJoin(actorId))
      : base.leftJoin(
          userFavorites,
          actorId !== null ? favoriteJoin(actorId) : sql`false`,
        )

  const toItems = (
    rows: { meme: MemeRow; uploaderName: string; favoritedAt: Date | null }[],
  ) =>
    rows.map((r) => ({
      ...r.meme,
      uploaderName: r.uploaderName,
      // INNER JOIN 那条路径上关系必然存在，不必再看 favoritedAt
      favorited: favoriteFilter ? true : r.favoritedAt !== null,
    }))

  // ── 随机抽样（SPEC §6.3.2） ──────────────────────────────────────
  //
  // ⚠️ **`order by random()` 是全表扫描 + 排序**，不是索引扫描。几万行在毫秒级，
  //    够首页用；**百万行量级它会是秒级**，届时换 `TABLESAMPLE` 或预生成随机序列。
  //    现在不预先优化——扫的是几万行不是几百万行，与 `findNearestByPhash` 那条
  //    「现在就上专用索引是提前优化」是同一个判断。到量了再换，别提前建索引。
  //
  // ⚠️ 这里**没有第二份 WHERE**：`conditions` 是上面逐条拼好的那一份，软删过滤、
  //    多值 AND、`uploader`、`tagStatus` 全在里面。随机路径另写一份 WHERE 是本任务
  //    最危险的写法——漏掉 `deleted_at is null` 的表现是「已删的图出现在首页」，
  //    不报错、不崩溃。见 SPEC §6.3.2 与 database.md §1.1。
  if (params.random === true) {
    const rows = await joined
      .where(and(...conditions))
      .orderBy(sql`random()`)
      .limit(limit)

    // 抽样没有下一页：给一个游标只会让客户端把「随机的第二页」接在第一页后面。
    return { items: toItems(rows), nextCursor: null }
  }

  const rows = await joined
    .where(and(...conditions))
    .orderBy(desc(memes.createdAt), desc(memes.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? encodeCursor(last.meme.createdAt, last.meme.id) : null

  return { items: toItems(page), nextCursor }
}

// ── 打标状态汇总（SPEC §6.6.1） ────────────────────────────────────
//
// `GET /memes/tag-status` 的 `counts`。**只有这一条查询在本文件里**：它只碰 `memes`。
// 同一个接口的 `running` / `failures` 是以 `tag_jobs` 为驱动的聚合，在 `data/tag-jobs.ts`。

export type TagStatusCounts = {
  ok: number
  pending: number
  refused: number
  needsManual: number
}

/**
 * 按 `tag_status` 分组的条数。
 *
 * ⚠️ **`deleted_at is null` 是硬条件**（SPEC §3.4、§6.6.1 的计数口径），
 * 而且口径必须和 `listMemes({ uploader, tagStatus })` 逐字一致——同一批图在两处
 * 条数对不上，说明其中一处漏了软删过滤，表现是数字多出来几个，**不报错**。
 * 测试里有一条专门拿这两个数字对账。
 *
 * 契约要的是**四个取值全给**，所以下面的返回值是四个键摆好再填，不是「查到什么给什么」：
 * 缺的那个必须是 0，前端不处理「这个键不存在」。
 *
 * @param uploaderId null 表示全站（`scope=all`，仅管理员，见服务层的口径判断）
 */
export async function countMemesByTagStatus(
  uploaderId: string | null,
  db: Db = defaultDb,
): Promise<TagStatusCounts> {
  const conditions: SQL[] = [isNull(memes.deletedAt)]
  if (uploaderId !== null) conditions.push(eq(memes.uploaderId, uploaderId))

  const rows = await db
    .select({ tagStatus: memes.tagStatus, count: sql<number>`count(*)::int` })
    .from(memes)
    .where(and(...conditions))
    .groupBy(memes.tagStatus)

  // 库里出现第五种取值只可能是有人绕过了状态机，那它就不会被读出来——
  // 契约里的四个取值之外，前端没有对应文案可写。
  const byStatus = new Map<string, number>(
    rows.map((row): [string, number] => [row.tagStatus, row.count]),
  )
  return {
    ok: byStatus.get('ok') ?? 0,
    pending: byStatus.get('pending') ?? 0,
    refused: byStatus.get('refused') ?? 0,
    needsManual: byStatus.get('needs_manual') ?? 0,
  }
}

/**
 * 单条浏览，含 favorited 字段。软删记录返回 null（调用方抛 NOT_FOUND）。SPEC §6.3.2
 */
export async function getMemeById(
  id: string,
  actorId: string | null,
  db: Db = defaultDb,
): Promise<MemeView | null> {
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
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  return { ...row.meme, uploaderName: row.uploaderName, favorited: row.favoritedAt !== null }
}
