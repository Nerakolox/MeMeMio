import { isEmbedConfigured } from '../ai/embedder.js'
import {
  claimOfReindex,
  claimReindexJob,
  deferReindexJob,
  markReindexJobDone,
  markReindexJobFailed,
  markReindexJobRetry,
  releaseRunningReindexJobs,
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
 *    下面的并发数是**本进程**的在途数，不是全站的。
 *
 * ⚠️ 这里的 `CONCURRENCY` 与上面那个「每进程」是同一层意思，但它**不在 `runtime_config`
 *    里**，这是有意的（SPEC §9.26）：本次只放开了打标与导入两条线的四个数，重建索引并发
 *    没放。**别照着打标 worker 的样子顺手把它也搬进配置表**——那要先论证它为什么该放开。
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

/**
 * 僵死任务的扫描间隔。理由同 `queue/worker.ts` 的 `STALE_SWEEP_INTERVAL_MS`：
 * **只在启动时扫一次不够**，几秒内重启的话在途任务还没超阈值，之后再也没人扫它，
 * 表现是「重建进度卡住不动」，不报错。
 */
const STALE_SWEEP_INTERVAL_MS = 60_000

/**
 * 停机时留给在途任务的收尾时限。**必须短于 compose 的 `stop_grace_period`（默认 10 秒）**，
 * 否则超时后被 SIGKILL，那些行永远停在 `running`。同 `queue/worker.ts` 的 `SHUTDOWN_DRAIN_MS`。
 */
export const SHUTDOWN_DRAIN_MS = 4_000

/** 进程退出时把在途重算放回队列的理由。它会原样进 `last_error`。 */
const RELEASED_ON_SHUTDOWN = '进程退出，任务被放回队列'

/** 队列空时的轮询间隔。重建不是实时任务，查勤一点没有收益。 */
const IDLE_POLL_MS = 5_000

/** 没配 embedding 通道时的轮询间隔。这时候查得再勤也取不到能跑的任务。 */
const UNCONFIGURED_POLL_MS = 60_000

type InFlight = { promise: Promise<void>; job: ReindexJobRow }

type WorkerState = {
  stopping: boolean
  loop: Promise<void>
  inFlight: Map<string, InFlight>
  wake: (() => void) | null
  sweepTimer: ReturnType<typeof setInterval> | null
  /** 停机信号，理由同打标 worker：让卡在「等在途任务」上的 tick 立刻返回。 */
  stopSignal: Promise<void>
  signalStop: () => void
}

let state: WorkerState | null = null

export type ReindexWorkerOptions = {
  /** 僵死扫描的间隔，只有测试会传。理由见 `STALE_SWEEP_INTERVAL_MS`。 */
  sweepIntervalMs?: number
}

export function startReindexWorker(options: ReindexWorkerOptions = {}): void {
  if (state !== null) return

  let signalStop: () => void = () => {}
  const stopSignal = new Promise<void>((resolve) => {
    signalStop = resolve
  })

  const self: WorkerState = {
    stopping: false,
    loop: Promise.resolve(),
    inFlight: new Map(),
    wake: null,
    sweepTimer: null,
    stopSignal,
    signalStop,
  }
  state = self
  self.loop = runLoop(self)

  self.sweepTimer = setInterval(() => {
    void sweepStale(self)
  }, options.sweepIntervalMs ?? STALE_SWEEP_INTERVAL_MS)
  self.sweepTimer.unref()

  log.info({ concurrency: CONCURRENCY }, '重建索引 worker 已启动')
}

/** 停止：不再取新任务，给在途任务一个收尾时限，到点放回队列。理由同 `stopTagWorker`。 */
export async function stopReindexWorker(drainMs: number = SHUTDOWN_DRAIN_MS): Promise<void> {
  const self = state
  if (self === null) return
  state = null

  self.stopping = true
  self.wake?.()
  self.signalStop()
  if (self.sweepTimer !== null) {
    clearInterval(self.sweepTimer)
    self.sweepTimer = null
  }

  await self.loop

  const pending = [...self.inFlight.values()]
  if (pending.length === 0) {
    log.info('重建索引 worker 已停止')
    return
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), drainMs)
  })
  const settled = await Promise.race([
    Promise.allSettled(pending.map((entry) => entry.promise)).then(() => true),
    deadline,
  ])
  if (timer !== null) clearTimeout(timer)

  if (settled) {
    log.info('重建索引 worker 已停止')
    return
  }

  const leftover = [...self.inFlight.values()]
  const released = await releaseRunningReindexJobs(
    leftover.map((entry) => entry.job.id),
    RELEASED_ON_SHUTDOWN,
  )
  log.warn(
    { drainMs, inFlight: leftover.length, released },
    '停机收尾超时，在途重算已放回队列',
  )
}

