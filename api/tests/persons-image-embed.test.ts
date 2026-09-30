import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 图片向量配置的三道闸门、换模型重算与「导入时自动入队」的守卫
 * （SPEC §6.7.5、§5.7.2；任务 2026-09-29-人物识别与聚类 §5）。
 *
 * 这一份和 `persons-api.test.ts` 的分工是**上游替身回不回话**：那边是恒 503 的桩
 * （断言「没有一条路径该调上游」），这边是会按图回话的桩，因为要测的正是
 * 「上游把图丢掉时这份配置存不进来」。
 *
 * 四条别人最容易漏掉的性质：
 *
 * 1. **`imageInputWorks = false` 的配置存不进来**（§6.7.5）。上游静默丢掉图之后
 *    照样回一个向量，那些向量全都差不多——存进来不报错，只是所有人物慢慢并成一团
 * 2. **第一次配好不自动补跑**（§6.7.5）。存量补跑要人点 `POST /admin/persons/reindex`
 * 并先看清条数：**每张图都是一次付费调用**
 * 3. **换模型没有 `confirmReindex` 就 409**，带上才是「全站每张图再花一次钱」
 * 4. **导入时入队必须过 `isImageEmbedConfigured()` 守卫**（`services/import.ts`）：
 *    没有它，管理员第一次配好通道的那一刻，积压的待办会**一起**开始花钱
 *
 * ## ⏸️ 2026-10-01：人物功能暂停期间的翻转
 *
 * 人物功能整体暂停待方案，机器不再算图片向量、也不再挂人物
 * （任务 2026-10-01-人物功能临时下线 §4）。
 * 这个文件里有三条断言因此**翻转**，都就地写了为什么：
 *
 * - 「点补跑才排」→ 排 0 条（`enqueuedCount: 0`）
 * - 「换模型重算 3 条」→ 0 条（闸门与 409 那两条没变）
 * - 「导入时自动入队」→ 导入时不再入队
 *
 * **接口、请求体、响应形状一条都没改**，翻转的只是「排几条 / 排不排」。
 * 恢复时连同注释一起翻回去，见任务 §5 的恢复清单。
 *
 * 探测图是哪两张、`imageInputWorks` 怎么判，见 `ai/probe.ts` / `ai/probe-image*.ts`。
 * 替身按图的 sha256 分辨它们——**认图不认调用次数**，所以「上游把图丢了」这件事
 * 在测试里是真的被复现的，而不是靠计数猜的。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

// 三组部署方默认值全部清空：这个文件里的「配好」**只能靠管理员在界面上配**
// （POST /config/image-embed/test + PUT），和真实部署一模一样
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''
process.env['DEFAULT_IMAGE_EMBED_BASE_URL'] = ''
process.env['DEFAULT_IMAGE_EMBED_API_KEY'] = ''
process.env['DEFAULT_IMAGE_EMBED_MODEL'] = ''

