import { and, eq, inArray, isNotNull, isNull, lt, not, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { MAX_TAG_CLAIMS } from '../lib/retry-policy.js'
import { db as defaultDb, type Db } from './db.js'
import { memes, tagJobs } from './schema.js'

/**
 * `tag_jobs` 的访问方法。
 *
 * **它不是 `memes` 的一部分**，所以不走 `data/memes.ts`（agents/rules/queue.md §8）。
 * 但反过来有一条硬要求：入队时传进来的 `memeId` / `userId` 必须来自 `data/memes.ts`
 * 的查询结果。不要为了省一次查询在这里 join `memes` —— 那会绕过 `deleted_at is null`，
 * 表现是给已经删掉的图打标，不报错。
 *
 * ⚠️ **上面那条管的是写路径（入队）。读路径反过来的 join 是允许的，判据是 join 有没有
 *    带 `deleted_at is null`**（queue.md §8 在 2026-09-19 收紧成这个措辞）：
 *    只有 join 才能在队列表的行上**应用**软删过滤，不 join 反而会把已删除的图算进去。
 *    本文件的 `countFailedTagJobsByReason` 就是这条路——别当成照抄 §8 抄错了，
 *    形状和 `data/imports.ts` 的待确认队列 join 一样。
 *
 * 这一层只写 SQL，不做判断。重试几次、退避多久由 `lib/retry-policy.ts` 决定，
 * 什么时候取任务由 `queue/worker.ts` 决定（project-structure.md：`queue/` 只负责调度）。
 */

export type TagJobRow = typeof tagJobs.$inferSelect

/**
 * **一次领取的标识**。所有回写 `tag_jobs` 的语句都必须带上它做条件。
 *
 * ⚠️ 这不是为了防恶意，是为了防**迟到的写入**：任务有整体超时（`queue/worker.ts` 的
 *    `JOB_TIMEOUT_MS`），超时之后原任务还在后台跑，它晚一步的完成 / 重试 / 失败
 *    会把**已经被放回 `pending`、或已经被别的进程重新领走**的那一行改掉。表现是
 *    「这张图刚被重排上就又变成 done 了」，不报错、也查不出来。
 *
 * `(id, attempts)` 是本表的全序：`claimTagJob` 每次领取都把 `attempts` +1，所以同一
 * 行的两次领取**不可能拿到同一个 attempts**。条件里再带上 `status = 'running'`
 * 是为了覆盖「被放回 pending 后还没人领」的那一段——那时 attempts 没变，只有状态变了。
 *
 * 用 `attempts` 而不是新加一列 `claimed_at`：它已经存在、已经单调递增，
 * 加一列就要迁移，而迁移换来的信息量是一样的。
 */
export type TagJobClaim = { id: string; attempts: number }

/** 从 `claimTagJob` 返回的行走一次，拿到这次领取的标识。 */
export function claimOf(job: TagJobRow): TagJobClaim {
  return { id: job.id, attempts: job.attempts }
}

/**
 * 回写条件的唯一落点。**不要在任何调用方手写这几个条件**——漏掉 `attempts` 那一条
 * 不会报错，只会让迟到的写入赢，而那正是这一整套要挡住的东西。
 */
function claimedWhere(claim: TagJobClaim): SQL {
  return and(
    eq(tagJobs.id, claim.id),
    eq(tagJobs.status, 'running'),
    eq(tagJobs.attempts, claim.attempts),
  ) as SQL
}

/**
 * `claimTagJob` 的三种结局。
 *
 * `exhausted` 单独成一支而不是「返回 null、顺便偷偷改一行」：收到它的调用方要做的
 * 事和「没任务」完全不同——它得把 `memes.tag_status` 翻成 `needs_manual`
 * （那是 `services/` 的活，本表不认识 `memes` 的状态机），并且**不能当成队列空**去睡轮询间隔。
 */
export type TagJobClaimResult =
  | { kind: 'job'; job: TagJobRow }
  /** 重领次数已耗尽，本函数已把它落成 `failed`。调用方负责对齐 `memes.tag_status`。 */
  | { kind: 'exhausted'; job: TagJobRow }
  | { kind: 'empty' }

/**
 * 入队。
 *
 * ⚠️ **必须在「写 memes」的同一个事务里调用**（agents/rules/database.md §5、
 * agents/rules/queue.md §2）。所以第一个参数是事务句柄，不是可选的 db。
 * 这是不用 Redis 换来的最大好处：「图片入库了但队列任务丢了」不可能发生——
 * **别为了"性能"把它拆开**，拆开就白放弃 Redis 了。
 *
 * 撞上唯一约束（同一张图重复入队）时静默跳过。重放 commit 是常态，
 * 而入队两次的代价是同一个文件被调两次 AI——花的是用户自己的钱。
 *
 * `userId` 传的是 `createMeme` 返回行的 `uploaderId`，不在这里查。
 */
export async function enqueueTagJob(memeId: string, userId: string, tx: Db): Promise<void> {
  await tx
    .insert(tagJobs)
    .values({ memeId, userId })
    .onConflictDoNothing({ target: tagJobs.memeId })
}

/**
 * 重打标的入队：**把已有的行重置回 `pending`**，而不是插一条新的。
 *
 * 这是 `POST /memes/retag` 唯一需要新写一个助手的原因（SPEC §6.4.3）。
 * `enqueueTagJob` 在这里**必然静默失效**：`tag_jobs_meme_id_key` 是 `meme_id` 上的
 * 唯一索引，而 `markTagJobDone` **保留 done 行**（与 `reindex_jobs` 的完成即删行相反），
 * 所以对一张已经打完的图再调一次 `enqueueTagJob` 是 `onConflictDoNothing` —— 什么都不发生，
 * 也不报错。库里的图全部 `tag_status = ok` 时，重打就变成了一个彻头彻尾的空操作。
 *
 * ⚠️ **`running` 的行绝对不能碰。** `claimTagJob` 只看 `status = 'pending'`，
 *    把一个正在跑的行改回 `pending`，第二个 worker 会认领同一条、
 *    **同一张图付两次钱**。所以更新带 `setWhere`：不满足条件的行既不更新、
 *    也不出现在 `RETURNING` 里——正好就是我们要的计数口径。
 *    （`setWhere` 是 drizzle-orm 0.38 里的非废弃字段，本文件是全仓唯一一处用它；
 *    它和已废弃的 `where` **不能同时传**，会抛。）
 *
 * ⚠️ **`attempts: 0` 是承重的。** `decideRetry(failure, attempts)` 拿它当重试预算，
 *    留着上一轮的终局值（最多的那个是 5）会让重打的图在**第一次**网络抖动时
 *    就直接判 `needs_manual`，而它本该还有五次机会。
 *
 * `lastError: null` 一并清掉：新一轮的失败计数该从零开始。**代价是上一轮的失败诊断
 * 不再留档**，这是有意的取舍（SPEC §6.4.3 记了这条）。
 *
 * **返回两个东西**，它们回答的是两个不同的问题：
 *
 *   - `scheduledMemeIds` —— 真的被（重）排上的。调用方拿它去翻 `memes.tag_status`，
 *     而那个写入**必须依据更新真的命中了哪些行**：用传进来的 id 列表的话，
 *     某个 id 因为 `running` 被跳过时它的图仍会被翻成 `pending`，
 *     两个写入互相矛盾，而且没人看得出来。
 *   - `alreadyPendingCount` —— 其中**原本就已在 `pending`** 的条数。它们没有被
 *     「新排上」，本来就在等着跑。响应里的 `enqueuedCount` 要减掉这一批，
 *     否则「连点两次、第二次 0 条」这个幂等口径就不成立（SPEC §6.4.3），
 *     而客户端拿它当进度基线用（`web` 的 `RetagPanel`）。
 *
 * ⚠️ **先读一次旧状态，是因为 `RETURNING` 只能给新行。** `ON CONFLICT DO UPDATE`
 *    的 `RETURNING` 里 `tag_jobs.status` 是**写完之后**的值，看不出某一行
 *    原本是不是就已经是 `pending`。这一次 select 走 `tag_jobs_meme_id_key`
 *    （`meme_id` 上的唯一索引），每批一次，代价可以忽略。
 *
 * ⚠️ **必须在「翻 tag_status」的同一个事务里调用**（queue.md §2）。
 *
 * @param rows 每项都要带 `userId`。它是 NOT NULL 且**不能 join `memes` 取**
 *             （queue.md §8 禁在本表 join `memes`），所以只能由调用方从
 *             `data/memes.ts` 的查询结果里带过来。
 *             调用方负责分批，见 `services/retag.ts` 的 `RETAG_BATCH`。
 */
export type RetagQueueResult = {
  scheduledMemeIds: string[]
  alreadyPendingCount: number
}

export async function requeueTagJobsForRetag(
  rows: { memeId: string; userId: string }[],
  tx: Db = defaultDb,
): Promise<RetagQueueResult> {
  if (rows.length === 0) return { scheduledMemeIds: [], alreadyPendingCount: 0 }

  const memeIds = rows.map((row) => row.memeId)

  const pending = await tx
    .select({ memeId: tagJobs.memeId })
    .from(tagJobs)
    .where(and(inArray(tagJobs.memeId, memeIds), eq(tagJobs.status, 'pending')))
  const wasPending = new Set(pending.map((row) => row.memeId))

  const updated = await tx
    .insert(tagJobs)
    .values(rows)
    .onConflictDoUpdate({
      target: tagJobs.memeId,
      set: {
        // userId 也一起写：图在上传者之间不可能转移，但万一重打时拿到的
        // 归属和行里存的不一致，留着一份对不上的冗余列比写一次更坏。
        userId: sql`excluded.user_id`,
        status: 'pending',
        attempts: 0,
        runAfter: new Date(),
        lastError: null,
      },
      setWhere: sql`${tagJobs.status} <> 'running'`,
    })
    .returning({ memeId: tagJobs.memeId })

  return {
    scheduledMemeIds: updated.map((row) => row.memeId),
    alreadyPendingCount: updated.filter((row) => wasPending.has(row.memeId)).length,
  }
}

/**
 * 取一条待处理任务并置为 running。**自带一个短事务。**
 *
 * `FOR UPDATE SKIP LOCKED` 是整个方案成立的基础——**多个 worker 不会取到同一条**。
 * 不要在调用方把它拆成「先 select 再 update」，那两步写法在并发下会重复消费。
 * 代码里任何地方都不许假设只有一个副本在跑（queue.md §1）。
 *
 * ⚠️ **事务在这个函数里开始也在这里结束**，不跨 AI 调用。行锁一直握到打标结束的话，
 *    一次 15 秒的视觉调用就是 15 秒的行锁，几十个任务下来连接池先被占光。
 *    取任务之后靠 `status = 'running'` 占位，不靠锁。
 *
 * `excludeUserIds` 实现按人分配（queue.md §4）：worker 把已经占满在途名额的人传进来，
 * 这条语句就跳过他们。**一个人导入一千张不能把别人刚传的一张堵在后面。**
 * 过滤直接写在 `tag_jobs.user_id` 上，全程没有 join `memes`。
 *
 * `attempts` 在取任务时就 +1，而不是失败时才加：worker 被 SIGKILL 的任务没人去写失败，
 * 不在这里加的话它会被无限重取。返回行里的 attempts 已经是**含本次**的次数，
 * 直接喂给 `decideRetry`。
 *
 * `run_after` 同时被推到 now()，作为「这条任务最后一次被碰」的时间戳，
 * 给 `requeueStaleRunningJobs` 用——单独加一列 started_at 只为这一个用途不划算。
 *
 * ⚠️ **毒任务在领取这**一步就被掐掉**（`MAX_TAG_CLAIMS`，见 `lib/retry-policy.ts`）。
 *    每次领取都把进程打崩的任务永远走不到 `applyFailure`，重试矩阵根本没机会运行，
 *    于是它会被无限重领。判据只能是 `attempts`——它没有 `last_error` 可看。
 *    落终局**在这里**做而不是在 worker 里：worker 拿到的将是一条 `failed` 的行，
 *    它再走一次领取判定就变成「先污染再判断」，多一个可以忘记的分支。
 */
export async function claimTagJob(
  excludeUserIds: string[] = [],
  db: Db = defaultDb,
): Promise<TagJobClaimResult> {
  return db.transaction(async (tx) => {
    const conditions = [eq(tagJobs.status, 'pending'), sql`${tagJobs.runAfter} <= now()`]
    if (excludeUserIds.length > 0) {
      conditions.push(not(inArray(tagJobs.userId, excludeUserIds)))
    }

    const rows = await tx
      .select()
      .from(tagJobs)
      .where(and(...conditions))
      .orderBy(tagJobs.runAfter)
      .limit(1)
      .for('update', { skipLocked: true })

    const job = rows[0]
    if (job === undefined) return { kind: 'empty' }

    if (job.attempts >= MAX_TAG_CLAIMS) {
      const lastError = `重试次数已耗尽（已被领取 ${job.attempts} 次，一次都没产出结论）`
      await tx.update(tagJobs).set({ status: 'failed', lastError }).where(eq(tagJobs.id, job.id))
      return { kind: 'exhausted', job: { ...job, status: 'failed', lastError } }
    }

    const attempts = job.attempts + 1
    await tx
      .update(tagJobs)
      .set({ status: 'running', attempts, runAfter: new Date() })
      .where(eq(tagJobs.id, job.id))

    return { kind: 'job', job: { ...job, status: 'running', attempts } }
  })
}

/**
 * 把任务标成完成。返回**是否真的写到了**——false 表示这次领取已经不作数了
 * （超时放回队列后又被别人领走），调用方记一条日志，不要当成成功。
 */
export async function markTagJobDone(claim: TagJobClaim, tx: Db = defaultDb): Promise<boolean> {
  const rows = await tx
    .update(tagJobs)
    .set({ status: 'done', lastError: null })
    .where(claimedWhere(claim))
    .returning({ id: tagJobs.id })
  return rows.length > 0
}

/**
 * 记一次失败并推后重试。
 *
 * 重试靠推后 `run_after`，**不靠 sleep**——worker 里长 sleep 会占着消费槽什么都不干。
 * 退避上限与降级分支见 agents/rules/queue.md §3。
 */
export async function markTagJobRetry(
  claim: TagJobClaim,
  runAfter: Date,
  lastError: string,
  tx: Db = defaultDb,
): Promise<boolean> {
  const rows = await tx
    .update(tagJobs)
    .set({ status: 'pending', runAfter, lastError })
    .where(claimedWhere(claim))
    .returning({ id: tagJobs.id })
  return rows.length > 0
}

/**
 * 终局失败。任务不再被取，`memes.tag_status` 怎么写由 services 层决定——
 * 队列表不认识 `memes`。
 */
export async function markTagJobFailed(
  claim: TagJobClaim,
  lastError: string,
  tx: Db = defaultDb,
): Promise<boolean> {
  const rows = await tx
    .update(tagJobs)
    .set({ status: 'failed', lastError })
    .where(claimedWhere(claim))
    .returning({ id: tagJobs.id })
  return rows.length > 0
}

/**
 * 推迟重跑，并**把这次尝试还回去**（`attempts` 写成传进来的值）。
 *
 * 只给「这次根本没试」的情况用——目前唯一的场景是取到任务时发现视觉通道没配置。
 * 那种情况必须不计次数：`AI_NOT_CONFIGURED` 是稳定的降级态，可能持续几天，
 * 用 `markTagJobRetry` 的话 attempts 会一路涨上去，等用户真配好 key 之后
 * **第一次网络抖动就直接判 needs_manual**——而它本该还有五次机会。
 */
export async function deferTagJob(
  claim: TagJobClaim,
  attempts: number,
  runAfter: Date,
  lastError: string,
  tx: Db = defaultDb,
): Promise<boolean> {
  const rows = await tx
    .update(tagJobs)
    .set({ status: 'pending', attempts, runAfter, lastError })
    .where(claimedWhere(claim))
    .returning({ id: tagJobs.id })
  return rows.length > 0
}

/** 进程退出时把在途任务放回队列的理由。它会原样进 `last_error`。 */
export const RELEASED_ON_SHUTDOWN = '进程退出，任务被放回队列'

/**
 * 停机时把**本进程正在跑**的任务放回 `pending`。
 *
 * ⚠️ **这是「放回」而不是「等它们跑完」**，理由是一个算术：compose 的
 *    `stop_grace_period` 默认 10 秒，而单个任务的整体超时是 90 秒——退出时等在途任务
 *    跑完是**不可能**的，等下去的结果是被 SIGKILL 强杀，任务永远停在 `running`
 *    （表现是「这几张图再也不会被打标」，不报错、不告警）。
 *
 * **已知代价：被放回的图会重新调一次视觉模型，也就是同一张图付两次钱。**
 * 这是有意的取舍——静默卡死比重复花钱严重得多。
 *
 * 条件里的 `status = 'running'` 是精确的，不需要 `attempts`：别的进程只能领 `pending`，
 * 所以一条还在 `running` 的行只可能属于我们。反过来，已经跑完写了结论的行不会被碰。
 */
export async function releaseRunningTagJobs(
  ids: string[],
  reason: string = RELEASED_ON_SHUTDOWN,
  db: Db = defaultDb,
): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db
    .update(tagJobs)
    .set({ status: 'pending', runAfter: new Date(), lastError: reason })
    .where(and(inArray(tagJobs.id, ids), eq(tagJobs.status, 'running')))
    .returning({ id: tagJobs.id })
  return rows.length
}

