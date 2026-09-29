import { isImageEmbedConfigured } from '../ai/image-embedder.js'
import {
  claimOfPersonVector,
  claimPersonVectorJob,
  markPersonVectorJobDone,
  markPersonVectorJobFailed,
  markPersonVectorJobRetry,
  releaseRunningPersonVectorJobs,
  requeueStaleRunningPersonVectorJobs,
  MAX_PERSON_VECTOR_ATTEMPTS,
  type PersonVectorJobRow,
} from '../data/person-vector-jobs.js'
import { backoffMs } from '../lib/retry-policy.js'
import { log } from '../logger.js'
import { computePersonVector } from '../services/person-vectors.js'

/**
 * 人物向量队列的消费者（SPEC §5.7.2 / §6.7.5、queue.md §7）。
 *
 * 第三个独立 worker，理由与「重算不挂在打标上」逐字相同（任务 §5「api 端」）：
 * 打标失败、没配视觉通道都不能连带人物。人物是附加能力，它自己的一条线。
 *
 * ## 与 `queue/reindex-worker.ts` 的三处差别，每一处都有理由
 *
 * 1. **单条更慢、更贵。** 一次调用要先把图从 R2 取回来、sharp 缩放，再送上游，
 *    而**每张图都是一次付费调用**（§6.7.5）。所以并发取 2（不是 4）、
 *    单条超时取 60 秒（不是 30）。
 * 2. **`not_configured` 完成即删，不推后重排。** 文本那边「没配通道」是个**暂时**
 *    状态，推后重排等管理员配好是省事的做法；这边一样是暂时状态，但等来的那一批
 *    是**一次性的大额扣费**——管理员配好通道的那一刻，几万条早就排着的任务会同时
 *    变得可跑。想补跑就由人显式点 `POST /admin/persons/reindex`，让它是一次有意识的动作。
 *    详细的取舍写在 `data/person-vector-jobs.ts` 的文件头。
 * 3. **失败不动 `memes.tag_status`。** 与重算一致，但这里更要说清：那张图只是暂时
 *    不属于任何人物，照样能被搜到、能被编辑。
 *
 * ⚠️ **不假设单副本**（queue.md §1）：取任务靠 `FOR UPDATE SKIP LOCKED`，
 *    下面的并发数是本进程的在途数。**分配**那一步的串行是另一件事，由
 *    `assignPersonVector` 里的 advisory 锁保证（`data/persons.ts`）。
 */

/**
 * 本进程同时跑几条。
 *
 * 比重算的 4 小：每条都要过一次对象存储 + 一次 sharp + 一次付费的图片编码，
 * 三条同时在途已经能把一张 2 核机器的带宽和 CPU 占满。**这个数不防限流，
 * 防的是本机**——上游限流由 `queue.md §3` 的退避处理。
 *
 * ⚠️ 它也**不在 `runtime_config` 里**（SPEC §9.26）：本次只放开了打标与导入
 *    两条线的四个数，重建索引并发都没放，这条更没有理由先放。
 */
const CONCURRENCY = 2

/** 单条的整体超时。取图 + 缩放 + 一次 embedding（15 秒封顶）+ 写库，留一倍余量。 */
const JOB_TIMEOUT_MS = 60_000

/** 回收卡在 running 的判据。必须明显大于 `JOB_TIMEOUT_MS`，否则会把在跑的任务抢走。 */
const STALE_RUNNING_MS = JOB_TIMEOUT_MS * 4

/**
 * 僵死任务的扫描间隔。理由同 `queue/worker.ts`：只在启动时扫一次不够，
 * 几秒内重启的话在途任务还没超阈值，之后再也没人扫它。
 */
const STALE_SWEEP_INTERVAL_MS = 60_000

/**
 * 停机时留给在途任务的收尾时限。**必须短于 compose 的 `stop_grace_period`**，
 * 否则超时后被 SIGKILL，那些行永远停在 `running`。同 `queue/worker.ts`。
 */
export const SHUTDOWN_DRAIN_MS = 4_000

