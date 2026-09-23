import { createHash, randomUUID } from 'node:crypto'
import { db } from '../data/db.js'
import { createMeme, findMemeByContentHash, findNearestByPhash } from '../data/memes.js'
import { findUserById, getStorageUsedBytes } from '../data/auth.js'
import {
  getBatchSnapshot,
  listResumableBatches,
  recordItemOutcome,
  type ItemOutcome,
  type ItemResult,
} from '../data/imports.js'
import { loadRuntimeConfig } from '../data/runtime-config.js'
import { enqueueTagJob } from '../data/tag-jobs.js'
import { detectFormat, isIngestible, SNIFF_BYTES, type DetectedFormat } from '../lib/magic-bytes.js'
import { AppError, isAppError } from '../lib/app-error.js'
import { log } from '../logger.js'
import { FFMPEG_CONCURRENCY, MAX_FILE_BYTES, NEAR_DUP_DISTANCE } from '../image/constants.js'
import { computePhash, readSize, toThumbnail } from '../image/decode.js'
import { extractFrames, isAnimatedByFrames } from '../image/frames.js'
import { probeMetadata, setFfmpegConcurrency } from '../image/probe.js'
import { withTempFile } from '../image/temp-file.js'
import {
  deleteObject,
  getObject,
  headObject,
  permanentKeyFor,
  putObject,
  thumbKeyFor,
} from '../storage/r2.js'
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

/**
 * 同时处理几个文件的**默认值**。ffmpeg 自己有并发上限（image-pipeline.md §8），
 * 这里不跟它对着干。
 *
 * ⚠️ **它不再是运行时用的值**：实际值来自 `runtime_config` 单行表（SPEC §5.6），
 *    `admin` 在设置页改完，下一批生效——**已经在跑的批次整批用旧值**，不中途改
 *    （§6.5.5）。默认值只有这一份，`services/runtime-config.ts` import 的是它。
 *
 * ⚠️ **它和其余三个数一样是「每进程」的**（SPEC §5.6）：多副本时实际全局上限 =
 *    这个数 × 进程数。注释、接口文案、界面文案都**不能写成「全站同时处理几个文件」**。
 *
 * ⚠️ **调大它的收益低于预期**：`createHash('sha256')` 在下面处理每个文件时是**同步**
 *    的 CPU 工作（20MB 文件几十毫秒），它会挡住本进程所有在途任务。
 *    **不要为了绕过它去改 `content_hash` 的算法**——那是 `memes.content_hash` 唯一约束
 *    的依据，改它等于换一套去重口径（任务 §陷阱六）。
 */
export const PIPELINE_CONCURRENCY_DEFAULT = 2

export type FileToProcess = { fileName: string; tempKey: string }

/** `MAX_FILE_BYTES` 的 MB 数。只用来拼给用户看的文案，判定一律用 bigint 比。 */
const MAX_FILE_MB = Number(MAX_FILE_BYTES / (1024n * 1024n))

/**
 * 条目 `reason` 直接给错误码原文的唯一情形。
 *
 * 其余失败都是「这个文件怎么了」（损坏、格式不支持、太大），reason 是给人看的一句话；
 * 而配额用满是**批次级**结局——从这一刻起剩下的文件都不用再传了。客户端要能按这个
 * 字面值把剩余条目一次性说明白，所以它跟其余的 reason 不是一个东西（SPEC §3.6）。
 */
const QUOTA_EXCEEDED_REASON = 'QUOTA_EXCEEDED'