/** 周期性地把僵死的重算任务放回队列。异常只记日志，绝不打挂定时器。 */
async function sweepStale(self: WorkerState): Promise<void> {
  if (self.stopping) return
  try {
    const requeued = await requeueStaleRunningReindexJobs(STALE_RUNNING_MS)
    if (requeued > 0) log.warn({ requeued, staleMs: STALE_RUNNING_MS }, '回收了僵死的 running 重算任务')
  } catch (error) {
    log.error({ err: error }, '回收僵死重算任务失败，下轮再试')
  }
}

async function runLoop(self: WorkerState): Promise<void> {
  await sweepStale(self)

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
    // ⚠️ 一起等 `stopSignal`，否则停机时这一轮会卡到某个任务自然结束（最长 30 秒）
    await Promise.race([...self.inFlight.values()].map((entry) => entry.promise).concat(self.stopSignal))
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

  const promise = runJob(job)
    // `.catch` 不能省，理由同 `queue/worker.ts`：finally 不接拒绝，
    // 而 Node 22 默认把未处理的拒绝变成进程退出
    .catch((error: unknown) => {
      log.error(
        { err: error, jobId: job.id, memeId: job.memeId },
        '重算任务收尾异常，行可能停在 running，等周期扫描回收',
      )
    })
    .finally(() => {
      self.inFlight.delete(job.id)
    })
  self.inFlight.set(job.id, { promise, job })
}

async function runJob(job: ReindexJobRow): Promise<void> {
  const claim = claimOfReindex(job)
  try {
    const outcome = await Promise.race([reindexMeme(job.memeId), timeoutAfter(JOB_TIMEOUT_MS)])

    if (outcome.kind === 'done' || outcome.kind === 'gone') {
      // ⚠️ **完成即删行**，不留 done 记录：`meme_id` 上有唯一索引，留着会让这张图
      //    在下一次换模型时静默入不了队（见 `markReindexJobDone` 的注释）
      await writeBack(claim, '完成', await markReindexJobDone(claim))
      return
    }

    if (outcome.kind === 'not_configured') {
      // 取任务和真正调用之间配置被清空了。**这次尝试不算数**——attempts 退回去，
      // 否则「配置暂时没配好」会在三轮空转之后把整批任务判成终局失败，
      // 而其实一次调用都没发生过
      await writeBack(
        claim,
        '未配置',
        await deferReindexJob(
          claim,
          job.attempts - 1,
          new Date(Date.now() + UNCONFIGURED_POLL_MS),
          'embedding 通道未配置',
        ),
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

/** 迟到的写入命中 0 行。同 `queue/worker.ts` 的同名函数，理由写在那儿。 */
async function writeBack(
  claim: { id: string; attempts: number },
  action: string,
  written: boolean,
): Promise<void> {
  if (written) return
  log.warn(
    { jobId: claim.id, attempts: claim.attempts, action },
    '重算任务已被放回队列或被别的进程领走，本次写入丢弃',
  )
}

/**
 * 退避重试或终局失败。
 *
 * 退避靠推后 `run_after`，**不靠 sleep**（queue.md §3）——sleep 会占着一个消费槽
 * 什么都不干。退避曲线复用打标那条 `backoffMs`：两边的失败原因都是「外部服务
 * 这会儿不行」，没有理由各写一条。
 */
async function applyFailure(job: ReindexJobRow, detail: string): Promise<void> {
  const claim = claimOfReindex(job)
  const lastError = detail.slice(0, 500)

  if (job.attempts < MAX_REINDEX_ATTEMPTS) {
    const written = await markReindexJobRetry(claim, new Date(Date.now() + backoffMs(job.attempts)), lastError)
    if (!written) {
      await writeBack(claim, '排入重试', false)
      return
    }
    log.info({ jobId: job.id, memeId: job.memeId, attempts: job.attempts }, '重算失败，已排入重试')
    return
  }

  // 终局：行留在表里当 `failed`。**不动 memes**——这张图的旧向量还在，
  // 搜索仍然能召回它，只是用的是旧模型的向量。删掉向量会让它彻底搜不到，更糟
  const written = await markReindexJobFailed(claim, lastError)
  if (!written) {
    await writeBack(claim, '落终局失败', false)
    return
  }
  log.warn({ jobId: job.id, memeId: job.memeId, attempts: job.attempts }, '重算终局失败')
}

/** `kind` 与 `ReindexOutcome` 的取值都不撞名，同 `queue/worker.ts` 的同名函数。 */
function timeoutAfter(ms: number): Promise<{ kind: 'job_timeout'; detail: string }> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ kind: 'job_timeout', detail: `任务超过 ${ms}ms 整体超时` }), ms).unref()
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