/** 进程退出时把在途任务放回队列的理由。它会原样进 `last_error`。 */
const RELEASED_ON_SHUTDOWN = '进程退出，任务被放回队列'

/** 队列空时的轮询间隔。人物向量不是实时任务。 */
const IDLE_POLL_MS = 5_000

/** 没配图片向量通道时的轮询间隔。这时候查得再勤也取不到能跑的任务。 */
const UNCONFIGURED_POLL_MS = 60_000

type InFlight = { promise: Promise<void>; job: PersonVectorJobRow }

type WorkerState = {
  stopping: boolean
  loop: Promise<void>
  inFlight: Map<string, InFlight>
  wake: (() => void) | null
  sweepTimer: ReturnType<typeof setInterval> | null
  stopSignal: Promise<void>
  signalStop: () => void
}

let state: WorkerState | null = null

export type PersonVectorWorkerOptions = {
  /** 僵死扫描的间隔，只有测试会传。理由见 `STALE_SWEEP_INTERVAL_MS`。 */
  sweepIntervalMs?: number
}

export function startPersonVectorWorker(options: PersonVectorWorkerOptions = {}): void {
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

  log.info({ concurrency: CONCURRENCY }, '人物向量 worker 已启动')
}

/** 停止：不再取新任务，给在途任务一个收尾时限，到点放回队列。同 `stopReindexWorker`。 */
export async function stopPersonVectorWorker(drainMs: number = SHUTDOWN_DRAIN_MS): Promise<void> {
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
    log.info('人物向量 worker 已停止')
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
    log.info('人物向量 worker 已停止')
    return
  }

  const leftover = [...self.inFlight.values()]
  const released = await releaseRunningPersonVectorJobs(
    leftover.map((entry) => entry.job.id),
    RELEASED_ON_SHUTDOWN,
  )
  log.warn(
    { drainMs, inFlight: leftover.length, released },
    '停机收尾超时，在途人物向量任务已放回队列',
  )
}

/** 周期性地把僵死的任务放回队列。异常只记日志，绝不打挂定时器。 */
async function sweepStale(self: WorkerState): Promise<void> {
  if (self.stopping) return
  try {
    const requeued = await requeueStaleRunningPersonVectorJobs(STALE_RUNNING_MS)
    if (requeued > 0) {
      log.warn({ requeued, staleMs: STALE_RUNNING_MS }, '回收了僵死的 running 人物向量任务')
    }
  } catch (error) {
    log.error({ err: error }, '回收僵死人物向量任务失败，下轮再试')
  }
}

async function runLoop(self: WorkerState): Promise<void> {
  await sweepStale(self)

  while (!self.stopping) {
    try {
      await tick(self)
    } catch (error) {
      // 循环本身挂掉等于人物向量永久停摆，而表现只是「进度条不动」——没有任何报错
      log.error({ err: error }, '人物向量循环异常，稍后重试')
      await idle(self, IDLE_POLL_MS)
    }
  }
}

async function tick(self: WorkerState): Promise<void> {
  if (self.inFlight.size >= CONCURRENCY) {
    await Promise.race(
      [...self.inFlight.values()].map((entry) => entry.promise).concat(self.stopSignal),
    )
    return
  }

  /*
   * ⚠️ **在取任务之前判断，而且这一步是必需的，不是优化。**
   *
   * 这里与重算 worker 有一个后果上的差别：那边的 `not_configured` 只是推后重排，
   * 抢一条回来最多浪费一次 attempts；这边 `not_configured` 是**完成即删**，
   * 所以「没配通道时把整个队列一条条领走删掉」会真的发生。管理员临时清空配置
   * 再填回来（改 key、换中转），排着的几万条就会在这一分钟里被静默清空。
   */
  if (!(await isImageEmbedConfigured())) {
    await idle(self, UNCONFIGURED_POLL_MS)
    return
  }

  const job = await claimPersonVectorJob()
  if (job === null) {
    await idle(self, IDLE_POLL_MS)
    return
  }

  const controller = new AbortController()
  const promise = runJob(job, controller)
    // `.catch` 不能省：finally 不接拒绝，而 Node 22 默认把未处理的拒绝变成进程退出
    .catch((error: unknown) => {
      log.error(
        { err: error, jobId: job.id, memeId: job.memeId },
        '人物向量任务收尾异常，行可能停在 running，等周期扫描回收',
      )
    })
    .finally(() => {
      self.inFlight.delete(job.id)
    })
  self.inFlight.set(job.id, { promise, job })
}

