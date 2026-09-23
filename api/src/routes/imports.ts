import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { AppError } from '../lib/app-error.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import {
  MAX_FILES_PER_BATCH,
  claimBatchCommit,
  createBatch,
  findOwnedBatch,
  findReviewItem,
  getBatchDeclaredBytes,
  getBatchSnapshot,
  listBatchTempKeys,
  listReviewQueue,
  resolveReviewItem,
} from '../data/imports.js'
import { getMemeById } from '../data/memes.js'
import { MAX_FILE_BYTES } from '../image/constants.js'
import { deleteObject, presignUpload, publicUrlFor } from '../storage/r2.js'
import { publish, subscribe } from '../services/import-events.js'
import {
  assertQuota,
  importReviewedFile,
  runBatch,
  type FileToProcess,
} from '../services/import.js'
import { serializeMeme } from '../serialize/meme.js'

/**
 * 导入（SPEC §6.2）。六个端点全部要求登录——导入是写操作，共享库里匿名写入
 * 等于给全站开放上传口。
 *
 * 上传流程分两段，中间夹着一次**浏览器直传 R2**：
 *
 *   POST /imports              签一批预签名 PUT，文件字节不经过 api
 *     → 浏览器 PUT 到 R2
 *   POST /imports/{id}/commit  告诉服务端「传完了，开始处理」，202 立即返回
 *     → 服务端后台跑管线，进度走 SSE
 */

// ── 请求体解析 ─────────────────────────────────────────────────────
//
// 校验写在这里而不是通用中间件：这两段请求体字段很少，而「缺字段就补默认值」
// 那种写法会让「配额算漏了」变成一个没有任何痕迹的错误。

function parseUploadBody(raw: unknown): { fileName: string; sizeBytes: bigint }[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象')
  }
  const files = (raw as Record<string, unknown>)['files']
  if (!Array.isArray(files) || files.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'files 必须是非空数组')
  }
  if (files.length > MAX_FILES_PER_BATCH) {
    throw new AppError('VALIDATION_FAILED', `一次最多 ${MAX_FILES_PER_BATCH} 个文件，请分批发`)
  }

  const seen = new Set<string>()
  return files.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new AppError('VALIDATION_FAILED', 'files 的每一项必须是 { fileName, sizeBytes }')
    }
    const record = entry as Record<string, unknown>
    const rawName = record['fileName']
    if (typeof rawName !== 'string' || rawName.trim() === '') {
      throw new AppError('VALIDATION_FAILED', 'fileName 必须是非空字符串')
    }
    const name = rawName.trim()

    // ⚠️ 文件名会直接拼进 R2 键。带 `/` 或 `..` 的名字能写到批次目录之外
    //    （`temp/<batchId>/../../memes/x`），那是一个路径穿越面。
    //    这里直接拒绝而不是「转义后接受」——转义的结果用户认不出来，反而更困惑。
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new AppError('VALIDATION_FAILED', `文件名不能包含路径分隔符：${name}`)
    }
    // 同批次重名会让两条 import_items 撞主键（batch_id + file_name）。
    // 拒绝比自动改名好：前端要能把返回的 uploads 和用户选的文件一一对上。
    if (seen.has(name)) {
      throw new AppError('VALIDATION_FAILED', `同一个批次里有重名文件：${name}`)
    }
    seen.add(name)

    const size = parseSizeBytes(record['sizeBytes'], name)
    return { fileName: name, sizeBytes: size }
  })
}

/** 声明的大小。**只用于配额预检**——真实大小在管线里按实际字节数重算。 */
function parseSizeBytes(value: unknown, name: string): bigint {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  let size: bigint
  try {
    size = BigInt(text)
  } catch {
    throw new AppError('VALIDATION_FAILED', `sizeBytes 不是整数：${name}`)
  }
  if (size < 0n) throw new AppError('VALIDATION_FAILED', `sizeBytes 不能为负：${name}`)
  if (size > MAX_FILE_BYTES) {
    throw new AppError('FILE_TOO_LARGE', `${name} 超过单文件上限`, { fileName: name })
  }
  return size
}

function parseCommitBody(raw: unknown): FileToProcess[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象')
  }
  const items = (raw as Record<string, unknown>)['items']
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'items 必须是非空数组')
  }

  return items.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new AppError('VALIDATION_FAILED', 'items 的每一项必须是 { fileName, tempKey }')
    }
    const record = entry as Record<string, unknown>
    const fileName = record['fileName']
    const tempKey = record['tempKey']
    if (typeof fileName !== 'string' || fileName.trim() === '') {
      throw new AppError('VALIDATION_FAILED', 'fileName 必须是非空字符串')
    }
    if (typeof tempKey !== 'string' || tempKey.trim() === '') {
      throw new AppError('VALIDATION_FAILED', 'tempKey 必须是非空字符串')
    }
    return { fileName: fileName.trim(), tempKey: tempKey.trim() }
  })
}

