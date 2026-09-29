import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { personVectorJobs } from './schema.js'

/**
 * `person_vector_jobs` 的访问方法（SPEC §5.7.2 / §6.7.5）。
 *
 * 第三张队列，形状照 `data/reindex-jobs.ts` 抄，但**刻意不共用代码**——和
 * 那边不共用 `tag-jobs.ts` 是同一条理由：三者的重试语义、并发口径和终局行为
 * 各不相同，抽一层公共基类会让「人物向量不按用户分组」这条被下一个人当成疏漏补回去。
 *
 * 与 `reindex_jobs` 的两处实质差别：
 *
 * 1. **`not_configured` 完成即删**，不推后重排。理由见 `queue/person-vector-worker.ts`：
 *    文本向量那边「没配通道」是个**暂时**状态（管理员马上会去配），推后有意义；
 *    这边一样是暂时状态，但**每张图都是一次付费调用**（§6.7.5），堆一个几万条的
 *    待办队列去等一个可能永远不配的通道，只会让管理员在配好那一刻意外触发一次性
 *    的大额扣费。删掉之后想补跑，由人显式点 `POST /admin/persons/reindex`。
 * 2. **没有 `defer`**。既然没配就删，就不需要「把 attempts 退回去」那个动作了。
 *
 * ⚠️ 硬要求同 queue.md §8：入队的 `memeId` 必须来自 `data/memes.ts` 的查询结果。
 *    **本文件一个字都不碰 `memes`**——在队列表上 join `memes` 会绕过
 *    `deleted_at is null`，表现是给已经删掉的图算向量（花钱，且结果无处可挂）。
 */

export type PersonVectorJobRow = typeof personVectorJobs.$inferSelect

/**
 * 一次领取的标识。推导与 `data/reindex-jobs.ts` 的 `ReindexJobClaim` 逐字相同。
 */
export type PersonVectorJobClaim = { id: string; attempts: number }

export function claimOfPersonVector(job: PersonVectorJobRow): PersonVectorJobClaim {
  return { id: job.id, attempts: job.attempts }
}

function claimedWhere(claim: PersonVectorJobClaim): SQL {
  return and(
    eq(personVectorJobs.id, claim.id),
    eq(personVectorJobs.status, 'running'),
    eq(personVectorJobs.attempts, claim.attempts),
  ) as SQL
}

/** 重试上限。同 `MAX_REINDEX_ATTEMPTS`：一次 embedding 调用，不是视觉。 */
export const MAX_PERSON_VECTOR_ATTEMPTS = 3

/**
 * 批量入队。**幂等**——撞上 `person_vector_jobs_meme_id_key` 的静默跳过，
 * 导入时的自动入队和 `POST /admin/persons/reindex` 的手动补触发都靠这条。
 *
 * @returns 真正插进去的条数。为 0 说明那些图都已经在队列里了，不是错误。
 */
export async function enqueuePersonVectorJobs(
  memeIds: string[],
  db: Db = defaultDb,
): Promise<number> {
  if (memeIds.length === 0) return 0
  const rows = await db
    .insert(personVectorJobs)
    .values(memeIds.map((memeId) => ({ memeId })))
    .onConflictDoNothing({ target: personVectorJobs.memeId })
    .returning({ id: personVectorJobs.id })
  return rows.length
}

/**
 * 取一条待处理任务并置为 `running`。自带短事务，`FOR UPDATE SKIP LOCKED`。
 *
 * `attempts` 在取任务时就 +1，理由同 `claimReindexJob`：被 SIGKILL 的任务没人写失败，
 * 不在这里加会被无限重取。
 */
export async function claimPersonVectorJob(db: Db = defaultDb): Promise<PersonVectorJobRow | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(personVectorJobs)
      .where(
        and(
          eq(personVectorJobs.status, 'pending'),
          sql`${personVectorJobs.runAfter} <= now()`,
        ),
      )
      .orderBy(personVectorJobs.runAfter)
      .limit(1)
      .for('update', { skipLocked: true })

    const job = rows[0]
    if (job === undefined) return null

    const attempts = job.attempts + 1
    await tx
      .update(personVectorJobs)
      .set({ status: 'running', attempts, runAfter: new Date() })
      .where(eq(personVectorJobs.id, job.id))

    return { ...job, status: 'running', attempts }
  })
}

/**
 * 完成即**删行**，不留 done 记录。**「通道没配」和「算完了」共用它**——
 * 两者对队列的意义是同一个：这件事不再排着了。
 *
 * 删行而不是留 done 是正确性：`meme_id` 上有唯一索引，留一条终态会让这张图在
 * **下一次**换口径或手动补跑时入不了队（`onConflictDoNothing` 静默跳过），
 * 表现是「重算跑完了，但有一批图的向量还是旧口径的」——不报错。
 *
 * 进度不依赖这些行：`total` / `done` 从 `meme_subjects` 真实计数算出来（§6.7.5）。
 */
