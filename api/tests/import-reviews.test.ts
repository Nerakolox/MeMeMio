import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 待确认队列的集成测试（SPEC §6.2.3 / joint-tasks/2026-09-15-import.md）。
 *
 * 队列是导入里唯一**跨越批次**的界面：用户可能今天传一批、明天传一批，
 * 攒下一堆「像重复」的图，然后一次处理掉。所以这里测三件事——
 *
 *   1. 列表能跨批次把同一个用户的条目都捞出来，并且带够并排对比要用的字段
 *   2. 只有条目主人能看见和处理（别人的批次一律按不存在处理）
 *   3. 两个动作的副作用方向相反：`import` 真的入库并打标、`skip` 丢掉 temp 对象
 *
 * 与 import.test.ts 一样：真实路由 + 真实管线 + 真 Postgres，只有 R2 是内存替身。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''

/**
 * ⚠️ **前缀在这里定死成非空，不用 `.env` 里填的那个。**
 *
 * 这个文件是三个公开地址（`tempUrl` / `existing.url` / `existing.thumbUrl`）唯一
 * 同时出现的地方，也就是「派生 URL 时漏了 `R2_KEY_PREFIX`」的回归位置。而前缀为空时
 * 带不带前缀拼出来是同一个字符串——用空前缀跑的断言全都照过，等于没断言。
 * `.env` 里填什么不由这里控制，所以自己定一个。
 */
process.env['R2_KEY_PREFIX'] = 'reviews-test/'

const { installR2Memory, resetR2, seedObject, hasObject, objectKeys } = await import(
  './helpers/r2-memory.js'
)
installR2Memory()

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { env } = await import('../src/env.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { importRoutes } = await import('../src/routes/imports.js')
const { memes, tagJobs, importItems } = await import('../src/data/schema.js')
const { eq } = await import('drizzle-orm')
const { FIXTURES, loadFixture } = await import('./helpers/fixtures.js')

const { sql, db } = createTestDb()

const testApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/imports', importRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
})

afterAll(async () => {
  await sql.end()
})

// ── 脚手架（与 import.test.ts 同形；重写一份是为了两边能各自独立演进） ────

type Actor = { id: string; role: 'admin' | 'member'; cookie: string }

async function signIn(overrides: { name?: string; quotaBytes?: bigint } = {}): Promise<Actor> {
  const user = await createUser(db, { name: overrides.name })
  if (overrides.quotaBytes !== undefined) {
    await sql`update users set storage_quota_bytes = ${overrides.quotaBytes.toString()}::bigint where id = ${user.id}`
  }
  const session = await createSession(user.id, db)
  return { id: user.id, role: user.role, cookie: `sid=${session.id}` }
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

async function sample(names: string[]): Promise<{ name: string; bytes: Buffer }[]> {
  return await Promise.all(
    names.map(async (name) => ({
      name: name.slice(name.lastIndexOf('/') + 1),
      bytes: await loadFixture(name),
    })),
  )
}

type ReviewEntry = {
  batchId: string
  fileName: string
  tempUrl: string | null
  sizeBytes: string | null
  width: number | null
  height: number | null
  distance: number | null
  existing: { id: string; originalFilename: string | null; url: string; thumbUrl: string } | null
}

async function runImport(
  actor: Actor,
  files: { name: string; bytes: Buffer }[],
): Promise<{ batchId: string }> {
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
    seedObject(upload.tempKey, bytes!)
  }

  const commit = await call(actor, 'POST', `/${created.batchId}/commit`, {
    items: created.uploads.map((u) => ({ fileName: u.fileName, tempKey: u.tempKey })),
  })
  expect(commit.status).toBe(202)
  await waitForBatch(actor, created.batchId)
  return { batchId: created.batchId }
}

