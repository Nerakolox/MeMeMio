import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { db } from '../data/db.js'
import { createMeme, findMemeByContentHash, findNearestByPhash } from '../data/memes.js'
import {
  getBatchSnapshot,
  recordItemOutcome,
  type ItemOutcome,
  type ItemResult,
} from '../data/imports.js'
import { enqueueTagJob } from '../data/tag-jobs.js'
import { detectFormat, isIngestible, SNIFF_BYTES, type DetectedFormat } from '../lib/magic-bytes.js'
import { AppError, isAppError } from '../lib/app-error.js'
import { log } from '../logger.js'
import { MAX_FILE_BYTES, NEAR_DUP_DISTANCE } from '../image/constants.js'
import { computePhash, readSize, toThumbnail } from '../image/decode.js'
import { extractFrames, isAnimatedByFrames } from '../image/frames.js'
import { probeMetadata } from '../image/probe.js'
import { withTempFile } from '../image/temp-file.js'
import { deleteObject, getObject, permanentKeyFor, putObject, thumbKeyFor } from '../storage/r2.js'
import { publish } from './import-events.js'

/**
 * 导入处理管线。SPEC §6.2.2 / image-pipeline.md §1。
 *
 * 顺序是**契约的一部分**，不是实现细节——它决定用户看到什么结果、以及花不花 AI 的钱：
 *
 *     magic bytes 探测真实格式（不信扩展名）
 *       → SHA-256 查库 → 精确命中 → exact_dup，静默跳过，删除暂存对象
 *       → pHash 计算 → 全库 Hamming 扫描 → 近似命中 → needs_review，不阻塞批次，不打标
 *       → 两关都过 → 写入 memes（tag_status = pending）→ 进打标队列
 *
 * **去重在调 AI 之前。** 表情包库重复率极高，先去重直接省掉相应比例的 AI 调用；
 * 用户自带 key 之后，这是在省用户自己的钱。不要为了「快点看到标签」把顺序调过来。
 */

/** 同时处理几个文件。ffmpeg 自己有并发上限（image-pipeline.md §8），这里不跟它对着干。 */
const PIPELINE_CONCURRENCY = 2

export type FileToProcess = { fileName: string; tempKey: string }

/**
 * 跑完一整批。**调用方不 await 它**——commit 接口返回 202，这批在后台继续。
 *
 * 每个文件独立处理，一个失败不影响其他：处理顺序是 per-file 的，整批不该被一个
 * 损坏文件拖停（SPEC §1.4 的 `error` 事件只留给**批次级**失败）。
 */
