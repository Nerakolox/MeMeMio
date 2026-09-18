import { Hono } from 'hono'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `/config/*` 六个端点与 `/admin/reindex*` 的端到端集成测试（任务 B / C / F 项、SPEC §6.5）。
 *
 * 测的是**契约**，不是实现细节：权限、脱敏串语义、探测位不接受客户端写入、
 * 三道闸门的错误码与顺序、重建入队的幂等。
 *
 * ⚠️ 全文贯穿一条断言：**任何响应体里都搜不到完整 key**（AGENTS.md §5）。
 *    它不是单独一个用例，而是每条成功路径上都顺手再验一次——只在一处验的话，
 *    下一个人加一个字段就漏了。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

/** 部署方那一套。要有值，`source: "default"` 的回显才测得到。 */
const DEPLOYER_VISION_KEY = 'sk-deployer-vision-0000-3344'
const DEPLOYER_EMBED_KEY = 'sk-deployer-embed-0000-5566'
process.env['DEFAULT_VISION_BASE_URL'] = 'https://deployer.example.test'
process.env['DEFAULT_VISION_API_KEY'] = DEPLOYER_VISION_KEY
process.env['DEFAULT_VISION_MODEL'] = 'deployer-vision'
process.env['DEFAULT_EMBED_BASE_URL'] = 'https://deployer.example.test'
process.env['DEFAULT_EMBED_API_KEY'] = DEPLOYER_EMBED_KEY
process.env['DEFAULT_EMBED_MODEL'] = 'deployer-embed'

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme, unitVector } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { applyEmbedding } = await import('../src/data/memes.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { embedConfigRoutes, visionConfigRoutes } = await import('../src/routes/config.js')
const { adminRoutes } = await import('../src/routes/admin.js')
const { reindexJobs, userAiConfigs } = await import('../src/data/schema.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

const testApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/config/vision', visionConfigRoutes)
  .route('/api/v1/config/embed', embedConfigRoutes)
  .route('/api/v1/admin', adminRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

const USER_VISION_KEY = 'sk-user-vision-abcd-7788'
const USER_EMBED_KEY = 'sk-site-embed-wxyz-2233'

type Actor = { id: string; cookie: string }

async function signIn(role: 'admin' | 'member' = 'member'): Promise<Actor> {
  const user = await createUser(db, { role })
  const session = await createSession(user.id, db)
  return { id: user.id, cookie: `sid=${session.id}` }
}

async function call(
  method: string,
  path: string,
  actor: Actor | null,
  body?: unknown,
): Promise<Response> {
  return testApp.request(`/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(actor === null ? {} : { cookie: actor.cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** 每条成功路径上都顺手验一遍：响应体里不能出现任何一把明文 key。 */
async function readJsonNoKeys(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  for (const key of [DEPLOYER_VISION_KEY, DEPLOYER_EMBED_KEY, USER_VISION_KEY, USER_EMBED_KEY]) {
    expect(text).not.toContain(key)
  }
  return JSON.parse(text) as Record<string, unknown>
}

// ── fetch 替身：按 URL 决定回什么 ───────────────────────────────────

let visionReply: { status: number; body: string } = { status: 200, body: '' }
let embedDim: number | null = 1024

function goodVisionBody(): string {
  return JSON.stringify({
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
  })
}

function stubProviders(): void {
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit) => {
    const href = String(url)
    if (href.endsWith('/v1/embeddings')) {
      if (embedDim === null) return new Response('embedding 服务不可用', { status: 503 })
      const requested = (JSON.parse(String(init.body)) as { dimensions?: number }).dimensions
      // 中转「照办」：带了 dimensions 就返回那个维度，否则返回原生维度
      const dim = requested ?? embedDim
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array<number>(dim).fill(0.01) }] }),
        { status: 200 },
      )
    }
    return new Response(visionReply.body, { status: visionReply.status })
  })
}

beforeEach(async () => {
  await truncateAll(sql)
  visionReply = { status: 200, body: goodVisionBody() }
  embedDim = 1024
  stubProviders()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

// ── 视觉配置 ────────────────────────────────────────────────────────

const VISION_INPUT = {
  baseUrl: 'https://own-relay.example.test',
  model: 'user-vision-model',
  apiKey: USER_VISION_KEY,
}

describe('GET /config/vision', () => {
  it('未登录 401', async () => {
    const res = await call('GET', '/config/vision', null)
    expect(res.status).toBe(401)
  })

  it('没配过时回显部署方默认值，source = default，key 只给后四位', async () => {
    const actor = await signIn()

    const res = await call('GET', '/config/vision', actor)
    expect(res.status).toBe(200)
    const body = await readJsonNoKeys(res)

    expect(body).toMatchObject({
      source: 'default',
      baseUrl: 'https://deployer.example.test',
      model: 'deployer-vision',
      apiKey: '****3344',
      verifiedAt: null,
      // 部署方那套同样没有测试记录，不许假设它支持什么
      jsonModeWorks: null,
      multiImageWorks: null,
    })
  })
})

describe('POST /config/vision/test', () => {
  it('不通过也是 200，rawResponse 原样在响应体里', async () => {
    const actor = await signIn()
    visionReply = { status: 401, body: `{"error":{"message":"bad key: ${USER_VISION_KEY}"}}` }

    const res = await call('POST', '/config/vision/test', actor, VISION_INPUT)

    // 做成 HTTP 错误的话前端会走错误分支，而错误分支里没有 rawResponse——
    // 那恰恰是用户唯一能用来判断「是模型不行还是我填错了」的东西
    expect(res.status).toBe(200)
    const body = await readJsonNoKeys(res)
    expect(body['ok']).toBe(false)
    // 中转把 key 抄进错误体了，带回来的那份换成了脱敏串（`readJsonNoKeys` 已经验过没有明文）
    expect(String(body['rawResponse'])).toContain('****7788')
    expect(String(body['rawResponse'])).toContain('bad key')
  })

  it('请求体本身非法才是 4xx', async () => {
    const actor = await signIn()

    const missing = await call('POST', '/config/vision/test', actor, { model: 'm', apiKey: 'k' })
    expect(missing.status).toBe(400)

    const badUrl = await call('POST', '/config/vision/test', actor, { ...VISION_INPUT, baseUrl: 'relay.example.test' })
    expect(badUrl.status).toBe(400)
  })

  it('测试连接本身不改变当前生效的配置', async () => {
    const actor = await signIn()

    await call('POST', '/config/vision/test', actor, VISION_INPUT)

    const res = await call('GET', '/config/vision', actor)
    expect((await readJsonNoKeys(res))['source']).toBe('default')
  })
})

describe('PUT /config/vision', () => {
  it('没有通过的测试记录 → CONFIG_TEST_REQUIRED', async () => {
    const actor = await signIn()

    const res = await call('PUT', '/config/vision', actor, VISION_INPUT)

    expect(res.status).toBe(400)
    const body = await readJsonNoKeys(res)
    expect((body['error'] as { code: string }).code).toBe('CONFIG_TEST_REQUIRED')
  })

  it('测过之后能保存，探测位来自探测而不是请求体', async () => {
    const actor = await signIn()
    await call('POST', '/config/vision/test', actor, VISION_INPUT)

    // 请求体里塞探测位，看它进不进得去。挡它的是 `ProviderInput` 的签名，不是注释
    const res = await call('PUT', '/config/vision', actor, {
      ...VISION_INPUT,
      jsonModeWorks: false,
      multiImageWorks: false,
    })

    expect(res.status).toBe(200)
    const body = await readJsonNoKeys(res)
    expect(body).toMatchObject({
      source: 'user',
      baseUrl: VISION_INPUT.baseUrl,
      model: VISION_INPUT.model,
      apiKey: '****7788',
      // 探测真实结果是 true/true，请求体里那两个 false 没有任何效果
      jsonModeWorks: true,
      multiImageWorks: true,
    })
    expect(body['verifiedAt']).not.toBeNull()

    // 库里存的是密文，直接 select 读不出原文
    const [row] = await db.select().from(userAiConfigs).where(eq(userAiConfigs.userId, actor.id))
    expect(row?.visionApiKeyEnc).not.toBeNull()
    expect(Buffer.from(row?.visionApiKeyEnc as Buffer).toString('utf8')).not.toContain(USER_VISION_KEY)
  })

  it('换了 key 没重测照样被拦——匹配带 key 指纹', async () => {
    const actor = await signIn()
    await call('POST', '/config/vision/test', actor, VISION_INPUT)

    // baseUrl 和 model 都没变，只换了 key。不带指纹匹配的话这一条会过，
    // 而「换了 key 忘了重测」正是最常见的填错方式
    const res = await call('PUT', '/config/vision', actor, {
      ...VISION_INPUT,
      apiKey: 'sk-another-key-0000-1111',
    })

    expect(res.status).toBe(400)
    expect(((await readJsonNoKeys(res))['error'] as { code: string }).code).toBe('CONFIG_TEST_REQUIRED')
  })

  it('脱敏串 = 不修改：不改 key 也能改 model（重测之后）', async () => {
    const actor = await signIn()
    await call('POST', '/config/vision/test', actor, VISION_INPUT)
    await call('PUT', '/config/vision', actor, VISION_INPUT)

    // 前端拿到的是 "****7788"，原样回传
    const nextModel = { ...VISION_INPUT, model: 'user-vision-model-v2', apiKey: '****7788' }
    await call('POST', '/config/vision/test', actor, nextModel)
    const res = await call('PUT', '/config/vision', actor, nextModel)

    expect(res.status).toBe(200)
    const body = await readJsonNoKeys(res)
    expect(body['model']).toBe('user-vision-model-v2')
    // 尾号没变，说明换回去的就是库里那把
    expect(body['apiKey']).toBe('****7788')
  })

  it('此前没配过 key 却传脱敏串 → 400，不静默当成空 key 保存', async () => {
    const actor = await signIn()

    const res = await call('PUT', '/config/vision', actor, { ...VISION_INPUT, apiKey: '****9999' })
    expect(res.status).toBe(400)
  })
})

// ── Embedding 配置 ──────────────────────────────────────────────────

const EMBED_INPUT = {
  baseUrl: 'https://site-embed.example.test',
  model: 'site-embed-a',
  apiKey: USER_EMBED_KEY,
}

describe('/config/embed 的权限', () => {
  it('普通用户读写都是 403', async () => {
    const actor = await signIn('member')

    expect((await call('GET', '/config/embed', actor)).status).toBe(403)
    expect((await call('PUT', '/config/embed', actor, EMBED_INPUT)).status).toBe(403)
    expect((await call('POST', '/config/embed/test', actor, EMBED_INPUT)).status).toBe(403)
  })

  it('/admin/reindex 也是 403', async () => {
    const actor = await signIn('member')

    expect((await call('POST', '/admin/reindex', actor)).status).toBe(403)
    expect((await call('GET', '/admin/reindex/status', actor)).status).toBe(403)
  })
})

describe('PUT /config/embed 的三道闸门', () => {
  it('实测维度低于 1024 → EMBED_DIM_TOO_SMALL，且顺序排在换模型确认之前', async () => {
    const admin = await signIn('admin')
    embedDim = 512

    const probe = await call('POST', '/config/embed/test', admin, EMBED_INPUT)
    expect(probe.status).toBe(200)
    expect((await readJsonNoKeys(probe))['nativeDim']).toBe(512)

    const res = await call('PUT', '/config/embed', admin, EMBED_INPUT)
    expect(res.status).toBe(400)
    const error = (await readJsonNoKeys(res))['error'] as { code: string; details: unknown }
    expect(error.code).toBe('EMBED_DIM_TOO_SMALL')
    expect(error.details).toMatchObject({ nativeDim: 512, required: 1024 })
  })

  it('第一次配置不算换模型，不触发重建', async () => {
    const admin = await signIn('admin')
    await call('POST', '/config/embed/test', admin, EMBED_INPUT)

    const res = await call('PUT', '/config/embed', admin, EMBED_INPUT)
    expect(res.status).toBe(200)
    const body = await readJsonNoKeys(res)
    expect(body).toMatchObject({
      source: 'user',
      model: 'site-embed-a',
      apiKey: '****2233',
      nativeDim: 1024,
      dimParamWorks: true,
      reindexTriggered: false,
      reindexEnqueuedCount: 0,
    })
  })

  it('库里有向量时换模型必须确认，409 之后带 confirmReindex 才过', async () => {
    const admin = await signIn('admin')
    await call('POST', '/config/embed/test', admin, EMBED_INPUT)
    await call('PUT', '/config/embed', admin, EMBED_INPUT)

    // 一张已经用旧模型算过向量的图
    const meme = await makeMeme(db, { uploaderId: admin.id, searchText: '疲惫的猫 今天不想上班' })
    await applyEmbedding(meme.id, unitVector(0), 'site-embed-a', db)

    const next = { ...EMBED_INPUT, model: 'site-embed-b' }
    await call('POST', '/config/embed/test', admin, next)

    const blocked = await call('PUT', '/config/embed', admin, next)
    expect(blocked.status).toBe(409)
    const error = (await readJsonNoKeys(blocked))['error'] as { code: string; details: unknown }
    expect(error.code).toBe('EMBED_MODEL_CHANGED')
    expect(error.details).toMatchObject({ currentModel: 'site-embed-a', nextModel: 'site-embed-b' })

    const confirmed = await call('PUT', '/config/embed', admin, { ...next, confirmReindex: true })
    expect(confirmed.status).toBe(200)
    const body = await readJsonNoKeys(confirmed)
    expect(body).toMatchObject({
      model: 'site-embed-b',
      reindexTriggered: true,
      reindexEnqueuedCount: 1,
    })

    const jobs = await db.select().from(reindexJobs).where(eq(reindexJobs.memeId, meme.id))
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.status).toBe('pending')
  })

  it('回的是**条数**不是布尔：库里 3 条旧向量 → reindexEnqueuedCount === 3', async () => {
    const admin = await signIn('admin')
    await call('POST', '/config/embed/test', admin, EMBED_INPUT)
    await call('PUT', '/config/embed', admin, EMBED_INPUT)

    // **3 条而不是 1 条**：N=1 时「排了多少条」和「排没排」返回的是同一个值（`1`），
    // 断言分不出两种实现，改回布尔照样全绿。N=3 才真的把「数」钉住（SPEC §6.5.3）
    for (let i = 0; i < 3; i++) {
      const meme = await makeMeme(db, { uploaderId: admin.id, searchText: `疲惫的猫 ${i}` })
      await applyEmbedding(meme.id, unitVector(i), 'site-embed-a', db)
    }

    const next = { ...EMBED_INPUT, model: 'site-embed-b' }
    await call('POST', '/config/embed/test', admin, next)

    const body = await readJsonNoKeys(
      await call('PUT', '/config/embed', admin, { ...next, confirmReindex: true }),
    )

    const jobs = await db.select().from(reindexJobs)
    expect(jobs).toHaveLength(3)
    // 这个数必须和队列里实际多出来的行数对得上，而不只是「大于 0」
    expect(body['reindexEnqueuedCount']).toBe(jobs.length)
  })

  it('库里没有任何向量时换模型不拦——没有东西需要重算', async () => {
    const admin = await signIn('admin')
    await call('POST', '/config/embed/test', admin, EMBED_INPUT)
    await call('PUT', '/config/embed', admin, EMBED_INPUT)

    const next = { ...EMBED_INPUT, model: 'site-embed-b' }
    await call('POST', '/config/embed/test', admin, next)

    const res = await call('PUT', '/config/embed', admin, next)
    expect(res.status).toBe(200)
  })

  it('confirmReindex 不是布尔值 → 400', async () => {
    const admin = await signIn('admin')
    const res = await call('PUT', '/config/embed', admin, { ...EMBED_INPUT, confirmReindex: 'yes' })
    expect(res.status).toBe(400)
  })
})

// ── 重建索引 ────────────────────────────────────────────────────────

describe('/admin/reindex', () => {
  async function seedAdminWithStale(): Promise<{ admin: Actor; memeId: string }> {
    const admin = await signIn('admin')
    await call('POST', '/config/embed/test', admin, EMBED_INPUT)
    await call('PUT', '/config/embed', admin, EMBED_INPUT)

    const meme = await makeMeme(db, { uploaderId: admin.id, searchText: '疲惫的猫 今天不想上班' })
    await applyEmbedding(meme.id, unitVector(0), 'old-model', db)
    return { admin, memeId: meme.id }
  }

  it('手动触发把过期的排进队列，重复触发是幂等空操作', async () => {
    const { admin, memeId } = await seedAdminWithStale()

    const first = await readJsonNoKeys(await call('POST', '/admin/reindex', admin))
    expect(first['enqueuedCount']).toBe(1)

    // 入队并不会让这条记录不再「过期」（`embed_model` 没变），所以幂等靠的是
    // 队列表上的唯一索引，不是靠 stale 变空
    const second = await readJsonNoKeys(await call('POST', '/admin/reindex', admin))
    expect(second['enqueuedCount']).toBe(0)

    const jobs = await db.select().from(reindexJobs).where(eq(reindexJobs.memeId, memeId))
    expect(jobs).toHaveLength(1)
  })

  it('进度来自库里的真实计数：stale 在入队前就大于 0', async () => {
    const { admin } = await seedAdminWithStale()

    const before = await readJsonNoKeys(await call('GET', '/admin/reindex/status', admin))
    expect(before).toMatchObject({ running: false, total: 1, done: 0, stale: 1, failed: 0 })

    await call('POST', '/admin/reindex', admin)

    const after = await readJsonNoKeys(await call('GET', '/admin/reindex/status', admin))
    // `running` 翻成真，`stale` 不变——两个数说的是两件事，都对
    expect(after).toMatchObject({ running: true, total: 1, done: 0, stale: 1, failed: 0 })
  })

  it('没配 embedding 模型时触发重建是空操作，不排一堆必然失败的任务', async () => {
    const admin = await signIn('admin')

    const res = await readJsonNoKeys(await call('POST', '/admin/reindex', admin))
    expect(res['enqueuedCount']).toBe(0)
  })

  it('回的是**条数**不是布尔：3 条过期 → enqueuedCount === 3', async () => {
    const actor = await signIn('admin')
    await call('POST', '/config/embed/test', actor, EMBED_INPUT)
    await call('PUT', '/config/embed', actor, EMBED_INPUT)

    // **3 条而不是 1 条**：N=1 时「排了多少条」和「排没排」的返回值撞在同一个 `1` 上，
    // 断言分不出两种实现，退回布尔照样全绿。N=3 才真的把「数」钉住（SPEC §6.5.4）
    for (let i = 0; i < 3; i++) {
      const meme = await makeMeme(db, { uploaderId: actor.id, searchText: `疲惫的猫 ${i}` })
      await applyEmbedding(meme.id, unitVector(i), 'old-model', db)
    }

    const body = await readJsonNoKeys(await call('POST', '/admin/reindex', actor))

    const jobs = await db.select().from(reindexJobs)
    expect(jobs).toHaveLength(3)
    // 这个数必须和队列里实际多出来的行数对得上，而不只是「大于 0」
    expect(body['enqueuedCount']).toBe(jobs.length)
    // 状态照旧跟在同一个响应里（`{ enqueuedCount, ...status }`）。`stale` 是此刻全局
    // 待重算量，和「这一次排了多少」是两个数，改名不能把 spread 碰掉
    expect(body).toMatchObject({ running: true, total: 3, done: 0, stale: 3, failed: 0 })
  })
})
