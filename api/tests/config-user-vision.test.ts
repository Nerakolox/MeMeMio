import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 任务 E 项的回归测试：**部署方没配视觉通道、但用户自己配了**。
 *
 * 这是本任务点名要处理的那条（`queue/worker.ts:139` 的 `isVisionConfigured()`）。
 * 改之前它是个纯环境变量判断，用户自带 key 之后那个前提不成立了——
 * 表现是**这些用户的图永远停在 pending**：worker 60 秒轮询一次、一条都不取，
 * 不报错、不告警、不重试，进度条上什么都看不出来。
 *
 * 单开一个文件的理由同 `tag-queue-unconfigured.test.ts`：要的是「进程启动时
 * `DEFAULT_VISION_*` 就是空的」，而 `env.ts` 在首次 import 时把值冻住，
 * 同一个文件里没法既有配置又没配置。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
// 部署方一项都没配。和 tag-queue-unconfigured 的区别只有一个：这里库里有用户配置
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
const { recordVisionTest, saveUserVisionConfig } = await import('../src/data/ai-configs.js')
const { isVisionConfigured, resolveVisionConfig } = await import('../src/ai/vision.js')
const { tagMeme } = await import('../src/services/tagging.js')
const { startTagWorker, stopTagWorker } = await import('../src/queue/worker.js')
const { memes, tagJobs, userAiConfigs } = await import('../src/data/schema.js')
const { loadFixture, FIXTURES } = await import('./helpers/fixtures.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

/** 用户自己那把 key。断言「发出去的是哪一把」全靠它。 */
const USER_KEY = 'sk-user-own-key-4d2f9a1b-9911'

const USER_INPUT = {
  baseUrl: 'https://own-relay.example.test',
  model: 'user-vision-model',
  apiKey: USER_KEY,
}

let authHeaders: string[] = []

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
  authHeaders = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

/** 让视觉调用成功返回一份能过词表校验的正文。顺便记下每次的 Authorization 头。 */
function stubVision(): void {
  vi.stubGlobal('fetch', async (_url: string | URL | Request, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    authHeaders.push(headers['Authorization'] ?? '')
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ocrText: '今天不想上班',
                description: '一只趴在桌上的猫，眼神疲惫，配着「今天不想上班」的文字',
                emotions: [],
                scenes: [],
                tags: [],
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }),
      { status: 200 },
    )
  })
}

/** 走**真实路径**配一条通过测试的视觉配置：先落测试记录，再保存。 */
async function configureUserVision(userId: string): Promise<void> {
  await recordVisionTest(userId, USER_INPUT, { ok: true, jsonModeWorks: true, multiImage: true }, db)
  await saveUserVisionConfig(userId, USER_INPUT, db)
}

async function seedPendingJob(userId: string): Promise<string> {
  const bytes = await loadFixture(FIXTURES.staticPng)
  const storageKey = `memes/${crypto.randomUUID()}.png`
  seedObject(storageKey, bytes)

  const meme = await makeMeme(db, { uploaderId: userId, storageKey })
  await db.transaction(async (tx) => enqueueTagJob(meme.id, userId, tx))
  return meme.id
}

describe('isVisionConfigured()：部署方 **或** 任何一个用户', () => {
  it('两边都没有时为假', async () => {
    expect(await isVisionConfigured()).toBe(false)
  })

  it('有一条通过测试的用户配置就为真——这条是改之前的 bug', async () => {
    const user = await createUser(db)
    await configureUserVision(user.id)

    expect(await isVisionConfigured()).toBe(true)
  })

  it('没通过测试的配置行不算数（verified_at 为 null）', async () => {
    // 「测过但没通过的行不能进生产打标」和「值不值得取任务」用的必须是同一条判据，
    // 否则 worker 会为了一条永远解析不出来的配置不停地空取任务
    const user = await createUser(db)
    await db.insert(userAiConfigs).values({
      userId: user.id,
      visionBaseUrl: USER_INPUT.baseUrl,
      visionModel: USER_INPUT.model,
      visionApiKeyEnc: Buffer.from('not-a-real-ciphertext'),
      verifiedAt: null,
    })

    expect(await isVisionConfigured()).toBe(false)
    expect(await resolveVisionConfig(user.id)).toBeNull()
  })
})

describe('部署方没配、用户自己配了', () => {
  it('worker 把任务取走并跑完，不再永远 pending', async () => {
    const user = await createUser(db)
    await configureUserVision(user.id)
    const memeId = await seedPendingJob(user.id)
    stubVision()

    startTagWorker()
    try {
      // 取到任务的话这条在一秒内就跑完了（同一套脚手架的其他用例都是）。
      // 没修之前这里会超时：worker 压根不取任务
      await waitFor(async () => {
        const [job] = await db.select().from(tagJobs).where(eq(tagJobs.memeId, memeId))
        return job?.status === 'done'
      })
    } finally {
      await stopTagWorker()
    }

    const [job] = await db.select().from(tagJobs).where(eq(tagJobs.memeId, memeId))
    expect(job?.lastError).toBeNull()

    const [meme] = await db.select().from(memes).where(eq(memes.id, memeId))
    expect(meme?.tagStatus).toBe('ok')
  })

  it('发出去的是**用户那把 key**，不是部署方的（部署方压根没有）', async () => {
    const user = await createUser(db)
    await configureUserVision(user.id)
    const memeId = await seedPendingJob(user.id)
    stubVision()

    const outcome = await tagMeme(memeId, new AbortController().signal)

    expect(outcome.kind).toBe('done')
    expect(authHeaders.length).toBeGreaterThan(0)
    // 这一条才是「用他自己的 key 打标」的硬证据。只断言 tagStatus 的话，
    // 拿别人的 key 跑通也一样是 ok
    expect(new Set(authHeaders)).toEqual(new Set([`Bearer ${USER_KEY}`]))

    // embedding 没配是正常降级：打标照常完成，只是没有向量
    const [meme] = await db.select().from(memes).where(eq(memes.id, memeId))
    expect(meme?.tagStatus).toBe('ok')
    expect(meme?.embedding).toBeNull()
    expect(meme?.visionModel).toBe(USER_INPUT.model)
  })

  it('没配的那个用户仍然走 not_configured，不受别人的配置影响', async () => {
    // `isVisionConfigured()` 为真只说明「值得去取任务」，不代表每个人都配了。
    // 取到之后还要按上传者逐条解析——这条防的是把全局判断当成逐条判断用
    const configured = await createUser(db)
    await configureUserVision(configured.id)

    const bare = await createUser(db)
    const memeId = await seedPendingJob(bare.id)
    stubVision()

    const outcome = await tagMeme(memeId, new AbortController().signal)

    expect(outcome.kind).toBe('not_configured')
    expect(authHeaders).toHaveLength(0)
  })
})

/** 轮询等待。worker 是异步的，固定 sleep 要么太短要么白等。 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待超时（${timeoutMs}ms）`)
}
