import { isVisionConfigured } from '../ai/vision.js'
import { loadRuntimeConfig } from '../data/runtime-config.js'
import {
  claimTagJob,
  deferTagJob,
  markTagJobDone,
  markTagJobFailed,
  markTagJobRetry,
  requeueStaleRunningJobs,
  type TagJobRow,
} from '../data/tag-jobs.js'
import { FFMPEG_CONCURRENCY } from '../image/constants.js'
import { setFfmpegConcurrency } from '../image/probe.js'
import { decideRetry } from '../lib/retry-policy.js'
import { log } from '../logger.js'
import { finalizeTagFailure, tagMeme } from '../services/tagging.js'

/**
 * 打标队列的消费者。
 *
 * **这一层只负责调度**（project-structure.md）：取任务、控并发、算下次什么时候再来。
 * 一次打标具体怎么做在 `services/tagging.ts`，重试几次在 `lib/retry-policy.ts`，
 * SQL 在 `data/tag-jobs.ts`。这里一行业务判断都不该有。
 *
 * ⚠️ **不假设单副本**（queue.md §1）。首期只跑一个进程，但取任务靠
 *    `FOR UPDATE SKIP LOCKED`，多开几个进程同样正确。下面的并发计数是**本进程**的
 *    在途数，不是全局的——它控的是本进程别把连接池和 AI 账单打爆，不是分布式限流。
 *
 * ⚠️ **并发上限现在是运行期参数**（SPEC §5.6）：每轮 tick 开头现查一次库，改完不用重启
 *    进程。下面两个 `*_DEFAULT` 只是「没配过」时的回落值。**别为了「立即生效」去打断
 *    在途任务**——被砍掉的任务会永远停在 `running`，表现是「这几张图再也不会被打标」，
 *    不报错不告警（见 `stopTagWorker` 的注释、§6.5.5）。
 */

/**
 * 本进程同时跑几个任务。视觉调用是纯 IO 等待，但每个都在烧钱，不宜开大。
 *
 * ⚠️ **这只是一个默认值，不再是运行时用的值。** 实际上限来自 `runtime_config` 单行表
 *    （SPEC §5.6），`admin` 在设置页改完对新任务生效、不用重启。这里留着的理由是
 *    「没配过」要有行为（§5.6：空表是正常状态），以及保存时「等于默认值就落成 `NULL`」
 *    需要一个比对对象——**默认值只有这一处**，`services/runtime-config.ts` import 的是
 *    它本身，不是另抄的一份（任务 §陷阱四）。
 */
export const TAG_CONCURRENCY_DEFAULT = 2

/**
 * 每个用户同时最多几个在途任务。**同样是默认值**，理由见上。
 *
 * **这是 queue.md §4 的落点**：一个人导入一千张不该让别人刚传的一张排到后面。
 * 默认取 1 而不是 2：打标槽总共只有 2 个，取 2 等于没限制。**单用户库上这个默认值会把
 * 吞吐压成 1 条/次**（第二个槽空转）——这正是本参数需要可调的原因，见 SPEC §9.26。
 */
export const TAG_PER_USER_INFLIGHT_DEFAULT = 1

/**
 * 单个任务的**整体**超时，和单次调用超时（`ai/provider.ts`）叠加而不是替代。
 *
 * 一个任务里可能有三次调用（10 帧 → 4 帧 → 拼图），每次 15 秒，加上抽帧和
 * embedding，只靠单次超时兜不住。卡住的任务表现是「导入进度条不动」，
 * **没有任何错误信息**——整体超时是唯一能让它变成可见错误的机制（queue.md §5）。
 */
const JOB_TIMEOUT_MS = 90_000

/**
 * 回收卡在 running 的任务的判据。必须**明显大于** `JOB_TIMEOUT_MS`，
 * 否则会把正在跑的任务抢走，表现是同一张图被调用两次 AI。
 */
const STALE_RUNNING_MS = JOB_TIMEOUT_MS * 4

/**
 * 队列空时的轮询间隔。
 *
 * 短轮询而不是长 sleep：**worker 里不要有长 sleep**（queue.md §3），退避靠推后
 * `run_after`，不靠让消费槽干等着。2 秒的空转是一条索引命中的 select，代价可忽略。
 */
const IDLE_POLL_MS = 2_000