/**
 * 配额检查（SPEC §3.6）。**三处都要调**：签发预签名 URL 前、commit 时、以及每个文件
 * 去重之后真正入库前（后面两处在 `runPipeline` 的 ⑥ 和 `importReviewedFile`）。
 *
 * 为什么必须有三处：前两处面对的是**声明值**，而声明值可以撒谎，也可能只是传了一半。
 * 真正决定装不装得下的是读回来的字节数，所以判定在第三处；前两处只是让「整批传到一半
 * 才发现装不下」提前成「一开始就被拒」，省掉一次白传。
 *
 * ⚠️ 第三处**必须在去重之后**：字节完全相同的图和相似的图都不占空间，放在去重之前
 * 会让「库里已经有一模一样的一张」变成「存储空间不足」。
 *
 * 配额**每次现查**，不吃调用方手里的快照：它可能在批次跑到一半时被管理员改小，
 * 也可能被并发的另一个批次吃掉——用批次开头那一份等于「改了不生效」。
 */
export async function assertQuota(userId: string, incomingBytes: bigint): Promise<void> {
  const user = await findUserById(userId)
  if (user === null) throw new AppError('NOT_FOUND', '用户不存在')

  const used = await getStorageUsedBytes(userId)
  const remaining = user.storageQuotaBytes - used
  if (incomingBytes > remaining) {
    throw new AppError('QUOTA_EXCEEDED', '存储空间不足', {
      // 客户端要能告诉用户「还差多少」，否则他只能反复试
      remaining: (remaining > 0n ? remaining : 0n).toString(),
      required: incomingBytes.toString(),
      used: used.toString(),
      quota: user.storageQuotaBytes.toString(),
    })
  }
}

/**
 * 取暂存对象的字节。**导入的两条读路径共用**（批次管线、待确认队列的「仍然导入」）。
 *
 * ⚠️ 大小上限的两道关**都在读字节之前**（第一道）/ 紧接着读回来之后（第二道）：
 *    一个声明 1KB、实际 300MB 的对象，等整份读进内存再比较 `MAX_FILE_BYTES` 时
 *    内存已经吃完了，表现是进程被 OOM 杀掉，而不是「这个文件太大」。
 *
 * **配额不在这里查**，虽然时机上也可以：字节完全相同的图会走 `exact_dup`、
 * 相似的图会进待确认队列，两种都不占空间，不该因为「装不下」被判失败。
 * 判定在去重之后、真正要吃空间的那一步之前（调用方各自的位置见 `runPipeline`
 * 的 ⑥ 和 `importReviewedFile`），两处都用**读回来的实际字节数**。
 */
async function readTempObject(tempKey: string): Promise<Buffer> {
  const head = await headObject(tempKey)
  if (head === null) {
    // 预签名直传之后这里是「没传成功」的正常落点：断网、关掉页面，或者 PUT 被 R2 拒了
    // （声明大小与实际不符会 403，见 storage/r2.ts 的 presignUpload）
    throw new AppError('NOT_FOUND', '文件没有上传成功，请重新上传')
  }
  if (head.sizeBytes > MAX_FILE_BYTES) {
    // 超限的文件永远进不来，留着只占空间
    await deleteObject(tempKey)
    throw new AppError('FILE_TOO_LARGE', `文件超过 ${MAX_FILE_MB}MB 上限`)
  }

  const bytes = await getObject(tempKey)

  // 取回来再比一次：两次调用之间对象理论上能被换掉（预签名 PUT 在 15 分钟有效期内
  // 可以反复覆盖同一个键），那时上面那次比较就没意义了。同一份字节本来也要算实际大小
  // 落进 `memes.size_bytes`，所以这次比较是顺手的。
  const sizeBytes = BigInt(bytes.byteLength)
  if (sizeBytes > MAX_FILE_BYTES) {
    await deleteObject(tempKey)
    throw new AppError('FILE_TOO_LARGE', `文件超过 ${MAX_FILE_MB}MB 上限`)
  }
  return bytes
}

/** 失败原因是不是「装不下」。两处要用：条目 `reason` 的字面值，和「不删 temp 对象」。 */
function isQuotaExceeded(error: unknown): boolean {
  return isAppError(error) && error.code === 'QUOTA_EXCEEDED'
}

