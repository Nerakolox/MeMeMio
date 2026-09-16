import { beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 降帧梯子：**图片数超限时先降帧，不降通道**（ai-providers.md §4 / SPEC §2.4）。
 *
 * 单开一个文件是因为这条路径在**生产环境里今天走不到**：`resolveVisionConfig()` 固定
 * 返回 `multiImage: null`（没有测试连接记录时按最保守路径走），于是动图的 plan 永远
 * 是单级的拼图，10 帧那一级排不出来。等 SPEC §6.5 的配置任务把探测结果存下来之后，
 * 这条梯子就会在真实流量里被走到——所以它现在必须有测试，而不是等那天再补。
 *
 * ⚠️ 这里 mock 的**只有 `resolveVisionConfig` 一个函数**，`callVision`、提示词、
 *    图像管线全是真的。把整个 `ai/vision.js` 换成假的等于把被测对象也换掉了。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
process.env['DEFAULT_VISION_BASE_URL'] = 'https://vision.test'
process.env['DEFAULT_VISION_API_KEY'] = 'vision-key-not-real'
process.env['DEFAULT_VISION_MODEL'] = 'test-vision'
// 这个文件不关心向量，关掉 embedding 通道，省得每条用例都要摆一个 embeddings 响应
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''

const { installR2Memory, resetR2, seedObject } = await import('./helpers/r2-memory.js')
installR2Memory()

/** 只改能力位，其余（凭据、`callVision`、提示词）全用真的。 */
vi.mock('../src/ai/vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/vision.js')>()
  return {
    ...actual,
    resolveVisionConfig: () => {
      const config = actual.resolveVisionConfig()
      return config === null ? null : { ...config, multiImage: true }
    },
  }
})

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { enqueueTagJob } = await import('../src/data/tag-jobs.js')
const { startTagWorker, stopTagWorker } = await import('../src/queue/worker.js')
const { memes, tagJobs } = await import('../src/data/schema.js')
const { loadFixture, FIXTURES } = await import('./helpers/fixtures.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

type Reply = { status?: number; json?: unknown; text?: string }

/** 供应商说「一次发不了这么多图」的那种 400。判定靠**错误语义**，不认厂商。 */
const IMAGE_LIMIT: Reply = {
  status: 400,
  json: { error: { message: 'too many images in one request (max 4)' } },
}

const OK_CONTENT = JSON.stringify({
  ocrText: '',
  description: '一只猫反复翻白眼，最后趴下不动了',
  emotions: ['无语'],
  scenes: ['吐槽'],
  tags: { subject: ['猫'], style: ['真人'] },
})

function chat(content: string): Reply {
  return { json: { choices: [{ message: { content }, finish_reason: 'stop' }] } }
}

let visionReplies: Reply[] = []
const visionCalls: { images: number; hint: string | null; model: string }[] = []

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('/v1/chat/completions')) {
      throw new Error(`测试里出现了预期外的外部调用：${url}`)
    }

    const body = JSON.parse(String(init?.body)) as {
      model: string
      messages: { role: string; content: unknown }[]
    }
    const user = body.messages.find((m) => m.role === 'user')
    const parts = Array.isArray(user?.content)
      ? (user.content as { type: string; text?: string }[])
      : []
    visionCalls.push({
      images: parts.filter((p) => p.type === 'image_url').length,
      hint: parts.find((p) => p.type === 'text')?.text ?? null,
      model: body.model,
    })

    const reply = visionReplies[Math.min(visionCalls.length - 1, visionReplies.length - 1)]
    const chosen = reply ?? IMAGE_LIMIT
    const status = chosen.status ?? 200
    if (chosen.text !== undefined) return new Response(chosen.text, { status })
    return new Response(JSON.stringify(chosen.json ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
}

async function seedLongAnimated(): Promise<string> {
  const user = await createUser(db)
  const bytes = await loadFixture(FIXTURES.animatedLongGif)
  const storageKey = `memes/${crypto.randomUUID()}.gif`
  seedObject(storageKey, bytes)

  const meme = await makeMeme(db, {
    uploaderId: user.id,
    storageKey,
    isAnimated: true,
    mime: 'image/gif',
  })
  await db.transaction(async (tx) => enqueueTagJob(meme.id, user.id, tx))
  return meme.id
}

async function jobRow(memeId: string) {
  const [row] = await db.select().from(tagJobs).where(eq(tagJobs.memeId, memeId))
  if (row === undefined) throw new Error('任务不见了')
  return row
}

async function workUntilSettled(memeId: string, timeoutMs = 20_000): Promise<void> {
  const baseline = (await jobRow(memeId)).attempts
  startTagWorker()
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = await jobRow(memeId)
      if (job.attempts > baseline && job.status !== 'running') return
      if (Date.now() > deadline) throw new Error(`等待任务处理超时：${job.status}/${job.attempts}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } finally {
    await stopTagWorker()
  }
}

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
  visionCalls.length = 0
  visionReplies = []
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

describe('图片数超限', () => {
  it('10 帧 → 4 帧 → 拼图，全程同一个通道', async () => {
    visionReplies = [IMAGE_LIMIT] // 三级都撞上限
    const memeId = await seedLongAnimated()

    await workUntilSettled(memeId)

    expect(visionCalls.map((c) => c.images)).toEqual([10, 4, 1])
    // 拼图那一级是**一张**图，不是四张——四张的话它跟「降到 4 帧」就没区别了
    expect(visionCalls[2]?.images).toBe(1)
    expect(visionCalls[0]?.hint).toContain('按时间顺序抽出的若干帧')
    expect(visionCalls[2]?.hint).toContain('网格图')

    // **梯子全程不换通道**：`vision_multi_image` 只说支不支持多图，探测不出上限，
    // 换一家同样可能超限，还要白花另一条通道的钱（ai-providers.md §4）
    expect(new Set(visionCalls.map((c) => c.model))).toEqual(new Set(['test-vision']))

    // 梯子走完仍然超限 = 正常降级走到头，按拒绝处理：终局，不重试
    const job = await jobRow(memeId)
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(1)

    const [meme] = await db.select().from(memes).where(eq(memes.id, memeId))
    expect(meme?.tagStatus).toBe('needs_manual')
  })

  it('降一级就成功的话不再往下降，也不算失败', async () => {
    visionReplies = [IMAGE_LIMIT, chat(OK_CONTENT)]
    const memeId = await seedLongAnimated()

    await workUntilSettled(memeId)

    // 第二级就过了，拼图那一级不该再发
    expect(visionCalls.map((c) => c.images)).toEqual([10, 4])

    const [meme] = await db.select().from(memes).where(eq(memes.id, memeId))
    expect(meme?.tagStatus).toBe('ok')
    expect(meme?.emotions).toEqual(['无语'])
    // 降级不是错误（SPEC §2.4）：这次打标是成功的，任务正常完成
    expect((await jobRow(memeId)).status).toBe('done')
  })
})