export async function runBatch(
  batchId: string,
  userId: string,
  files: FileToProcess[],
): Promise<void> {
  log.info({ batchId, count: files.length }, '开始处理导入批次')

  try {
    // 分批并发，不是一次性全开——一千张同时开一千个 ffmpeg 会把机器打满
    for (let i = 0; i < files.length; i += PIPELINE_CONCURRENCY) {
      const slice = files.slice(i, i + PIPELINE_CONCURRENCY)
      await Promise.all(slice.map((file) => processOneFile(batchId, userId, file)))
    }

    const snapshot = await getBatchSnapshot(batchId)
    publish(batchId, {
      event: 'done',
      data: {
        total: snapshot.total,
        imported: snapshot.imported,
        exactDup: snapshot.exactDup,
        needsReview: snapshot.needsReview,
        failed: snapshot.failed,
      },
    })
    log.info({ batchId, ...snapshot }, '导入批次处理完成')
  } catch (error) {
    // 走到这里说明是批次级故障（数据库断了、查快照失败），不是单个文件的问题。
    // `error` 事件之后连接关闭，客户端要靠快照接口重新对齐。
    log.error({ err: error, batchId }, '导入批次级失败')
    publish(batchId, {
      event: 'error',
      data: {
        code: isAppError(error) ? error.code : 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

/**
 * 单个文件。**任何异常都在这里被收成 `failed` 结果 + `item` 事件**，
 * 不允许冒泡出去——一个损坏文件不该让整批停下，也不该让用户看到一条错误码
 * 而不知道是哪个文件（image-pipeline.md §7：失败要具体到文件）。
 */
async function processOneFile(
  batchId: string,
  userId: string,
  file: FileToProcess,
): Promise<void> {
  try {
    const result = await runPipeline(batchId, userId, file)
    await finish(batchId, file.fileName, {
      result: result.result,
      memeId: result.memeId ?? null,
      similarTo: result.similarTo ?? null,
      distance: result.distance ?? null,
      reason: result.reason ?? null,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // 原始 message 进日志，**不进响应**（SPEC §2.1）。事件里带的是 code + 可读原因。
    log.warn({ err: error, batchId, fileName: file.fileName }, '导入单文件失败')
    await finish(batchId, file.fileName, { result: 'failed', reason })
  }
}

type PipelineResult = {
  result: ItemResult
  memeId?: string
  /** `needs_review` 时指向库里那张相似的图，以及汉明距离。待确认队列靠它并排对比。 */
  similarTo?: string
  distance?: number
  reason?: string
}

async function runPipeline(
  batchId: string,
  userId: string,
  file: FileToProcess,
): Promise<PipelineResult> {
  const bytes = await getObject(file.tempKey)

  // ① 大小。**用实际字节数，不用前端声明的 sizeBytes** —— 声明值可以撒谎，
  //    也可能只是传了一半。声明值只在签发预签名 URL 时用于配额预检。
  const sizeBytes = BigInt(bytes.byteLength)
  if (sizeBytes > MAX_FILE_BYTES) {
    await deleteObject(file.tempKey)
    throw new AppError('FILE_TOO_LARGE', `文件超过 ${Number(MAX_FILE_BYTES / (1024n * 1024n))}MB 上限`)
  }

  // ② magic bytes。**不信扩展名，也不信 mime** —— 微信「另存为」改名是常态。
  const detected = detectFormat(bytes.subarray(0, SNIFF_BYTES))
  if (detected === null || !isIngestible(detected.format)) {
    await deleteObject(file.tempKey)
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      detected === null ? '这不是一张图片' : `不支持 ${detected.format} 格式`,
    )
  }

  // ③ SHA-256 精确去重。**这一步在解码之前**，重复文件连 sharp 都不用跑。
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const existing = await findMemeByContentHash(contentHash)
  if (existing !== null) {
    // 命中就删暂存对象：用户已经有的图，留着只是占空间
    await deleteObject(file.tempKey)
    return { result: 'exact_dup', memeId: existing.id }
  }

  // ④ 到这里才值得解码。前面两步都只读字节，坏了也不该让 sharp 白跑一趟。
  const size = await readSize(bytes)
  const phash = await computePhash(bytes)

  // ⑤ pHash 全库扫描。命中就攒进待确认队列，**不打标** —— 等用户确认「仍然导入」
  //    之后才进队列，否则被判重复的那些白花钱（SPEC §6.2.2）。
  const neighbor = await findNearestByPhash(phash, NEAR_DUP_DISTANCE)
  if (neighbor !== null) {
    // ⚠️ 不删 temp 对象：用户可能选「仍然导入」，那时还要用它。
    //    7 天未处理的由定时任务连同对象一起清（image-pipeline.md §6）。
    //
    // `similarTo` / `distance` **必须带到条目上**：待确认队列接口要给用户并排对比
    // （`listReviewQueue` 靠 `similar_to` 关联出 existing，靠 `distance` 显示相似度）。
    // 只在 `reason` 那句话里写「距离 7」是不够的——那是给人看的文本，程序读不出来。
    return {
      result: 'needs_review',
      similarTo: neighbor.meme.id,
      distance: neighbor.distance,
      reason: `库里已有一张相近的图（距离 ${neighbor.distance}）`,
    }
  }

  // ⑥ 入库。**先写 R2 再写库**（agents/rules/database.md §5）：反过来会出现
  //    「库里有记录但文件不存在」，那个用户能看见。
  const meme = await persistBytes({
    bytes,
    detected,
    fileName: file.fileName,
    userId,
    sizeBytes,
    contentHash,
    phash,
    size,
  })

  // ⑦ 暂存对象使命结束。删除失败只留日志，不影响结果。
  await deleteObject(file.tempKey)

  return { result: 'imported', memeId: meme.id }
}

/**
 * 把一个已经过完前四关的 Buffer 落成一条 `memes`。
 *
 * **导出是因为「待确认队列里点仍然导入」也要走这条路**（routes/imports.ts）。
 * 那条路径的格式探测、帧数解析、R2 写入顺序和导入完全一样，重写一遍必然分叉——
 * 而分叉的地方会是「先写库还是先写 R2」这种不报错、只留脏数据的东西。
 */
/**
 * 删临时目录的重试逻辑搬去了 `image/temp-file.ts`：打标那条路径要抽同样的帧，
 * 落盘 + 清理这一段一模一样，共用一份免得只在一边修了 bug。
 */

export async function persistBytes(params: {
  bytes: Buffer
  detected: DetectedFormat
  fileName: string
  userId: string
  sizeBytes: bigint
  contentHash: string
  phash: bigint
  size: { width: number; height: number }
}): Promise<{ id: string }> {
  const { bytes, detected, fileName, userId, sizeBytes, contentHash, phash, size } = params

  // 帧数只能靠 ffmpeg 真的解析容器拿到。**不能从 mime 推断**：WebP 和 APNG 都可能是
  // 动图也可能静图；「是 GIF 但只有一帧」要判为静图（实测 252 个 GIF 里有 13 个）。
  // 这个字段是前端复制/下载分流的唯一依据，错了的表现是「点了复制没反应」。
  const isAnimated = await withTempFile(bytes, fileName, async (localPath) => {
    const metadata = await probeMetadata(localPath)
    const animated = isAnimatedByFrames(metadata)

    // 动图导入期就跑一遍抽帧，**结果不落库**。目的是在导入时就暴露
    // 「这个文件 ffmpeg 处理不了」，而不是等用户配好 key 之后才在打标阶段失败——
    // 那时他面对的是一批 pending 到天荒地老的图，没有任何错误信息。
    if (animated) {
      const selection = await extractFrames(localPath, metadata)
      log.debug(
        {
          fileName,
          rawFrameCount: selection.rawFrameCount,
          distinctFrameCount: selection.distinctFrameCount,
          sentFrames: selection.frames.length,
        },
        '动图抽帧完成',
      )
    }
    return animated
  })

  // 扩展名**从真实格式取，不从文件名取**：一个被改名成 `.png` 的 GIF 若存成
  // `xxx.png`，CDN 会用错误的 Content-Type 送出去。
  const storageKey = permanentKeyFor(randomUUID(), extensionForFormat(detected.format))
  await putObject(storageKey, bytes, detected.mime)

  // 缩略图失败**不是致命的**（image-pipeline.md §5）：原图在就行，缩略图丢了能重生成。
  // 所以它单独 try，不参与下面那次事务的成败。
  try {
    await putObject(thumbKeyFor(storageKey), await toThumbnail(bytes), 'image/webp')
  } catch (error) {
    log.warn({ err: error, storageKey }, '缩略图生成失败，稍后可重建')
  }

  // ⚠️ 「写 memes + 入队打标」必须在同一个事务里（agents/rules/database.md §5）。
  // 这是不用 Redis 换来的最大好处：「图片入库了但队列任务丢了」不可能发生。
  const meme = await db.transaction(async (tx) => {
    const row = await createMeme(
      {
        uploaderId: userId,
        storageKey,
        originalFilename: fileName,
        contentHash,
        phash,
        mime: detected.mime,
        width: size.width,
        height: size.height,
        sizeBytes,
        isAnimated,
        // 导入只负责入库，打标由队列消费者做。这里只能承诺到 pending 这一步。
        tagStatus: 'pending',
      },
      tx,
    )
    // userId 取 createMeme 的返回行，不另外传参：入队用的两个 id 都来自 `data/memes.ts`
    // 的查询结果，队列表因此永远不需要 join memes（queue.md §8）
    await enqueueTagJob(row.id, row.uploaderId, tx)
    return row
  })

  return { id: meme.id }
}

function extensionForFormat(format: string): string {
  // jpeg 的通行扩展名是 .jpg，写 .jpeg 不报错但会让人以为是两个格式
  return format === 'jpeg' ? 'jpg' : format
}

/**
 * 「仍然导入」这一条路径：把暂存对象当成一个全新的文件重新走一遍入库。
 *
 * ⚠️ **不查精确重复，也不查近似重复。** 用户已经在待确认队列里看过对比并选了
 * 「仍然导入」——他刚刚做过那个判断，这里再判一次只会把他送回同一个队列，
 * 变成点了没反应的死循环。这正是「判断权在人」那条decision 的落点。
 */
export async function importReviewedFile(params: {
  fileName: string
  tempKey: string
  userId: string
}): Promise<{ memeId: string }> {
  const bytes = await getObject(params.tempKey)

  const sizeBytes = BigInt(bytes.byteLength)
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new AppError('FILE_TOO_LARGE', '文件超过单文件上限')
  }

  const detected = detectFormat(bytes.subarray(0, SNIFF_BYTES))
  if (detected === null || !isIngestible(detected.format)) {
    throw new AppError('UNSUPPORTED_FORMAT', detected === null ? '这不是一张图片' : `不支持 ${detected.format} 格式`)
  }

  const size = await readSize(bytes)
  const contentHash = createHash('sha256').update(bytes).digest('hex')

  // 精确重复在这一支**仍然要查**：近似重复的判断是人做的，但「字节完全相同」
  // 是硬事实，库里已经有这条记录时不能再插一条——`content_hash` 上有唯一约束，
  // 插入会直接抛 500。
  const existing = await findMemeByContentHash(contentHash)
  if (existing !== null) return { memeId: existing.id }

  const meme = await persistBytes({
    bytes,
    detected,
    fileName: params.fileName,
    userId: params.userId,
    sizeBytes,
    contentHash,
    phash: await computePhash(bytes),
    size,
  })

  // 用户已经确认过了，暂存对象可以删了
  await deleteObject(params.tempKey)

  return { memeId: meme.id }
}

/**
 * 落库 + 发 `item` + `progress`。**单文件唯一的收尾入口**，成功和失败都走这里。
 *
 * 落库和发事件必须是同一处：曾经「成功回填、失败回填」和「发事件」是两段分开写的
 * 代码，成功那条路径只在事件里发了 `imported`，库里那条条目**一直是 `pending`**。
 * 表现是批次永远跑不完、`progress` 永远停在原地、SSE 永远不会发 `done`——
 * 而日志里一切正常。先落库再发事件，顺序不能反：事件发出去的时候，
 * 重连的客户端去拉快照必须已经能看到这个结果。
 *
 * `progress` 是**累计**值，不是增量——客户端重连后拉到的快照和这里的事件是同一套口径，
 * 不该出现「快照说 done=50、事件也说 done=50 但含义不同」这种要靠猜的东西。
 */
async function finish(
  batchId: string,
  fileName: string,
  outcome: ItemOutcome,
): Promise<void> {
  await recordItemOutcome(batchId, fileName, outcome)

  publish(batchId, {
    event: 'item',
    data: {
      fileName,
      result: outcome.result,
      ...(outcome.memeId !== undefined && outcome.memeId !== null
        ? { memeId: outcome.memeId }
        : {}),
      // reason 是给人看的一句话，**不是给程序分支的字段**。程序分支看 result。
      ...(outcome.reason !== undefined && outcome.reason !== null
        ? { reason: outcome.reason }
        : {}),
    },
  })

  const snapshot = await getBatchSnapshot(batchId)
  publish(batchId, {
    event: 'progress',
    data: {
      total: snapshot.total,
      done: snapshot.done,
      skipped: snapshot.skipped,
      pending: snapshot.pending,
    },
  })
}
