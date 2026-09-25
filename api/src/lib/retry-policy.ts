/**
 * 打标任务的重试矩阵。**纯函数、零 import**（project-structure.md）。
 *
 * 规则来自 agents/rules/queue.md §3 与 SPEC §2.4，一条都不能少：
 *
 * | 失败 | 处理 |
 * |---|---|
 * | `AI_UNREACHABLE`    | 指数退避重试，上限 5 次，之后 `needs_manual` |
 * | `AI_REFUSED`        | **不重试主通道**（内容策略拒绝是确定性的） |
 * | `AI_INVALID_OUTPUT` | 主通道重试 1 次，仍失败按 `AI_REFUSED` 处理 |
 * | `AI_UNSUPPORTED`    | **不重试**，标记失败并提示用户检查配置 |
 *
 * 退避靠更新 `run_after`，**worker 里不许有长 sleep**——那会占着一个消费槽什么都不干。
 * 这个文件只算「隔多久、还是不再试了」，真正的推后动作在 `data/tag-jobs.ts`。
 */

/**
 * 一次打标尝试的失败原因。**运行时也导出**，因为它是契约里的一份清单：
 * `GET /memes/tag-status` 的 `failures[].reason` 只允许这五个取值（SPEC §6.6.1），
 * 归类时按这个数组读，两端不会各自维护一份枚举。
 *
 * `embed_failed` 不是打标失败：打标已经成功写库了，只是向量没算出来。
 * 它单独成一支是因为 **embedding 失败不回滚打标**（SPEC §5.2.3 / 本任务验收）——
 * 那张图此时已经能被 OCR/trgm 搜到，退回 `pending` 反而让它连文字都搜不到。
 */
export const TAG_JOB_FAILURES = [
  'unreachable',
  'refused',
  'invalid_output',
  'unsupported',
  'embed_failed',
] as const

export type TagJobFailure = (typeof TAG_JOB_FAILURES)[number]

/** `AI_UNREACHABLE` 的重试上限。queue.md §3 写死 5 次。 */
export const MAX_UNREACHABLE_ATTEMPTS = 5

/** `AI_INVALID_OUTPUT` 只重试主通道 1 次，也就是总共尝试 2 次。 */
export const MAX_INVALID_OUTPUT_ATTEMPTS = 2

/** embedding 单独重试的上限。它不影响 `tag_status`，只影响向量什么时候补上。 */
export const MAX_EMBED_ATTEMPTS = 5

/**
 * 一个打标任务**最多能被领取几次**。到点还在 `pending` 的直接落终局失败，
 * 不再交给 worker 跑（落点：`data/tag-jobs.ts` 的 `claimTagJob`）。
 *
 * 取所有失败类型里**最宽**的那份预算（`unreachable` / `embed_failed` 都是 5）。
 * 一条被反复领取却一次都没写出结论的任务（典型是每次领取都把进程打崩，或者
 * 每次都被停机掐掉）**没有 `last_error` 可看**，它属于哪一类失败无从判断——
 * 比这个数更紧的失败类型早就该在 `decideRetry` 里终局了，不可能还留在 `pending`。
 *
 * ⚠️ 这条防的是**无限重领**：`claimTagJob` 每次领取都把 `attempts` +1，而一个每次
 *    都把进程打崩的任务永远走不到 `applyFailure`，`decideRetry` 根本没机会运行。
 *    表现是「队列里有一条任务，进程一轮到它就重启」，不报错。
 */
export const MAX_TAG_CLAIMS = MAX_UNREACHABLE_ATTEMPTS

/** 第一次退避 30s，之后翻倍。上限 30 分钟——再久就该人来看一眼了。 */
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 30 * 60_000

/**
 * 非法输出的重试**几乎不退避**：它不是「等一会儿就好」的故障，
 * 而是「同一个提示词再问一次，模型这次可能把话说完」。等 30s 没有意义。
 */
export const INVALID_OUTPUT_RETRY_MS = 2_000

export type RetryDecision =
  /** 回队列，`delayMs` 之后再取。 */
  | { action: 'retry'; delayMs: number }
  /**
   * 终局。`tagStatus` 为 null 表示**不要动 `tag_status`**——
   * embedding 失败走的就是这一支，打标结果必须原样留在库里。
   */
  | { action: 'fail'; tagStatus: 'needs_manual' | null }

/** 指数退避，封顶。`attempts` 是**包含本次在内**的已尝试次数。 */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS)
}

/**
 * @param attempts 包含本次在内的已尝试次数（取任务时就 +1，崩溃也算一次）
 *
 * ⚠️ **本任务只有部署方默认通道**，没有副通道可降。所以 `refused` 的终局是
 *    `needs_manual` 而不是「走副通道」——副通道的敏感内容降级语义在 SPEC §9.5 还是
 *    `proposed`，本任务明确不实现（任务 2026-09-16-tag-queue「明确不做」）。
 *    接入点留在 `services/tagging.ts` 的降级链上，不在这里。
 */
export function decideRetry(failure: TagJobFailure, attempts: number): RetryDecision {
  switch (failure) {
    case 'unreachable':
      // 网络问题换个供应商也没用，而且会白花副通道的钱（ai-providers.md §4）：回队列重跑
      return attempts < MAX_UNREACHABLE_ATTEMPTS
        ? { action: 'retry', delayMs: backoffMs(attempts) }
        : { action: 'fail', tagStatus: 'needs_manual' }

    case 'invalid_output':
      // 重试 1 次；仍失败按 AI_REFUSED 处理，也就是不再重试主通道
      return attempts < MAX_INVALID_OUTPUT_ATTEMPTS
        ? { action: 'retry', delayMs: INVALID_OUTPUT_RETRY_MS }
        : { action: 'fail', tagStatus: 'needs_manual' }

    case 'refused':
      // 内容策略拒绝是确定性的，重试一百次也是拒绝，只会浪费用户的钱
      return { action: 'fail', tagStatus: 'needs_manual' }

    case 'unsupported':
      // 配置问题，要告诉用户去改配置，不是等它自己好
      return { action: 'fail', tagStatus: 'needs_manual' }

    case 'embed_failed':
      // 打标已经成功，tag_status 必须留在 ok。这里只决定向量什么时候再补
      return attempts < MAX_EMBED_ATTEMPTS
        ? { action: 'retry', delayMs: backoffMs(attempts) }
        : { action: 'fail', tagStatus: null }
  }
}
