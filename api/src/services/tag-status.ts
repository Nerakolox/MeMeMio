import { isVisionConfigured, resolveVisionConfig } from '../ai/vision.js'
import { countMemesByTagStatus, type TagStatusCounts } from '../data/memes.js'
import { countFailedTagJobsByReason, countRunningTagJobs } from '../data/tag-jobs.js'
import { TAG_JOB_FAILURES, type TagJobFailure } from '../lib/retry-policy.js'

/**
 * `GET /memes/tag-status` 的编排（SPEC §6.6.1）。
 *
 * 这一层只做三件事：定口径（算谁的范围）、把失败前缀折成契约里的五个类别、
 * 并发取数。权限判断在路由，SQL 在 `data/`（project-structure.md）。
 *
 * **它不回答「该怎么办」。** `needs_manual` 的图现在能重跑了，但动作在
 * `POST /memes/retag`（§6.4.3，`filter.tagStatus` 指到 `needs_manual` 就是「重试这批」）。
 * 这里多一个「重试」的口子就是同一个语义的第二条实现——§6.6.2 明令禁止。
 *
 * 换句话说本接口是**只读的**：它给出计数，客户端拿计数去画进度、去决定要不要调 retag。
 */

/** `mine` = 调用者自己的图；`all` = 全站，仅管理员可用（权限在路由判）。 */
export type TagStatusScope = 'mine' | 'all'

/** `failures[].reason` 只有这个类别集合，中文文案由客户端映射（SPEC §6.6.1）。 */
export type TagFailureCount = { reason: TagJobFailure; count: number }

export type TagStatusSummary = {
  scope: TagStatusScope
  visionConfigured: boolean
  counts: TagStatusCounts
  running: number
  failures: TagFailureCount[]
}

/**
 * @param actorId **即使 `scope=all` 也要传**。它只用来定 `mine` 的归属，
 *                不是权限判断——权限在路由，数据层不重复做授权。
 */
export async function getTagStatusSummary(
  scope: TagStatusScope,
  actorId: string,
): Promise<TagStatusSummary> {
  // 全站口径传 null 给数据层。**这个 null 不是「没登录」**——到得了这里的请求
  // 一定已经过了路由的登录与角色检查，参数名按语义取 `uploaderId` 就是为了不混淆。
  const uploaderId = scope === 'mine' ? actorId : null

  const [counts, running, groups, visionConfigured] = await Promise.all([
    countMemesByTagStatus(uploaderId),
    countRunningTagJobs(uploaderId),
    countFailedTagJobsByReason(uploaderId),
    // `mine` 走完整解析（含部署方默认兜底），`all` 走全站存在性判断——
    // 后者正是 worker 决定「值不值得取任务」用的那一个，两处必须同口径（SPEC §6.6.1）。
    scope === 'mine' ? isVisionResolvedFor(actorId) : isVisionConfigured(),
  ])

  // 折进契约的五个类别。**表里出现第六种前缀时它会被丢掉，而不是原样返回**：
  // 类别是契约、诊断串不是（§6.6.1 不返回 `last_error` 原文是同一条理由），
  // 而且前端对未知类别没有文案可写。
  const byReason = new Map<string, number>(
    groups.map((group): [string, number] => [group.reason, group.count]),
  )
  const failures: TagFailureCount[] = TAG_JOB_FAILURES
    .map((reason) => ({ reason, count: byReason.get(reason) ?? 0 }))
    // 0 条的不列出来：契约要的是「失败分布」，不是五个类别各占一行
    .filter((entry) => entry.count > 0)
    // 降序。条数相同时保持上面那个固定顺序，结果稳定（数组长度固定，Array#sort 是稳定的）
    .sort((a, b) => b.count - a.count)

  // 三个数分别来自 memes / tag_jobs 的两张表，**不追求同一快照**：契约本身就写明
  // `sum(failures)` 与 `counts.needsManual` 不必相等（embed_failed 的图 tag_status 是 ok）。
  return { scope, visionConfigured, counts, running, failures }
}

/** 本人的通道是否可用。**只在这里调 `resolveVisionConfig`**，路由不碰 env、不碰库。 */
async function isVisionResolvedFor(userId: string): Promise<boolean> {
  return (await resolveVisionConfig(userId)) !== null
}
