import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 打标队列消费者的集成测试（joint-tasks/2026-09-16-tag-queue.md）。
 *
 * 真 Postgres + 真图像管线（sharp / ffmpeg）+ 真路由层代码，**只把两件事换掉**：
 * R2 换内存对象，`fetch` 换成可编排的替身。视觉供应商不能用真的——一次跑测试
 * 花几十次调用的钱，而且它的输出不稳定，断言不了。
 *
 * ⚠️ 判定逻辑本身的测试在 `src/lib/vision-output.test.ts`，用的是
 *    `docs/fixtures/responses/` 里的**真实响应样本**。这里测的是「判定结果接上
 *    队列和数据库之后，库里变成什么样」——两层不重复。
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
const { enqueueTagJob } = await import('../src/data/tag-jobs.js')
const { tagMeme } = await import('../src/services/tagging.js')
const { startTagWorker, stopTagWorker } = await import('../src/queue/worker.js')
const { memes, tagJobs } = await import('../src/data/schema.js')
const { loadFixture, FIXTURES } = await import('./helpers/fixtures.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

// ── fetch 替身 ─────────────────────────────────────────────────────

type Reply = { status?: number; json?: unknown; text?: string }

/** 视觉调用按顺序取，取完之后重复用最后一条——降级梯子会连发好几次。 */
let visionReplies: Reply[] = []
let embedReply: Reply = { json: { data: [{ embedding: new Array(TEST_EMBED_DIM).fill(0.1) }] } }

/** 每次视觉调用发了几张图、带没带提示。断「先降帧再降通道」时要看这个。 */
const visionCalls: { images: number; hint: string | null }[] = []
let embedCallCount = 0

function toResponse(reply: Reply): Response {
  const status = reply.status ?? 200
  if (reply.text !== undefined) return new Response(reply.text, { status })
  return new Response(JSON.stringify(reply.json ?? {}), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 把一段正文包成 OpenAI 兼容的 chat 信封。 */
function chat(content: string, finishReason = 'stop'): Reply {
  return { json: { choices: [{ message: { content }, finish_reason: finishReason }] } }
}

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    if (url.includes('/v1/chat/completions')) {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: unknown }[]
      }
      const user = body.messages.find((m) => m.role === 'user')
      const parts = Array.isArray(user?.content) ? (user.content as { type: string; text?: string }[]) : []
      visionCalls.push({
        images: parts.filter((p) => p.type === 'image_url').length,
        hint: parts.find((p) => p.type === 'text')?.text ?? null,
      })
      const reply = visionReplies[Math.min(visionCalls.length - 1, visionReplies.length - 1)]
      return toResponse(reply ?? chat('{}'))
    }

    if (url.includes('/v1/embeddings')) {
      embedCallCount += 1
      return toResponse(embedReply)
    }

    throw new Error(`测试里出现了预期外的外部调用：${url}`)
  })
}

// ── 脚手架 ─────────────────────────────────────────────────────────

async function seedMeme(
  options: { fixture?: string; isAnimated?: boolean; mime?: string } = {},
): Promise<{ id: string; userId: string }> {
  const user = await createUser(db)
  const fixture = options.fixture ?? FIXTURES.staticPng
  const bytes = await loadFixture(fixture)
  const storageKey = `memes/${crypto.randomUUID()}.png`
  seedObject(storageKey, bytes)

  const meme = await makeMeme(db, {
    uploaderId: user.id,
    storageKey,
    isAnimated: options.isAnimated ?? false,
    mime: options.mime ?? 'image/png',
  })
  return { id: meme.id, userId: user.id }
}

async function enqueue(memeId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => enqueueTagJob(memeId, userId, tx))
}

async function memeRow(id: string) {
  const [row] = await db.select().from(memes).where(eq(memes.id, id))
  if (row === undefined) throw new Error('meme 不见了')
  return row
}

async function jobRow(memeId: string) {
  const [row] = await db.select().from(tagJobs).where(eq(tagJobs.memeId, memeId))
  if (row === undefined) throw new Error('任务不见了')
  return row
}

/**
 * 起 worker，等这条任务被处理完一轮，再停掉。
 *
 * 判据是「attempts 比进来时多了一次，且不再是 running」——
 *
 *   - 不能只等 `status !== 'pending'`：重试分支会把状态写回 pending，那几条会一直等到超时。
 *   - 不能只等 `attempts >= 1`：有的用例会先把 attempts 顶到上限附近，那样条件在
 *     worker 还没碰过这条任务时就已经成立，测的就变成了「我自己刚写进去的那一行」。
 */