/**
 * 本进程此刻正在跑的批次。
 *
 * ⚠️ **这是进程内的，不是分布式锁。** 多副本时另一个副本看不见它，可能正在跑同一批。
 *    真正的互斥要一把带心跳的租约（队列表上多一列 + 条件更新），而本项目不引入
 *    Redis（§9.11）。这里能做到的是「同一个进程不重复跑」；跨进程的重叠靠
 *    `recordItemOutcome` 的**先写入者赢**兜底——代价是**白跑一遍**（多花一次 ffmpeg
 *    和一次 AI 的钱），不是数据错乱。取舍见 `listResumableBatches` 的注释。
 */
const runningBatches = new Set<string>()

/**
 * 跑完一整批。**调用方不 await 它**——commit 接口返回 202，这批在后台继续。
 *
 * 每个文件独立处理，一个失败不影响其他：处理顺序是 per-file 的，整批不该被一个
 * 损坏文件拖停（SPEC §1.4 的 `error` 事件只留给**批次级**失败）。
 *
 * 同一批次重复触发是**空操作**：`claimBatchCommit` 只挡得住并发的两个 commit，
 * 挡不住「启动续跑扫到了刚到的那一批」这种时间差。到那时两个 run 会并发处理同一批
 * 文件——同一张图的两条腿都写库，都会发 `item` 事件。
 */
export async function runBatch(
  batchId: string,
  userId: string,
  files: FileToProcess[],
): Promise<void> {
  if (runningBatches.has(batchId)) {
    log.warn({ batchId }, '这一批已经在本进程处理中，跳过重复触发')
    return
  }
  runningBatches.add(batchId)

  log.info({ batchId, count: files.length }, '开始处理导入批次')

  try {
    // 运行参数**在批次开头读一次**（SPEC §6.5.5）：已经在跑的批次整批用旧值，不中途改。
    // 现查库不缓存，读到的就是别的进程刚写的值——「改完不用重启」全靠这一条（§9.26）
    const runtime = await loadRuntimeConfig()
    const pipelineConcurrency = runtime?.importConcurrency ?? PIPELINE_CONCURRENCY_DEFAULT

    // ffmpeg 上限要一起设：导入这条线真正的旋钮是它在 `probe.ts` 里的进程级槽位，
    // 只调管线并发的话「调完一点没变快」，而且不知道为什么（任务 §为什么要做）
    setFfmpegConcurrency(runtime?.ffmpegConcurrency ?? FFMPEG_CONCURRENCY)
    log.info({ batchId, pipelineConcurrency }, '导入批次使用运行参数')

    // 分批并发，不是一次性全开——一千张同时开一千个 ffmpeg 会把机器打满
    //
    // 中途配额用尽之后**剩下的不再跑管线**（每张都要 ffmpeg 抽帧、算哈希，全是白跑），
    // 但仍然逐条发 `item` 判失败：SPEC §3.6 要的是「剩余文件全部标记失败」，
    // 不是静默停下（error-handling.md §7）。
    let quotaExhausted = false
    for (let i = 0; i < files.length; i += pipelineConcurrency) {
      const slice = files.slice(i, i + pipelineConcurrency)
      if (quotaExhausted) {
        await Promise.all(
          slice.map((file) =>
            finish(batchId, file.fileName, {
              result: 'failed',
              reason: QUOTA_EXCEEDED_REASON,
            }),
          ),
        )
        continue
      }
      const results = await Promise.all(
        slice.map((file) => processOneFile(batchId, userId, file)),
      )
      quotaExhausted = results.some((result) => result.quotaExhausted)
    }
    if (quotaExhausted) {
      log.warn({ batchId, userId }, '配额用尽，批次剩余文件全部标记失败')
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
        // 同 `processOneFile`：原始 message 只进上面那条日志。批次级故障恰恰最可能
        // 是数据库错误，而那种 message 里带连接串（error-handling.md §1）。
        message: isAppError(error) ? error.message : '导入处理失败，请重新拉取批次状态',
      },
    })
  } finally {
    // ⚠️ **必须在 finally 里清。** 漏掉的后果不是这一次出问题，而是这个批次在本进程里
    //    **永远不会再被续跑**（`runningBatches` 那一行挡住）——而续跑正是它存在的意义。
    //    中间那条 `catch` 里的 `publish` 自己也可能抛，所以不能只在正常出口清。
    runningBatches.delete(batchId)
  }
}

