import { availableParallelism } from 'node:os'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 运行参数的集成测试（SPEC §5.6 / §6.5.5 / §9.26）。
 *
 * 测三件事，三件都不重叠：
 *
 *   1. **端点契约**——权限、四组上下限、交叉约束、回显生效值、等于默认值落成 `NULL`。
 *   2. **worker 真的用配置值**，不是常量。判据是「同时有几条 `running`」：把视觉调用
 *      挂住，窗口就开得很宽，不需要靠运气。**这条不可能由 `GET` 的响应证明**——
 *      响应只说明存进去了，不说明有人读它。
 *   3. **两条路径都把 ffmpeg 上限传进 `image/` 层**。打标那条最容易漏：它只在动图
 *      抽帧时才过 ffmpeg，删掉那行不影响任何静图用例。
 *
 * ⚠️ 这里**测不出「速度提升」**。本任务明确不新增吞吐端点（§6.5.5），唯一能证明提速的
 *    是真库上 `GET /memes/tag-status` 的 `pending` 下降速率，那要人工量一次。
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

const { installR2Memory, resetR2, seedObject } = await import('./helpers/r2-memory.js')
installR2Memory()

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme, TEST_EMBED_DIM } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { createBatch } = await import('../src/data/imports.js')
const { enqueueTagJob } = await import('../src/data/tag-jobs.js')
const { runtimeConfig } = await import('../src/data/schema.js')
const { adminRoutes } = await import('../src/routes/admin.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { FFMPEG_CONCURRENCY } = await import('../src/image/constants.js')
const { ffmpegConcurrency } = await import('../src/image/probe.js')
const {
  startTagWorker,
  stopTagWorker,
  TAG_CONCURRENCY_DEFAULT,
  TAG_PER_USER_INFLIGHT_DEFAULT,
} = await import('../src/queue/worker.js')
const { PIPELINE_CONCURRENCY_DEFAULT, runBatch } = await import('../src/services/import.js')
const { FIXTURES, loadFixture } = await import('./helpers/fixtures.js')

const { sql, db } = createTestDb()

const testApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/admin', adminRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

/** 本机核数。上限是 `min(核数, 16)`，所以断言不能写死 8 或 16。 */
const CPU_COUNT = availableParallelism()
const FFMPEG_MAX = Math.min(CPU_COUNT, 16)

const DEFAULTS = {
  tagConcurrency: TAG_CONCURRENCY_DEFAULT,
  tagPerUserInflight: TAG_PER_USER_INFLIGHT_DEFAULT,
  importConcurrency: PIPELINE_CONCURRENCY_DEFAULT,
  ffmpegConcurrency: FFMPEG_CONCURRENCY,
}

type Actor = { id: string; cookie: string }

async function signIn(role: 'admin' | 'member' = 'admin'): Promise<Actor> {
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

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } }
  return body.error?.code ?? '（没有错误信封）'
}

/** 直接读库，不看端点回显——「落成 NULL」这件事只有库里能证明。 */
async function storedRow() {
  const [row] = await db.select().from(runtimeConfig)
  return row
}

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
  // 模块级槽池是跨用例共享的（`probe.ts` 的 `slots`），每个用例自己复位
  await call('PUT', '/admin/runtime', await signIn(), DEFAULTS)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

// ── 权限 ────────────────────────────────────────────────────────────

describe('/admin/runtime 的权限', () => {
  it('普通用户读写都是 403，不是「写不了但看得见」', async () => {
    const member = await signIn('member')

    const read = await call('GET', '/admin/runtime', member)
    expect(read.status).toBe(403)
    expect(await errorCode(read)).toBe('FORBIDDEN')

    const write = await call('PUT', '/admin/runtime', member, DEFAULTS)
    expect(write.status).toBe(403)
    expect(await errorCode(write)).toBe('FORBIDDEN')
  })

  it('未登录是 401 —— 并发上限改的是全站资源分配与 AI 账单（§3.3）', async () => {
    expect((await call('GET', '/admin/runtime', null)).status).toBe(401)
    expect(await errorCode(await call('PUT', '/admin/runtime', null, DEFAULTS))).toBe('UNAUTHENTICATED')
  })
})

// ── GET ─────────────────────────────────────────────────────────────

describe('GET /admin/runtime', () => {
  it('空表是正常状态：四个生效值 = 代码默认值，没有 source 字段', async () => {
    await truncateAll(sql)
    const admin = await signIn()

    const res = await call('GET', '/admin/runtime', admin)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(body).toMatchObject({ ...DEFAULTS, cpuCount: CPU_COUNT, updatedAt: null, updatedBy: null })
    // 与 `/config/vision` 不同：这里只有一层来源，多一个 `source` 就是多一层要做对的语义
    expect(body).not.toHaveProperty('source')
  })
})

// ── PUT 的校验 ──────────────────────────────────────────────────────