/**
 * 把 commit 的条目对齐到**库里记着的**暂存键上。
 *
 * ⚠️ **这是硬边界「写路径归属检查」在导入这一侧的落点**（SPEC §3.4）。
 *
 * 直接用客户端传来的 `tempKey` 去 `getObject` / `deleteObject` 是一个能删掉**别人正式图片**
 * 的洞：R2 的对象键能从响应里的 `url` 推出来（`memes/<uuid>.png` 这种形状），攻击者把它
 * 当 tempKey 传进来，管线就会把它当成自己的暂存对象——走到 `exact_dup` 或
 * `UNSUPPORTED_FORMAT` 分支时那个对象会被物理删除。而这条路**不经过任何 `memes` 写接口**，
 * `assertCanMutate` 拦不到它（SPEC §3.3 的三条规则管的是「改动这条记录」，不是「删这个对象」）。
 *
 * 所以键的唯一来源是 `import_items.temp_storage_key`——它在建批次时写死，客户端没有任何
 * 一步能改它。客户端传的值只用来对照：对不上就整条 `VALIDATION_FAILED`，
 * 不「宽容处理」成静默跳过（要么是客户端拼错了键，要么是有人在试，两种都该被拒）。
 */
async function resolveCommitItems(
  batchId: string,
  requested: FileToProcess[],
): Promise<FileToProcess[]> {
  const stored = await listBatchTempKeys(batchId)
  const keyByFileName = new Map(stored.map((row) => [row.fileName, row.tempStorageKey]))

  return requested.map((item) => {
    const storedKey = keyByFileName.get(item.fileName)
    if (storedKey === undefined) {
      throw new AppError('VALIDATION_FAILED', `这个批次里没有文件 ${item.fileName}`, {
        fileName: item.fileName,
      })
    }
    if (storedKey === null) {
      // 建批次的时候一定写了这个键，能读到 null 说明数据被手工改过。
      // 这是服务端的问题，不该报成客户端的 400（同待确认那条路径的处置）。
      throw new AppError('INTERNAL', '这条记录的暂存键丢失，无法处理', {
        fileName: item.fileName,
      })
    }
    if (storedKey !== item.tempKey) {
      throw new AppError('VALIDATION_FAILED', `${item.fileName} 的 tempKey 与上传时签发的不一致`, {
        fileName: item.fileName,
      })
    }
    return { fileName: item.fileName, tempKey: storedKey }
  })
}

type Vars = AuthVariables