// R2 换内存对象（导入那条用例要真字节）。必须在 import 任何 src 模块之前调
const { installR2Memory, resetR2, seedObject } = await import('./helpers/r2-memory.js')
installR2Memory()

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { adminRoutes } = await import('../src/routes/admin.js')
const { imageEmbedConfigRoutes } = await import('../src/routes/config.js')
const { importRoutes } = await import('../src/routes/imports.js')
const { PROBE_IMAGE_SHA256 } = await import('../src/ai/probe-image.js')
const { PROBE_IMAGE_B_SHA256 } = await import('../src/ai/probe-image-b.js')
const { FIXTURES, loadFixture } = await import('./helpers/fixtures.js')
const { imageEmbedConfig, memeSubjects, personVectorJobs, persons, tagJobs } = await import(
  '../src/data/schema.js'
)
// ⏸️ 暂停期间它是唯一还会走到「写向量」那一步的入口（三条入队路径都停着），
// 所以下面直接调它来验证「算完不挂人物」
const { computePersonVector } = await import('../src/services/person-vectors.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

const testApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/config/image-embed', imageEmbedConfigRoutes)
  .route('/api/v1/admin', adminRoutes)
  .route('/api/v1/imports', importRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

const USER_IMAGE_KEY = 'sk-site-image-abcd-9911'
const BASE_URL = 'https://own-relay.example.test'
const MODEL = 'user-image-model'

/** 上游原生维度。4096 是探测里真见过的那个数（硅基流动），也让「截断」这条路被测到。 */
const NATIVE_DIM = 4096

// ── fetch 替身 ────────────────────────────────────────────────────

type UpstreamMode = 'works' | 'drops-image' | 'identical-vectors' | 'ignores-dimensions' | 'down'

let mode: UpstreamMode = 'works'

/** 探测图的两张在替身里**必须能被分开**，否则「两张图算出的向量几乎一样」测不出来。 */
function axisFor(imageDataUrl: string): number {
  const base64 = imageDataUrl.slice(imageDataUrl.indexOf(',') + 1)
  const sha = createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')
  if (sha === PROBE_IMAGE_SHA256) return 0
  if (sha === PROBE_IMAGE_B_SHA256) return 1
  // 认不出来的图（真跑 worker 时是用户上传的图）给第三个方向，
  // 不与任何一张探测图撞上——撞上会让「两张图被当成同一张」这种错判变成绿色
  return 2
}

function unitVector(dim: number, axis: number): number[] {
  const vector = new Array<number>(dim).fill(0)
  vector[axis % dim] = 1
  return vector
}

function stubUpstream(): void {
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit) => {
    const href = String(url)
    if (!href.endsWith('/v1/embeddings')) {
      return new Response('这个文件只提供图片向量通道', { status: 503 })
    }
    if (mode === 'down') return new Response('中转服务不可用', { status: 503 })

    const body = JSON.parse(String(init.body)) as {
      input: { image: string }[]
      dimensions?: number
    }
    const image = body.input[0]?.image ?? ''
    // 带了 dimensions 就照办（探测据此判 dimParamWorks），否则回原生维度。
    // `ignores-dimensions` 是「中转嘴上说支持、实际照旧回原生」那一类
    const dim =
      mode === 'ignores-dimensions' ? NATIVE_DIM : (body.dimensions ?? NATIVE_DIM)
    const axis = mode === 'identical-vectors' || mode === 'drops-image' ? 0 : axisFor(image)

    return new Response(
      JSON.stringify({
        data: [{ embedding: unitVector(dim, axis) }],
        // 「图被静默丢掉」时上游往往还会明说 token 为 0；另一种（identical-vectors）
        // 连这句话都没有，只有两张图算出同一个向量——两条路都得挡住
        usage: { image_tokens: mode === 'drops-image' ? 0 : 512 },
      }),
      { status: 200 },
    )
  })
}

// ── 脚手架 ────────────────────────────────────────────────────────

type Actor = { id: string; role: 'admin' | 'member'; cookie: string }

