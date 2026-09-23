import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { importBatches, importItems, memes, users } from './schema.js'

/**
 * 导入批次与条目。**只碰 `import_batches` / `import_items`**。
 *
 * 涉及 `memes` 的查询（精确哈希、pHash 邻域）在 `data/memes.ts` 里，
 * 因为 `memes` 只有一个入口，而软删过滤必须只有一份实现。
 */

export type ImportBatchRow = typeof importBatches.$inferSelect
export type ImportItemRow = typeof importItems.$inferSelect

/** 批次元信息保留 24 小时。`needs_review` 条目例外，见 SPEC §5.5。 */
const BATCH_TTL_HOURS = 24

/** 单批文件数上限。上千张要分批发，一次请求体不该有几十万条条目。 */
export const MAX_FILES_PER_BATCH = 1000

// ── 批量上传第一步：建批次 ──────────────────────────────────────────

/**
 * 建批次并写入条目。`declaredSizeBytes` 是**用户声明的**大小，用于配额预检——
 * 真正可信的大小要等预签名直传完成后用 `headObject` 核（`src/storage/r2.ts`）。
 */
export async function createBatch(input: {
  userId: string
  files: { fileName: string; sizeBytes: bigint }[]
}): Promise<ImportBatchRow> {
  const expiresAt = new Date(Date.now() + BATCH_TTL_HOURS * 60 * 60 * 1000)

  return await defaultDb.transaction(async (tx) => {
    const batchRows = await tx
      .insert(importBatches)
      .values({ userId: input.userId, total: input.files.length, expiresAt })
      .returning()
    const batch = batchRows[0]
    if (batch === undefined) throw new Error('建批次失败')

    await tx.insert(importItems).values(
      input.files.map((f) => ({
        batchId: batch.id,
        fileName: f.fileName,
        sizeBytes: f.sizeBytes,
        // ⚠️ 这个模板必须和 `storage/r2.ts` 的 `tempKeyFor` **逐字一致**：签发预签名
        //    PUT 用的是那边拼出来的键，而 commit 以这一列为准（见 listBatchTempKeys）。
        //    两边写岔的表现是**每一次 commit 都 VALIDATION_FAILED**——响亮地坏，
        //    不会静默放行。导入的每个端到端用例都会踩到它，所以改这里必然打红。
        tempStorageKey: `temp/${batch.id}/${f.fileName}`,
      })),
    )
    return batch
  })
}

export async function findBatchById(
  batchId: string,
  db: Db = defaultDb,
): Promise<ImportBatchRow | null> {
  const rows = await db.select().from(importBatches).where(eq(importBatches.id, batchId)).limit(1)
  return rows[0] ?? null
}

/**
 * 抢下「这一批开始处理」的原子标志。
 *
 * 条件更新而不是先查后写：两个并发的 commit 只有一个能把 `committed_at` 从 null 改掉，
 * 另一个拿到 0 行。**这不是防恶意，是防网络抖动下的重试**——重试一次就让整批文件
 * 重跑一遍 ffmpeg、重判一遍重复，用户看到的是进度条走两遍。
 */
export async function claimBatchCommit(
  batchId: string,
  userId: string,
  db: Db = defaultDb,
): Promise<ImportBatchRow | null> {
  const rows = await db
    .update(importBatches)
    .set({ committedAt: new Date() })
    .where(
      and(
        eq(importBatches.id, batchId),
        // 归属检查写进 where：拿到 0 行既可能是「不是你的」，也可能是「已经提交过」，
        // 两者在上层都要变成 404 / 幂等空操作，不能只靠 userId 在内存里比一次就完事
        eq(importBatches.userId, userId),
        isNull(importBatches.committedAt),
      ),
    )
    .returning()
  return rows[0] ?? null
}

// ── 处理过程中：写结果 ──────────────────────────────────────────────