async function workUntilSettled(memeId: string, timeoutMs = 15_000): Promise<void> {
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

const OK_CONTENT = JSON.stringify({
  ocrText: '我服了',
  description: '一只猫翻着白眼，一脸无话可说的表情，配着「我服了」三个大字',
  // 「服了」不在 emotions 里，靠别名归一化成「无语」——这条断言顺便钉住了
  // 「alias 归一化排在校验词表之前」（ai-providers.md §5）
  emotions: ['服了'],
  scenes: ['吐槽'],
  tags: { subject: ['猫'], style: ['真人'] },
})

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
  visionCalls.length = 0
  embedCallCount = 0
  visionReplies = [chat(OK_CONTENT)]
  embedReply = { json: { data: [{ embedding: new Array(TEST_EMBED_DIM).fill(0.1) }] } }
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

// ── 正常路径 ───────────────────────────────────────────────────────

describe('打标成功', () => {
  it('五个字段 + search_text + embedding 一次写完，任务标 done', async () => {
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)

    await workUntilSettled(id)

    const row = await memeRow(id)
    expect(row.tagStatus).toBe('ok')
    expect(row.ocrText).toBe('我服了')
    expect(row.description).toContain('翻着白眼')
    // alias 归一化：「服了」→「无语」（shared/vocab/vocab.json）
    expect(row.emotions).toEqual(['无语'])
    expect(row.scenes).toEqual(['吐槽'])
    // tags 是扁平的 text[]，subject 和 style 合到一起
    expect(row.tags).toEqual(['猫', '真人'])
    expect(row.visionModel).toBe('test-vision')

    // search_text 必须和五个来源字段同一条 UPDATE 写进去，否则文本检索搜不到这张图
    expect(row.searchText).not.toBeNull()
    expect(row.searchText).toContain('我服了')
    expect(row.searchText).toContain('吐槽')
    // original_filename **不进** search_text（SPEC §5.2.3）
    expect(row.searchText).not.toContain('.png')

    expect(row.embedding).not.toBeNull()
    expect(row.embedModel).toBe('test-embed')

    expect((await jobRow(id)).status).toBe('done')
  })

  it('静图只发一张 PNG，不带多帧提示', async () => {
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await workUntilSettled(id)

    expect(visionCalls).toHaveLength(1)
    expect(visionCalls[0]?.images).toBe(1)
    expect(visionCalls[0]?.hint).toBeNull()
  })

  it('词表外的标签被丢掉，不是整条作废', async () => {
    visionReplies = [
      chat(
        JSON.stringify({
          ocrText: '',
          description: '一只狗在敲键盘',
          emotions: ['开心', '这个词表里没有'],
          scenes: [],
          tags: { subject: ['狗'], style: ['赛博朋克风'] },
        }),
      ),
    ]
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await workUntilSettled(id)

    const row = await memeRow(id)
    // 判空排在校验词表之后（ai-providers.md §5）：越界的词丢掉，剩下的照常入库
    expect(row.tagStatus).toBe('ok')
    expect(row.emotions).toEqual(['开心'])
    expect(row.tags).toEqual(['狗'])
  })
})

describe('动图', () => {
  it('抽帧之后拼成一张图发出去——没有探测记录时不发多图', async () => {
    const { id, userId } = await seedMeme({
      fixture: FIXTURES.animatedGif,
      isAnimated: true,
      mime: 'image/gif',
    })
    await enqueue(id, userId)
    await workUntilSettled(id)

    expect((await memeRow(id)).tagStatus).toBe('ok')
    expect(visionCalls).toHaveLength(1)
    // `vision_multi_image` 没有探测记录（null）时走最保守路径：拼图，**一张**
    expect(visionCalls[0]?.images).toBe(1)
    expect(visionCalls[0]?.hint).toContain('网格图')
  })
})

// ── 三种拒绝形态（ai-providers.md §3） ──────────────────────────────

