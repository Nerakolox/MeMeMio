import { Hono } from 'hono'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 队列可靠性（joint-tasks/2026-09-24-queue-reliability.md）。
 *
 * 这一组钉的全是**不报错、只静默变坏**的那类问题：
 *
 *   1. 停机时在途任务停在 `running`（图再也不会被打标）
 *   2. 僵死任务只在启动时扫一次（几秒内重启就再也捞不到）
 *   3. 毒任务被无限重领（每次领取都崩，永远走不到重试矩阵）
 *   4. 超时后迟到的写入盖掉已经被放回 / 已被别人领走的行
 *   5. 重建索引用 offset 翻页 + 边入队边完成 → 漏行，而那部分**永远召回不到**
 *   6. 批次跑到一半退出，没人等也没人续
 *   7. SSE 发完 `done` 不关连接
 *
 * 每条都用「可观察的结果」断言，不读代码：库里那一行长什么样、对象存了几个、
 * 连接有没有关。**只有第 1 条的时间预算在 `src/shutdown.test.ts` 里单独钉**
 * （收尾总时限必须短于 Docker 的 10 秒 `stop_grace_period`）。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 全部 env 必须在 import 任何 src 模块之前设好：env.ts 在首次 import 时就冻结
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
process.env['DEFAULT_VISION_BASE_URL'] = 'https://vision.test'
process.env['DEFAULT_VISION_API_KEY'] = 'vision-key-not-real'
process.env['DEFAULT_VISION_MODEL'] = 'test-vision'
process.env['DEFAULT_EMBED_BASE_URL'] = 'https://embed.test'
process.env['DEFAULT_EMBED_API_KEY'] = 'embed-key-not-real'
process.env['DEFAULT_EMBED_MODEL'] = 'test-embed'

/**
 * 「边入队边完成」的交错钩子。
 *
 * `enqueueAllStale` 是「翻一页 → 入队 → 再翻下一页」，而 worker 会在两次翻页**之间**
 * 把已入队的那些算完（`embed_model` 被写上）——于是它们掉出 `WHERE` 集合。
 * 这就是 offset 翻页漏行的现场。要让这个交错真的发生在测试里，只能在
 * `enqueueReindexJobs` 上挂一个钩子：真实实现照跑，跑完顺手把这一批"算完"。
 *
 * `vi.hoisted` 是因为 `vi.mock` 的提升：工厂会在文件顶部的 import 之前执行。
 */
const { interleave } = vi.hoisted(() => ({
  interleave: { calls: 0, enabled: false, finished: 0, model: '' },
}))

vi.mock('../src/data/reindex-jobs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/reindex-jobs.js')>()
  return {
    ...actual,
    enqueueReindexJobs: async (
      memeIds: string[],
      db?: Parameters<typeof actual.enqueueReindexJobs>[1],
    ): Promise<number> => {
      const inserted = await actual.enqueueReindexJobs(memeIds, db)
      interleave.calls += 1
      if (!interleave.enabled || interleave.model === '') return inserted

      const { db: defaultDb } = await import('../src/data/db.js')
      const { memes } = await import('../src/data/schema.js')
      const { inArray } = await import('drizzle-orm')
      // 模拟 worker 把这一批算完：`embed_model` 一写，它们就不再是「过期」的了
      await defaultDb
        .update(memes)
        .set({ embedModel: interleave.model })
        .where(inArray(memes.id, memeIds))
      interleave.finished += memeIds.length
      return inserted
    },
  }
})

