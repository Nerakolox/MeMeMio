import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { reindexJobs } from './schema.js'

/**
 * `reindex_jobs` 的访问方法（SPEC §6.5.4）。
 *
 * 和 `data/tag-jobs.ts` 同一套路子，但**刻意不共用代码**：两个队列的重试策略、
 * 并发口径和终局语义都不同，抽一层公共基类只会让「重算不按用户分组」这条
 * 被下一个人当成疏漏补回去。
 *
 * ⚠️ 硬要求同 queue.md §8：入队的 `memeId` 必须来自 `data/memes.ts` 的查询结果。
 *    **本文件一个字都不碰 `memes`**——在队列表上 join `memes` 会绕过
 *    `deleted_at is null`，表现是给已经删掉的图重算向量。
 */

export type ReindexJobRow = typeof reindexJobs.$inferSelect

/** 重算的重试上限。比打标宽松一点：它不花 AI 视觉的钱，只是一次 embedding 调用。 */
export const MAX_REINDEX_ATTEMPTS = 3

/**
 * 批量入队。**幂等**（SPEC §6.5.4：「重复调用不会让同一条记录重算两遍」）——
 * 撞上 `reindex_jobs_meme_id_key` 的静默跳过。
 *
 * `PUT /config/embed` 带 `confirmReindex` 的自动触发和 `POST /admin/reindex` 的
 * 手动补触发走的是同一个函数，所以两者天然幂等，不需要各自再判一遍。
 *
 * @returns 真正插进去的条数。为 0 说明该算的都已经在队列里了，不是错误。
 */
export async function enqueueReindexJobs(memeIds: string[], db: Db = defaultDb): Promise<number> {
  if (memeIds.length === 0) return 0
  const rows = await db
    .insert(reindexJobs)
    .values(memeIds.map((memeId) => ({ memeId })))
    .onConflictDoNothing({ target: reindexJobs.memeId })
    .returning({ id: reindexJobs.id })
  return rows.length
}

/**
 * 取一条待处理任务并置为 running。自带短事务，`FOR UPDATE SKIP LOCKED`。
 *
 * **没有 `excludeUserIds` 参数**，这不是漏写：重算是运维操作，不是谁的配额
 * （任务 F 项）。并发上限按全站一个小数字控，落在 `queue/reindex-worker.ts`。
 *
 * `attempts` 在取任务时就 +1，理由同 `claimTagJob`：被 SIGKILL 的任务没人写失败，
 * 不在这里加会被无限重取。
 */
export async function claimReindexJob(db: Db = defaultDb): Promise<ReindexJobRow | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(reindexJobs)
      .where(and(eq(reindexJobs.status, 'pending'), sql`${reindexJobs.runAfter} <= now()`))
      .orderBy(reindexJobs.runAfter)
      .limit(1)
      .for('update', { skipLocked: true })

    const job = rows[0]
    if (job === undefined) return null

    const attempts = job.attempts + 1
    await tx
      .update(reindexJobs)
      .set({ status: 'running', attempts, runAfter: new Date() })
      .where(eq(reindexJobs.id, job.id))

    return { ...job, status: 'running', attempts }
  })
}

/**
 * 完成即**删行**，不留 done 记录。
 *
 * 这不是省空间，是正确性：`meme_id` 上有唯一索引，留一条 done 会让这张图在
 * **下一次**换模型时入不了队（`onConflictDoNothing` 静默跳过），表现是
 * 「重建跑完了，但有一批图的向量还是旧模型的」——不报错。
 *
 * 进度不依赖这些行：`total` / `done` 由 `countEmbeddingProgress` 从 `memes` 真实计数
 * 算出来（§6.5.4），删掉队列行不影响它。
 */
export async function markReindexJobDone(id: string, db: Db = defaultDb): Promise<void> {
  await db.delete(reindexJobs).where(eq(reindexJobs.id, id))
}

export async function markReindexJobRetry(
  id: string,
  runAfter: Date,
  lastError: string,
  db: Db = defaultDb,
): Promise<void> {
  await db
    .update(reindexJobs)
    .set({ status: 'pending', runAfter, lastError })
    .where(eq(reindexJobs.id, id))
}