/**
 * 启动时把「死在半路的批次」接着跑完（SPEC §1.4，本任务 §9）。
 *
 * 「死在半路」的判据只有「已 commit + 还有没结论的条目」，所以**正常在跑的批次也会被
 * 扫到**：同进程靠 `runningBatches` 挡，而启动那一刻这个集合是空的——**这正是对的**，
 * 重启前在跑的那些批次已经随进程一起死了，它们就是要续的对象。多副本下另一个副本
 * 在跑的那批这里看不见，代价见 `runningBatches` 的注释。
 *
 * 逐个 await，不并发开跑：一次重启可能积压几十个半截批次，全部并发起来等于
 * 每个批次各带 `pipelineConcurrency` 个 ffmpeg 一起上，正是「分批并发」要避免的场面。
 * 代价是一个卡住的批次会拖住它后面的——`runPipeline` 每一步都有超时，不会真的卡死。
 *
 * 调用方**不 await**（`server.ts`）：一批可能跑几分钟，启动不该等它。
 * 这里自己吞掉每一个异常，所以这个 promise 不会 reject。
 */
export async function resumeInterruptedBatches(): Promise<void> {
  const batches = await listResumableBatches()
  if (batches.length === 0) return

  log.info({ count: batches.length }, '发现被中断的导入批次，续跑')

  for (const batch of batches) {
    if (batch.brokenCount > 0) {
      // 暂存键为空是数据被手工改过，重试也好不了。**必须说出来**：不说的话表现是
      // 「这一批永远停在还有未完成」，而且日志里什么线索都没有
      log.warn(
        { batchId: batch.batchId, brokenCount: batch.brokenCount },
        '批次里有暂存键缺失的条目，这些条目续跑不了，该批次会停在「还有未完成」',
      )
    }
    if (batch.items.length === 0) continue

    try {
      await runBatch(
        batch.batchId,
        batch.userId,
        batch.items.map((item) => ({ fileName: item.fileName, tempKey: item.tempStorageKey })),
      )
    } catch (error) {
      // `runBatch` 自己已经把批次级异常收成了 `error` 事件，走到这里的只可能是它的
      // catch 块本身出事（例如库断了、publish 抛了）。不接住的话整个续跑会停在这一批，
      // 后面的批次没人管——而那是一次静默的「只续了一半」
      log.error({ err: error, batchId: batch.batchId }, '续跑导入批次失败，继续下一批')
    }
  }
}

/**
 * 单个文件。**任何异常都在这里被收成 `failed` 结果 + `item` 事件**，
 * 不允许冒泡出去——一个损坏文件不该让整批停下，也不该让用户看到一条错误码
 * 而不知道是哪个文件（image-pipeline.md §7：失败要具体到文件）。
 *
 * 返回值只回答一件事：**这一张是不是撞上了配额上限**。是的话 `runBatch` 把剩下的
 * 全部判失败——配额不会因为少传一张就变得够用。
 */