export async function markPersonVectorJobDone(
  claim: PersonVectorJobClaim,
  db: Db = defaultDb,
): Promise<boolean> {
  const rows = await db
    .delete(personVectorJobs)
    .where(claimedWhere(claim))
    .returning({ id: personVectorJobs.id })
  return rows.length > 0
}

export async function markPersonVectorJobRetry(
  claim: PersonVectorJobClaim,
  runAfter: Date,
  lastError: string,
  db: Db = defaultDb,
): Promise<boolean> {
  const rows = await db
    .update(personVectorJobs)
    .set({ status: 'pending', runAfter, lastError })
    .where(claimedWhere(claim))
    .returning({ id: personVectorJobs.id })
  return rows.length > 0
}

/**
 * 停机时把**本进程正在跑**的任务放回 `pending`。理由与 `releaseRunningReindexJobs`
 * 逐字相同：10 秒的 `stop_grace_period` 等不完一次 embedding 调用，
 * 等下去只会被 SIGKILL，任务永远停在 `running`。
 */
export async function releaseRunningPersonVectorJobs(
  ids: string[],
  reason: string,
  db: Db = defaultDb,
): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db
    .update(personVectorJobs)
    .set({ status: 'pending', runAfter: new Date(), lastError: reason })
    .where(and(inArray(personVectorJobs.id, ids), eq(personVectorJobs.status, 'running')))
    .returning({ id: personVectorJobs.id })
  return rows.length
}

/**
 * 终局失败。**失败的行留在表里**——它们是 `GET /admin/persons/reindex/status` 的
 * `failed`，`stale` 长时间不降就是出了问题，管理员得能看见。
 */
export async function markPersonVectorJobFailed(
  claim: PersonVectorJobClaim,
  lastError: string,
  db: Db = defaultDb,
): Promise<boolean> {
  const rows = await db
    .update(personVectorJobs)
    .set({ status: 'failed', lastError })
    .where(claimedWhere(claim))
    .returning({ id: personVectorJobs.id })
  return rows.length > 0
}

/**
 * 清掉上一轮遗留的 failed 行。**只在换口径重算时调用**（`PUT /config/image-embed`
 * 带 `confirmReindex`）。
 *
 * ⚠️ **这个函数是必需的，不是清理洁癖。** `meme_id` 上的唯一索引让「已有一条
 *    failed 行」的图在 `onConflictDoNothing` 下**入不了队**——不清的话，换口径重算
 *    会把上一轮失败的那些图整批漏掉，而进度条照样走完、`stale` 照样是 0
 *    （`stale` 按 `meme_subjects` 算，那些图的行还带着旧口径的向量……恰好也不 stale）。
 *    表现是永远差一批图，没有任何地方出声。
 *
 * 不在 `POST /admin/persons/reindex` 里调：那是同一轮的手动补触发，把 failed 清了
 * 等于把「有 12 条重试耗尽了」这个事实抹掉，而那正是管理员要看的东西。
 */
export async function clearFailedPersonVectorJobs(db: Db = defaultDb): Promise<number> {
  const rows = await db
    .delete(personVectorJobs)
    .where(eq(personVectorJobs.status, 'failed'))
    .returning({ id: personVectorJobs.id })
  return rows.length
}

/**
 * 把卡在 `running` 的任务放回队列。进程启动时调一次，理由同
 * `requeueStaleRunningReindexJobs`：SIGKILL 之后任务永远停在 `running`，
 * 表现是「补算进度卡住不动」，不报错、不告警。
 */
export async function requeueStaleRunningPersonVectorJobs(
  staleMs: number,
  db: Db = defaultDb,
): Promise<number> {
  const rows = await db
    .update(personVectorJobs)
    .set({ status: 'pending', lastError: 'worker 异常退出，任务被回收' })
    .where(
      and(
        eq(personVectorJobs.status, 'running'),
        lt(personVectorJobs.runAfter, new Date(Date.now() - staleMs)),
      ),
    )
    .returning({ id: personVectorJobs.id })
  return rows.length
}

export type PersonVectorQueueCounts = { queued: number; failed: number }

/**
 * 队列自己的两个数：**在队列里排着的**和**重试耗尽的**。
 *
 * ⚠️ 与 `GET /admin/persons/reindex/status` 的 `stale` 不是一回事，理由与
 *    `countReindexJobs` 那条注释逐字相同：`stale` 是「向量过期、该重算的条数」，
 *    来自 `meme_subjects`；手动触发之前它就已经大于 0，而 `queued` 还是 0。
 *
 * count 在这里可以——它只在管理员看进度时被调用，不落在任何用户请求上。
 */
export async function countPersonVectorJobs(db: Db = defaultDb): Promise<PersonVectorQueueCounts> {
  const [row] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${personVectorJobs.status} in ('pending','running'))::int`,
      failed: sql<number>`count(*) filter (where ${personVectorJobs.status} = 'failed')::int`,
    })
    .from(personVectorJobs)
  return { queued: row?.queued ?? 0, failed: row?.failed ?? 0 }
}
