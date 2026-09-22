import { resolveVisionConfig } from '../ai/vision.js'
import { db as defaultDb, type Db } from '../data/db.js'
import {
  assertCanMutate,
  findMemesForRetagByIds,
  listMemesForRetag,
  markTagStatusPending,
  type Actor,
  type RetagCandidate,
} from '../data/memes.js'
import { requeueTagJobsForRetag } from '../data/tag-jobs.js'
import { AppError } from '../lib/app-error.js'
import { log } from '../logger.js'

/**
 * `POST /memes/retag` 的编排（SPEC §6.4.3）。
 *
 * 这一层只做三件事：定候选、按策略筛掉不该重打的、分批入队。SQL 在 `data/`，
 * 权限判断**逐行走 `assertCanMutate`**（AGENTS.md §5：判断只在那一处，
 * 调用方不自行拼条件）。
 *
 * **它不是 `services/reindex.ts` 的兄弟，尽管形状像。** 三个差别都在钱上：
 *
 *   |              | 重建索引（§6.5.4） | 重打标（§6.4.3） |
 *   | 幂等         | 是                 | **否**——再点一次就是再花一遍全库 |
 *   | 花谁的       | 部署方的 embedding | **图片上传者的**视觉预算 |
 *   | 完成即删行   | 是（`reindex_jobs`）| 否（`tag_jobs` 留 done 行） |
 *
 * 第三行正是本文件必须新写一个队列助手的原因——`enqueueTagJob` 对已经打完的图
 * 是静默空操作（`data/tag-jobs.ts` 的 `requeueTagJobsForRetag` 顶上写了原因）。
 */

/**
 * 一次读多少条候选。取小了要翻很多页，取大了一次把几万个 uuid 拉进内存。
 * 1000 条 uuid 约 36 KB。同 `ai-config.ts` 的 `ENQUEUE_PAGE`。
 */
export const RETAG_PAGE = 1000

/**
 * 一条 INSERT / UPDATE 里塞多少行。
 *
 * 与 `RETAG_PAGE` 分开是有意的：前者是**读**的页大小，后者是**写**的语句大小，
 * 两者只是恰好取了同一个数。这个必须存在——postgres.js 在 65534 个绑定参数处
 * 硬抛 `MAX_PARAMETERS_EXCEEDED` 且**不自动分块**，所以「一条语句把十万行写进去」
 * 的表现是 500，不是「慢」。`ai-config.ts` 的 `ENQUEUE_CAP = 100_000` 只管
 * 「一次触发排多少条」，照抄它来当语句大小会在约 1.1 万行时炸。
 */
export const RETAG_BATCH = 1000

/**
 * 候选的两种来源，对应 SPEC §6.4.3 的两个请求体形状。**恰好一种。**
 *
 * `uploaderId` 为 null 表示不按上传者收窄——只有 admin 能走到这里，
 * 收窄是**路由**做的（非 admin 缺省收窄到自己），本层不做授权判断，
 * 只做逐行的 `assertCanMutate`。
 */
export type RetagInput =
  | { kind: 'ids'; memeIds: string[] }
  | { kind: 'filter'; uploaderId: string | null; tagStatus: string | null }

/**
 * 三个计数**都带 `Count` 后缀**（SPEC §6.5.3）：叫得像布尔的数字会让客户端写
 * `=== true`，静默判错。`skipped*` 两个字段存在的意义是让「一条都没排上」
 * 可解释——否则界面只能说「0 条」，而那有三种完全不同的成因。
 */
export type RetagResult = {
  /** **本次新排上**的条数（不含原本就已在 pending 的），见 `requeueTagJobsForRetag`。 */
  enqueuedCount: number
  /** 因为 `edited_by` 非空被跳过的。§6.4.3：机器输出不该冲掉人的工作。 */
  skippedEditedCount: number
  /** 因为**它自己上传者**没有可用视觉通道被跳过的。 */
  skippedUnconfiguredCount: number
}

export async function retagMemes(input: RetagInput, actor: Actor): Promise<RetagResult> {
  const candidates = await collectCandidates(input)

  /**
   * 筛这一趟要同时产出「要排的」和两个跳过计数，所以**不能在读的时候就过滤**。
   *
   * 顺序是有讲究的：**先归属，再 `edited_by`，最后通道。**
   * 归属必须排在最前，否则「非上传者传别人的 `memeIds`」在那些图上恰好
   * `edited_by` 非空时会变成「静默跳过 1 张」而不是 `FORBIDDEN`——**静默越权**。
   */
  const queue: { memeId: string; userId: string }[] = []
  let skippedEditedCount = 0
  let skippedUnconfiguredCount = 0

  /**
   * 按上传者缓存通道解析结果。**这是本文件最要紧的一处**（SPEC §6.4.3）。
   *
   * 不能用全局的 `isVisionConfigured()` 当闸门：那个函数回答的是「全站有没有
   * 任意一条通道」（`ai/vision.ts:74`），而配置是**按人**解析的。
   * 错的闸门在「A 配了、B 没配」时会排一批必然解析不出来的任务，表现是那些图
   * **永远停在 `pending`、每轮被重新认领、任何地方都不报错**——
   * 没有异常、没有失败计数，只有一个永远不动的进度。
   *
   * 缓存是安全的：一次请求里配置不会变，而重复解析同一个人的代价是一次多余查询。
   */
  const visionResolved = new Map<string, boolean>()
  async function hasVision(userId: string): Promise<boolean> {
    const cached = visionResolved.get(userId)
    if (cached !== undefined) return cached
    const ok = (await resolveVisionConfig(userId)) !== null
    visionResolved.set(userId, ok)
    return ok
  }

  for (const candidate of candidates) {
    // §3.3 硬边界：逐行走那一处判断，这里不自己拼条件
    assertCanMutate(candidate, actor, 'retag')

    if (candidate.editedBy !== null) {
      skippedEditedCount++
      continue
    }

    if (!(await hasVision(candidate.uploaderId))) {
      skippedUnconfiguredCount++
      continue
    }

    queue.push({ memeId: candidate.id, userId: candidate.uploaderId })
  }

  const enqueuedCount = await enqueueInBatches(queue)

  log.info(
    {
      actorId: actor.id,
      source: input.kind,
      candidates: candidates.length,
      enqueuedCount,
      skippedEditedCount,
      skippedUnconfiguredCount,
    },
    '重打标入队完成',
  )

  return { enqueuedCount, skippedEditedCount, skippedUnconfiguredCount }
}