/**
 * 把卡在 running 的任务放回队列。**启动时扫一次，之后周期性地扫**
 * （周期在 `queue/worker.ts` / `queue/reindex-worker.ts`）。
 *
 * ⚠️ **只在启动时扫一次是不够的**，这正是本函数从「启动一次」改成「周期性」的原因：
 *    进程被 OOM 或强杀后如果**几秒内就重启**，那些在途任务还没超过回收阈值，
 *    启动时那一次扫描一条都捞不到——之后再也没人扫它。表现是一批图静默停在
 *    「打标中」，界面上也没有入口能把它们捞出来。
 *
 * 正常退出路径下这里什么都捞不到：停机时在途任务由 `releaseRunningTagJobs` 直接放回。
 * 它防的是 SIGKILL / OOM / 断电，以及**别的副本**死在半路（多副本时每个进程都扫，
 * 谁先扫到都一样，条件是幂等的）。
 *
 * 判据是 `run_after`（取任务时被推到 now()）早于 `now() - staleMs`。
 * `staleMs` 要明显大于任务整体超时，否则会把正在跑的任务抢走导致重复调用 AI。
 */
export async function requeueStaleRunningJobs(
  staleMs: number,
  db: Db = defaultDb,
): Promise<number> {
  const rows = await db
    .update(tagJobs)
    .set({ status: 'pending', lastError: 'worker 异常退出，任务被回收' })
    .where(
      and(eq(tagJobs.status, 'running'), lt(tagJobs.runAfter, new Date(Date.now() - staleMs))),
    )
    .returning({ id: tagJobs.id })
  return rows.length
}