describe('拒绝的三种形态', () => {
  it('形态一：HTTP 层的内容策略错误码', async () => {
    visionReplies = [{ status: 451, json: { error: { message: 'content_policy_violation' } } }]
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await workUntilSettled(id)

    // AI_REFUSED **不重试主通道**：内容策略拒绝是确定性的，重试只是浪费用户的钱
    expect(visionCalls).toHaveLength(1)
    const job = await jobRow(id)
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(1)
    expect((await memeRow(id)).tagStatus).toBe('needs_manual')
  })

  it('形态二：HTTP 200 但正文是拒绝措辞', async () => {
    visionReplies = [chat('抱歉，我无法描述这张图片。')]
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await workUntilSettled(id)

    expect(visionCalls).toHaveLength(1)
    expect((await jobRow(id)).status).toBe('failed')
    expect((await memeRow(id)).tagStatus).toBe('needs_manual')
  })

  it('形态三：JSON 结构完整但内容全空——最阴险的一种', async () => {
    visionReplies = [
      chat(
        JSON.stringify({
          ocrText: '',
          description: '',
          emotions: [],
          scenes: [],
          tags: { subject: [], style: [] },
        }),
      ),
    ]
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await workUntilSettled(id)

    const row = await memeRow(id)
    // 这一条挡的是「JSON 解析成功、类型检查通过、字段都在，于是当成一次成功的打标
    // 写进库」——那张图会带着一组空标签躺在共享库里，搜不到也没人知道为什么
    expect(row.tagStatus).toBe('needs_manual')
    expect(row.description).toBeNull()
    expect(row.searchText).toBeNull()
    expect((await jobRow(id)).status).toBe('failed')
  })

  it('词表过滤之后才全空的，同样算拒绝', async () => {
    visionReplies = [
      chat(
        JSON.stringify({
          ocrText: '',
          description: '',
          emotions: ['一个不存在的情绪'],
          scenes: [],
          tags: { subject: [], style: [] },
        }),
      ),
    ]
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await workUntilSettled(id)

    expect((await memeRow(id)).tagStatus).toBe('needs_manual')
  })
})

// ── 重试矩阵（queue.md §3） ─────────────────────────────────────────

describe('重试矩阵', () => {
  it('AI_UNREACHABLE：回队列并推后 run_after，不是失败', async () => {
    visionReplies = [{ status: 503, text: 'upstream is down' }]
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    const before = Date.now()
    await workUntilSettled(id)

    const job = await jobRow(id)
    expect(job.status).toBe('pending')
    expect(job.attempts).toBe(1)
    // 退避靠推后 run_after，不靠 worker 里 sleep
    expect(job.runAfter.getTime()).toBeGreaterThan(before + 10_000)
    // 还在重试，图不该被判死
    expect((await memeRow(id)).tagStatus).toBe('pending')
  })

  it('AI_UNREACHABLE 攒够次数之后转 needs_manual', async () => {
    visionReplies = [{ status: 503, text: 'upstream is down' }]
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    // 直接把 attempts 顶到上限前一次，省掉真的等五轮退避
    await db.update(tagJobs).set({ attempts: 4 }).where(eq(tagJobs.memeId, id))

    await workUntilSettled(id)

    expect((await jobRow(id)).status).toBe('failed')
    expect((await memeRow(id)).tagStatus).toBe('needs_manual')
  })

  it('AI_INVALID_OUTPUT：主通道重试 1 次', async () => {
    visionReplies = [chat('这不是 JSON，只是一段闲聊。')]
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await workUntilSettled(id)

    const job = await jobRow(id)
    expect(job.status).toBe('pending')
    // 不是「等一会儿就好」的故障，退避几乎为零
    expect(job.runAfter.getTime()).toBeLessThan(Date.now() + 10_000)
    expect((await memeRow(id)).tagStatus).toBe('pending')
  })

  it('AI_INVALID_OUTPUT 第二次仍失败按 AI_REFUSED 处理', async () => {
    visionReplies = [chat('这不是 JSON，只是一段闲聊。')]
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await db.update(tagJobs).set({ attempts: 1 }).where(eq(tagJobs.memeId, id))

    await workUntilSettled(id)

    expect((await jobRow(id)).status).toBe('failed')
    expect((await memeRow(id)).tagStatus).toBe('needs_manual')
  })

  it('AI_UNSUPPORTED：一次都不重试', async () => {
    // 真实样本形态：api.codexzh.com 的 30/30 都是 HTTP 400 + protocol_not_supported
    visionReplies = [
      { status: 400, json: { error: { message: '模型不支持 chat completions 协议', code: 'protocol_not_supported' } } },
    ]
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await workUntilSettled(id)

    expect(visionCalls).toHaveLength(1)
    expect((await jobRow(id)).status).toBe('failed')
    expect((await memeRow(id)).tagStatus).toBe('needs_manual')
  })
})

