import { isVisionConfigured } from '../ai/vision.js'
import { loadRuntimeConfig } from '../data/runtime-config.js'
import {
  claimOf,
  claimTagJob,
  deferTagJob,
  markTagJobDone,
  markTagJobFailed,
  markTagJobRetry,
  releaseRunningTagJobs,
  requeueStaleRunningJobs,
  type TagJobClaim,
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
 *
 * ⚠️ **这个数不许暴露成运行参数**（SPEC §5.6 / §9.26）：它和 `JOB_TIMEOUT_MS`
 *    是同一个判断的两半，可独立调节就会有人调反，表现正是上面那句「同一张图付两次钱」。
 */
const STALE_RUNNING_MS = JOB_TIMEOUT_MS * 4

/**
 * 僵死任务的扫描间隔。**本函数从「启动时扫一次」改成周期性扫描的全部落点。**
 *
 * 启动时那一次不够：进程被 OOM 或强杀后如果几秒内就重启，在途任务还没超过
 * `STALE_RUNNING_MS`，启动那一次一条都捞不到，之后再也没人扫它——一批图静默停在
 * 「打标中」，界面上也没有入口能把它们捞出来。
 *
 * 取 1 分钟的实测量级：判据是 6 分钟（`STALE_RUNNING_MS`），所以「被杀」到「被回收」
 * 落在 6–7 分钟之间。这个数**不是**「多久发现」，是「多久扫一遍」，调小只增加空查询。
 */
const STALE_SWEEP_INTERVAL_MS = 60_000

/**
 * 停机时留给在途任务的收尾时限。
 *
 * **必须短于 compose 的 `stop_grace_period`（默认 10 秒）**，否则超时之后 Docker 直接
 * SIGKILL，那些任务就永远停在 `running` 了——而「放回 `pending`」正是这一整套要保住的东西。
 * 取 4 秒：一个任务的自然耗时上限是 90 秒，所以**等它们跑完从来不是选项**，
 * 这个时限只是给「刚好快跑完」的那一两个留一点余地，减少白花的钱。
 */
export const SHUTDOWN_DRAIN_MS = 4_000

/**
 * 队列空时的轮询间隔。
 *
 * 短轮询而不是长 sleep：**worker 里不要有长 sleep**（queue.md §3），退避靠推后
 * `run_after`，不靠让消费槽干等着。2 秒的空转是一条索引命中的 select，代价可忽略。
 */
const IDLE_POLL_MS = 2_000

/** 没配视觉通道时的轮询间隔。这时候查得再勤也没用，但也不能彻底不查。 */
const UNCONFIGURED_POLL_MS = 60_000

/** 一个在途任务。`job` 留着是为了停机时能按领取标识把它放回去。 */
type InFlight = { promise: Promise<void>; job: TagJobRow; controller: AbortController }

type WorkerState = {
  stopping: boolean
  loop: Promise<void>
  inFlight: Map<string, InFlight>
  perUser: Map<string, number>
  wake: (() => void) | null
  sweepTimer: ReturnType<typeof setInterval> | null
  /** 停机信号。让卡在「等在途任务」上的 tick 立刻返回，否则 `await self.loop` 没有上界。 */
  stopSignal: Promise<void>
  signalStop: () => void
}

let state: WorkerState | null = null

export type TagWorkerOptions = {
  /**
   * 僵死扫描的间隔，只有测试会传。**不要去调生产里的默认值**——
   * 那个数写在 `STALE_SWEEP_INTERVAL_MS` 的注释里，理由也写在那儿。
   */
  sweepIntervalMs?: number
}

export function startTagWorker(options: TagWorkerOptions = {}): void {
  if (state !== null) return

  let signalStop: () => void = () => {}
  const stopSignal = new Promise<void>((resolve) => {
    signalStop = resolve
  })

  const self: WorkerState = {
    stopping: false,
    loop: Promise.resolve(),
    inFlight: new Map(),
    perUser: new Map(),
    wake: null,
    sweepTimer: null,
    stopSignal,
    signalStop,
  }
  state = self
  self.loop = runLoop(self)

  // 周期扫僵死任务。**独立于 tick 循环**：tick 可能正卡在 `Promise.race` 上等一个在途
  // 任务（最长 `JOB_TIMEOUT_MS` = 90 秒），挂在循环里的话扫描会被它一起推迟。
  // `unref` 不让它撑住进程退出——停机时也会显式清掉。
  self.sweepTimer = setInterval(() => {
    void sweepStale(self)
  }, options.sweepIntervalMs ?? STALE_SWEEP_INTERVAL_MS)
  self.sweepTimer.unref()

  // 这里记的是**默认值**，不是当前生效值——真正生效的要等第一轮 tick 查完库才知道，
  // 那时会把实际用的数记进日志。写死「已生效」会让人以为配置没被读到
  log.info(
    { defaultConcurrency: TAG_CONCURRENCY_DEFAULT, defaultPerUser: TAG_PER_USER_INFLIGHT_DEFAULT },
    '打标 worker 已启动',
  )
}

/**
 * 停止 worker：不再取新任务，先给在途任务一个收尾时限。
 *
 * **先等、到点放回 `pending`，不是无限等。** 等是为了「退出时不留半完成任务」——
 * 每个在途任务最后都要写一次 `tag_jobs`（done / pending / failed）。但等是有界的：
 * `drainMs` 到点之后，还没跑完的任务被**主动 abort 并放回 `pending`**，
 * 因为等下去的结果是被 Docker SIGKILL 强杀，那些任务反而永远停在 `running`。
 *
 * ⚠️ **被放回的图会重新调一次视觉模型，也就是同一张图付两次钱。** 这是已知代价：
 *    静默卡死（图上没有出口、日志里没有错误）比重复花钱严重得多。
 *
 * 真被 SIGKILL 砍掉、连这一步都没走到的那些，由周期性的 `requeueStaleRunningJobs` 兜底。
 */
export async function stopTagWorker(drainMs: number = SHUTDOWN_DRAIN_MS): Promise<void> {
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

  // 有界：tick 里那次「等在途任务」的 race 也挂了 `stopSignal`
  await self.loop
  await drain(self, drainMs)
}

async function drain(self: WorkerState, drainMs: number): Promise<void> {
  const pending = [...self.inFlight.values()]
  if (pending.length === 0) {
    log.info('打标 worker 已停止')
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
    log.info('打标 worker 已停止')
    return
  }

  // 到点还没跑完：掐掉在途的外部调用，把任务放回队列。
  // 掐掉是**省钱的**（那次视觉请求不会再回结果），但**不改变正确性**——
  // 就算它晚一步写回来，那些写入都带着领取标识，命不中已经是 pending 的行。
  const leftover = [...self.inFlight.values()]
  for (const entry of leftover) entry.controller.abort()
  const released = await releaseRunningTagJobs(leftover.map((entry) => entry.job.id))
  log.warn(
    { drainMs, inFlight: leftover.length, released },
    '停机收尾超时，在途任务已放回队列（这些图会重新调用一次模型）',
  )
}

/** 周期性地把僵死任务放回队列。异常只记日志，绝不让它打挂定时器。 */
async function sweepStale(self: WorkerState): Promise<void> {
  if (self.stopping) return
  try {
    const requeued = await requeueStaleRunningJobs(STALE_RUNNING_MS)
    if (requeued > 0) {
      log.warn({ requeued, staleMs: STALE_RUNNING_MS }, '回收了僵死的 running 任务')
    }
  } catch (error) {
    log.error({ err: error }, '回收僵死任务失败，下轮再试')
  }
}

async function runLoop(self: WorkerState): Promise<void> {
  // 启动时先扫一次：正常退出路径下这里永远是 0，非 0 说明上次是被砍死的，值得显眼
  await sweepStale(self)

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
    // 等任意一个跑完再来。这不是 sleep，是在等真实进度。
    // ⚠️ **必须一起等 `stopSignal`**：否则停机时 `await self.loop` 会一直卡在这个 race 上，
    //    要等到某个任务自然结束（最长 90 秒）才返回，收尾时限就形同虚设
    await Promise.race([...self.inFlight.values()].map((entry) => entry.promise).concat(self.stopSignal))
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

  const claim = await claimTagJob(busy)

  if (claim.kind === 'empty') {
    await idle(self, IDLE_POLL_MS)
    return
  }

  if (claim.kind === 'exhausted') {
    // 重领次数已耗尽（判据在 claimTagJob 里，行已经被落成 failed）。
    // 这里只负责把 `memes.tag_status` 对齐——**不能光改队列表**，那会留下
    // 「任务说失败、图说还在打标」的矛盾，而它不报错、只是让那张图永远显示在打标中。
    //
    // 不睡轮询间隔：队列里可能还有下一条同样的任务，让它立刻被处理。
    await finalizeTagFailure(claim.job.memeId, 'needs_manual')
    log.warn(
      { jobId: claim.job.id, memeId: claim.job.memeId, attempts: claim.job.attempts },
      '任务重领次数已达上限，落终局失败',
    )
    return
  }

  const job = claim.job
  const controller = new AbortController()

  self.perUser.set(job.userId, (self.perUser.get(job.userId) ?? 0) + 1)
  const promise = runJob(job, controller)
    // ⚠️ **`.catch` 不能省。** `finally` 不接拒绝，所以「`runJob` 的 catch 里那次写库
    //    又失败了」会变成 unhandledRejection，而 Node 22 默认**直接退出进程**——
    //    于是一次写库抖动就打挂整个 worker。这里记一条，任务留给周期扫描回收。
    .catch((error: unknown) => {
      log.error(
        { err: error, jobId: job.id, memeId: job.memeId },
        '打标任务收尾异常，任务可能停在 running，等周期扫描回收',
      )
    })
    .finally(() => {
      self.inFlight.delete(job.id)
      const left = (self.perUser.get(job.userId) ?? 1) - 1
      if (left <= 0) self.perUser.delete(job.userId)
      else self.perUser.set(job.userId, left)
    })
  self.inFlight.set(job.id, { promise, job, controller })
}

/**
 * 跑一条任务。
 *
 * `tagMeme` 承诺不抛，所以**唯一可能从这里逃出去的是写库失败**（`applyFailure` 里那次
 * `finalizeTagFailure` / `markTagJob*`）。调用方挂了 `.catch`，别把那条去掉。
 */
async function runJob(job: TagJobRow, controller: AbortController): Promise<void> {
  const claim = claimOf(job)
  const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS)

  try {
    // signal 负责掐掉在途的 fetch（`ai/provider.ts` 会把它和单次超时叠加）；
    // race 负责给**本函数的等待**封顶——抽帧那种 CPU 活儿不看 signal
    const outcome = await Promise.race([
      tagMeme(job.memeId, controller.signal),
      timeoutAfter(JOB_TIMEOUT_MS),
    ])

    if (outcome.kind === 'done') {
      await writeBack(claim, '完成', await markTagJobDone(claim))
      return
    }
    if (outcome.kind === 'gone') {
      // 图在排队期间被删了。任务判完成，不是失败——没什么可重试的
      await writeBack(claim, '图已删除', await markTagJobDone(claim))
      log.debug({ jobId: job.id, memeId: job.memeId }, '图已删除，任务跳过')
      return
    }
    if (outcome.kind === 'not_configured') {
      // 取任务和真正调用之间配置被清空了。**这次尝试不算数**
      await writeBack(
        claim,
        '未配置',
        await deferTagJob(
          claim,
          job.attempts - 1,
          new Date(Date.now() + UNCONFIGURED_POLL_MS),
          '视觉通道未配置',
        ),
      )
      return
    }

    if (outcome.kind === 'job_timeout') {
      // ⚠️ **超时之后那份工作还在后台跑**（race 只是不再等它）。主动掐掉，让它别再烧钱、
      //    也别再往下写。就算它晚一步写回来，带领取标识的写入也命不中已经被放回的行
      controller.abort()
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

/**
 * 迟到的写入会命中 0 行（任务已被放回 `pending`，或被别的进程重新领走）。
 *
 * 这不是错误，也不能当成成功：静默按成功处理的表现是「日志说完成了，库里还是 pending」。
 */
async function writeBack(claim: TagJobClaim, action: string, written: boolean): Promise<void> {
  if (written) return
  log.warn(
    { jobId: claim.id, attempts: claim.attempts, action },
    '任务已被放回队列或被别的进程领走，本次写入丢弃',
  )
}

/** 重试矩阵的落点。**判断在 `lib/retry-policy.ts`，这里只执行。** */
async function applyFailure(
  job: TagJobRow,
  failure: Parameters<typeof decideRetry>[0],
  detail: string,
): Promise<void> {
  const claim = claimOf(job)
  const decision = decideRetry(failure, job.attempts)
  const lastError = `${failure}: ${detail}`.slice(0, 500)

  if (decision.action === 'retry') {
    // 退避靠推后 run_after，不靠 sleep
    const written = await markTagJobRetry(claim, new Date(Date.now() + decision.delayMs), lastError)
    if (!written) {
      await writeBack(claim, '排入重试', false)
      return
    }
    log.info(
      { jobId: job.id, memeId: job.memeId, failure, attempts: job.attempts, delayMs: decision.delayMs },
      '打标失败，已排入重试',
    )
    return
  }

  // tagStatus 为 null 表示**不要动 tag_status**——embedding 失败不回滚打标
  //
  // ⚠️ 这里的顺序是「先写 memes、再写队列表」，和上面重试那一支不同（那边只有一个写入）。
  //    两次写入不装在同一个事务里，所以存在一个极短的窗口：`memes` 已经翻了
  //    `needs_manual`、而队列表那一行还没改。**这个窗口是自愈的**——任务还是 `running`，
  //    下一个领到它的进程会照常写出自己的结论；反过来（先改队列表）留下的窗口是
  //    「任务已终局、图还在打标中」，那需要一个外部动作才能对齐。
  if (decision.tagStatus !== null) {
    await finalizeTagFailure(job.memeId, decision.tagStatus)
  }
  const written = await markTagJobFailed(claim, lastError)
  if (!written) {
    await writeBack(claim, '落终局失败', false)
    return
  }
  log.warn(
    { jobId: job.id, memeId: job.memeId, failure, attempts: job.attempts, tagStatus: decision.tagStatus },
    '打标终局失败',
  )
}

/**
 * 整体超时那一支。**`kind` 必须和 `TagOutcome` 的取值都不同**——
 * 撞名的话下面 `outcome.kind === 'job_timeout'` 的分支永远走不到，`controller.abort()`
 * 静默失效，后台那份工作会一直烧到它自己结束。
 */
function timeoutAfter(
  ms: number,
): Promise<{ kind: 'job_timeout'; failure: 'unreachable'; detail: string }> {
  return new Promise((resolve) => {
    setTimeout(
      () => resolve({ kind: 'job_timeout', failure: 'unreachable', detail: `任务超过 ${ms}ms 整体超时` }),
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