const { installR2Memory, resetR2, seedObject, r2Calls } = await import('./helpers/r2-memory.js')
installR2Memory()

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme, TEST_EMBED_DIM } = await import('./helpers/factories.js')
const { FIXTURES, loadFixture } = await import('./helpers/fixtures.js')
const { createSession } = await import('../src/data/auth.js')
const { recordEmbedTest, saveEmbedConfig } = await import('../src/data/ai-configs.js')
const {
  createBatch,
  claimBatchCommit,
  getBatchSnapshot,
  listResumableBatches,
  recordItemOutcome,
} = await import('../src/data/imports.js')
const {
  claimOf,
  claimTagJob,
  enqueueTagJob,
  markTagJobDone,
  markTagJobFailed,
  markTagJobRetry,
  releaseRunningTagJobs,
  RELEASED_ON_SHUTDOWN,
} = await import('../src/data/tag-jobs.js')
const { startTagWorker, stopTagWorker } = await import('../src/queue/worker.js')
const { enqueueAllStale } = await import('../src/services/ai-config.js')
const { resumeInterruptedBatches, runBatch } = await import('../src/services/import.js')
const { publish, subscriberCount } = await import('../src/services/import-events.js')
const { MAX_TAG_CLAIMS } = await import('../src/lib/retry-policy.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { importRoutes } = await import('../src/routes/imports.js')
const { importItems, memes, tagJobs } = await import('../src/data/schema.js')
// `sql` 这个名字已经被 `createTestDb()` 的 postgres.js 标签占用了，这里换个名
const { and, eq, sql: dsql } = await import('drizzle-orm')
const { randomUUID } = await import('node:crypto')

const { sql, db } = createTestDb()

/** 导入路由的挂载方式和 `app.ts` 一致（含 `requestId`，SSE 那条要用）。 */
const testApp = new Hono().use('*', requestId).route('/api/v1/imports', importRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
  interleave.calls = 0
  interleave.enabled = false
  interleave.finished = 0
  interleave.model = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

// ── 脚手架 ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await sleep(20)
  }
}

/** 把视觉调用挂住——「一个卡在 15 秒 HTTP 调用上的在途任务」的真实形状。 */
function hangFetch(): void {
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
}

async function jobRow(memeId: string) {
  const [row] = await db.select().from(tagJobs).where(eq(tagJobs.memeId, memeId))
  if (row === undefined) throw new Error('任务不见了')
  return row
}

async function memeRow(id: string) {
  const [row] = await db.select().from(memes).where(eq(memes.id, id))
  if (row === undefined) throw new Error('图不见了')
  return row
}

/** 建一张图 + 一条 `pending` 任务。队列里那一行的 id 由 `tag_jobs_meme_id_key` 定住。 */
async function enqueueOne(): Promise<{ userId: string; memeId: string }> {
  const user = await createUser(db)
  const meme = await makeMeme(db, { uploaderId: user.id })
  // ⚠️ **图必须真的存在。** 对象不在的话 `prepareImages` 立刻抛，
  //    任务在几毫秒内变成 `failed`、根本停不在 `running` 上——
  //    而「停机时在途任务怎么办」测的正是它停在 `running` 的那一刻
  seedObject(meme.storageKey, await loadFixture(FIXTURES.staticPng))
  await db.transaction(async (tx) => enqueueTagJob(meme.id, user.id, tx))
  return { userId: user.id, memeId: meme.id }
}

/** `docs/fixtures/images/` 下的样本，文件名取基名（接口会拒掉带路径分隔符的名字）。 */
async function sample(names: string[]): Promise<{ name: string; bytes: Buffer }[]> {
  return await Promise.all(
    names.map(async (name) => ({
      name: name.slice(name.lastIndexOf('/') + 1),
      bytes: await loadFixture(name),
    })),
  )
}

type Actor = { id: string; cookie: string }

async function signIn(): Promise<Actor> {
  const user = await createUser(db)
  const session = await createSession(user.id, db)
  return { id: user.id, cookie: `sid=${session.id}` }
}

// ── §1 停机 ────────────────────────────────────────────────────────

describe('停机把在途任务放回队列', () => {
  it('收尾时限到点后任务回到 pending，不停在 running', async () => {
    hangFetch()
    const { memeId } = await enqueueOne()

    startTagWorker()
    await waitFor(async () => (await jobRow(memeId)).status === 'running', '任务被领取')

    // 收尾时限短一点，别让用例干等 4 秒；生产的 4 秒写在 SHUTDOWN_DRAIN_MS 上
    await stopTagWorker(150)

    const job = await jobRow(memeId)
    expect(job.status).toBe('pending')
    expect(job.lastError).toBe(RELEASED_ON_SHUTDOWN)
  })

  it('超时之后那份工作晚一步写回来的结论，盖不掉已经被放回的行', async () => {
    hangFetch()
    const { memeId } = await enqueueOne()

    startTagWorker()
    await waitFor(async () => (await jobRow(memeId)).status === 'running', '任务被领取')
    await stopTagWorker(150)

    const job = await jobRow(memeId)
    // 这就是超时那一刻还在后台跑的那份工作手里的领取标识：id + 本次的 attempts。
    // 它晚一步写回「完成」时，行已经回到 pending 了，条件命不中
    const lateClaim = { id: job.id, attempts: job.attempts }
    expect(await markTagJobDone(lateClaim)).toBe(false)
    expect((await jobRow(memeId)).status).toBe('pending')
  })
})

