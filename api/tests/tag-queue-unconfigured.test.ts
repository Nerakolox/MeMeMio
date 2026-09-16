import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 没配视觉通道时的行为：**不消费、不失败重试，图留在 pending**（queue.md §3 最后一行）。
 *
 * 单开一个文件是因为它要的是「进程启动时 `DEFAULT_VISION_*` 就是空的」——`env.ts`
 * 在首次 import 时把值冻住，同一个文件里没法既有配置又没配置。
 *
 * 这条规则值得单测，是因为最自然的写法会把它做错：取任务 → 发现没配置 → 当成失败
 * 重试。那样退避五轮之后整库的图都会变成 `needs_manual`，而部署方只是还没来得及填
 * 环境变量。填完之后本该自动补打标的那批图，全都得先人工改回 pending。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
// 三个都清空。只清一个也够触发 `asCredentials` 返回 null，但那测的是「缺一项」，
// 不是「压根没配」——部署方漏配时三项通常一起是空的
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''

const { installR2Memory, resetR2, seedObject } = await import('./helpers/r2-memory.js')
installR2Memory()

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { enqueueTagJob } = await import('../src/data/tag-jobs.js')
const { isVisionConfigured } = await import('../src/ai/vision.js')
const { tagMeme } = await import('../src/services/tagging.js')
const { startTagWorker, stopTagWorker } = await import('../src/queue/worker.js')
const { memes, tagJobs } = await import('../src/data/schema.js')
const { loadFixture, FIXTURES } = await import('./helpers/fixtures.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

let fetchCalls = 0

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
  fetchCalls = 0
  // 任何一次外部调用都是 bug：没配置就不该有人去调
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    fetchCalls += 1
    throw new Error(`没配视觉通道却发起了调用：${String(input)}`)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

async function seedPendingJob(): Promise<string> {
  const user = await createUser(db)
  const bytes = await loadFixture(FIXTURES.staticPng)
  const storageKey = `memes/${crypto.randomUUID()}.png`
  seedObject(storageKey, bytes)

  const meme = await makeMeme(db, { uploaderId: user.id, storageKey })
  await db.transaction(async (tx) => enqueueTagJob(meme.id, user.id, tx))
  return meme.id
}

describe('AI_NOT_CONFIGURED', () => {
  it('配置为空时 isVisionConfigured() 为假', () => {
    expect(isVisionConfigured()).toBe(false)
  })

  it('worker 起着但不消费：任务留在 pending，attempts 不涨', async () => {
    const memeId = await seedPendingJob()

    startTagWorker()
    try {
      // worker 空转一轮的间隔是 60s，这里只要给它足够的时间「本来会取走任务」。
      // 1 秒里正常配置下这条任务早就跑完了（同一套脚手架的其他用例都在 1 秒内结束）
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    } finally {
      await stopTagWorker()
    }

    const [job] = await db.select().from(tagJobs).where(eq(tagJobs.memeId, memeId))
    // 关键是这三条：**没被取走**（pending）、**没算一次尝试**（attempts 0）、
    // **没被判死**（tag_status 仍是 pending）。配置补上之后它会被原样捡起来
    expect(job?.status).toBe('pending')
    expect(job?.attempts).toBe(0)
    expect(job?.lastError).toBeNull()

    const [meme] = await db.select().from(memes).where(eq(memes.id, memeId))
    expect(meme?.tagStatus).toBe('pending')
    expect(meme?.embedding).toBeNull()

    expect(fetchCalls).toBe(0)
  })

  it('直接调 tagMeme 返回 not_configured，而不是失败', async () => {
    const memeId = await seedPendingJob()

    const outcome = await tagMeme(memeId, new AbortController().signal)

    // 返回 `failed` 的话 worker 会按重试矩阵处置它，最终落 needs_manual——
    // 「没配置」和「配了但不好使」必须是两件事
    expect(outcome.kind).toBe('not_configured')
    expect(fetchCalls).toBe(0)

    const [meme] = await db.select().from(memes).where(eq(memes.id, memeId))
    expect(meme?.tagStatus).toBe('pending')
  })
})