describe('PUT /admin/runtime 的越界处理', () => {
  /** 四个字段的边界值逐个试。**越界一律报错，不静默截断**（§9.26）。 */
  const OUT_OF_RANGE: { field: keyof typeof DEFAULTS; value: number }[] = [
    { field: 'tagConcurrency', value: 0 },
    { field: 'tagConcurrency', value: 17 },
    { field: 'tagPerUserInflight', value: 0 },
    { field: 'tagPerUserInflight', value: 5 },
    { field: 'importConcurrency', value: 0 },
    { field: 'importConcurrency', value: 9 },
    { field: 'ffmpegConcurrency', value: 0 },
  ]

  it.each(OUT_OF_RANGE)('$field = $value → VALIDATION_FAILED', async ({ field, value }) => {
    const admin = await signIn()

    // 先放一组非默认值：这样「拒绝之后什么都没落库」有东西可比，
    // 否则「库里还是空」和「根本没法比较」长得一模一样
    const base = { ...DEFAULTS, tagConcurrency: 4, importConcurrency: 5 }
    await call('PUT', '/admin/runtime', admin, base)
    const before = await storedRow()

    const res = await call('PUT', '/admin/runtime', admin, { ...base, [field]: value })

    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
    expect(await storedRow()).toEqual(before)
  })

  it('ffmpeg 上限来自本机核数：min(核数, 16) 收，+1 拒', async () => {
    const admin = await signIn()

    const ok = await call('PUT', '/admin/runtime', admin, {
      ...DEFAULTS,
      ffmpegConcurrency: FFMPEG_MAX,
    })
    expect(ok.status).toBe(200)
    // **上限与响应里的 cpuCount 是同一个取值的两处使用**：算两遍迟早有一遍过时
    expect((await ok.json()) as Record<string, unknown>).toMatchObject({
      ffmpegConcurrency: FFMPEG_MAX,
      cpuCount: CPU_COUNT,
    })

    const tooBig = await call('PUT', '/admin/runtime', admin, {
      ...DEFAULTS,
      ffmpegConcurrency: FFMPEG_MAX + 1,
    })
    expect(tooBig.status).toBe(400)
    expect(await errorCode(tooBig)).toBe('VALIDATION_FAILED')
  })

  it('每用户在途大于打标并发 → 拒绝（静默无效的配置比报错更难查）', async () => {
    const admin = await signIn()

    const res = await call('PUT', '/admin/runtime', admin, {
      ...DEFAULTS,
      tagConcurrency: 2,
      tagPerUserInflight: 3,
    })

    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('缺字段、非整数、字符串数字都算非法——不做部分更新', async () => {
    const admin = await signIn()

    const missing = await call('PUT', '/admin/runtime', admin, {
      tagConcurrency: 3,
      tagPerUserInflight: 1,
      importConcurrency: 2,
    })
    expect(await errorCode(missing)).toBe('VALIDATION_FAILED')

    const fractional = await call('PUT', '/admin/runtime', admin, {
      ...DEFAULTS,
      tagConcurrency: 2.5,
    })
    expect(await errorCode(fractional)).toBe('VALIDATION_FAILED')

    // 「不信客户端」：`"4"` 也能凑出 4，但服务端是唯一校验点，接受它等于把类型放宽给所有人
    const numericString = await call('PUT', '/admin/runtime', admin, {
      ...DEFAULTS,
      tagConcurrency: '4',
    })
    expect(await errorCode(numericString)).toBe('VALIDATION_FAILED')
  })
})

// ── 归一化 ──────────────────────────────────────────────────────────

describe('等于默认值的输入归一成 NULL', () => {
  it('全部填默认值 → 四列都是 NULL，但 GET 仍回默认值', async () => {
    const admin = await signIn()

    const res = await call('PUT', '/admin/runtime', admin, DEFAULTS)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject(DEFAULTS)

    // 归一化在保存时做。不归一的话，一个显式存的 2 会在默认值改成别的数之后把它钉住，
    // 而界面上看不出「这是被钉住的旧默认值」
    expect(await storedRow()).toMatchObject({
      tagConcurrency: null,
      tagPerUserInflight: null,
      importConcurrency: null,
      ffmpegConcurrency: null,
    })
  })

  it('只改一个字段：那个落库，其余三个仍是 NULL', async () => {
    const admin = await signIn()

    await call('PUT', '/admin/runtime', admin, { ...DEFAULTS, tagConcurrency: 4 })

    expect(await storedRow()).toMatchObject({
      tagConcurrency: 4,
      tagPerUserInflight: null,
      importConcurrency: null,
      ffmpegConcurrency: null,
    })
  })

  it('回显的是**生效值**：填回去那一格等于默认值时不显示被钉住的旧值', async () => {
    const admin = await signIn()

    await call('PUT', '/admin/runtime', admin, { ...DEFAULTS, tagConcurrency: 4 })
    const back = await call('PUT', '/admin/runtime', admin, DEFAULTS)

    expect((await back.json()) as Record<string, unknown>).toMatchObject(DEFAULTS)
    expect((await storedRow())?.tagConcurrency).toBeNull()
  })

  it('改过之后 updatedAt / updatedBy 有值，且 updatedAt 只精确到秒', async () => {
    const admin = await signIn()

    const body = (await (
      await call('PUT', '/admin/runtime', admin, { ...DEFAULTS, importConcurrency: 5 })
    ).json()) as Record<string, unknown>

    expect(body['updatedBy']).toBe(admin.id)
    expect(String(body['updatedAt'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
})

// ── worker 真的用配置值 ─────────────────────────────────────────────

/** 让视觉调用挂住，好稳定地数「同时在跑几条」。 */
let gate: Promise<void> | null = null
let openGate: () => void = () => {}

const OK_CONTENT = JSON.stringify({
  ocrText: '我服了',
  description: '一只猫翻着白眼，一脸无话可说',
  expressions: ['翻白眼'],
  emotions: ['无语'],
  tones: ['无所谓'],
  purposes: ['吐槽'],
  scenes: [],
  tags: { subject: ['猫'], style: [] },
})

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/v1/chat/completions')) {
      await gate
      return new Response(
        JSON.stringify({ choices: [{ message: { content: OK_CONTENT }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/v1/embeddings')) {
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array(TEST_EMBED_DIM).fill(0.1) }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`测试里出现了预期外的外部调用：${url}`)
  })
}

async function seedQueued(uploaderIds: string[]): Promise<void> {
  const bytes = await loadFixture(FIXTURES.staticPng)
  for (const [i, userId] of uploaderIds.entries()) {
    const storageKey = `memes/gated-${i}-${userId}.png`
    seedObject(storageKey, bytes)
    const meme = await makeMeme(db, { uploaderId: userId, storageKey })
    await db.transaction(async (tx) => enqueueTagJob(meme.id, userId, tx))
  }
}

async function runningCount(): Promise<number> {
  const rows = await sql<{ n: string }[]>`select count(*) as n from tag_jobs where status = 'running'`
  return Number(rows[0]?.n ?? 0)
}

/** 轮询到条件成立，超时即失败——**不要用固定的 sleep 猜时长**。 */
async function until(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('等待条件超时')
}

describe('打标 worker 用的是配置值，不是常量', () => {
  it('tagConcurrency：3 个用户各 1 张 → 同时在跑 3 条（默认是 2）', async () => {
    const admin = await signIn()
    const users = [await createUser(db), await createUser(db), await createUser(db)]
    await seedQueued(users.map((u) => u.id))

    // 每用户在途保持默认 1：三个人各占一个槽，所以「同时在跑几条」只反映总数上限
    await call('PUT', '/admin/runtime', admin, { ...DEFAULTS, tagConcurrency: 3 })
    stubFetch()
    gate = new Promise<void>((resolve) => {
      openGate = resolve
    })

    startTagWorker()
    try {
      await until(async () => (await runningCount()) === 3)
      // 再等一会儿，确认没有第 4 条溜进来
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await runningCount()).toBe(3)
    } finally {
      openGate()
      await stopTagWorker()
    }
  })

  it('tagPerUserInflight：同一个人 3 张 → 填 2 就同时跑 2 条（默认 1 会只跑 1 条）', async () => {
    const admin = await signIn()
    const user = await createUser(db)
    await seedQueued([user.id, user.id, user.id])

    await call('PUT', '/admin/runtime', admin, {
      ...DEFAULTS,
      tagConcurrency: 2,
      tagPerUserInflight: 2,
    })
    stubFetch()
    gate = new Promise<void>((resolve) => {
      openGate = resolve
    })

    startTagWorker()
    try {
      await until(async () => (await runningCount()) === 2)
      await new Promise((resolve) => setTimeout(resolve, 300))
      // 恰好 2，不是 3：每用户在途那一项也在生效
      expect(await runningCount()).toBe(2)
    } finally {
      openGate()
      await stopTagWorker()
    }
  })

  it('打标路径也会把 ffmpeg 上限传进 image 层', async () => {
    const admin = await signIn()
    const user = await createUser(db)
    await seedQueued([user.id])

    await call('PUT', '/admin/runtime', admin, { ...DEFAULTS, ffmpegConcurrency: 3 })
    stubFetch()
    gate = Promise.resolve()

    startTagWorker()
    try {
      // tick 读过一次配置就够了，不必等任务跑完
      await until(async () => ffmpegConcurrency() === 3)
    } finally {
      await stopTagWorker()
    }
  })
})

// ── 导入路径 ────────────────────────────────────────────────────────

describe('导入批次开头也读运行参数', () => {
  it('ffmpeg 上限进 image 层', async () => {
    const admin = await signIn()
    const user = await createUser(db)
    // 目的只是让 `runBatch` 走到「读配置」那两行，不必真的搬一个文件：
    // 批次里挂一条条目（`values([])` 会抛），而交给 `runBatch` 的文件列表是空的
    const batch = await createBatch({
      userId: user.id,
      files: [{ fileName: 'never-processed.png', sizeBytes: 1n }],
    })

    await call('PUT', '/admin/runtime', admin, { ...DEFAULTS, ffmpegConcurrency: 4 })
    await runBatch(batch.id, user.id, [])

    // 导入这条线真正的旋钮是 ffmpeg 的槽位，不是管线并发——只暴露后者的话
    // 管理员调完会发现一点没变快，然后不知道为什么（任务 §为什么要做）
    expect(ffmpegConcurrency()).toBe(4)
  })
})