/**
 * 批次里每个文件的暂存键。**commit 用它决定「处理哪些文件、各自的键是什么」**，
 * 客户端在请求体里传的 tempKey 只用来对照（见 `routes/imports.ts` 的 `resolveCommitItems`）。
 *
 * 这一列是导入里唯一可信的暂存键来源：它在 `createBatch` 时写死，客户端没有任何一步
 * 能改它。反过来，拿客户端传来的键直接去 `getObject` / `deleteObject` 等于把 R2 的
 * 删除权交给了请求体——正式图片的键能从响应里的 `url` 推出来，而那条路不经过任何
 * `memes` 写接口，`assertCanMutate` 拦不到（SPEC §3.4 的硬边界）。
 *
 * 不返回整行：commit 只需要文件名和键，其余列（`result`、`similar_to`……）由管线回填。
 */
export async function listBatchTempKeys(
  batchId: string,
  db: Db = defaultDb,
): Promise<{ fileName: string; tempStorageKey: string | null }[]> {
  return await db
    .select({ fileName: importItems.fileName, tempStorageKey: importItems.tempStorageKey })
    .from(importItems)
    .where(eq(importItems.batchId, batchId))
}

export type ItemResult = 'imported' | 'exact_dup' | 'needs_review' | 'failed'

export type ItemOutcome = {
  result: ItemResult
  memeId?: string | null
  similarTo?: string | null
  distance?: number | null
  reason?: string | null
}

/**
 * 写单个文件的结果。**按主键更新，不插入**——条目在 `createBatch` 时就建好了。
 *
 * 先建条目再回填是有意的：处理中途进程被杀，批次快照里那些没结论的文件就是
 * `pending`，而不是「记录不存在」。后者会让前端在重连后收到一个总数对不上的快照。
 */
export async function recordItemOutcome(
  batchId: string,
  fileName: string,
  outcome: ItemOutcome,
  db: Db = defaultDb,
): Promise<void> {
  await db
    .update(importItems)
    .set({
      result: outcome.result,
      memeId: outcome.memeId ?? null,
      similarTo: outcome.similarTo ?? null,
      distance: outcome.distance ?? null,
      reason: outcome.reason ?? null,
    })
    .where(and(eq(importItems.batchId, batchId), eq(importItems.fileName, fileName)))
}

/**
 * 批次快照。**SSE 断线后前端靠它补齐**（SPEC §1.4），所以字段名和 SSE 的
 * `done` 事件对齐，两边不该出现「快照叫 skipped、事件叫 exactDup」这种错位。
 *
 * `pending` = 还没有结论的（含正在处理的），不是「等待用户确认」。
 */
export async function getBatchSnapshot(batchId: string, db: Db = defaultDb) {
  const rows = await db
    .select({ result: importItems.result, count: sql<number>`count(*)::int` })
    .from(importItems)
    .where(eq(importItems.batchId, batchId))
    .groupBy(importItems.result)

  let total = 0
  let imported = 0
  let exactDup = 0
  let needsReview = 0
  let failed = 0

  for (const row of rows) {
    const n = Number(row.count)
    total += n
    if (row.result === 'imported') imported += n
    else if (row.result === 'exact_dup') exactDup += n
    else if (row.result === 'needs_review') needsReview += n
    else if (row.result === 'failed') failed += n
  }

  return {
    total,
    done: imported + exactDup + needsReview + failed,
    skipped: exactDup,
    pending: total - (imported + exactDup + needsReview + failed),
    imported,
    exactDup,
    needsReview,
    failed,
  }
}

/**
 * 批次内声明的总字节数。commit 时的配额复查用它。
 *
 * 用声明值而不是实际值：这一刻文件还在 R2 的 temp/ 里，没人核过实际大小。
 * 真正可信的大小在管线里按实际字节数重算（`services/import.ts`），
 * 所以这里高估或低估都只是「早一次或晚一次拒绝」，不会让超额入库。
 *
 * ⚠️ `sum()` 回来的是字符串不是 bigint，同 `getStorageUsedBytes`：postgres.js 不认
 *    聚合结果的 bigint 解析器，`sql<bigint>` 只是标注。显式转，别信类型。
 */
export async function getBatchDeclaredBytes(batchId: string, db: Db = defaultDb): Promise<bigint> {
  const rows = await db
    .select({ total: sql<bigint>`coalesce(sum(${importItems.sizeBytes}), 0)::bigint` })
    .from(importItems)
    .where(eq(importItems.batchId, batchId))
  return rows[0] === undefined ? 0n : BigInt(rows[0].total)
}