async function waitForBatch(actor: Actor, batchId: string): Promise<void> {
  const deadline = Date.now() + 25_000
  for (;;) {
    const res = await call(actor, 'GET', `/${batchId}`)
    const snapshot = (await res.json()) as { pending: number }
    if (snapshot.pending === 0) return
    if (Date.now() > deadline) throw new Error(`批次没处理完：${JSON.stringify(snapshot)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * 造出一条待确认条目，返回它的批次号和文件名。
 *
 * `near-resized` 与 `near-jpeg` 实测汉明距离 7，低于 `NEAR_DUP_DISTANCE = 8`
 * （见 helpers/fixtures.ts），所以先导前者、再导后者就会落进队列。
 */
async function makeReviewItem(actor: Actor): Promise<{ batchId: string; fileName: string }> {
  await runImport(actor, await sample([FIXTURES.nearResized]))
  const { batchId } = await runImport(actor, await sample([FIXTURES.nearJpeg]))
  return { batchId, fileName: 'near-jpeg.jpg' }
}

async function listReviews(actor: Actor): Promise<ReviewEntry[]> {
  const res = await call(actor, 'GET', '/reviews')
  expect(res.status).toBe(200)
  return ((await res.json()) as { items: ReviewEntry[] }).items
}

async function memeOf(fileName: string) {
  const rows = await db.select().from(memes).where(eq(memes.originalFilename, fileName))
  return rows[0] ?? null
}

async function itemOf(batchId: string, fileName: string) {
  const rows = await db.select().from(importItems).where(eq(importItems.batchId, batchId))
  return rows.find((r) => r.fileName === fileName)
}

async function jobCount(): Promise<number> {
  const rows = await db.select({ id: tagJobs.id }).from(tagJobs)
  return rows.length
}

/**
 * 公开 URL → R2 上的**完整键**（带部署前缀）。
 *
 * 用它而不是 `toContain('temp/...')`：子串断言在漏了前缀时照样过，而漏前缀正是
 * 2026-09-18 那次事故的全部内容。反推出键再和桶里真实存在的键比，测的是
 * 「这个地址真能打开」——那个 bug 唯一的表现就是不报错、只是 404。
 */
function fullKeyOf(url: string): string {
  const base = `${env.r2PublicBaseUrl}/`
  expect(url.startsWith(base)).toBe(true)
  return url.slice(base.length)
}

// ── 列表 ──────────────────────────────────────────────────────────

describe('待确认队列（GET /reviews）', () => {
  it('没有待确认条目时返回空数组，而不是 404', async () => {
    const alice = await signIn()
    expect(await listReviews(alice)).toEqual([])
  })

  it('带齐并排对比要用的字段：tempUrl、距离、existing 完整序列化', async () => {
    const alice = await signIn()
    const { batchId, fileName } = await makeReviewItem(alice)

    const items = await listReviews(alice)
    expect(items).toHaveLength(1)
    const entry = items[0]!

    expect(entry.batchId).toBe(batchId)
    expect(entry.fileName).toBe(fileName)
    // 用户要看到「新图 vs 库里那张」两张图才敢决定，所以 tempUrl 和 existing.url 都得有
    expect(entry.tempUrl).toContain(`temp/${batchId}/${fileName}`)
    expect(entry.distance).toBe(7)
    expect(entry.existing?.originalFilename).toBe('near-resized.png')

    // existing 走的是**和浏览接口同一个序列化函数**，所以内部字段一个都不该漏出来
    expect(entry.existing).not.toHaveProperty('storageKey')
    expect(entry.existing).not.toHaveProperty('contentHash')
    expect(entry.existing).not.toHaveProperty('phash')
    expect(typeof entry.existing?.url).toBe('string')

    // 条目还没入库，宽高如实是 null，不能编一个 0 出来糊弄前端
    expect(entry.width).toBeNull()
    expect(entry.height).toBeNull()
    expect(entry.sizeBytes).not.toBeNull()
  })

  /**
   * 回归锚点：joint-tasks/2026-09-18-r2-public-url-prefix.md。
   *
   * 三个地址曾经全都少了 `R2_KEY_PREFIX`——对象在 `mememio/thumbs/x.webp`，
   * 响应里给的是 `/thumbs/x.webp`。入库成功、接口 200、日志干净，只有浏览器裂图。
   */
  it('tempUrl / existing.url / existing.thumbUrl 都指向桶里真实存在的对象', async () => {
    const alice = await signIn()
    const { batchId, fileName } = await makeReviewItem(alice)

    // 这条断言的前提。前缀为空时下面几条全都会通过，但什么也没测到
    expect(env.r2.keyPrefix).not.toBe('')

    const entry = (await listReviews(alice))[0]!
    const existing = entry.existing!

    // objectKeys() 给的是桶里的完整键，与写入侧经 key() 拼出来的是同一个字符串
    const inBucket = objectKeys()
    expect(inBucket).toContain(fullKeyOf(entry.tempUrl!))
    expect(inBucket).toContain(fullKeyOf(existing.url))
    expect(inBucket).toContain(fullKeyOf(existing.thumbUrl))

    // 前缀的位置也钉住：在 base 之后、业务键之前，而不是塞进 R2_PUBLIC_BASE_URL
    expect(fullKeyOf(entry.tempUrl!)).toBe(`${env.r2.keyPrefix}temp/${batchId}/${fileName}`)
    expect(fullKeyOf(existing.thumbUrl)).toMatch(
      new RegExp(`^${env.r2.keyPrefix}thumbs/[0-9a-f-]+\\.webp$`),
    )
  })

  it('跨批次汇总，并且只列自己的', async () => {
    const alice = await signIn({ name: 'alice' })
    const bob = await signIn({ name: 'bob' })

    const aliceItem = await makeReviewItem(alice)
    const bobItem = await makeReviewItem(bob)

    const mine = await listReviews(alice)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.batchId).toBe(aliceItem.batchId)

    const his = await listReviews(bob)
    expect(his).toHaveLength(1)
    expect(his[0]!.batchId).toBe(bobItem.batchId)
  })

  it('别人不能处理我的条目（一律 NOT_FOUND，不泄露批次存不存在）', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const { batchId, fileName } = await makeReviewItem(alice)

    const res = await call(bob, 'POST', `/reviews/${batchId}/${encodeURIComponent(fileName)}`, {
      action: 'skip',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('处理过的条目不再出现在队列里', async () => {
    const alice = await signIn()
    const { batchId, fileName } = await makeReviewItem(alice)

    await call(alice, 'POST', `/reviews/${batchId}/${encodeURIComponent(fileName)}`, {
      action: 'skip',
    })
    expect(await listReviews(alice)).toEqual([])

    // 再点一次是 NOT_FOUND，而不是把它重新导进来
    const again = await call(alice, 'POST', `/reviews/${batchId}/${encodeURIComponent(fileName)}`, {
      action: 'skip',
    })
    expect(again.status).toBe(404)
  })
})

// ── 处理 ──────────────────────────────────────────────────────────

describe('处理待确认（POST /reviews/{batchId}/{fileName}）', () => {
  it('action = "import"：入库、进打标队列、删 temp 对象', async () => {
    const alice = await signIn()
    const { batchId, fileName } = await makeReviewItem(alice)

    // 处理之前它不在库里，也没进队列
    expect(await memeOf(fileName)).toBeNull()
    expect(await jobCount()).toBe(1)

    const res = await call(alice, 'POST', `/reviews/${batchId}/${encodeURIComponent(fileName)}`, {
      action: 'import',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { fileName: string; result: string; memeId: string }
    expect(body).toMatchObject({ fileName, result: 'imported' })

    const meme = await memeOf(fileName)
    expect(meme?.id).toBe(body.memeId)
    // 打标队列消费者不在本任务范围内，导入只承诺到 pending
    expect(meme?.tagStatus).toBe('pending')
    expect(await jobCount()).toBe(2)

    // temp 对象是「还没决定」时的暂存，决定了就该收走
    expect(hasObject(`temp/${batchId}/${fileName}`)).toBe(false)

    // 条目本身也从 needs_review 转成 imported，快照跟着变
    expect(await itemOf(batchId, fileName)).toMatchObject({ result: 'imported' })
    const snapshot = (await (await call(alice, 'GET', `/${batchId}`)).json()) as {
      needsReview: number
      done: number
    }
    expect(snapshot.needsReview).toBe(0)
    expect(snapshot.done).toBe(1)
  })

  it('action = "skip"：不入库、不打标、temp 对象删掉', async () => {
    const alice = await signIn()
    const { batchId, fileName } = await makeReviewItem(alice)

    const res = await call(alice, 'POST', `/reviews/${batchId}/${encodeURIComponent(fileName)}`, {
      action: 'skip',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ fileName, result: 'skipped' })

    expect(await memeOf(fileName)).toBeNull()
    expect(await jobCount()).toBe(1)
    expect(hasObject(`temp/${batchId}/${fileName}`)).toBe(false)
  })

  it('action = "import" 时配额照样拦（这条图此前没占过空间）', async () => {
    const alice = await signIn()
    const { batchId, fileName } = await makeReviewItem(alice)

    // 把配额压到只剩 1 字节，模拟「导入期间空间被别的东西吃满了」
    await sql`update users set storage_quota_bytes = 1::bigint where id = ${alice.id}`

    const res = await call(alice, 'POST', `/reviews/${batchId}/${encodeURIComponent(fileName)}`, {
      action: 'import',
    })
    // 413 而不是 403：配额是「装不下」不是「没权限」（见 lib/app-error.ts 的映射表）
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string; details?: { remaining?: string } } }
    expect(body.error.code).toBe('QUOTA_EXCEEDED')
    // `remaining` 是**钳到 0 之后**的值：已经超额时它不能是负数，
    // 否则前端会照着算出一个负的进度条。
    expect(body.error.details?.remaining).toBe('0')

    // 拦下来了就什么都别动：条目还在队列里，temp 对象还在，用户腾出空间还能再试
    expect(await memeOf(fileName)).toBeNull()
    expect(hasObject(`temp/${batchId}/${fileName}`)).toBe(true)
    expect(await listReviews(alice)).toHaveLength(1)
  })

  it('action 不是 import/skip 时 VALIDATION_FAILED', async () => {
    const alice = await signIn()
    const { batchId, fileName } = await makeReviewItem(alice)

    const res = await call(alice, 'POST', `/reviews/${batchId}/${encodeURIComponent(fileName)}`, {
      action: 'delete',
    })
    expect(res.status).toBe(400)
    expect(await listReviews(alice)).toHaveLength(1)
  })
})