async function processOneFile(
  batchId: string,
  userId: string,
  file: FileToProcess,
): Promise<{ quotaExhausted: boolean }> {
  try {
    const result = await runPipeline(userId, file)
    await finish(batchId, file.fileName, {
      result: result.result,
      memeId: result.memeId ?? null,
      similarTo: result.similarTo ?? null,
      distance: result.distance ?? null,
      reason: result.reason ?? null,
    })
    return { quotaExhausted: false }
  } catch (error) {
    // 原始 message 进日志，**不进响应**（SPEC §2.1）。事件里带的是可读原因。
    log.warn({ err: error, batchId, fileName: file.fileName }, '导入单文件失败')

    const quotaExhausted = isQuotaExceeded(error)
    await finish(batchId, file.fileName, {
      result: 'failed',
      reason: quotaExhausted ? QUOTA_EXCEEDED_REASON : readableReason(error),
    })
    return { quotaExhausted }
  }
}

/**
 * 给用户看的失败原因。
 *
 * `AppError` 的 message 本来就是写给用户的中文文案（SPEC §2.2），直接用；
 * **其余一律收成一句通用的**——数据库和第三方 SDK 的报错里可能带连接串、带 key
 * （error-handling.md §1），而 `reason` 会原样出现在 SSE `item` 事件和条目列表里。
 */
function readableReason(error: unknown): string {
  return isAppError(error) ? error.message : '处理失败，请稍后重试'
}

type PipelineResult = {
  result: ItemResult
  memeId?: string
  /** `needs_review` 时指向库里那张相似的图，以及汉明距离。待确认队列靠它并排对比。 */
  similarTo?: string
  distance?: number
  reason?: string
}

/**
 * 一个文件从字节到结论的全部判断。**不带 batchId**：这条管线的每一步都只看这个文件
 * 本身（大小、magic bytes、SHA-256、pHash），没有一步需要知道它属于哪个批次。
 *
 * 「这个条目确实属于这个批次」由 `recordItemOutcome` 的
 * `where batch_id = ? and file_name = ?` 保证——那是写库那一步的事，落在 `finish()` 里。
 */
