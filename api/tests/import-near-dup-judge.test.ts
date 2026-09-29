import { Hono } from 'hono'
import sharp from 'sharp'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 近似重复自动判定的集成测试（SPEC §9.33 / 任务 2026-09-29-近似重复自动判定）。
 *
 * 真实路由 + 真实管线 + 真 Postgres，R2 是内存替身。
 *
 * ⚠️ **视觉上游是替身**：`fetch` 被换成按队列取回复的桩，这里测的是「拿到某个结论之后
 *    管线怎么走、库里变成什么样」，**不是模型判得准不准**。真实模型对「同模板换字」
 *    的判断质量在这个文件里没有量过（testing.md）。
 *
 * 没配视觉通道的落点在 import.test.ts（那个文件的 env 是空的；env 在首次 import 时冻结，
 * 所以有通道和没通道只能分文件）。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
process.env['DEFAULT_VISION_BASE_URL'] = 'https://vision.test'
process.env['DEFAULT_VISION_API_KEY'] = 'vision-key-not-real'
process.env['DEFAULT_VISION_MODEL'] = 'test-vision'

const { installR2Memory, resetR2, seedObject, hasObject } = await import('./helpers/r2-memory.js')
installR2Memory()

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { importRoutes } = await import('../src/routes/imports.js')
const { memes, tagJobs, importItems } = await import('../src/data/schema.js')
const { computePhash } = await import('../src/image/decode.js')
const { hammingDistance } = await import('../src/lib/phash.js')
const { eq } = await import('drizzle-orm')
const { FIXTURES, loadFixture } = await import('./helpers/fixtures.js')

const { sql, db } = createTestDb()