/**
 * 推后，并**把 attempts 写回去**。用在「没配 embedding 通道」这一支。
 *
 * 和 `markReindexJobRetry` 分成两个函数，是因为它们说的是两件不同的事：
 * 重试是「这次失败了，等会儿再试」，推后是「这次压根不算数」。稳定的降级态
 * （通道被清空了）不该消费重试次数——否则配置空着的那一个小时里，
 * 整批任务会在三轮空转之后全部变成终局失败，而没有任何一次真的调用过。
 *
 * attempts 和 run_after **同一条 UPDATE**：分两步写的话，中间崩一次就会
 * 留下一条已经推后但 attempts 没退回去的任务。同 `deferTagJob`。
 */
export async function deferReindexJob(
  id: string,
  attempts: number,
  runAfter: Date,
  lastError: string,
  db: Db = defaultDb,
): Promise<void> {
  await db
    .update(reindexJobs)
    .set({ status: 'pending', attempts, runAfter, lastError })
    .where(eq(reindexJobs.id, id))
}

/**
 * 终局失败。**失败的行留在表里**（§6.5.4、queue.md §7：不做断点续传），
 * 它们是 `GET /admin/reindex/status` 的 `failed`——`stale` 长时间不降就是出了问题，
 * 管理员得能看见。
 */
export async function markReindexJobFailed(
  id: string,
  lastError: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.update(reindexJobs).set({ status: 'failed', lastError }).where(eq(reindexJobs.id, id))
}

/**
 * 还有没有未完成的重算任务。
 *
 * ⚠️ **这条查询落在每一个搜索请求上**（SPEC §6.3.1 的 `degraded`）。所以它必须是
 *    存在性查询：`status in ('pending','running')` 命中 `reindex_jobs_claim_idx`，
 *    `limit 1` 一命中就返回。**不能写成 count(\*)**——那是全表扫，库里几万条重算任务时
 *    每次搜索都要付一遍。
 */
export async function hasUnfinishedReindexJobs(db: Db = defaultDb): Promise<boolean> {
  const rows = await db
    .select({ id: reindexJobs.id })
    .from(reindexJobs)
    .where(inArray(reindexJobs.status, ['pending', 'running']))
    .limit(1)
  return rows.length > 0
}

export type ReindexQueueCounts = { queued: number; failed: number }

/**
 * 队列自己的两个数：**在队列里排着的**和**重试耗尽的**。
 *
 * ⚠️ `queued` 不是 `GET /admin/reindex/status` 的 `stale`。`stale` 的定义是
 *    「向量过期、该重算的条数」，来自 `memes`（`countEmbeddingProgress`），
 *    和「已经排进队列了没有」是两件事——手动触发之前 `stale` 就已经大于 0，
 *    而 `queued` 还是 0。当年把这两个都叫 stale 的话，进度条会在
 *    「入队前」和「入队后」显示两个都对但互相矛盾的数。
 *
 * 这里 count 是可以的——它只在管理员查看进度时被调用，不落在搜索请求上。
 */
export async function countReindexJobs(db: Db = defaultDb): Promise<ReindexQueueCounts> {
  const [row] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${reindexJobs.status} in ('pending','running'))::int`,
      failed: sql<number>`count(*) filter (where ${reindexJobs.status} = 'failed')::int`,
    })
    .from(reindexJobs)
  return { queued: row?.queued ?? 0, failed: row?.failed ?? 0 }
}

/**
 * 清掉上一轮遗留的 failed 行。**只在开启新一轮重建时调用**（换了 embedding 模型）。
 *
 * 不在 `POST /admin/reindex` 里调：那个端点是同一轮的手动补触发，把 failed 清了
 * 等于把「有 12 条重试耗尽了」这个事实抹掉，而那正是管理员要看的东西。
 */
export async function clearFailedReindexJobs(db: Db = defaultDb): Promise<number> {
  const rows = await db
    .delete(reindexJobs)
    .where(eq(reindexJobs.status, 'failed'))
    .returning({ id: reindexJobs.id })
  return rows.length
}

/**
 * 把卡在 running 的任务放回队列。进程启动时调一次，理由同 `requeueStaleRunningJobs`：
 * SIGKILL 之后任务永远停在 running，表现是「重建进度卡住不动」，不报错、不告警。
 */
export async function requeueStaleRunningReindexJobs(
  staleMs: number,
  db: Db = defaultDb,
): Promise<number> {
  const rows = await db
    .update(reindexJobs)
    .set({ status: 'pending', lastError: 'worker 异常退出，任务被回收' })
    .where(
      and(
        eq(reindexJobs.status, 'running'),
        lt(reindexJobs.runAfter, new Date(Date.now() - staleMs)),
      ),
    )
    .returning({ id: reindexJobs.id })
  return rows.length
}
