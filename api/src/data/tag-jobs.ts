import { and, eq, inArray, lt, not, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { tagJobs } from './schema.js'

/**
 * `tag_jobs` 的访问方法。
 *
 * **它不是 `memes` 的一部分**，所以不走 `data/memes.ts`（agents/rules/queue.md §8）。
 * 但反过来有一条硬要求：入队时传进来的 `memeId` / `userId` 必须来自 `data/memes.ts`
 * 的查询结果。不要为了省一次查询在这里 join `memes` —— 那会绕过 `deleted_at is null`，
 * 表现是给已经删掉的图打标，不报错。
 *
 * 这一层只写 SQL，不做判断。重试几次、退避多久由 `lib/retry-policy.ts` 决定，
 * 什么时候取任务由 `queue/worker.ts` 决定（project-structure.md：`queue/` 只负责调度）。
 */

export type TagJobRow = typeof tagJobs.$inferSelect

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
 */
export async function claimTagJob(
  excludeUserIds: string[] = [],
  db: Db = defaultDb,
): Promise<TagJobRow | null> {
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
    if (job === undefined) return null

    const attempts = job.attempts + 1
    await tx
      .update(tagJobs)
      .set({ status: 'running', attempts, runAfter: new Date() })
      .where(eq(tagJobs.id, job.id))

    return { ...job, status: 'running', attempts }
  })
}

/** 把任务标成完成。 */
export async function markTagJobDone(id: string, tx: Db = defaultDb): Promise<void> {
  await tx.update(tagJobs).set({ status: 'done', lastError: null }).where(eq(tagJobs.id, id))
}

/**
 * 记一次失败并推后重试。
 *
 * 重试靠推后 `run_after`，**不靠 sleep**——worker 里长 sleep 会占着消费槽什么都不干。
 * 退避上限与降级分支见 agents/rules/queue.md §3。
 */
export async function markTagJobRetry(
  id: string,
  runAfter: Date,
  lastError: string,
  tx: Db = defaultDb,
): Promise<void> {
  await tx
    .update(tagJobs)
    .set({ status: 'pending', runAfter, lastError })
    .where(eq(tagJobs.id, id))
}

/**
 * 终局失败。任务不再被取，`memes.tag_status` 怎么写由 services 层决定——
 * 队列表不认识 `memes`。
 */
export async function markTagJobFailed(
  id: string,
  lastError: string,
  tx: Db = defaultDb,
): Promise<void> {
  await tx.update(tagJobs).set({ status: 'failed', lastError }).where(eq(tagJobs.id, id))
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
  id: string,
  attempts: number,
  runAfter: Date,
  lastError: string,
  tx: Db = defaultDb,
): Promise<void> {
  await tx
    .update(tagJobs)
    .set({ status: 'pending', attempts, runAfter, lastError })
    .where(eq(tagJobs.id, id))
}

/**
 * 把卡在 running 的任务放回队列。**进程启动时调一次。**
 *
 * 优雅退出会等在途任务跑完，所以正常路径下这里什么都捞不到。它防的是
 * SIGKILL / OOM / 断电——那种情况下任务永远停在 running，**表现是「这张图再也不会被打标」，
 * 不报错、不告警**。没有这个兜底，一次容器重启就能静默废掉一批图。
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
