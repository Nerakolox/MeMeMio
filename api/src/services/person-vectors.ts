import { embedImage, personEmbedModelKey, resolveImageEmbedConfig } from '../ai/image-embedder.js'
import { getImageEmbedModel } from '../data/ai-configs.js'
import {
  countPersonVectorProgress,
  findMemeById,
  listStalePersonVectorMemeIds,
  type StalePersonVectorCursor,
} from '../data/memes.js'
import {
  clearFailedPersonVectorJobs,
  countPersonVectorJobs,
  enqueuePersonVectorJobs,
} from '../data/person-vector-jobs.js'
import { assignPersonVector } from '../data/persons.js'
import { representativePng } from '../image/representative.js'
import { log } from '../logger.js'
import { getObject } from '../storage/r2.js'
import { ENQUEUE_CAP, ENQUEUE_PAGE } from './ai-config.js'

/**
 * 人物向量的计算、补跑与进度（SPEC §5.7.2 / §6.7.5）。
 *
 * 结构照 `services/reindex.ts` 抄，但**两处刻意不同**：
 *
 * 1. **它要读图**。文本重算是「从 `search_text` 再算一遍」，人物向量必须把原始字节
 *    从 R2 取回来（`getObject`）——所以它多一次对象存储往返，也多一条「图取不回来」的
 *    失败路径。
 * 2. **每张图都是一次付费调用**（§6.7.5）。文本换模型是管理员的一次性运维；
 *    这里点一次「补算」是真金白银，所以 `enqueueAllStalePersonVectors` 的封顶值
 *    与日志比那边更要紧。
 *
 * ⚠️ **不抛异常**，返回值告诉 worker 是哪一类，与 `services/reindex.ts`、
 *    `services/tagging.ts` 同一个口径。
 *
 * ## 这一步失败不能挡任何东西
 *
 * 没配通道、调用失败、图取不回来——图照样入库、打标、能被搜到，只是暂时不属于任何
 * 人物（§5.7.2）。人物是附加能力。
 */

export type PersonVectorOutcome =
  | { kind: 'done' }
  /** 图在排队期间被删了。任务判完成，没什么可重试的。 */
  | { kind: 'gone' }
  /** 没配图片向量通道。**不重试**——理由见 `queue/person-vector-worker.ts`。 */
  | { kind: 'not_configured' }
  | { kind: 'failed'; detail: string }

/**
 * 算一张图的人物向量并挂人物。
 *
 * ⚠️ **软删过滤在 `findMemeById` 里。** 这一步是异步的，图完全可能在排队期间被删——
 *    给一张已经删掉的图算向量不只是白花钱，它还会在 `meme_subjects` 上留下一行，
 *    而那一行会**在物理删除之前一直算在那个人的图数里**（`liveCountCte` 按
 *    `memes.deleted_at` 过滤，所以其实不会——但那份向量本身也没有任何用处）。
 *
 * @param signal 任务整体超时后 worker 会 abort。传下去是为了让在途的那次付费调用
 *               别再烧钱：那一刻结果已经没人要了。
 */
export async function computePersonVector(
  memeId: string,
  signal?: AbortSignal,
): Promise<PersonVectorOutcome> {
  const meme = await findMemeById(memeId)
  if (meme === null) return { kind: 'gone' }

  const config = await resolveImageEmbedConfig()
  if (config === null) return { kind: 'not_configured' }

  let png: Buffer
  try {
    const bytes = await getObject(meme.storageKey)
    // 长边 768、动图取中间帧。**取法与近似重复判定共用一份实现**
    // （`image/representative.ts`），只有缩放口径不同
    png = await representativePng(bytes, meme.storageKey, meme.isAnimated, 'person')
  } catch (error) {
    // 对象存储取不回、sharp 解不开都归这里。**不记 err 原文**：里面可能是整个
    // 对象键，属于内部信息（error-handling.md §4）
    log.warn({ memeId }, '取图失败，人物向量这一步跳过')
    return { kind: 'failed', detail: '取图失败' }
  }

  const result = await embedImage(png, config, signal)
  if (!result.ok) {
    if (result.reason === 'not_configured') return { kind: 'not_configured' }
    return { kind: 'failed', detail: `图片向量 ${result.reason}` }
  }

  /*
   * `embed_model` 写的必须是**真正算出这个向量的那个口径**——`config` 是上面解析出来
   * 那一份，不是重新解析的。两次解析之间配置可能刚好被改掉，那时写进去的口径对不上，
   * 不报错，只是那条记录从此被当成「已经是新口径了」永远不再重算。
   *
   * ⚠️ 拼接口径只有 `personEmbedModelKey` 一处实现（`ai/image-embedder.ts`）：
   *    改长边等于换模型（§5.7.1），而长边是编在函数里的常量，所以这里不需要也不该
   *    自己拼一次字符串。
   */
  await assignPersonVector(memeId, result.vector, personEmbedModelKey(config.model))
  return { kind: 'done' }
}