/** 没配视觉通道时的轮询间隔。这时候查得再勤也没用，但也不能彻底不查。 */
const UNCONFIGURED_POLL_MS = 60_000

type WorkerState = {
  stopping: boolean
  loop: Promise<void>
  inFlight: Map<string, Promise<void>>
  perUser: Map<string, number>
  wake: (() => void) | null
}

let state: WorkerState | null = null

export function startTagWorker(): void {
  if (state !== null) return

  const self: WorkerState = {
    stopping: false,
    loop: Promise.resolve(),
    inFlight: new Map(),
    perUser: new Map(),
    wake: null,
  }
  state = self
  self.loop = runLoop(self)
  // 这里记的是**默认值**，不是当前生效值——真正生效的要等第一轮 tick 查完库才知道，
  // 那时会把实际用的数记进日志。写死「已生效」会让人以为配置没被读到
  log.info(
    { defaultConcurrency: TAG_CONCURRENCY_DEFAULT, defaultPerUser: TAG_PER_USER_INFLIGHT_DEFAULT },
    '打标 worker 已启动',
  )
}

/**
 * 停止 worker：不再取新任务，**等在途任务跑完**。
 *
 * 等而不是砍，是为了「退出时不留半完成任务」：每个在途任务最后都要写一次
 * `tag_jobs`（done / pending / failed），砍掉的话它会永远停在 running。
 * 真被 SIGKILL 砍掉的那种由启动时的 `requeueStaleRunningJobs` 兜底。
 *
 * 在途任务本身有 `JOB_TIMEOUT_MS` 上限，所以这里的等待是有界的。
 */
export async function stopTagWorker(): Promise<void> {
  const self = state
  if (self === null) return
  state = null

  self.stopping = true
  self.wake?.()
  await self.loop
  await Promise.allSettled([...self.inFlight.values()])
  log.info('打标 worker 已停止')
}

async function runLoop(self: WorkerState): Promise<void> {
  try {
    const requeued = await requeueStaleRunningJobs(STALE_RUNNING_MS)
    // 正常退出路径下这里永远是 0。非 0 说明上次是被砍死的，值得在日志里显眼
    if (requeued > 0) log.warn({ requeued }, '回收了上次异常退出遗留的 running 任务')
  } catch (error) {
    log.error({ err: error }, '回收遗留任务失败，worker 继续启动')
  }

  while (!self.stopping) {
    try {
      await tick(self)
    } catch (error) {
      // 循环本身挂掉等于打标永久停摆，且没有任何报错。宁可记一条再接着转
      log.error({ err: error }, '打标循环异常，稍后重试')
      await idle(self, IDLE_POLL_MS)
    }
  }
}

async function tick(self: WorkerState): Promise<void> {
  // ⚠️ **运行参数必须在开头读，在下面那个 early return 之前。** 放到 `isVisionConfigured()`
  //    旁边的话，一轮已经卡在 `Promise.race` 上的 tick 仍按旧值判断，于是「调高并发」的
  //    生效延迟会变成**一个在途任务的自然耗时**（最长 `JOB_TIMEOUT_MS` = 90 秒）。
  //    现查库不缓存，读到的就是别的进程刚写的值——「改完不用重启」全靠这一条（§9.26）。
  const runtime = await loadRuntimeConfig()
  const tagConcurrency = runtime?.tagConcurrency ?? TAG_CONCURRENCY_DEFAULT
  const perUserInflight = runtime?.tagPerUserInflight ?? TAG_PER_USER_INFLIGHT_DEFAULT

  // ffmpeg 上限**必须在这里一起设**：打标那条路也过 ffmpeg（动图抽帧走
  // `probeMetadata` / `extractFrames`），不设的话只改导入会「打标这边调了没用」。
  // ⚠️ 上调时唤醒等待者在 `setFfmpegConcurrency` 内部做，见那个函数的注释
  setFfmpegConcurrency(runtime?.ffmpegConcurrency ?? FFMPEG_CONCURRENCY)

  if (self.inFlight.size >= tagConcurrency) {
    // 等任意一个跑完再来。这不是 sleep，是在等真实进度
    await Promise.race([...self.inFlight.values()])
    return
  }

  // AI_NOT_CONFIGURED：**不消费**，图留在 pending 等配置好后批量补打标（queue.md §3）。
  // 在取任务之前判断，免得白白 claim 一条又放回去。
  // ⚠️ 这是个**全局**判断：部署方配了 **或** 任何一个用户配了，都算「值得去取任务」
  //    （任务 E 项）。它现在要查一次库，所以只在这里问一次，取到任务之后按上传者逐条解析
  if (!(await isVisionConfigured())) {
    await idle(self, UNCONFIGURED_POLL_MS)
    return
  }

  const busy = [...self.perUser.entries()]
    .filter(([, count]) => count >= perUserInflight)
    .map(([userId]) => userId)

  const job = await claimTagJob(busy)
  if (job === null) {
    await idle(self, IDLE_POLL_MS)
    return
  }

  self.perUser.set(job.userId, (self.perUser.get(job.userId) ?? 0) + 1)
  const promise = runJob(job).finally(() => {
    self.inFlight.delete(job.id)
    const left = (self.perUser.get(job.userId) ?? 1) - 1
    if (left <= 0) self.perUser.delete(job.userId)
    else self.perUser.set(job.userId, left)
  })
  self.inFlight.set(job.id, promise)
}

