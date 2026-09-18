import { isEmbedConfigured } from '../ai/embedder.js'
import {
  claimReindexJob,
  deferReindexJob,
  markReindexJobDone,
  markReindexJobFailed,
  markReindexJobRetry,
  requeueStaleRunningReindexJobs,
  MAX_REINDEX_ATTEMPTS,
  type ReindexJobRow,
} from '../data/reindex-jobs.js'
import { backoffMs } from '../lib/retry-policy.js'
import { log } from '../logger.js'
import { reindexMeme } from '../services/reindex.js'

/**
 * 重建索引队列的消费者（SPEC §6.5.4、queue.md §7）。
 *
 * 和打标 worker 是**两个独立的 worker**，不是一个 worker 两张表：
 *
 * - 重算**不按用户分组**。它是运维操作，不是谁的配额（任务 F 项），所以这里没有
 *   `perUser` 计数，也没有 `excludeUserIds`——`claimReindexJob` 连那个参数都没有。
 * - 重算**不调视觉**，一次只有一个 embedding 请求，比打标便宜得多，所以并发和
 *   超时都是另一套数。
 * - 失败的行**留在表里**，不做断点续传（queue.md §7）。管理员在
 *   `GET /admin/reindex/status` 的 `failed` 里看得见。
 *
 * ⚠️ 同样**不假设单副本**（queue.md §1）：取任务靠 `FOR UPDATE SKIP LOCKED`。
 *    下面的并发数是**本进程**的在途数。
 */

/**
 * 本进程同时跑几条重算。
 *
 * 比打标的 2 大一点：一次只有一个 embedding 请求，不抽帧、不拼图、不烧视觉的钱。
 * 但仍然是个**小上限**——全站重建可能有几万条，把 embedding 供应商打到限流的话，
 * 整轮重建会比慢慢跑还慢。
 */
const CONCURRENCY = 4

/** 单条重算的整体超时。一次 embedding 调用 15 秒封顶，留一倍余量给取文本和写库。 */
const JOB_TIMEOUT_MS = 30_000

/** 回收卡在 running 的判据。必须明显大于 `JOB_TIMEOUT_MS`，否则会把在跑的任务抢走。 */
const STALE_RUNNING_MS = JOB_TIMEOUT_MS * 4

/** 队列空时的轮询间隔。重建不是实时任务，查勤一点没有收益。 */
const IDLE_POLL_MS = 5_000

/** 没配 embedding 通道时的轮询间隔。这时候查得再勤也取不到能跑的任务。 */
const UNCONFIGURED_POLL_MS = 60_000

type WorkerState = {
  stopping: boolean
  loop: Promise<void>
  inFlight: Map<string, Promise<void>>
  wake: (() => void) | null
}

let state: WorkerState | null = null

export function startReindexWorker(): void {
  if (state !== null) return

  const self: WorkerState = {
    stopping: false,
    loop: Promise.resolve(),
    inFlight: new Map(),
    wake: null,
  }
  state = self
  self.loop = runLoop(self)
  log.info({ concurrency: CONCURRENCY }, '重建索引 worker 已启动')
}

/** 停止：不再取新任务，**等在途任务跑完**。理由同 `stopTagWorker`。 */
export async function stopReindexWorker(): Promise<void> {
  const self = state
  if (self === null) return
  state = null

  self.stopping = true
  self.wake?.()
  await self.loop
  await Promise.allSettled([...self.inFlight.values()])
  log.info('重建索引 worker 已停止')
}

async function runLoop(self: WorkerState): Promise<void> {
  try {
    const requeued = await requeueStaleRunningReindexJobs(STALE_RUNNING_MS)
    if (requeued > 0) log.warn({ requeued }, '回收了上次异常退出遗留的 running 重算任务')
  } catch (error) {
    log.error({ err: error }, '回收遗留重算任务失败，worker 继续启动')
  }

  while (!self.stopping) {
    try {
      await tick(self)
    } catch (error) {
      // 循环本身挂掉等于重建永久停摆，而表现只是「进度条不动」——没有任何报错
      log.error({ err: error }, '重建索引循环异常，稍后重试')
      await idle(self, IDLE_POLL_MS)
    }
  }
}