/**
 * 把所有**没有当前口径向量**的图排进队列。**幂等**（`onConflictDoNothing`）。
 *
 * 没配图片向量模型时返回 0：没有「当前口径」就没有「过期」可言，这时候入队
 * 只会排出一批必然被 worker 删掉的空任务。
 *
 * ⚠️ **翻页用 keyset，不用 `OFFSET`**，理由写在 `listStalePersonVectorMemeIds` 上
 *    （与文本侧逐字相同：入队与消费同时发生，算完的行掉出 WHERE 集合，offset 因此漏行）。
 *
 * ⚠️ **到 `ENQUEUE_CAP` 就停，剩下的既不排队也不报错。** 这里比文本侧更该留日志：
 *    每一条都是一次付费调用，「排了 10 万条、还剩 30 万条」是管理员必须知道的事。
 *
 * @returns 真正插进去的条数。它小于扫到的条数时，可能是重复入队，也可能是被 cap 截断。
 */
export async function enqueueAllStalePersonVectors(): Promise<number> {
  const model = await getImageEmbedModel()
  if (model === null) return 0
  const currentModelKey = personEmbedModelKey(model)

  let enqueued = 0
  let scanned = 0
  let cursor: StalePersonVectorCursor | null = null

  for (;;) {
    const page = await listStalePersonVectorMemeIds(currentModelKey, cursor, ENQUEUE_PAGE)
    if (page.length === 0) break

    enqueued += await enqueuePersonVectorJobs(page.map((row) => row.id))
    scanned += page.length

    const last = page[page.length - 1]
    if (last === undefined) break
    cursor = { createdAt: last.createdAt, id: last.id }

    if (page.length < ENQUEUE_PAGE) break

    if (scanned >= ENQUEUE_CAP) {
      log.warn(
        { cap: ENQUEUE_CAP, scanned, enqueued },
        '本轮人物向量补算达到入队上限，剩余记录**没有**排进队列（再触发一次可继续）',
      )
      break
    }
  }
  return enqueued
}

/**
 * 清掉上一轮的 failed 行，然后全量补排。**只在换口径时调用**
 * （`PUT /config/image-embed` 带 `confirmReindex`）。
 *
 * 必须先清：`meme_id` 上的唯一索引让「已有一条 failed 行」的图入不了队，
 * 不清的话上一轮失败的图会被整批漏掉，而进度条照样走完。详见
 * `clearFailedPersonVectorJobs` 的注释。
 */
export async function restartPersonVectorReindex(): Promise<number> {
  const cleared = await clearFailedPersonVectorJobs()
  const enqueued = await enqueueAllStalePersonVectors()
  log.info({ cleared, enqueued }, '换图片向量模型，全站人物向量重算入队')
  return enqueued
}

export type PersonReindexStatus = {
  running: boolean
  total: number
  done: number
  stale: number
  failed: number
}

/**
 * `GET /admin/persons/reindex/status`。**与 `GET /admin/reindex/status` 同形**
 * （§6.7.5），四个数全部来自库，不是进程内存里的计数器。
 *
 * ⚠️ **它不影响搜索的 `degraded`。** 那个字段只说检索的向量路，人物不参与检索召回
 *    （§6.7.5）——这句话的落点是：这里没有任何一个函数被 `services/search.ts` 调用。
 *
 * 没配通道时拿空串去比对：`embed_model = ''` 不命中任何行，于是 `done = 0`、
 * `stale = 全部`。那正是「还没配图片向量」该显示的样子（同 `getReindexStatus`）。
 *
 * `running` 用「队列里还有 pending / running」表达，不是「此刻有 worker 在跑」——
 * 与 `hasUnfinishedReindexJobs` 同一个口径，也是管理员看得懂的那个意思。
 */
export async function getPersonReindexStatus(): Promise<PersonReindexStatus> {
  const model = await getImageEmbedModel()
  const currentModelKey = model === null ? '' : personEmbedModelKey(model)

  const [progress, queue] = await Promise.all([
    countPersonVectorProgress(currentModelKey),
    countPersonVectorJobs(),
  ])

  return {
    running: queue.queued > 0,
    total: progress.total,
    done: progress.done,
    stale: progress.stale,
    failed: queue.failed,
  }
}