async function runJob(job: PersonVectorJobRow, controller: AbortController): Promise<void> {
  const claim = claimOfPersonVector(job)
  try {
    /*
     * 超时同时**断开在途的那次付费调用**：`timeoutAfter` 只让竞速返回，
     * 上游的请求还在烧钱，而它算出来的结果已经没人要了（`computePersonVector`
     * 把 signal 透传给 `embedImage`）。重算 worker 没有这一手是因为那边一次调用
     * 便宜得多，且不读图——不是为了「保持一致」才不做的。
     */
    const outcome = await Promise.race([
      computePersonVector(job.memeId, controller.signal),
      timeoutAfter(JOB_TIMEOUT_MS, controller),
    ])

    if (outcome.kind === 'done' || outcome.kind === 'gone') {
      // 完成即删行，理由同 `markPersonVectorJobDone`：`meme_id` 上的唯一索引
      await writeBack(claim, '完成', await markPersonVectorJobDone(claim))
      return
    }

    if (outcome.kind === 'not_configured') {
      /*
       * 走到这里只有一种可能：领任务和真正调用之间配置被清掉了（取任务之前已经
       * 判过一次）。**判完成而不是重试**——理由见文件头第 2 条。这里留一条 info：
       * 它是「队列里少了任务但没人算过」的唯一痕迹，而这条路径本身是罕见的。
       */
      const written = await markPersonVectorJobDone(claim)
      if (written) {
        log.info({ jobId: job.id, memeId: job.memeId }, '领到任务时图片向量通道已不可用，任务出队')
      }
      return
    }

    await applyFailure(job, outcome.detail)
  } catch (error) {
    // computePersonVector 承诺不抛。走到这里是没预料到的异常，按可重试失败处理，
    // 而不是让任务永远停在 running
    log.error({ err: error, jobId: job.id, memeId: job.memeId }, '人物向量任务异常')
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
    '人物向量任务已被放回队列或被别的进程领走，本次写入丢弃',
  )
}

/**
 * 退避重试或终局失败。退避曲线复用打标那条 `backoffMs`：三边的失败原因都是
 * 「外部服务这会儿不行」。
 *
 * ⚠️ 与 `attributes` 无关地，这里**永远不碰 `memes`**：终局失败只记在这一行，
 *    那张图的 `tag_status` 不动（§5.7.2）。
 */
async function applyFailure(job: PersonVectorJobRow, detail: string): Promise<void> {
  const claim = claimOfPersonVector(job)
  const lastError = detail.slice(0, 500)

  if (job.attempts < MAX_PERSON_VECTOR_ATTEMPTS) {
    const written = await markPersonVectorJobRetry(
      claim,
      new Date(Date.now() + backoffMs(job.attempts)),
      lastError,
    )
    if (!written) {
      await writeBack(claim, '排入重试', false)
      return
    }
    log.info({ jobId: job.id, memeId: job.memeId, attempts: job.attempts }, '人物向量失败，已排入重试')
    return
  }

  // 终局：行留在表里当 `failed`，由 `GET /admin/persons/reindex/status` 显示
  const written = await markPersonVectorJobFailed(claim, lastError)
  if (!written) {
    await writeBack(claim, '落终局失败', false)
    return
  }
  log.warn({ jobId: job.id, memeId: job.memeId, attempts: job.attempts }, '人物向量终局失败')
}

/** `kind` 与 `PersonVectorOutcome` 的取值都不撞名，同 `queue/worker.ts` 的同名函数。 */
function timeoutAfter(ms: number, controller: AbortController): Promise<{ kind: 'job_timeout'; detail: string }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      controller.abort()
      resolve({ kind: 'job_timeout', detail: `任务超过 ${ms}ms 整体超时` })
    }, ms).unref()
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