// ── 待确认队列（SPEC §6.2.3） ───────────────────────────────────────

export type ReviewQueueEntry = {
  batchId: string
  fileName: string
  tempStorageKey: string | null
  sizeBytes: bigint | null
  width: number | null
  height: number | null
  distance: number | null
  existingId: string
  existingUploaderName: string
  existingSizeBytes: bigint
  existingWidth: number | null
  existingHeight: number | null
  existingCreatedAt: Date
}

/**
 * 当前用户的全部待确认条目，**跨批次**，不按批次清理。
 *
 * ⚠️ 这就是 `import_items_result_idx` 存在的理由，也是「批次元信息 24 小时后清理但
 * `needs_review` 不清理」那条规则（image-pipeline.md §6）的落点：条目是用户的待办，
 * 不是导入日志。跟着批次一起清掉的表现是「用户的待确认队列凭空消失」。
 *
 * 关联的 `existing` 必须是**未软删**的图，否则用户会看到一个已经删掉的对比对象。
 */
export async function listReviewQueue(
  userId: string,
  db: Db = defaultDb,
): Promise<ReviewQueueEntry[]> {
  const rows = await db
    .select({
      batchId: importItems.batchId,
      fileName: importItems.fileName,
      tempStorageKey: importItems.tempStorageKey,
      sizeBytes: importItems.sizeBytes,
      distance: importItems.distance,
      existingId: memes.id,
      existingUploaderName: users.name,
      existingSizeBytes: memes.sizeBytes,
      existingWidth: memes.width,
      existingHeight: memes.height,
      existingCreatedAt: memes.createdAt,
      // 条目的宽高还没入库（它还没进 memes），derive 不出来就先留 null，
      // 前端按「只有距离和文件名」降级展示，不要编一个 0 出来
      width: sql<number | null>`null`,
      height: sql<number | null>`null`,
    })
    .from(importItems)
    .innerJoin(importBatches, eq(importItems.batchId, importBatches.id))
    .innerJoin(memes, eq(importItems.similarTo, memes.id))
    .innerJoin(users, eq(memes.uploaderId, users.id))
    .where(and(eq(importBatches.userId, userId), eq(importItems.result, 'needs_review'), isNull(memes.deletedAt)))
    .orderBy(asc(importItems.batchId), asc(importItems.fileName))

  return rows
}

export async function findReviewItem(
  batchId: string,
  fileName: string,
  userId: string,
  db: Db = defaultDb,
): Promise<ImportItemRow | null> {
  const rows = await db
    .select({ item: importItems })
    .from(importItems)
    .innerJoin(importBatches, eq(importItems.batchId, importBatches.id))
    .where(
      and(
        eq(importItems.batchId, batchId),
        eq(importItems.fileName, fileName),
        eq(importBatches.userId, userId),
        // 只有待确认的条目能被处理。已经处理过的返回 null，上层变 NOT_FOUND——
        // 重复点「跳过」不该报错，但也不该把一条已导入的图再导一次
        eq(importItems.result, 'needs_review'),
      ),
    )
    .limit(1)
  return rows[0]?.item ?? null
}

/** 把待确认条目改判为导入或跳过。**不在这里写 `memes`**，那要走 `data/memes.ts`。 */
export async function resolveReviewItem(
  batchId: string,
  fileName: string,
  outcome: { result: 'imported' | 'exact_dup'; memeId?: string | null },
  db: Db = defaultDb,
): Promise<void> {
  await db
    .update(importItems)
    .set({ result: outcome.result, memeId: outcome.memeId ?? null })
    .where(and(eq(importItems.batchId, batchId), eq(importItems.fileName, fileName)))
}

/**
 * 批次是否存在且属于该用户。SSE 和快照两个接口都要用。
 *
 * **归属检查放在查询里**，不在 handler 里手写一遍——手写的那份漏掉时，
 * 表现是能订阅别人的导入进度。这里刻意不做「已提交」的前置条件：
 * 快照接口要能在 commit 之前就被调用（前端 commit 后立刻拉一次）。
 */
export async function findOwnedBatch(
  batchId: string,
  userId: string,
  db: Db = defaultDb,
): Promise<ImportBatchRow | null> {
  const rows = await db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, batchId), eq(importBatches.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}