async function runPipeline(
  userId: string,
  file: FileToProcess,
): Promise<PipelineResult> {
  // ① 大小上限、取字节。见 readTempObject：上限在读字节之前就比掉了。
  //    用实际字节数而不是前端声明的 sizeBytes —— 声明值可以撒谎，也可能只是传了一半。
  const bytes = await readTempObject(file.tempKey)
  const sizeBytes = BigInt(bytes.byteLength)

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
  //
  // ⚠️ **从这里往下的任何失败都要连 temp 对象一起收走**：解码失败、R2 写失败、入库失败
  //    留下的暂存对象没有任何记录指向它，而 temp/ 只跟着批次元信息在 24 小时后被清
  //    （image-pipeline.md §6）——在此之前重试一次就多叠一份。
  //    唯一不删的是 `needs_review`：它是**待办不是失败**，用户可能选「仍然导入」，
  //    那时还要用这个对象。它是 `return`，走不到下面的 catch。
  try {
    const size = await readSize(bytes)
    const phash = await computePhash(bytes)

    // ⑤ pHash 全库扫描。命中就攒进待确认队列，**不打标** —— 等用户确认「仍然导入」
    //    之后才进队列，否则被判重复的那些白花钱（SPEC §6.2.2）。
    const neighbor = await findNearestByPhash(phash, NEAR_DUP_DISTANCE)
    if (neighbor !== null) {
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

    // ⑥ 配额按**实际字节**查（SPEC §3.6）。放在这里而不是读字节之前：上面两条去重路径
    //    都不占空间（exact_dup 什么都没写、needs_review 还只是个待办），真正吃空间的
    //    只有下面这一步入库。声明值在预签名和 commit 各查过一次，但它们都只能「早一点拒」，
    //    判定必须是这里读回来的字节数。
    await assertQuota(userId, sizeBytes)

    // ⑦ 入库。**先写 R2 再写库**（agents/rules/database.md §5）：反过来会出现
    //    「库里有记录但文件不存在」，那个用户能看见。
    const persisted = await persistBytes({
      bytes,
      detected,
      fileName: file.fileName,
      userId,
      sizeBytes,
      contentHash,
      phash,
      size,
    })

    // ⑧ 暂存对象使命结束。删除失败只留日志，不影响结果。
    await deleteObject(file.tempKey)

    // 同批两张字节相同的图会有一条在唯一约束上让位（见 persistBytes）。
    // 对用户来说那就是它本来要得到的结论：库里已经有一张一模一样的。
    return persisted.exactDup
      ? { result: 'exact_dup', memeId: persisted.id }
      : { result: 'imported', memeId: persisted.id }
  } catch (error) {
    // 配额用尽是**唯一不删 temp 对象**的失败：空间可以腾出来（管理员调大配额、
    // 用户删掉几张图），那一刻这条还能重来。其余失败留下的暂存对象没有任何记录指向它，
    // 现在收掉比等 24 小时清理干净。
    if (!isQuotaExceeded(error)) await deleteObject(file.tempKey)
    throw error
  }
}

/** `memes.content_hash` 唯一约束的名字。定义处是 `data/schema.ts` 的 `memes_content_hash_key`。 */
const CONTENT_HASH_CONSTRAINT = 'memes_content_hash_key'

/**
 * 这个错误是不是「同一个 `content_hash` 已经有一条记录」。
 *
 * postgres.js 把唯一约束违反报成 `code === '23505'` 并带上约束名，但 drizzle 在某些
 * 路径上会**再包一层**，把它放进 `cause` 里。所以沿 cause 链找，只看最外层的话
 * 并发去重会悄悄退回「failed + R2 孤儿对象」——也就是这段代码本来要修的那个表现，
 * 而且不报错。
 *
 * 约束名取不到时（不同驱动版本字段名不同）按「是」处理。**这不会误吞别的错误**：
 * 调用方回查不到相同 `content_hash` 的记录时会原样抛出，宽判的代价只是多一次回查。
 */
function isContentHashConflict(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    const candidate = current as {
      code?: unknown
      constraint_name?: unknown
      constraint?: unknown
      cause?: unknown
    }
    if (candidate.code === '23505') {
      const name = candidate.constraint_name ?? candidate.constraint
      if (name === undefined || name === CONTENT_HASH_CONSTRAINT) return true
    }
    current = candidate.cause
  }
  return false
}

/**
 * 把一个已经过完前四关的 Buffer 落成一条 `memes`。
 *
 * **导出是因为「待确认队列里点仍然导入」也要走这条路**（routes/imports.ts）。
 * 那条路径的格式探测、帧数解析、R2 写入顺序和导入完全一样，重写一遍必然分叉——
 * 而分叉的地方会是「先写库还是先写 R2」这种不报错、只留脏数据的东西。
 *
 * 返回值里的 `exactDup` 表示**这次插入没成，命中的是并发写进来的同一条**（见函数末尾）。
 * 两条路径对它的处置不同：批次管线如实报 `exact_dup`；「仍然导入」那条路用户已经做过
 * 判断，回同一个 `memeId` 即可。
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
}): Promise<{ id: string; exactDup: boolean }> {
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
  try {
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
    return { id: meme.id, exactDup: false }
  } catch (error) {
    // 撞上 `content_hash` 的唯一约束：**同一个批次里两张字节相同的图会一起走到这里**。
    // 去重查询（`findMemeByContentHash`）在管线里读的是「库里有没有」，两张并发处理的
    // 图读到的是同一个「还没有」，于是两条 INSERT 只有一条能成——晚的那条撞唯一索引。
    //
    // 这不是「这个文件坏了」，是**另一个条目先落了库**：回查之后按精确重复处理，
    // 用户的结论和串行处理时完全一样（第二张就是重复）。不回查的话它变成一条 failed，
    // 库里明明有这张图，用户却看到「导入失败」。
    //
    // ⚠️ **必须把刚写的正式对象和缩略图删掉**：它们在 R2 上，事务回滚管不到，
    //    而且 `memes/`、`thumbs/` 前缀**不在定时清理的范围内**（清理只碰 temp/ 和缩略图，
    //    见 image-pipeline.md §6）——留着就是永久的孤儿对象。
    if (!isContentHashConflict(error)) throw error

    const winner = await findMemeByContentHash(contentHash)
    // 回查不到就说明不是「别人先写了同样的字节」，原样抛出去（也顺带保证了上面那个
    // 宽松的约束名判定不会把别的唯一约束错误吞成「重复」）
    if (winner === null) throw error

    await deleteObject(storageKey)
    await deleteObject(thumbKeyFor(storageKey))
    log.info(
      { storageKey, memeId: winner.id, fileName },
      '内容哈希撞唯一约束，按精确重复处理并收回刚写的对象',
    )
    return { id: winner.id, exactDup: true }
  }
}

function extensionForFormat(format: string): string {
  // jpeg 的通行扩展名是 .jpg，写 .jpeg 不报错但会让人以为是两个格式
  return format === 'jpeg' ? 'jpg' : format
}

/**
 * 「仍然导入」这一条路径：把暂存对象当成一个全新的文件重新走一遍入库。
 *
 * ⚠️ **不查近似重复。** 用户已经在待确认队列里看过对比并选了「仍然导入」——他刚刚
 * 做过那个判断，这里再判一次只会把他送回同一个队列，变成点了没反应的死循环。
 * 这正是「判断权在人」那条 decision 的落点。
 *
 * 精确重复是另一回事：字节完全相同是硬事实，`content_hash` 上有唯一约束，所以
 * 下面仍然要查一次（连着点两次「仍然导入」也是这条路径上的并发）。
 */