// ── 打标状态汇总里的两个数（SPEC §6.6.1） ──────────────────────────
//
// `GET /memes/tag-status` 的 `running` 与 `failures`。它们以 `tag_jobs` 为驱动，
// 所以在这一个文件里；`counts` 只碰 `memes`，在 `data/memes.ts`。

/**
 * 此刻 `status = 'running'` 的任务数。
 *
 * **这是库里的真实计数，不是进程内存计数器**（SPEC §6.6.1）：多副本下它合计所有副本
 * 在跑的任务，而内存计数重启就归零。被 SIGKILL 卡住的任务要到下次进程启动
 * （`requeueStaleRunningJobs`）才降下来，在此之前这个数偏大——可接受的近似，
 * **不要为了它去加实时对账**。
 *
 * 不 join `memes`：契约只说「在跑的任务数」。跑到一半图被删掉的那些很快会判 `gone`，
 * 不值得为它多一次 join（queue.md §8 的方向判据在这里用不上，这里根本没有 join）。
 *
 * @param userId null 表示全站（`scope=all`）
 */
export async function countRunningTagJobs(
  userId: string | null,
  db: Db = defaultDb,
): Promise<number> {
  const conditions: SQL[] = [eq(tagJobs.status, 'running')]
  if (userId !== null) conditions.push(eq(tagJobs.userId, userId))

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tagJobs)
    .where(and(...conditions))
  return row?.count ?? 0
}