// ── §2 周期回收 ────────────────────────────────────────────────────

describe('僵死任务的回收', () => {
  it('进程不重启也能回收：启动之后才变成 running 的行照样被捞回来', async () => {
    hangFetch()
    const { memeId } = await enqueueOne()
    const row = await jobRow(memeId)

    startTagWorker({ sweepIntervalMs: 150 })
    // **先等启动那一次扫完**：这一行是启动之后才被改成 running 的，
    // 所以能捞到它的只可能是周期扫描——这正是「只在启动时扫一次」不成立的地方
    await sleep(500)
    await sql`
      update tag_jobs
      set status = 'running', run_after = now() - interval '10 minutes'
      where id = ${row.id}
    `

    // 判据是这一条 last_error——它只有 `requeueStaleRunningJobs` 会写。
    // （任务就算紧接着又被领走也不会覆盖它：`claimTagJob` 不动 last_error，
    //  所以这个断言不会因为「worker 手快」而闪）
    await waitFor(
      async () => (await jobRow(memeId)).lastError === 'worker 异常退出，任务被回收',
      '僵死任务被周期扫描回收',
    )

    await stopTagWorker(150)
  })
})

// ── §7 毒任务 ──────────────────────────────────────────────────────

describe('毒任务', () => {
  it('重领次数达上限的任务在领取这一步落终局失败，不再被无限重领', async () => {
    hangFetch()
    const { memeId } = await enqueueOne()
    const row = await jobRow(memeId)

    // 「每次领取都把进程打崩」的任务 attempts 会一路涨上去，而它永远走不到
    // `applyFailure`——重试矩阵根本没机会运行
    await sql`
      update tag_jobs
      set attempts = ${MAX_TAG_CLAIMS}, run_after = now() - interval '1 minute'
      where id = ${row.id}
    `

    startTagWorker()
    await waitFor(
      async () => (await memeRow(memeId)).tagStatus === 'needs_manual',
      '图被落成 needs_manual',
    )
    await stopTagWorker(150)

    const job = await jobRow(memeId)
    expect(job.status).toBe('failed')
    expect(job.lastError).toContain('重试次数已耗尽')
    // 不再被领取：跑一小会儿，attempts 不许再涨
    const attempts = job.attempts
    await sleep(200)
    expect((await jobRow(memeId)).attempts).toBe(attempts)
  })
})

// ── §4 迟到的写入 ──────────────────────────────────────────────────

describe('迟到的写入', () => {
  it('被放回 pending 之后，原来那次领取的完成 / 重试 / 失败全部命不中', async () => {
    const { memeId } = await enqueueOne()

    const claim = await claimTagJob()
    expect(claim.kind).toBe('job')
    if (claim.kind !== 'job') return
    const stale = claimOf(claim.job)

    // 停机（或超时）把这一行放回队列。`attempts` 没变，变的是 status
    await releaseRunningTagJobs([claim.job.id])
    expect((await jobRow(memeId)).status).toBe('pending')

    expect(await markTagJobDone(stale)).toBe(false)
    expect(await markTagJobRetry(stale, new Date(), '迟到')).toBe(false)
    expect(await markTagJobFailed(stale, '迟到')).toBe(false)

    const job = await jobRow(memeId)
    expect(job.status).toBe('pending')
    // 只有停机那次写下的理由，没有「迟到」留下的任何痕迹
    expect(job.lastError).toBe(RELEASED_ON_SHUTDOWN)
  })

  it('被别的进程重新领走之后，旧标识同样命不中', async () => {
    const { memeId } = await enqueueOne()

    const first = await claimTagJob()
    expect(first.kind).toBe('job')
    if (first.kind !== 'job') return
    const stale = claimOf(first.job)

    // 排入重试时把 run_after 提前，让下一个进程立刻能领到
    expect(await markTagJobRetry(stale, new Date(Date.now() - 1_000), '抖动')).toBe(true)

    const second = await claimTagJob()
    expect(second.kind).toBe('job')
    if (second.kind !== 'job') return
    // 领取把 attempts 加了 1，所以两次领取的标识不可能相同
    expect(second.job.attempts).toBeGreaterThan(stale.attempts)

    expect(await markTagJobDone(stale)).toBe(false)
    expect((await jobRow(memeId)).status).toBe('running')

    // 真正领到它的那次写回才是有效的
    expect(await markTagJobDone(claimOf(second.job))).toBe(true)
    expect((await jobRow(memeId)).status).toBe('done')
  })
})