async function signIn(role: 'admin' | 'member' = 'admin'): Promise<Actor> {
  const user = await createUser(db, { role })
  const session = await createSession(user.id, db)
  return { id: user.id, role: user.role, cookie: `sid=${session.id}` }
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

/** 读 JSON，并**逐字断言没有一把明文 key**（AGENTS.md §5）——每条成功路径都顺手验一次。 */
async function readJsonNoKeys(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  expect(text).not.toContain(USER_IMAGE_KEY)
  return JSON.parse(text) as Record<string, unknown>
}

const INPUT = { baseUrl: BASE_URL, model: MODEL, apiKey: USER_IMAGE_KEY }

/** 走完「测连接 → 保存」，返回保存的响应。断言留给调用方。 */
async function configure(
  actor: Actor,
  model = MODEL,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const tested = await call('POST', '/config/image-embed/test', actor, { ...INPUT, model })
  expect(tested.status).toBe(200)
  return call('PUT', '/config/image-embed', actor, { ...INPUT, model, ...extra })
}

/** 库里现在排着几条人物向量任务。 */
async function jobCount(): Promise<number> {
  return (await db.select().from(personVectorJobs)).length
}

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
  mode = 'works'
  stubUpstream()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

// ── 探测与闸门 ────────────────────────────────────────────────────

describe('测试连接（§6.7.5）', () => {
  it('上游把图丢掉（image_tokens = 0）时 ok = false，但仍是 200 且带原话', async () => {
    const admin = await signIn()
    mode = 'drops-image'

    const res = await call('POST', '/config/image-embed/test', admin, INPUT)

    // 不通过也是 200：做成 4xx 的话前端会走错误分支，而错误分支里没有 rawError
    // ——那恰恰是用户唯一能判断「是模型不行还是我填错了」的东西
    expect(res.status).toBe(200)
    const body = await readJsonNoKeys(res)
    expect(body).toMatchObject({
      ok: false,
      imageInputWorks: false,
      // 维度是实测出来的，图丢了不影响这件事
      nativeDim: NATIVE_DIM,
      dimParamWorks: true,
    })
    // 上游那句「image_tokens = 0」要带着——用户看不见日志
    expect(String(body['rawError'])).toContain('image_tokens')
  })

  it('两张明显不同的图算出几乎一样的向量时同样判 false', async () => {
    const admin = await signIn()
    mode = 'identical-vectors'

    const body = await readJsonNoKeys(await call('POST', '/config/image-embed/test', admin, INPUT))

    expect(body).toMatchObject({ ok: false, imageInputWorks: false })
    // 这条路上游什么都没说（token 是正常的），rawError 仍然是原始响应体
    expect(body['rawError']).not.toBeNull()
  })

  it('上游够不着时 ok = false，imageInputWorks 是 null 而不是 false', async () => {
    const admin = await signIn()
    mode = 'down'

    const body = await readJsonNoKeys(await call('POST', '/config/image-embed/test', admin, INPUT))

    expect(body).toMatchObject({ ok: false, nativeDim: null, dimParamWorks: null })
    // **没测出来 ≠ 测出来不行**：报 false 会让用户以为这个供应商不支持图片
    expect(body['imageInputWorks']).toBeNull()
  })

  it('通过的探测：六个字段就是 SPEC §6.7.5 列的那些', async () => {
    const admin = await signIn()

    const body = await readJsonNoKeys(await call('POST', '/config/image-embed/test', admin, INPUT))

    expect(body).toEqual({
      ok: true,
      nativeDim: NATIVE_DIM,
      dimParamWorks: true,
      // dimensions 生效 → 上游直接回 1024 维，客户端不需要截断
      willTruncate: false,
      imageInputWorks: true,
      rawError: null,
    })
  })

  it('dimensions 不生效时 willTruncate = true，配置照样能存（客户端截断是保守路径）', async () => {
    const admin = await signIn()
    mode = 'ignores-dimensions'

    const body = await readJsonNoKeys(await call('POST', '/config/image-embed/test', admin, INPUT))

    expect(body).toMatchObject({
      nativeDim: NATIVE_DIM,
      dimParamWorks: false,
      // 4096 → 1024 由客户端截断，**截完必须重新 L2 归一化**（本端入口 §4）
      willTruncate: true,
      imageInputWorks: true,
      ok: true,
    })

    // 不配合的中转**不是**不能用的中转：能力位按实测存，运行时据此分支
    const saved = await call('PUT', '/config/image-embed', admin, INPUT)
    expect(saved.status).toBe(200)
    const stored = await readJsonNoKeys(await call('GET', '/config/image-embed', admin))
    // 这两个位来自探测记录，请求体里传不进来（`data/ai-configs.ts` 的签名挡着）
    expect(stored).toMatchObject({ source: 'user', dimParamWorks: false, imageInputWorks: true })
  })

  it('测试连接本身不改变当前生效的配置，只有 admin 能调', async () => {
    const admin = await signIn()
    const member = await signIn('member')

    await call('POST', '/config/image-embed/test', admin, INPUT)

    const still = await readJsonNoKeys(await call('GET', '/config/image-embed', admin))
    expect(still['source']).toBe('default')

    expect((await call('POST', '/config/image-embed/test', member, INPUT)).status).toBe(403)
    expect((await call('GET', '/config/image-embed', null)).status).toBe(401)
  })
})

describe('保存的三道闸门（§6.5.2 / §6.7.5）', () => {
  it('没测过就保存 → CONFIG_TEST_REQUIRED', async () => {
    const admin = await signIn()

    const res = await call('PUT', '/config/image-embed', admin, INPUT)

    expect(res.status).toBe(400)
    const body = await readJsonNoKeys(res)
    expect((body['error'] as { code: string }).code).toBe('CONFIG_TEST_REQUIRED')
    // 一个字都没写进去
    expect(await db.select().from(imageEmbedConfig)).toHaveLength(0)
  })

  it('图被丢掉的配置存不进来，而且那句话说得出口（§6.7.5）', async () => {
    const admin = await signIn()
    mode = 'drops-image'
    await call('POST', '/config/image-embed/test', admin, INPUT)

    const res = await call('PUT', '/config/image-embed', admin, INPUT)

    expect(res.status).toBe(400)
    const body = await readJsonNoKeys(res)
    const error = body['error'] as { code: string; message: string }
    expect(error.code).toBe('CONFIG_TEST_REQUIRED')
    // 泛泛的「保存前需要先通过测试连接」在这里是**用户看不懂**的那种消息：
    // 他刚刚点了测试，界面也把「图被丢掉了」摆在他面前
    expect(error.message).toContain('没有真的编码图片')
    expect(await db.select().from(imageEmbedConfig)).toHaveLength(0)
  })

  it('两张图向量一样的配置同样存不进来', async () => {
    const admin = await signIn()
    mode = 'identical-vectors'
    await call('POST', '/config/image-embed/test', admin, INPUT)

    const res = await call('PUT', '/config/image-embed', admin, INPUT)

    expect(res.status).toBe(400)
    expect(await db.select().from(imageEmbedConfig)).toHaveLength(0)
  })

  it('上游够不着、或请求体本身非法，都进不了保存', async () => {
    const admin = await signIn()
    mode = 'down'
    await call('POST', '/config/image-embed/test', admin, INPUT)

    const unreachable = await call('PUT', '/config/image-embed', admin, INPUT)
    expect(unreachable.status).toBe(400)

    // 请求体的形状问题在探测之前就该挡住（协议、空字段）
    expect((await call('POST', '/config/image-embed/test', admin, { ...INPUT, baseUrl: 'relay.example.test' })).status).toBe(400)
    expect((await call('POST', '/config/image-embed/test', admin, { ...INPUT, model: '  ' })).status).toBe(400)
  })

  it('通过之后能保存：source = user、key 只回显后四位、密文进库', async () => {
    const admin = await signIn()
    const created = await configure(admin)

    expect(created.status).toBe(200)
    const body = await readJsonNoKeys(created)
    expect(body).toMatchObject({
      source: 'user',
      baseUrl: BASE_URL,
      model: MODEL,
      apiKey: '****9911',
      // 探测位来自探测，请求体里传不进来
      nativeDim: NATIVE_DIM,
      dimParamWorks: true,
      imageInputWorks: true,
      // 第一次配：库里本来没有模型，所以不是「换了模型」
      reindexTriggered: false,
      reindexEnqueuedCount: 0,
    })
    expect(body['verifiedAt']).not.toBeNull()

    // 库里存的是密文，select 读不出原文
    const [row] = await db.select().from(imageEmbedConfig).where(eq(imageEmbedConfig.id, 1))
    expect(Buffer.from(row?.apiKeyEnc as Buffer).toString('utf8')).not.toContain(USER_IMAGE_KEY)

    // 之后再读回来还是脱敏串
    const again = await readJsonNoKeys(await call('GET', '/config/image-embed', admin))
    expect(again['apiKey']).toBe('****9911')
  })
})

// ── 补跑与进度（§6.7.5） ──────────────────────────────────────────

describe('补跑与进度', () => {
  it('第一次配好**不**自动补跑，存量要人点了才排（每张图都是一次付费调用）', async () => {
    const admin = await signIn()
    await makeMeme(db, { uploaderId: admin.id })
    await makeMeme(db, { uploaderId: admin.id })

    await configure(admin)

    // ⚠️ 这条是这个文件里最要紧的一条：自动补跑的表现是「配好之后账单一跳」
    expect(await jobCount()).toBe(0)

    const status = (await readJsonNoKeys(
      await call('GET', '/admin/persons/reindex/status', admin),
    )) as Record<string, number>
    expect(status).toMatchObject({ total: 2, done: 0, stale: 2, failed: 0, running: false })
  })

  it('点补跑：接口还在、形状不变，但暂停期间一条都不排（⏸️ 见文件头）', async () => {
    const admin = await signIn()
    const memes = [await makeMeme(db, { uploaderId: admin.id }), await makeMeme(db, { uploaderId: admin.id })]
    await configure(admin)

    /*
     * ⚠️ **这一条翻转自「点补跑才排，幂等」（原来是 `enqueuedCount: 2` / `jobCount() === 2`）。**
     *
     * 不是测试退化了：人物功能暂停期间机器不再算图片向量
     * （任务 2026-10-01-人物功能临时下线 §4），
     * 补跑接口按 §2 第 4 条留着、响应形状一个字没改，但它排 0 条。
     * **恢复时把下面这几条断言一起翻回去**，那就是 §5 恢复清单里 api 的两行。
     */
    const first = await readJsonNoKeys(await call('POST', '/admin/persons/reindex', admin))
    expect(first).toMatchObject({
      enqueuedCount: 0,
      // 一条都没排 → 队列是空的 → 界面不该显示「进行中」
      running: false,
      total: 2,
      stale: 2,
    })
    expect(await jobCount()).toBe(0)
    // 排 0 条的另一半：这条路径不会产出任何人物
    expect(await db.select().from(persons)).toHaveLength(0)

    // 上一轮有一条重试耗尽：它留在表里是 `failed`，是管理员要看见的东西
    await db
      .insert(personVectorJobs)
      .values({ memeId: memes[0]!.id, status: 'failed', lastError: '图片向量 unreachable' })

    const second = await readJsonNoKeys(await call('POST', '/admin/persons/reindex', admin))
    expect(second['enqueuedCount']).toBe(0)
    expect(second['failed']).toBe(1)
    // 补跑**不清** failed（清只发生在换模型开启新一轮时），否则「有 12 条重试耗尽了」
    // 这个事实会被抹掉。暂停期间这一条仍然成立——开关挡的是入队，不是清理
    expect(await jobCount()).toBe(1)
  })

  it('换模型：没带 confirmReindex 是 409，带了才重算，而且说得出条数', async () => {
    const admin = await signIn()
    const memes = [
      await makeMeme(db, { uploaderId: admin.id }),
      await makeMeme(db, { uploaderId: admin.id }),
      await makeMeme(db, { uploaderId: admin.id }),
    ]
    await configure(admin)

    // 库里已经有人物向量（第一批算出来的），换模型会让它们全部作废
    await db.insert(memeSubjects).values({
      memeId: memes[0]!.id,
      embedding: unitVector(1024, 0),
      embedModel: `${MODEL}@768`,
      personId: null,
    })

    // 上一轮有一条重试耗尽，停在这一轮开始之前
    await db
      .insert(personVectorJobs)
      .values({ memeId: memes[1]!.id, status: 'failed', lastError: '图片向量 unreachable' })
    expect(await jobCount()).toBe(1)

    // 新模型也得先测过：匹配三要素（baseUrl + model + key 指纹）里含 model，
    // 没测过会先撞上第一道闸门 CONFIG_TEST_REQUIRED，测不到这里要测的第三道
    const tested = await call('POST', '/config/image-embed/test', admin, {
      ...INPUT,
      model: 'next-model',
    })
    expect(tested.status).toBe(200)

    const blocked = await call('PUT', '/config/image-embed', admin, { ...INPUT, model: 'next-model' })
    expect(blocked.status).toBe(409)
    const error = ((await readJsonNoKeys(blocked))['error']) as { code: string }
    expect(error.code).toBe('EMBED_MODEL_CHANGED')

    const confirmed = await call('PUT', '/config/image-embed', admin, {
      ...INPUT,
      model: 'next-model',
      confirmReindex: true,
    })
    expect(confirmed.status).toBe(200)
    const body = await readJsonNoKeys(confirmed)
    /*
     * ⚠️ **`reindexEnqueuedCount` 翻转自 3。** 这三条断言原来验证的是「每一条存量图
     *    都是一次付费调用，界面要靠这个数说清花多少钱」；暂停期间一条都不排
     *    （任务 2026-10-01-人物功能临时下线 §4），
     *    于是 0。**闸门没变**（上面那两条 409 / 200 照旧），变的只是「排几条」。
     */
    expect(body).toMatchObject({
      model: 'next-model',
      reindexTriggered: true,
      reindexEnqueuedCount: 0,
    })
    // 「重算」在暂停期间只剩**清上一轮 failed** 这一半，它仍然照跑
    expect(await jobCount()).toBe(0)

    // 再存一次同一份配置：没换模型，什么都不该发生（也不需要 confirmReindex）
    const again = await call('PUT', '/config/image-embed', admin, { ...INPUT, model: 'next-model' })
    expect(again.status).toBe(200)
    expect(await readJsonNoKeys(again)).toMatchObject({
      reindexTriggered: false,
      reindexEnqueuedCount: 0,
    })
    expect(await jobCount()).toBe(0)
  })

  it('三个人物向量都还没有时，换模型不拦（没有东西可重算）', async () => {
    const admin = await signIn()
    await makeMeme(db, { uploaderId: admin.id })
    await configure(admin)

    // 没有 embedding 行 → hasPersonVectors 为 false → 不要求确认
    const res = await configure(admin, 'next-model')
    expect(res.status).toBe(200)
    expect(await readJsonNoKeys(res)).toMatchObject({ reindexTriggered: true })
  })
})

// ── 导入时**不**自动入队（⏸️ 暂停期间） ───────────────────────────
//
// 这个 describe 原来叫「导入时自动入队（§6.7.5：配好之后新图不用点）」，
// 断言的是「配好通道之后新图会排上一条人物向量任务」。人物功能暂停期间
// （任务 2026-10-01-人物功能临时下线 §4 附带那条），
// 机器连向量都不算了：这个向量的唯一消费方是人物，配着也算、算完也没有人看，
// 就是每张新图一次白花的付费调用。
//
// **不删代码、不删用例**，只把断言翻过来并留下这段话。`runImport`、上游替身、
// R2 替身全部原样留着——恢复时它们是现成的。

describe('导入时不再自动入队（⏸️ 人物功能暂停）', () => {
  type Presigned = { batchId: string; uploads: { fileName: string; tempKey: string }[] }

  async function runImport(actor: Actor, fixture: string): Promise<void> {
    const bytes = await loadFixture(fixture)
    const name = fixture.slice(fixture.lastIndexOf('/') + 1)

    const created = await call('POST', '/imports', actor, {
      files: [{ fileName: name, sizeBytes: bytes.byteLength }],
    })
    expect(created.status).toBe(200)
    const batch = (await created.json()) as Presigned
    for (const upload of batch.uploads) seedObject(upload.tempKey, bytes)

    const commit = await call('POST', `/imports/${batch.batchId}/commit`, actor, {
      items: batch.uploads.map((u) => ({ fileName: u.fileName, tempKey: u.tempKey })),
    })
    expect(commit.status).toBe(202)

    // 等批次处理完（契约是 202 + SSE，测试没有浏览器，只能轮询快照）
    const deadline = Date.now() + 25_000
    for (;;) {
      const snapshot = (await (
        await call('GET', `/imports/${batch.batchId}`, actor)
      ).json()) as { pending: number }
      if (snapshot.pending === 0) break
      if (Date.now() > deadline) throw new Error('导入批次超时')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('配没配通道，导进来的图都不排队（⏸️ 翻转自「配好之后会排一条 pending」）', async () => {
    const admin = await signIn()

    await runImport(admin, FIXTURES.staticPng)
    // 打标任务是另一条路，它照常排——用来证明这条导入链真的跑到了入队那一步
    expect(await db.select().from(tagJobs)).toHaveLength(1)
    // 守卫在 `services/import.ts` 的 persistBytes：没有它，管理员配好通道的那一刻
    // 积压的待办会**一起**开始付费
    expect(await jobCount()).toBe(0)

    await configure(admin)

    await runImport(admin, FIXTURES.staticJpg)
    // ⚠️ **翻转的那一条**：原来是「配好之后会排一条 pending」。暂停期间恒不排，
    // 所以打标的条数才是这条导入链确实跑到了入队那一步的证据
    expect(await db.select().from(tagJobs)).toHaveLength(2)
    expect(await jobCount()).toBe(0)
    // 既没排队，就没有向量、没有归属，机器也不会建人物
    expect(await db.select().from(memeSubjects)).toHaveLength(0)
    expect(await db.select().from(persons)).toHaveLength(0)
  })
})

// ── 算完不挂人物（⏸️ 暂停期间的写路径，§4 前两条） ─────────────────

describe('图片向量任务算完只写向量、不挂人物', () => {
  /**
   * 上面那条测的是「三条入队路径都停了」，这条测**算向量那一步本身**：
   * 就算有一条任务真的跑起来（残留、手工插的行、以后半开着恢复），
   * 它也只写向量、不产生归属、不建人物。
   */
  it('算完：meme_subjects 有向量、person_id 与 assigned_by 留空，库里没有人物', async () => {
    const admin = await signIn()
    await configure(admin)

    const bytes = await loadFixture(FIXTURES.staticPng)
    const meme = await makeMeme(db, { uploaderId: admin.id })
    // 这一步要真读图（`getObject` → sharp 缩放 → 送上游），所以对象得真的在
    seedObject(meme.storageKey, bytes)

    const outcome = await computePersonVector(meme.id)
    expect(outcome.kind).toBe('done')

    const subjects = await db.select().from(memeSubjects)
    expect(subjects).toHaveLength(1)
    expect(subjects[0]?.embedding).not.toBeNull()
    // ⚠️ 机器自动挂已下掉：向量照写，归属一个都不写（`writePersonVector`）
    expect(subjects[0]?.personId).toBeNull()
    expect(subjects[0]?.assignedBy).toBeNull()
    expect(await db.select().from(persons)).toHaveLength(0)
  })
})