const testApp = new Hono().use('*', requestId).route('/api/v1/imports', importRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

// ── 视觉上游替身 ───────────────────────────────────────────────────

type Reply = { status?: number; json?: unknown; text?: string; throws?: boolean }

let visionReplies: Reply[] = []
/** 每次判重调用里各张图的 data URL 前缀与解码后的字节头，断「送出去的是 PNG」。 */
const visionCalls: { images: Buffer[]; prompt: string }[] = []

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function chat(content: string, finishReason = 'stop'): Reply {
  return { json: { choices: [{ message: { content }, finish_reason: finishReason }] } }
}

function verdict(v: string, reason = '画面一致'): Reply {
  return chat(JSON.stringify({ verdict: v, reason }))
}

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('/v1/chat/completions')) {
      throw new Error(`测试里出现了预期外的外部调用：${url}`)
    }
    const body = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: unknown }[]
    }
    const system = body.messages.find((m) => m.role === 'system')
    const user = body.messages.find((m) => m.role === 'user')
    const parts = Array.isArray(user?.content)
      ? (user.content as { type: string; image_url?: { url: string } }[])
      : []
    visionCalls.push({
      prompt: typeof system?.content === 'string' ? system.content : '',
      images: parts
        .filter((p) => p.type === 'image_url')
        .map((p) => Buffer.from((p.image_url?.url ?? '').replace(/^data:image\/png;base64,/, ''), 'base64')),
    })
    const reply = visionReplies[Math.min(visionCalls.length - 1, visionReplies.length - 1)]
    if (reply?.throws) throw new DOMException('This operation was aborted', 'AbortError')
    const status = reply?.status ?? 200
    if (reply?.text !== undefined) return new Response(reply.text, { status })
    return new Response(JSON.stringify(reply?.json ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
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

// ── 脚手架 ────────────────────────────────────────────────────────

type Actor = { id: string; cookie: string }

async function signIn(): Promise<Actor> {
  const user = await createUser(db)
  const session = await createSession(user.id, db)
  return { id: user.id, cookie: `sid=${session.id}` }
}

async function call(actor: Actor, method: string, path: string, body?: unknown): Promise<Response> {
  return await testApp.request(`/api/v1/imports${path}`, {
    method,
    headers: {
      cookie: actor.cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

type File = { name: string; bytes: Buffer }

async function sample(names: string[]): Promise<File[]> {
  return await Promise.all(
    names.map(async (name) => ({
      name: name.slice(name.lastIndexOf('/') + 1),
      bytes: await loadFixture(name),
    })),
  )
}

type Snapshot = {
  total: number
  done: number
  skipped: number
  pending: number
  needsReview: number
  failed: number
}

async function runImport(actor: Actor, files: File[]): Promise<{ batchId: string; snapshot: Snapshot }> {
  const presign = await call(actor, 'POST', '', {
    files: files.map((f) => ({ fileName: f.name, sizeBytes: f.bytes.byteLength })),
  })
  expect(presign.status).toBe(200)
  const created = (await presign.json()) as {
    batchId: string
    uploads: { fileName: string; tempKey: string }[]
  }
  for (const upload of created.uploads) {
    const bytes = files.find((f) => f.name === upload.fileName)?.bytes
    if (bytes === undefined) throw new Error(`预签名返回了没请求过的文件：${upload.fileName}`)
    seedObject(upload.tempKey, bytes)
  }
  const commit = await call(actor, 'POST', `/${created.batchId}/commit`, {
    items: created.uploads.map((u) => ({ fileName: u.fileName, tempKey: u.tempKey })),
  })
  expect(commit.status).toBe(202)

  const deadline = Date.now() + 25_000
  for (;;) {
    const res = await call(actor, 'GET', `/${created.batchId}`)
    const snapshot = (await res.json()) as Snapshot
    if (snapshot.pending === 0) return { batchId: created.batchId, snapshot }
    if (Date.now() > deadline) throw new Error(`批次没处理完：${JSON.stringify(snapshot)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function itemOf(batchId: string, fileName: string) {
  const rows = await db.select().from(importItems).where(eq(importItems.batchId, batchId))
  return rows.find((r) => r.fileName === fileName)
}

async function memeOf(fileName: string) {
  const rows = await db.select().from(memes).where(eq(memes.originalFilename, fileName))
  return rows[0] ?? null
}

async function memeCount(): Promise<number> {
  return (await db.select({ id: memes.id }).from(memes)).length
}

async function jobCount(): Promise<number> {
  return (await db.select({ id: tagJobs.id }).from(tagJobs)).length
}

/** 同一批像素、不同的字节：PNG 压缩级别不同，SHA-256 变了、pHash 不变（距离 0）。 */
async function reencodedStatic(): Promise<File> {
  const original = await loadFixture(FIXTURES.staticPng)
  const bytes = await sharp(original).png({ compressionLevel: 0 }).toBuffer()
  expect(bytes.equals(original)).toBe(false)
  return { name: 'static-again.png', bytes }
}

/** 先把 near-resized 入库；随后导 near-jpeg 就是距离 7 的近似命中。 */
async function seedNearResized(alice: Actor): Promise<string> {
  const first = await runImport(alice, await sample([FIXTURES.nearResized]))
  expect(first.snapshot).toMatchObject({ done: 1, failed: 0 })
  const stored = await memeOf('near-resized.png')
  if (stored === null) throw new Error('near-resized 没入库')
  return stored.id
}

// ── 距离 0 ─────────────────────────────────────────────────────────

describe('距离 0：直接判重复，不问任何人', () => {
  it('exact_dup + 留痕，不调 AI、不写 memes、暂存对象被删', async () => {
    const alice = await signIn()
    const first = await runImport(alice, await sample([FIXTURES.staticPng]))
    expect(first.snapshot).toMatchObject({ done: 1 })
    const stored = await memeOf('static.png')

    const again = await reencodedStatic()
    // 前提：字节不同（SHA-256 那关过得去）、pHash 距离恰为 0
    expect(hammingDistance(await computePhash(again.bytes), stored!.phash)).toBe(0)

    const second = await runImport(alice, [again])

    expect(second.snapshot).toMatchObject({ skipped: 1, needsReview: 0, failed: 0, done: 1 })
    const item = await itemOf(second.batchId, again.name)
    expect(item?.result).toBe('exact_dup')
    expect(item?.memeId).toBe(stored!.id)
    expect(item?.distance).toBe(0)
    expect(item?.reason).toContain('距离 0')

    expect(visionCalls).toHaveLength(0)
    expect(await memeCount()).toBe(1)
    expect(await jobCount()).toBe(1)
    expect(hasObject(`temp/${second.batchId}/${again.name}`)).toBe(false)
  })
})

// ── 距离 1…阈值：问视觉模型 ─────────────────────────────────────────

describe('距离 1…阈值：视觉模型三态（上游为替身）', () => {
  it('same → exact_dup + 留痕，两张图都以 PNG 送出，暂存对象被删', async () => {
    const alice = await signIn()
    const existingId = await seedNearResized(alice)
    visionReplies = [verdict('same', '同一张图，只是压缩不同')]

    const second = await runImport(alice, await sample([FIXTURES.nearJpeg]))

    expect(second.snapshot).toMatchObject({ skipped: 1, needsReview: 0, failed: 0 })
    const item = await itemOf(second.batchId, 'near-jpeg.jpg')
    expect(item?.result).toBe('exact_dup')
    expect(item?.memeId).toBe(existingId)
    expect(item?.distance).toBe(7)
    expect(item?.reason).toContain('视觉模型判定为同一张')
    expect(item?.reason).toContain('同一张图，只是压缩不同')

    // 调用恰好一次；两张图，且都是 PNG（送 AI 的永远只有 PNG）
    expect(visionCalls).toHaveLength(1)
    expect(visionCalls[0]?.images).toHaveLength(2)
    for (const image of visionCalls[0]!.images) {
      expect(image.subarray(0, 4).equals(PNG_MAGIC)).toBe(true)
    }
    // 提示词要求从严：钉住「拿不准就 unsure」这句，别被谁调提示词时删掉
    expect(visionCalls[0]?.prompt).toContain('unsure')

    expect(await memeOf('near-jpeg.jpg')).toBeNull()
    expect(await memeCount()).toBe(1)
    expect(await jobCount()).toBe(1)
    expect(hasObject(`temp/${second.batchId}/near-jpeg.jpg`)).toBe(false)
  })

  it('different → 正常入库并进打标队列', async () => {
    const alice = await signIn()
    await seedNearResized(alice)
    visionReplies = [verdict('different', '文字不同')]

    const second = await runImport(alice, await sample([FIXTURES.nearJpeg]))

    expect(second.snapshot).toMatchObject({ done: 1, skipped: 0, needsReview: 0, failed: 0 })
    const item = await itemOf(second.batchId, 'near-jpeg.jpg')
    expect(item?.result).toBe('imported')
    expect(await memeOf('near-jpeg.jpg')).not.toBeNull()
    expect(await jobCount()).toBe(2)
    expect(visionCalls).toHaveLength(1)
  })

  it('unsure → needs_review，与没有判重前一致：带 similarTo / distance，temp 保留', async () => {
    const alice = await signIn()
    const existingId = await seedNearResized(alice)
    visionReplies = [verdict('unsure', '看不清')]

    const second = await runImport(alice, await sample([FIXTURES.nearJpeg]))

    expect(second.snapshot).toMatchObject({ needsReview: 1, skipped: 0, failed: 0 })
    const item = await itemOf(second.batchId, 'near-jpeg.jpg')
    expect(item?.result).toBe('needs_review')
    expect(item?.similarTo).toBe(existingId)
    expect(item?.distance).toBe(7)
    expect(item?.reason).toBe('库里已有一张相近的图（距离 7）')
    expect(await memeOf('near-jpeg.jpg')).toBeNull()
    expect(await jobCount()).toBe(1)
    expect(hasObject(`temp/${second.batchId}/near-jpeg.jpg`)).toBe(true)
  })

  // 下面每一种都必须落回 needs_review：不是 failed，也不是悄悄入库，更不是 exact_dup
  const degradations: [string, Reply][] = [
    ['上游 503', { status: 503, text: 'upstream is down' }],
    ['上游 400（不支持该协议）', { status: 400, json: { error: { message: '模型不支持 chat completions 协议' } } }],
    ['网络错误 / 超时（fetch 抛 AbortError）', { throws: true }],
    ['正文不是 JSON', chat('这两张图看起来差不多。')],
    ['JSON 合法但 verdict 不在三态里', verdict('identical')],
    ['JSON 合法但缺 verdict', chat(JSON.stringify({ reason: '一样' }))],
    ['输出被截断（finish_reason = length）即使内容像是 same', chat('{"verdict":"same","reason":"一', 'length')],
    ['截断且恰好是完整 same', chat(JSON.stringify({ verdict: 'same', reason: 'x' }), 'length')],
  ]
  for (const [title, reply] of degradations) {
    it(`调用失败 / 输出不合规 → needs_review：${title}`, async () => {
      const alice = await signIn()
      const existingId = await seedNearResized(alice)
      visionReplies = [reply]

      const second = await runImport(alice, await sample([FIXTURES.nearJpeg]))

      expect(second.snapshot).toMatchObject({ needsReview: 1, skipped: 0, failed: 0 })
      const item = await itemOf(second.batchId, 'near-jpeg.jpg')
      expect(item?.result).toBe('needs_review')
      expect(item?.similarTo).toBe(existingId)
      expect(item?.distance).toBe(7)
      expect(await memeOf('near-jpeg.jpg')).toBeNull()
      expect(hasObject(`temp/${second.batchId}/near-jpeg.jpg`)).toBe(true)
    })
  }

  it('带围栏 / 前后缀的 JSON 仍能解析（same 的宽容解析）', async () => {
    const alice = await signIn()
    await seedNearResized(alice)
    visionReplies = [chat('结论如下：\n```json\n{"verdict":"Same","reason":"一致"}\n```')]

    const second = await runImport(alice, await sample([FIXTURES.nearJpeg]))
    expect(second.snapshot).toMatchObject({ skipped: 1 })
  })
})

// ── 分层与批次 ─────────────────────────────────────────────────────

describe('超过阈值与批次内互不影响', () => {
  it('距离超过阈值：不调视觉模型，照常入库', async () => {
    const alice = await signIn()
    await seedNearResized(alice)

    const second = await runImport(alice, await sample([FIXTURES.different]))

    expect(second.snapshot).toMatchObject({ done: 1, needsReview: 0, failed: 0 })
    expect(visionCalls).toHaveLength(0)
    expect(await memeOf('different.png')).not.toBeNull()
  })

  it('一批里既有距离 0 又有要问模型的：各走各的，互不影响', async () => {
    const alice = await signIn()
    // 库里先有 static.png 与 near-resized.png
    const seeded = await runImport(alice, await sample([FIXTURES.staticPng, FIXTURES.nearResized]))
    expect(seeded.snapshot).toMatchObject({ done: 2, failed: 0 })
    visionReplies = [verdict('unsure', '拿不准')]

    const again = await reencodedStatic()
    const near = (await sample([FIXTURES.nearJpeg]))[0]!
    const second = await runImport(alice, [again, near])

    expect(second.snapshot).toMatchObject({ total: 2, skipped: 1, needsReview: 1, failed: 0 })
    expect((await itemOf(second.batchId, again.name))?.result).toBe('exact_dup')
    expect((await itemOf(second.batchId, near.name))?.result).toBe('needs_review')
    // 只有近似那一张调了模型
    expect(visionCalls).toHaveLength(1)
  })
})