// ── §5 重建索引翻页 ────────────────────────────────────────────────

const EMBED_INPUT = {
  baseUrl: 'https://site-embed.example.test',
  model: 'site-embed-reliability',
  apiKey: 'sk-site-embed-0000-1122',
}

/** 建 `count` 张「有 search_text、还没算当前模型向量」的图。 */
async function seedStale(userId: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    uploaderId: userId,
    storageKey: `test/stale-${i}.png`,
    contentHash: randomUUID().replace(/-/g, ''),
    phash: 0n,
    mime: 'image/png',
    sizeBytes: 1024n,
    isAnimated: false,
    searchText: `第 ${i} 张`,
    tagStatus: 'ok',
  }))
  await db.insert(memes).values(rows)
}

describe('重建索引入队', () => {
  it('入队与消费交错时一张不漏（offset 翻页会漏，keyset 不会）', async () => {
    const user = await createUser(db)
    await recordEmbedTest(EMBED_INPUT, {
      ok: true,
      nativeDim: TEST_EMBED_DIM,
      dimParamWorks: true,
    })
    await saveEmbedConfig(EMBED_INPUT)

    // 必须超过一页（`ENQUEUE_PAGE` = 1000），否则根本不会翻第二页，
    // 而这个 bug 只在第二页及以后出现
    const total = 1100
    await seedStale(user.id, total)

    interleave.model = EMBED_INPUT.model
    interleave.enabled = true
    const enqueued = await enqueueAllStale()
    interleave.enabled = false

    // 一张不漏。offset 翻页的话这里会是 1000：第二页 offset=1000 落在只剩 100 行的
    // 结果集之外，于是那 100 张既不排队也不报错——**永远召回不到**
    //
    // ⚠️ **这一条排在前面是有意的。** 断言顺序就是失败时的信息量：放第一条，
    //    offset 翻页红的理由是「expected 1000 to be 1100」（就是那个 bug 本身）；
    //    放在最后的话，先炸的是下面那句 `calls >= 2`（第二页根本没来），
    //    读的人得自己把两件事连起来才看得出漏的是行、不是页
    expect(enqueued).toBe(total)
    // 交错真的发生了：翻了两页以上，而且每一批入队之后都被"算完"了。
    // 这两条是上面那句的**前提校验**——如果交错没发生，enqueued === total 就
    // 变得毫无意义（一个从来没翻过页的实现也能让它绿）
    expect(interleave.calls).toBeGreaterThanOrEqual(2)
    expect(interleave.finished).toBe(total)
  })
})

// ── §9 批次续跑 ────────────────────────────────────────────────────