// ── 候选 ───────────────────────────────────────────────────────────

/**
 * **先把候选全部读出来，再开始写**——这不是为了少开事务，是正确性。
 *
 * `filter.tagStatus` 合法可筛任意一个状态，而本接口**改的正是 `tag_status`**
 * （§6.4.3：入队即置回 `pending`）。边读边写的话，第一页处理完就有一批行
 * 不再满足 `tagStatus = ok`，于是第二页的 offset 已经错位——循环会提前结束，
 * **而且报的是成功**。库里的图全是旧提示词打的，`filter: { tagStatus: 'ok' }`
 * 恰恰是最自然的用法。
 *
 * 内存上是安全的：攒下来的只有「真的要排的」那些，每项两个 uuid。
 */
async function collectCandidates(input: RetagInput): Promise<RetagCandidate[]> {
  if (input.kind === 'ids') {
    // 客户端可能把同一个 id 传两遍。去重之后再比对，否则「查回来的比传进来的少」
    // 会把重复项误判成「有 id 不存在」，一个合法的请求变成 NOT_FOUND
    const wanted = new Set(input.memeIds)
    const rows = await findMemesForRetagByIds([...wanted], RETAG_BATCH)

    /**
     * ⚠️ **有 id 查不到就整条请求 `NOT_FOUND`，不静默跳过。**
     *
     * 「不存在」和「已被软删」在查询里是同一个结果（§3.4 的软删过滤），而两者
     * 对调用方是同一句话：「你手上那份列表过期了」。返回 `enqueuedCount: 3`
     * （本该 4）会让客户端把「少打了一张」读成成功——那正是本项目最怕的静默部分成功。
     * `memeIds` 是一份**显式的小清单**（不像 `filter` 可能选中全库），
     * 所以「整条失败、让客户端刷新列表再来」是付得起的。
     */
    if (rows.length !== wanted.size) {
      throw new AppError('NOT_FOUND', '有图片不存在或已被删除，请刷新列表后重试')
    }
    return rows
  }

  const out: RetagCandidate[] = []
  for (let offset = 0; ; offset += RETAG_PAGE) {
    const page = await listMemesForRetag(input, RETAG_PAGE, offset)
    out.push(...page)
    if (page.length < RETAG_PAGE) break
  }
  return out
}

// ── 写 ─────────────────────────────────────────────────────────────

/**
 * 分批入队 + 翻 `tag_status`。**每批一个事务**，两件事在同一个事务里
 * （queue.md §2：图片入库了但队列任务丢了这种交错不可能发生）。
 *
 * 一批一个事务、而不是一个大事务：整批十万行的话，锁和往返都堆在一次事务里，
 * 而**这个操作本来就不需要原子**——它没有「全成功或全失败」的语义，
 * 半途崩掉的结果是「排了一半」，再点一次会把剩下的补上（已排的变成 0 条，
 * 正好就是 `enqueuedCount` 的幂等口径）。回报的数是真的，不是猜的。
 *
 * 返回的是**新排上**的条数：原本就已在 `pending` 的行不算（见队列助手的注释），
 * 否则「连点两次、第二次 0 条」不成立，而客户端的进度基线正是拿它当的。
 */
async function enqueueInBatches(
  queue: { memeId: string; userId: string }[],
  db: Db = defaultDb,
): Promise<number> {
  let enqueuedCount = 0

  for (let start = 0; start < queue.length; start += RETAG_BATCH) {
    const batch = queue.slice(start, start + RETAG_BATCH)

    const newlyEnqueued = await db.transaction(async (tx) => {
      const { scheduledMemeIds, alreadyPendingCount } = await requeueTagJobsForRetag(batch, tx)
      // 翻的是 RETURNING 给的 id，**不是 batch 自己的 id 列表**：
      // 卡在 running 的行被 upsert 跳过了，翻它的图会让两个写入互相矛盾（§6.4.3）
      await markTagStatusPending(scheduledMemeIds, tx)
      return scheduledMemeIds.length - alreadyPendingCount
    })

    enqueuedCount += newlyEnqueued
  }

  return enqueuedCount
}