async function runJob(job: TagJobRow): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS)

  try {
    // signal 负责掐掉在途的 fetch（`ai/provider.ts` 会把它和单次超时叠加）；
    // race 负责给**本函数的等待**封顶——抽帧那种 CPU 活儿不看 signal
    const outcome = await Promise.race([
      tagMeme(job.memeId, controller.signal),
      timeoutAfter(JOB_TIMEOUT_MS),
    ])

    if (outcome.kind === 'done') {
      await markTagJobDone(job.id)
      return
    }
    if (outcome.kind === 'gone') {
      // 图在排队期间被删了。任务判完成，不是失败——没什么可重试的
      await markTagJobDone(job.id)
      log.debug({ jobId: job.id, memeId: job.memeId }, '图已删除，任务跳过')
      return
    }
    if (outcome.kind === 'not_configured') {
      // 取任务和真正调用之间配置被清空了。**这次尝试不算数**
      await deferTagJob(
        job.id,
        job.attempts - 1,
        new Date(Date.now() + UNCONFIGURED_POLL_MS),
        '视觉通道未配置',
      )
      return
    }

    await applyFailure(job, outcome.failure, outcome.detail)
  } catch (error) {
    // 走到这里的是没预料到的异常（tagMeme 承诺不抛）。当成不可达处理：
    // 退避重试几次仍不行就转人工，而不是让这条任务永远停在 running
    log.error({ err: error, jobId: job.id, memeId: job.memeId }, '打标任务异常')
    await applyFailure(job, 'unreachable', '任务异常终止')
  } finally {
    clearTimeout(timer)
  }
}

/** 重试矩阵的落点。**判断在 `lib/retry-policy.ts`，这里只执行。** */
async function applyFailure(
  job: TagJobRow,
  failure: Parameters<typeof decideRetry>[0],
  detail: string,
): Promise<void> {
  const decision = decideRetry(failure, job.attempts)
  const lastError = `${failure}: ${detail}`.slice(0, 500)

  if (decision.action === 'retry') {
    // 退避靠推后 run_after，不靠 sleep
    await markTagJobRetry(job.id, new Date(Date.now() + decision.delayMs), lastError)
    log.info(
      { jobId: job.id, memeId: job.memeId, failure, attempts: job.attempts, delayMs: decision.delayMs },
      '打标失败，已排入重试',
    )
    return
  }

  // tagStatus 为 null 表示**不要动 tag_status**——embedding 失败不回滚打标
  if (decision.tagStatus !== null) {
    await finalizeTagFailure(job.memeId, decision.tagStatus)
  }
  await markTagJobFailed(job.id, lastError)
  log.warn(
    { jobId: job.id, memeId: job.memeId, failure, attempts: job.attempts, tagStatus: decision.tagStatus },
    '打标终局失败',
  )
}

function timeoutAfter(ms: number): Promise<{ kind: 'failed'; failure: 'unreachable'; detail: string }> {
  return new Promise((resolve) => {
    setTimeout(
      () => resolve({ kind: 'failed', failure: 'unreachable', detail: `任务超过 ${ms}ms 整体超时` }),
      ms,
    ).unref()
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