describe('批次续跑', () => {
  it('接着跑「已提交 + 还有 pending 条目」的批次，已下结论的条目不动', async () => {
    const actor = await createUser(db)
    const samples = await sample([FIXTURES.staticPng, FIXTURES.staticJpg, FIXTURES.staticWebp])

    const batch = await createBatch({
      userId: actor.id,
      files: samples.map((s) => ({ fileName: s.name, sizeBytes: BigInt(s.bytes.byteLength) })),
    })
    await claimBatchCommit(batch.id, actor.id)
    // 预签名直传那一步：三个文件都传完了
    for (const s of samples) seedObject(`temp/${batch.id}/${s.name}`, s.bytes)

    // 第一个文件上一轮已经跑完、并且判了失败——续跑**不许碰它**
    const first = samples[0]
    if (first === undefined) throw new Error('样本不见了')
    await recordItemOutcome(batch.id, first.name, { result: 'failed', reason: '上一轮就失败了' })

    await resumeInterruptedBatches()

    const snapshot = await getBatchSnapshot(batch.id)
    expect(snapshot.total).toBe(3)
    expect(snapshot.pending).toBe(0)
    expect(snapshot.failed).toBe(1)
    expect(snapshot.imported + snapshot.exactDup).toBe(2)

    const [item] = await db
      .select()
      .from(importItems)
      .where(and(eq(importItems.batchId, batch.id), eq(importItems.fileName, first.name)))
    // 先写入者赢：续跑重新得出的结论没有覆盖上一轮那条
    expect(item?.reason).toBe('上一轮就失败了')
    // 那个 temp 对象也不该被续跑删掉（它上一轮的结论是失败，不是消费掉了）
    expect(item?.result).toBe('failed')
  })

  it('没提交的、以及元信息已过期的批次都不续跑', async () => {
    const actor = await createUser(db)
    const one = [{ fileName: 'a.png', sizeBytes: 1024n }]

    await createBatch({ userId: actor.id, files: one })

    const expired = await createBatch({ userId: actor.id, files: one })
    await claimBatchCommit(expired.id, actor.id)
    await sql`update import_batches set expires_at = now() - interval '1 hour' where id = ${expired.id}`

    const normal = await createBatch({ userId: actor.id, files: one })
    await claimBatchCommit(normal.id, actor.id)

    // 元信息 24 小时后被清理（image-pipeline.md §6），在那之后续一批只剩半截的记录
    // 没有意义；没提交的批次是「还没开始」，不是「被打断」
    const resumable = await listResumableBatches()
    expect(resumable.map((batch) => batch.batchId)).toEqual([normal.id])
    expect(resumable[0]?.items).toEqual([{ fileName: 'a.png', tempStorageKey: `temp/${normal.id}/a.png` }])
  })

  it('同一批次重复触发是空操作，不产生重复的对象', async () => {
    const actor = await createUser(db)
    const samples = await sample([FIXTURES.staticPng, FIXTURES.staticJpg, FIXTURES.staticWebp])

    const batch = await createBatch({
      userId: actor.id,
      files: samples.map((s) => ({ fileName: s.name, sizeBytes: BigInt(s.bytes.byteLength) })),
    })
    await claimBatchCommit(batch.id, actor.id)
    for (const s of samples) seedObject(`temp/${batch.id}/${s.name}`, s.bytes)

    const files = samples.map((s) => ({ fileName: s.name, tempKey: `temp/${batch.id}/${s.name}` }))
    // 同一次微任务里触发两遍：`claimBatchCommit` 只挡得住并发的两个 commit，
    // 挡不住「启动续跑扫到了刚到的那一批」这种时间差
    await Promise.all([runBatch(batch.id, actor.id, files), runBatch(batch.id, actor.id, files)])

    const [counted] = await db
      .select({ count: dsql<number>`count(*)::int` })
      .from(memes)
      .where(eq(memes.uploaderId, actor.id))
    const count = counted?.count ?? 0
    expect(count).toBe(3)

    // 3 张原图 + 3 张缩略图。跑两遍的话这里会是 12——第二次的写入会留下
    // **没有任何记录指向的孤儿对象**（`memes/` 前缀不在定时清理范围内）
    expect(r2Calls.commands.filter((command) => command.kind === 'put')).toHaveLength(6)
  })
})

// ── §8 SSE ─────────────────────────────────────────────────────────

describe('SSE 在终态之后关闭', () => {
  it('批次发完 done 就把连接关掉，不再挂着心跳', async () => {
    const actor = await signIn()
    const batch = await createBatch({
      userId: actor.id,
      files: [{ fileName: 'a.png', sizeBytes: 1024n }],
    })
    await claimBatchCommit(batch.id, actor.id)

    const response = await testApp.request(`/api/v1/imports/${batch.id}/events`, {
      headers: { cookie: actor.cookie },
    })
    expect(response.status).toBe(200)

    // ⚠️ 必须**先开始读**：`streamSSE` 的第一次写入要有读者才推得动，
    //    否则订阅还没挂上，事件就发出去了
    const body = response.text()
    await waitFor(() => subscriberCount(batch.id) === 1, 'SSE 订阅挂上')

    publish(batch.id, {
      event: 'done',
      data: { total: 1, imported: 1, exactDup: 0, needsReview: 0, failed: 0 },
    })

    // 连接真的关了 → 读得到结束；不关的话这里会一直挂到心跳超时
    const text = await withTimeout(body, 5_000)
    expect(text).toContain('event: done')
    expect(subscriberCount(batch.id)).toBe(0)
  })

  it('批次级失败（error）同样关连接', async () => {
    const actor = await signIn()
    const batch = await createBatch({
      userId: actor.id,
      files: [{ fileName: 'a.png', sizeBytes: 1024n }],
    })

    const response = await testApp.request(`/api/v1/imports/${batch.id}/events`, {
      headers: { cookie: actor.cookie },
    })
    const body = response.text()
    await waitFor(() => subscriberCount(batch.id) === 1, 'SSE 订阅挂上')

    publish(batch.id, { event: 'error', data: { code: 'INTERNAL', message: '批次级失败' } })

    const text = await withTimeout(body, 5_000)
    expect(text).toContain('event: error')
  })
})

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`等待超时（${ms}ms）：SSE 连接没有被关掉`)
    }),
  ])
}
