import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 重建索引队列与搜索侧降级（任务 F 项、SPEC §6.5.4、§6.3.1）。
 *
 * 三条是这个任务最容易做错的地方，本文件逐条钉住：
 *
 *   1. **重算不重跑视觉**（「必须先知道的四件事」第 4 条）。断言方式不是读代码，
 *      是看整轮重算里一次 `/v1/chat/completions` 都没发出去过。
 *   2. **完成即删行**。`meme_id` 上有唯一索引，留着 done 记录会让这张图在
 *      下一次换模型时静默入不了队。
 *   3. **有未完成任务时搜索 `degraded: true`**，但结果照常返回、不中断。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
// 部署方不配 embedding：这一套全部来自 `embed_config` 表，顺便验了「DB 优先」
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''
// 视觉也清空：HyDE 只在视觉通道可用时才发请求，清掉之后搜索用例发出的每一个请求
// 都必然是 embedding 的，「重算没调视觉」这条断言才不会被别人的调用混淆
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme, unitVector } = await import('./helpers/factories.js')
const { recordEmbedTest, saveEmbedConfig } = await import('../src/data/ai-configs.js')
const { applyEmbedding, softDeleteMeme } = await import('../src/data/memes.js')
const { enqueueAllStale } = await import('../src/services/ai-config.js')
const { reindexMeme } = await import('../src/services/reindex.js')
const { startReindexWorker, stopReindexWorker } = await import('../src/queue/reindex-worker.js')
const { searchMemes } = await import('../src/services/search.js')
const { memes, reindexJobs } = await import('../src/data/schema.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

const EMBED_INPUT = {
  baseUrl: 'https://site-embed.example.test',
  model: 'site-embed-b',
  apiKey: 'sk-site-embed-0000-4455',
}

let calledPaths: string[] = []

beforeEach(async () => {
  await truncateAll(sql)
  calledPaths = []
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit) => {
    const href = String(url)
    calledPaths.push(href)
    if (href.endsWith('/v1/embeddings')) {
      const requested = (JSON.parse(String(init.body)) as { dimensions?: number }).dimensions ?? 1024
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array<number>(requested).fill(0.01) }] }),
        { status: 200 },
      )
    }
    throw new Error(`重算不该发这个请求：${href}`)
  })
})

afterEach(async () => {
  await stopReindexWorker()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

/** 配好全站 embedding 通道，走真实路径（测试记录 → 保存）。 */
async function configureEmbed(): Promise<void> {
  await recordEmbedTest(EMBED_INPUT, { ok: true, nativeDim: 1024, dimParamWorks: true }, db)
  await saveEmbedConfig(EMBED_INPUT, db)
}

/** 一张已经打过标、但向量是旧模型算的图。 */
async function seedStaleMeme(uploaderId: string): Promise<string> {
  const meme = await makeMeme(db, {
    uploaderId,
    searchText: '今天不想上班 一只趴在桌上的猫 疲惫',
    description: '一只趴在桌上的猫，眼神疲惫',
    tags: ['猫'],
    visionModel: 'some-vision-model',
    tagStatus: 'ok',
  })
  await applyEmbedding(meme.id, unitVector(0), 'site-embed-a', db)
  return meme.id
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待超时（${timeoutMs}ms）`)
}

describe('reindexMeme', () => {
  it('只重算向量，**不碰任何 AI 产出字段**，也不调视觉', async () => {
    await configureEmbed()
    const user = await createUser(db)
    const memeId = await seedStaleMeme(user.id)

    const outcome = await reindexMeme(memeId)
    expect(outcome.kind).toBe('done')

    const [meme] = await db.select().from(memes).where(eq(memes.id, memeId))
    expect(meme?.embedModel).toBe('site-embed-b')
    // 手工编辑过的字段被覆盖是这条规则真正防的事故，所以逐个断言
    expect(meme?.description).toBe('一只趴在桌上的猫，眼神疲惫')
    expect(meme?.tags).toEqual(['猫'])
    expect(meme?.visionModel).toBe('some-vision-model')
    expect(meme?.searchText).toBe('今天不想上班 一只趴在桌上的猫 疲惫')

    // 靠 import 列表保证的事，这里用实际发出的请求再验一次
    expect(calledPaths.every((p) => p.endsWith('/v1/embeddings'))).toBe(true)
  })

  it('图在排队期间被删了 → gone，不是失败', async () => {
    await configureEmbed()
    const user = await createUser(db)
    const memeId = await seedStaleMeme(user.id)
    await softDeleteMeme(memeId, user, db)

    expect((await reindexMeme(memeId)).kind).toBe('gone')
    expect(calledPaths).toHaveLength(0)
  })

  it('没配 embedding 通道 → not_configured，不消费重试次数', async () => {
    const user = await createUser(db)
    const memeId = await seedStaleMeme(user.id)

    expect((await reindexMeme(memeId)).kind).toBe('not_configured')
    expect(calledPaths).toHaveLength(0)
  })
})

describe('enqueueAllStale', () => {
  it('软删的图不入队', async () => {
    await configureEmbed()
    const user = await createUser(db)
    const alive = await seedStaleMeme(user.id)
    const dead = await seedStaleMeme(user.id)
    await softDeleteMeme(dead, user, db)

    expect(await enqueueAllStale()).toBe(1)

    const jobs = await db.select().from(reindexJobs)
    expect(jobs.map((j) => j.memeId)).toEqual([alive])
  })

  it('已经是当前模型的图不入队', async () => {
    await configureEmbed()
    const user = await createUser(db)
    const fresh = await makeMeme(db, { uploaderId: user.id, searchText: '已经是新模型了' })
    await applyEmbedding(fresh.id, unitVector(1), EMBED_INPUT.model, db)

    expect(await enqueueAllStale()).toBe(0)
  })
})

describe('重建 worker', () => {
  it('把队列跑空，完成即删行', async () => {
    await configureEmbed()
    const user = await createUser(db)
    const memeId = await seedStaleMeme(user.id)
    await enqueueAllStale()

    startReindexWorker()
    await waitFor(async () => (await db.select().from(reindexJobs)).length === 0)

    const [meme] = await db.select().from(memes).where(eq(memes.id, memeId))
    expect(meme?.embedModel).toBe(EMBED_INPUT.model)

    // 留一条 done 记录的话，这张图在下一次换模型时会被 onConflictDoNothing 静默跳过
    expect(await db.select().from(reindexJobs)).toHaveLength(0)
  })
})

describe('搜索侧降级（SPEC §6.3.1）', () => {
  it('有未完成的重算任务时 degraded: true，但结果照常返回', async () => {
    await configureEmbed()
    const user = await createUser(db)
    const memeId = await seedStaleMeme(user.id)
    await enqueueAllStale()

    const outcome = await searchMemes('不想上班', 10, user.id, 'req-degraded', db)

    // 关键是**两条同时成立**：降级标记打上了，而结果一条不少
    expect(outcome.degraded).toBe(true)
    expect(outcome.items.map((item) => item.id)).toContain(memeId)
  })

  it('队列空时不降级（向量路本身是通的）', async () => {
    await configureEmbed()
    const user = await createUser(db)
    const fresh = await makeMeme(db, { uploaderId: user.id, searchText: '今天不想上班' })
    await applyEmbedding(fresh.id, unitVector(0), EMBED_INPUT.model, db)

    const outcome = await searchMemes('不想上班', 10, user.id, 'req-normal', db)

    expect(outcome.degraded).toBe(false)
  })
})