export const importRoutes = new Hono<{ Variables: Vars }>()
  .use('*', requireAuth)

  /**
   * POST /api/v1/imports — 签预签名直传 URL（SPEC §6.2.1）
   *
   * 只签名，不接收字节。文件从浏览器直传 R2，api 全程不碰图片内容。
   */
  .post('/', async (c) => {
    const actor = c.get('currentUser')
    const raw: unknown = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON')
    })
    const files = parseUploadBody(raw)

    await assertQuota(
      actor.id,
      files.reduce((sum, f) => sum + f.sizeBytes, 0n),
    )

    const batch = await createBatch({ userId: actor.id, files })

    // 文件名已校验过，这里拼出的 tempKey 一定落在 temp/<batchId>/ 之内
    const uploads = await Promise.all(
      files.map(async (f) => {
        const { uploadUrl, tempKey } = await presignUpload({
          batchId: batch.id,
          fileName: f.fileName,
          // 声明的大小绑进签名：R2 会拿实际的 Content-Length 和它比，不符直接 403。
          // 前端声明的是 `file.size`，所以正常上传不受影响（storage/r2.ts 的 presignUpload）
          sizeBytes: f.sizeBytes,
        })
        return { fileName: f.fileName, uploadUrl, tempKey }
      }),
    )

    return c.json({ batchId: batch.id, uploads })
  })

  /**
   * GET /api/v1/imports/reviews — 待确认队列（SPEC §6.2.3）
   *
   * ⚠️ **必须注册在 `/:batchId` 之前。** Hono 按注册顺序匹配，`/reviews` 会先被
   * `/:batchId` 吃掉，表现是「待确认队列一直说批次不存在」。
   */
  .get('/reviews', async (c) => {
    const actor = c.get('currentUser')
    const entries = await listReviewQueue(actor.id)

    const items = await Promise.all(
      entries.map(async (entry) => {
        // existing 用完整的 meme 序列化结果，前端并排展示两侧用的是同一套字段
        const existing = await getMemeById(entry.existingId, actor.id)
        return {
          batchId: entry.batchId,
          fileName: entry.fileName,
          // tempUrl 指向**暂存对象**，用户还没决定要不要它。
          // 用公开地址直出而不是预签名 GET：这个队列可能放好几天，签名会过期。
          tempUrl: entry.tempStorageKey === null ? null : publicUrlFor(entry.tempStorageKey),
          sizeBytes: entry.sizeBytes?.toString() ?? null,
          width: entry.width,
          height: entry.height,
          distance: entry.distance,
          existing: existing === null ? null : serializeMeme(existing),
        }
      }),
    )

    return c.json({ items })
  })

  /**
   * POST /api/v1/imports/reviews/{batchId}/{fileName} — 处理一条待确认（SPEC §6.2.3）
   *
   * `action: "import"` 才入队打标。在此之前它一直不打标——被判为重复的图
   * 不该先花掉 AI 的钱再被用户丢掉。
   */
  .post('/reviews/:batchId/:fileName', async (c) => {
    const actor = c.get('currentUser')
    const batchId = c.req.param('batchId')
    // ⚠️ **不要在这里再 decodeURIComponent 一次**：Hono 的 `c.req.param()` 已经解过码
    //（`request.js` 的 `#getDecodedParam` 走 `tryDecodeURIComponent`）。再解一次的话，
    // 文件名里的 `%` 会让它抛 URIError —— 表现是「文件名带百分号的图永远处理不了」，
    // 而且返回 500 而不是 404/400。
    const fileName = c.req.param('fileName')

    const raw: unknown = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON')
    })
    const action = (raw as Record<string, unknown>)['action']
    if (action !== 'import' && action !== 'skip') {
      throw new AppError('VALIDATION_FAILED', 'action 只能是 "import" 或 "skip"')
    }

    // findReviewItem 里带了归属检查，也带了 result = 'needs_review' 的条件：
    // 别人的条目和已经处理过的条目在这里都变成 NOT_FOUND
    const item = await findReviewItem(batchId, fileName, actor.id)
    if (item === null) throw new AppError('NOT_FOUND', '没有这条待确认记录')

    if (action === 'skip') {
      // 跳过是最常见的处置方式。**连着 temp 对象一起删**——留着只占空间，
      // 而且会让「7 天未处理」那条清理任务白跑一趟。
      await resolveReviewItem(batchId, fileName, { result: 'exact_dup' })
      if (item.tempStorageKey !== null) await deleteObject(item.tempStorageKey)
      return c.json({ fileName, result: 'skipped' })
    }

    if (item.tempStorageKey === null) {
      // 没有暂存对象就没法导入。这不该发生（条目建的时候就有 tempKey），
      // 真发生了说明数据被手工改过，直说比抛一个 500 好。
      throw new AppError('INTERNAL', '这条记录的暂存对象丢失，无法导入', { fileName })
    }

    // 配额**不在这里查**：这一刻能拿来判定的只有条目上那个声明值，而它可能撒谎。
    // 真正的判定在 importReviewedFile → readTempObject 里，按读回来的**实际字节**算，
    // 而且是在读字节之前就拒（SPEC §3.6）。

    const { memeId } = await importReviewedFile({
      fileName,
      tempKey: item.tempStorageKey,
      userId: actor.id,
    })

    await resolveReviewItem(batchId, fileName, { result: 'imported', memeId })
    publish(batchId, { event: 'item', data: { fileName, result: 'imported', memeId } })

    return c.json({ fileName, result: 'imported', memeId })
  })

  /**
   * POST /api/v1/imports/{batchId}/commit — 触发处理（SPEC §6.2.1）
   *
   * **202 立即返回，不同步等处理完。** 上千张图要跑几分钟，同步等会让请求超时，
   * 而且中途断开时用户拿不到 batchId——那批图就变成孤儿了。
   */
  .post('/:batchId/commit', async (c) => {
    const actor = c.get('currentUser')
    const batchId = c.req.param('batchId')
    const raw: unknown = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON')
    })
    const requested = parseCommitBody(raw)

    // 归属检查放在校验之前：不是自己的批次一律「不存在」，**不能因为条目对不上变成 400**——
    // 那会泄露「这个 batchId 存不存在」。
    const batch = await findOwnedBatch(batchId, actor.id)
    if (batch === null) throw new AppError('NOT_FOUND', '没有这个导入批次')

    // 键一律取库里的那份，客户端传的只用来对照（见 resolveCommitItems）。
    // 必须在 claimBatchCommit **之前**：校验失败时这一批还没被标成已提交，
    // 客户端改正之后还能重来一次；放在 claim 之后的话这一批会永远卡在 pending。
    const items = await resolveCommitItems(batchId, requested)

    // 抢「这一批开始处理」的原子标志（见 claimBatchCommit）
    const claimed = await claimBatchCommit(batchId, actor.id)
    if (claimed === null) {
      // 走到这里只可能是**已经 commit 过**：归属上面已经查过了。
      // **这不该报错**：客户端重试是常态，报错会让用户以为导入失败了，而实际上它正在跑。
      // 返回同一批的幂等结果。
      return c.json({ batchId, accepted: batch.total, alreadyCommitted: true }, 202)
    }

    // commit 时再查一次配额（SPEC §6.2.1）：期间可能有别的批次入库了。
    // 这一处用的是**声明值**，只是「早一点拒绝」；判定在每个文件入库前按实际字节再做一次。
    await assertQuota(actor.id, await getBatchDeclaredBytes(batchId))

    // ⚠️ 故意不 await：这批在后台跑，进度走 SSE。
    //    catch 是必须的——不接的话 promise 拒绝会变成 unhandledRejection 打挂进程。
    void runBatch(batchId, actor.id, items).catch(() => {
      // runBatch 内部已把失败发成 error 事件并记了日志，这里只兜住 promise
    })

    return c.json({ batchId, accepted: items.length }, 202)
  })

  /**
   * GET /api/v1/imports/{batchId} — 批次快照
   *
   * **SSE 断线后前端靠它补齐**（SPEC §1.4）。字段和 `done` 事件对齐，
   * 客户端两处用同一套渲染逻辑。
   */
  .get('/:batchId', async (c) => {
    const actor = c.get('currentUser')
    const batchId = c.req.param('batchId')
    const batch = await findOwnedBatch(batchId, actor.id)
    if (batch === null) throw new AppError('NOT_FOUND', '没有这个导入批次')

    const snapshot = await getBatchSnapshot(batchId)
    return c.json({
      total: snapshot.total,
      done: snapshot.done,
      skipped: snapshot.skipped,
      pending: snapshot.pending,
      needsReview: snapshot.needsReview,
      failed: snapshot.failed,
      committed: batch.committedAt !== null,
    })
  })

  /**
   * GET /api/v1/imports/{batchId}/events — SSE 进度（SPEC §1.4）
   *
   * **连接断开不影响服务端处理**：处理跑在服务端的批次循环里，这个连接只是旁观。
   * 断开时漏掉的增量事件不补发，重连后靠快照补齐。
   */
  .get('/:batchId/events', async (c) => {
    const actor = c.get('currentUser')
    const batchId = c.req.param('batchId')
    const batch = await findOwnedBatch(batchId, actor.id)
    if (batch === null) throw new AppError('NOT_FOUND', '没有这个导入批次')

    c.header('Cache-Control', 'no-cache, no-transform')
    // 反代会缓冲整个响应，SSE 就变成了「结束时一次性收到」。这一行是给 nginx 看的。
    c.header('X-Accel-Buffering', 'no')

    return streamSSE(c, async (stream) => {
      // ① 先发当前累计状态。**重连时这一步就是全部的意义**——
      //    漏掉的增量不补发，由这个快照和 GET /imports/{id} 补齐。
      const snapshot = await getBatchSnapshot(batchId)
      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({
          total: snapshot.total,
          done: snapshot.done,
          skipped: snapshot.skipped,
          pending: snapshot.pending,
        }),
      })

      // ② 再挂实时增量
      let closed = false
      const unsubscribe = subscribe(batchId, (event) => {
        void stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) })
      })
      stream.onAbort(() => {
        closed = true
        unsubscribe()
      })

      // ③ 心跳。反代和 CDN 会在几十秒空闲后掐掉没有字节的连接，而这个批次可能
      //    正卡在一张 81 帧的动图上——用户看到的表现是「进度条不动」，没有报错。
      while (!closed) {
        await stream.sleep(15_000)
        if (closed) break
        await stream.writeSSE({ event: 'ping', data: '{}' })
      }

      unsubscribe()
    })
  })