async function tick(self: WorkerState): Promise<void> {
  if (self.inFlight.size >= CONCURRENCY) {
    await Promise.race([...self.inFlight.values()])
    return
  }

  // 在取任务之前判断，免得白白 claim 一条又放回去（还会白烧一次 attempts）
  if (!(await isEmbedConfigured())) {
    await idle(self, UNCONFIGURED_POLL_MS)
    return
  }

  const job = await claimReindexJob()
  if (job === null) {
    await idle(self, IDLE_POLL_MS)
    return
  }

  const promise = runJob(job).finally(() => {
    self.inFlight.delete(job.id)
  })
  self.inFlight.set(job.id, promise)
}

async function runJob(job: ReindexJobRow): Promise<void> {
  try {
    const outcome = await Promise.race([reindexMeme(job.memeId), timeoutAfter(JOB_TIMEOUT_MS)])

    if (outcome.kind === 'done' || outcome.kind === 'gone') {
      // ⚠️ **完成即删行**，不留 done 记录：`meme_id` 上有唯一索引，留着会让这张图
      //    在下一次换模型时静默入不了队（见 `markReindexJobDone` 的注释）
      await markReindexJobDone(job.id)
      return
    }

    if (outcome.kind === 'not_configured') {
      // 取任务和真正调用之间配置被清空了。**这次尝试不算数**——attempts 退回去，
      // 否则「配置暂时没配好」会在三轮空转之后把整批任务判成终局失败，
      // 而其实一次调用都没发生过
      await deferReindexJob(
        job.id,
        job.attempts - 1,
        new Date(Date.now() + UNCONFIGURED_POLL_MS),
        'embedding 通道未配置',
      )
      return
    }

    await applyFailure(job, outcome.detail)
  } catch (error) {
    // reindexMeme 承诺不抛。走到这里是没预料到的异常，按可重试失败处理，
    // 而不是让任务永远停在 running
    log.error({ err: error, jobId: job.id, memeId: job.memeId }, '重算任务异常')
    await applyFailure(job, '任务异常终止')
  }
}

/**
 * 退避重试或终局失败。
 *
 * 退避靠推后 `run_after`，**不靠 sleep**（queue.md §3）——sleep 会占着一个消费槽
 * 什么都不干。退避曲线复用打标那条 `backoffMs`：两边的失败原因都是「外部服务
 * 这会儿不行」，没有理由各写一条。
 */
async function applyFailure(job: ReindexJobRow, detail: string): Promise<void> {
  const lastError = detail.slice(0, 500)

  if (job.attempts < MAX_REINDEX_ATTEMPTS) {
    await markReindexJobRetry(job.id, new Date(Date.now() + backoffMs(job.attempts)), lastError)
    log.info({ jobId: job.id, memeId: job.memeId, attempts: job.attempts }, '重算失败，已排入重试')
    return
  }

  // 终局：行留在表里当 `failed`。**不动 memes**——这张图的旧向量还在，
  // 搜索仍然能召回它，只是用的是旧模型的向量。删掉向量会让它彻底搜不到，更糟
  await markReindexJobFailed(job.id, lastError)
  log.warn({ jobId: job.id, memeId: job.memeId, attempts: job.attempts }, '重算终局失败')
}

function timeoutAfter(ms: number): Promise<{ kind: 'failed'; detail: string }> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ kind: 'failed', detail: `任务超过 ${ms}ms 整体超时` }), ms).unref()
  })
}

/** 可被 stop 打断的等待。停机时不用干等满一个轮询间隔。 */
function idle(self: WorkerState, ms: number): Promise<void> {
  if (self.stopping) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    timer.unref()
    self.wake = finish

    function finish(): void {
      clearTimeout(timer)
      self.wake = null
      resolve()
    }
  })
}