export async function importReviewedFile(params: {
  fileName: string
  tempKey: string
  userId: string
}): Promise<{ memeId: string }> {
  // 对象在不在、大小上限两道关在 readTempObject 里，**都在读字节之前**。
  const bytes = await readTempObject(params.tempKey)

  const sizeBytes = BigInt(bytes.byteLength)
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

  // 配额（SPEC §3.6）**按实际字节**查，位置和批次管线一致：精确重复上面已经返回了，
  // 走到这里的这一份字节是真的要占空间的。这一处不吞错误——配额不足抛 QUOTA_EXCEEDED
  // 出去变成 413，而且**不删 temp 对象**：待确认条目是待办不是日志，用户腾出空间之后
  // 还能再点一次「仍然导入」（SPEC §6.2.3）。
  await assertQuota(params.userId, sizeBytes)

  const persisted = await persistBytes({
    bytes,
    detected,
    fileName: params.fileName,
    userId: params.userId,
    sizeBytes,
    contentHash,
    phash: await computePhash(bytes),
    size,
  })

  // 用户已经确认过了，暂存对象可以删了。
  // ⚠️ 放在这里而不是上面的 catch 里：入库失败时**保留**暂存对象，用户还能再点一次
  //    （这条路径和批次不同，它是可重试的）。
  await deleteObject(params.tempKey)

  return { memeId: persisted.id }
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
 *
 * ⚠️ **写没落上就不广播**（`recordItemOutcome` 返回 false）。同一条目被两个进程处理时
 *    （停机放回 + 续跑重叠、或者多副本），后写的那个结论作废——但如果不拦，
 *    `item` 事件照样会发出去，用户就看到了一个**库里并不存在**的结论。
 *    `progress` 发的是累计快照，跳过这一条不会让计数错位（下一次 finish 会带上真实值），
 *    批次末尾的 `done` 也仍然按库里的快照发。
 */
async function finish(
  batchId: string,
  fileName: string,
  outcome: ItemOutcome,
): Promise<void> {
  const written = await recordItemOutcome(batchId, fileName, outcome)
  if (!written) {
    log.info(
      { batchId, fileName },
      '条目结论已由别处写入，本进程的作废，不广播事件',
    )
    return
  }

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
