import { callVision, resolveVisionConfig, type VisionPayloadMode } from '../ai/vision.js'
import { embedText, resolveEmbedConfig } from '../ai/embedder.js'
import { applyEmbedding, applyTagResult, findMemeById, setTagStatus } from '../data/memes.js'
import { composeCollage, toAiPng } from '../image/decode.js'
import { extractFrames, pickCollageFrames } from '../image/frames.js'
import { probeMetadata } from '../image/probe.js'
import { withTempFile } from '../image/temp-file.js'
import { planVisionAttempts, takeTailFrames, type VisionAttempt } from '../lib/frame-plan.js'
import type { TagJobFailure } from '../lib/retry-policy.js'
import {
  buildSearchText,
  interpretVisionContent,
  type VocabAdapter,
  type VocabField,
} from '../lib/vision-output.js'
import { log } from '../logger.js'
import { getObject } from '../storage/r2.js'
import { isKnownLabel, vocabulary } from '../vocab.js'

/**
 * 打标编排：取图 → 送 AI → 校验 → 写回 → 算向量。
 *
 * 这一层是「业务」，所以队列（`queue/worker.ts`）不写这些，它只负责调度；
 * SQL 也不在这里，全部走 `data/`（project-structure.md）。
 *
 * **不抛异常表示失败。** 失败是降级不是错误（SPEC §2.4），返回值告诉调用方是哪一类，
 * 由 `lib/retry-policy.ts` 决定重试还是终局。
 */

/**
 * 一次打标的结局。
 *
 * `gone` 和 `not_configured` 都不是失败：
 *
 *   - `gone`            —— 图在 AI 调用期间被删了。任务直接判完成，不重试。
 *   - `not_configured`  —— 没配视觉通道。**不消费、不失败重试**，图留在 pending，
 *                          等配置好之后批量补打标（queue.md §3 最后一行）。
 */
export type TagOutcome =
  | { kind: 'done'; embedded: boolean }
  | { kind: 'gone' }
  | { kind: 'not_configured' }
  | { kind: 'failed'; failure: TagJobFailure; detail: string }

/** 把词表接进纯函数层。`lib/vision-output.ts` 自己不读磁盘，所以别名表从这里注入。 */
const vocabAdapter: VocabAdapter = {
  alias: (value: string): string => vocabulary.aliases?.[value] ?? value,
  isKnown: (field: VocabField, value: string): boolean => isKnownLabel(field, value),
}

export async function tagMeme(memeId: string, signal: AbortSignal): Promise<TagOutcome> {
  const meme = await findMemeById(memeId)
  // 软删过滤在 findMemeById 里。打标是异步的，图完全可能在排队期间被删掉，
  // 这时候继续调 AI 就是白花钱打一张没人看得到的图
  if (meme === null) return { kind: 'gone' }

  /*
   * 只差向量的快速路径。
   *
   * embedding 失败不回滚打标（queue.md §3），所以任务回队列重跑时，视觉那一步
   * **已经付过钱了**。不认这条路径的话每次重试都要重新调一次视觉模型，
   * 而那一步的产出和上次一模一样。
   */
  if (meme.tagStatus === 'ok' && meme.embedding === null && meme.searchText !== null) {
    return embedAndStore(memeId, meme.searchText)
  }

  const config = resolveVisionConfig()
  if (config === null) return { kind: 'not_configured' }

  let images: Buffer[]
  let plan: VisionAttempt[]
  try {
    const prepared = await prepareImages(meme.storageKey, meme.isAnimated, config.multiImage)
    images = prepared.images
    plan = prepared.plan
  } catch (error) {
    // 取不到对象、ffmpeg 处理不了、文件损坏——都是这张图本身的问题，重试解决不了。
    // 归 unsupported（不重试）而不是 unreachable，否则一个坏文件会退避重试五轮
    log.warn({ err: error, memeId }, '打标取图失败')
    return { kind: 'failed', failure: 'unsupported', detail: '图片无法处理' }
  }

  for (const [rung, attempt] of plan.entries()) {
    const payload = await buildPayload(attempt, images)
    const result = await callVision(payload.images, payload.mode, config, signal)

    if (!result.ok) {
      if (result.failure === 'image_limit') {
        const next = plan[rung + 1]
        // 每次降级都要记日志（哪个通道、什么形态、memeId），否则降级和吞错误长得一样
        log.warn(
          {
            memeId,
            model: config.model,
            form: 'image_limit',
            from: describeAttempt(attempt),
            to: next ? describeAttempt(next) : null,
          },
          '图片数超限，同通道内降级',
        )
        // ⚠️ **先降帧，不降通道。** `vision_multi_image` 探测不出单请求图片数上限
        // （SPEC §2.4），换个供应商同样可能超限，还要白花另一条通道的钱
        if (next !== undefined) continue
        // 梯子走完还是超限：按「AI_UNSUPPORTED 之外的正常降级」处理（SPEC §2.4），
        // 也就是当拒绝——终局、不重试。判成 unsupported 会变成「提示用户检查配置」，
        // 但用户改配置也解决不了供应商的图片数上限
        return { kind: 'failed', failure: 'refused', detail: '图片数超限，降帧与拼图都被拒' }
      }
      return { kind: 'failed', failure: result.failure, detail: `HTTP 层判定：${result.failure}` }
    }

    const outcome = interpretVisionContent(
      result.envelope.content,
      result.envelope.finishReason,
      vocabAdapter,
    )

    if (outcome.kind === 'refused') {
      log.warn(
        { memeId, model: config.model, form: outcome.form, mode: payload.mode },
        '视觉通道拒绝',
      )
      return { kind: 'failed', failure: 'refused', detail: `${outcome.form}：${outcome.detail}` }
    }
    if (outcome.kind === 'invalid_output') {
      return { kind: 'failed', failure: 'invalid_output', detail: outcome.detail }
    }

    if (outcome.violations.length > 0) {
      // 词表外的词被丢掉而不是整条作废（ai-providers.md §5 把判空排在校验词表之后，
      // 整条作废的话判空那一步永远走不到）。记下来是为了给词表迭代提供依据
      log.info(
        { memeId, model: config.model, violations: outcome.violations },
        '丢弃词表外的标签',
      )
    }

    const searchText = buildSearchText(outcome.fields)
    // 五个字段 + search_text + vision_model + tag_status 在**同一条 UPDATE** 里
    const written = await applyTagResult(memeId, {
      ...outcome.fields,
      searchText,
      visionModel: config.model,
    })
    if (!written) return { kind: 'gone' }

    log.info(
      { memeId, model: config.model, mode: payload.mode, rung },
      '打标完成',
    )
    return embedAndStore(memeId, searchText)
  }

  // plan 至少有一项，走到这里说明 planVisionAttempts 被改坏了
  return { kind: 'failed', failure: 'unsupported', detail: '没有可用的送图方式' }
}