// ── embedding ──────────────────────────────────────────────────────

describe('embedding 失败不回滚打标', () => {
  it('打标留在 ok，只有向量为空，任务回队列单独重试', async () => {
    embedReply = { status: 500, text: 'embedding service down' }
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await workUntilSettled(id)

    const row = await memeRow(id)
    // 标已经打好了，向量没算出来只是让这张图暂时进不了向量路。
    // 把 tag_status 一起退回等于扔掉一次已经付过钱的视觉调用
    expect(row.tagStatus).toBe('ok')
    expect(row.searchText).not.toBeNull()
    expect(row.embedding).toBeNull()
    expect((await jobRow(id)).status).toBe('pending')
  })

  it('重试时不再调视觉模型，只补算向量', async () => {
    embedReply = { status: 500, text: 'embedding service down' }
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await workUntilSettled(id)
    expect(visionCalls).toHaveLength(1)

    // 修好 embedding，把任务放回可取状态
    embedReply = { json: { data: [{ embedding: new Array(TEST_EMBED_DIM).fill(0.2) }] } }
    await db
      .update(tagJobs)
      .set({ status: 'pending', runAfter: new Date(), attempts: 0 })
      .where(eq(tagJobs.memeId, id))

    await workUntilSettled(id)

    const row = await memeRow(id)
    expect(row.embedding).not.toBeNull()
    // **视觉调用没有再发一次**——那一步的产出和上次一模一样，重付一次钱没有道理
    expect(visionCalls).toHaveLength(1)
    expect(embedCallCount).toBe(2)
    expect((await jobRow(id)).status).toBe('done')
  })
})

// ── 软删 ───────────────────────────────────────────────────────────

describe('排队期间图被删掉', () => {
  it('任务直接判完成，不调 AI', async () => {
    const { id, userId } = await seedMeme()
    await enqueue(id, userId)
    await db.update(memes).set({ deletedAt: new Date() }).where(eq(memes.id, id))

    await workUntilSettled(id)

    expect(visionCalls).toHaveLength(0)
    expect((await jobRow(id)).status).toBe('done')
  })
})

// ── 并发按用户分（queue.md §4） ─────────────────────────────────────

describe('并发按用户分', () => {
  it('一个人的批量导入不会把别人的图堵在后面', async () => {
    const heavy = await createUser(db)
    const light = await createUser(db)
    const bytes = await loadFixture(FIXTURES.staticPng)

    const heavyIds: string[] = []
    for (let i = 0; i < 6; i += 1) {
      const storageKey = `memes/heavy-${i}.png`
      seedObject(storageKey, bytes)
      const meme = await makeMeme(db, { uploaderId: heavy.id, storageKey })
      await enqueue(meme.id, heavy.id)
      heavyIds.push(meme.id)
    }
    // 后入队，run_after 也更晚——纯按 run_after 排序的话它排在六张之后
    const lightKey = 'memes/light.png'
    seedObject(lightKey, bytes)
    const lightMeme = await makeMeme(db, { uploaderId: light.id, storageKey: lightKey })
    await enqueue(lightMeme.id, light.id)

    startTagWorker()
    try {
      const deadline = Date.now() + 20_000
      for (;;) {
        if ((await jobRow(lightMeme.id)).status === 'done') break
        if (Date.now() > deadline) throw new Error('轻量用户的任务一直没被处理')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } finally {
      await stopTagWorker()
    }

    // 判据不是「它第一个完成」（那取决于调度时序），而是「它没有等六张全跑完」。
    // 这就是 queue.md §4 存在的理由：共享库里一个人的批量导入会直接影响所有人的体验
    const doneHeavy = await Promise.all(heavyIds.map(async (i) => (await jobRow(i)).status))
    expect(doneHeavy.filter((s) => s === 'done').length).toBeLessThan(heavyIds.length)
  })
})

// ── services 层直调（不经队列） ─────────────────────────────────────

describe('tagMeme 直调', () => {
  it('图不存在时返回 gone，不调 AI', async () => {
    const outcome = await tagMeme(crypto.randomUUID(), new AbortController().signal)
    expect(outcome.kind).toBe('gone')
    expect(visionCalls).toHaveLength(0)
  })
})