/** 一个失败类别（原样取自 `last_error` 的前缀，**没有校验是不是契约里的五个取值**）。 */
export type TagFailureGroup = { reason: string; count: number }

/**
 * 终局失败的任务按 `last_error` 的类别前缀分组计数。
 *
 * ⚠️ **这条查询 join 了 `memes`，方向是「在队列表的行上应用软删过滤」**
 * （文件头那段说的读路径）：不 join 的话，已经删掉的图会一直算在失败分布里，
 * 而它根本不出现在待处理列表里，用户看到的数字和列表对不上。
 * 所以 `deleted_at is null` 是这条 join 的**目的**，不是顺带加的。
 *
 * 归属按 `memes.uploader_id` 过滤，和 `counts` 的口径对齐（图是谁的），
 * **不是** `tag_jobs.user_id`（任务为谁跑）——两者由 `enqueueTagJob` 保证相等，
 * 但契约里的「同一批图」指的是前者。
 *
 * 类别取第一个冒号之前那段：写入格式固定是 `` `${failure}: ${detail}` ``
 * （`queue/worker.ts` 的 `applyFailure`）。**`detail` 一律不带出去**——
 * 它来自供应商响应，格式随时会变（SPEC §6.6.1）。
 *
 * 返回的是原样的分组，**不折成契约的五个取值**：那是响应形状，属于服务层
 * （`services/tag-status.ts`）。
 *
 * @param uploaderId null 表示全站（`scope=all`）
 */
export async function countFailedTagJobsByReason(
  uploaderId: string | null,
  db: Db = defaultDb,
): Promise<TagFailureGroup[]> {
  const reason = sql<string>`split_part(${tagJobs.lastError}, ':', 1)`

  const conditions: SQL[] = [
    eq(tagJobs.status, 'failed'),
    // 没有 last_error 的失败任务没有类别可报，别让它在分组里多出一个 null 桶
    isNotNull(tagJobs.lastError),
    isNull(memes.deletedAt),
  ]
  if (uploaderId !== null) conditions.push(eq(memes.uploaderId, uploaderId))

  const rows = await db
    .select({ reason, count: sql<number>`count(*)::int` })
    .from(tagJobs)
    .innerJoin(memes, eq(memes.id, tagJobs.memeId))
    .where(and(...conditions))
    .groupBy(reason)

  return rows.map((row) => ({ reason: row.reason, count: row.count }))
}