/** 终局失败时落 `tag_status`。取值由 `lib/retry-policy.ts` 决定，这里只负责写。 */
export async function finalizeTagFailure(memeId: string, tagStatus: string): Promise<void> {
  await setTagStatus(memeId, tagStatus)
}

// ── 取图 ───────────────────────────────────────────────────────────

/**
 * 把一张 meme 变成**若干张 PNG**，以及这个通道下的送图梯子。
 *
 * ⚠️ **送 AI 的永远只有 PNG**（image-pipeline.md）。动图在这里就抽完帧了，
 *    `ai/` 那一层不认识 GIF，也不该认识。
 */
async function prepareImages(
  storageKey: string,
  isAnimated: boolean,
  multiImage: boolean | null,
): Promise<{ images: Buffer[]; plan: VisionAttempt[] }> {
  const bytes = await getObject(storageKey)

  if (!isAnimated) {
    return { images: [await toAiPng(bytes)], plan: planVisionAttempts(false, 1, multiImage) }
  }

  const frames = await withTempFile(bytes, storageKey, async (filePath) => {
    const metadata = await probeMetadata(filePath)
    return extractFrames(filePath, metadata)
  })

  // extractFrames 出来的是**原尺寸** PNG，没缩过。每帧都要过一遍 toAiPng，
  // 否则一次 10 帧的请求能有几十兆——漏了不报错，只是账单和延迟一起翻几倍
  const images = await Promise.all(frames.frames.map((frame) => toAiPng(frame.png)))

  return { images, plan: planVisionAttempts(true, images.length, multiImage) }
}

async function buildPayload(
  attempt: VisionAttempt,
  images: Buffer[],
): Promise<{ images: Buffer[]; mode: VisionPayloadMode }> {
  if (attempt.mode === 'single') return { images: images.slice(0, 1), mode: 'single' }
  if (attempt.mode === 'frames') {
    return { images: takeTailFrames(images, attempt.count), mode: 'frames' }
  }
  // 拼图是**一张**图，不是四张
  return { images: [await composeCollage(pickCollageFrames(images))], mode: 'collage' }
}

function describeAttempt(attempt: VisionAttempt): string {
  return attempt.mode === 'frames' ? `frames:${attempt.count}` : attempt.mode
}

// ── 向量 ───────────────────────────────────────────────────────────

/**
 * 算 embedding 并写库。
 *
 * ⚠️ **失败绝不回滚打标**（queue.md §3）：标已经打好了，向量没算出来只是让这张图
 *    暂时进不了向量路，搜索侧本来就会 `degraded: true`。把 tag_status 一起退回
 *    等于扔掉一次已经付过钱的视觉调用。
 *
 * 没配 embedding 通道时返回 `done`（`embedded: false`）而不是失败：那是稳定的降级态，
 * 让任务无限重试只会空转队列。配好之后由重建索引任务补算（queue.md §7）。
 *
 * 截断后重新 L2 归一化在 `embedText` 里（`lib/vector.ts` 的 `truncateAndNormalize`）。
 * **这里不补做**——在写库前补救等于承认上游可能传进没归一化的向量。
 */
async function embedAndStore(memeId: string, searchText: string): Promise<TagOutcome> {
  const embedConfig = resolveEmbedConfig()
  if (embedConfig === null) {
    log.debug({ memeId }, '未配置 embedding 通道，向量留空')
    return { kind: 'done', embedded: false }
  }

  const result = await embedText(searchText)
  if (!result.ok) {
    if (result.reason === 'not_configured') return { kind: 'done', embedded: false }
    log.warn({ memeId, reason: result.reason }, 'embedding 失败，打标结果保留')
    return { kind: 'failed', failure: 'embed_failed', detail: `embedding ${result.reason}` }
  }

  const written = await applyEmbedding(memeId, result.vector, embedConfig.model)
  if (!written) return { kind: 'gone' }
  return { kind: 'done', embedded: true }
}
