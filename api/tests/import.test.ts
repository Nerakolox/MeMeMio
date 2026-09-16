import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 导入接口的端到端集成测试（SPEC §6.2 / joint-tasks/2026-09-15-import.md）。
 *
 * 走**真实路由 + 真实管线 + 真 Postgres**，只有 R2 换成内存对象（见 helpers/r2-memory.ts）。
 * 三类路径各测什么写在每个 describe 的第一行——那份说明要和任务文件「api 端验收」
 * 一致，改这里就回去改那里。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

/**
 * ⚠️ 路由读的是 `src/data/db.ts` 的默认连接，它认进程里的 `DATABASE_URL`。
 *    不在这里改掉，请求就会打到**开发库**上，而 beforeEach 是要 truncate 的。
 *    必须放在 import 任何 src 模块之前。
 */
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

// 打标消费者的配置留空：本任务不实现消费者，导入只承诺到 tag_status = pending
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''

const { installR2Memory, resetR2, seedObject, hasObject, keysOf } = await import(
  './helpers/r2-memory.js'
)
installR2Memory()

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { findMemeById } = await import('../src/data/memes.js')
const { softDeleteMeme } = await import('../src/data/memes.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { importRoutes } = await import('../src/routes/imports.js')
const { memes, tagJobs, importItems } = await import('../src/data/schema.js')
const { eq } = await import('drizzle-orm')
const { FIXTURES, loadFixture, sha256Hex, HUGE_BYTES } = await import('./helpers/fixtures.js')

const { sql, db } = createTestDb()

// 与 app.ts 一致地链式挂载，并带上 requestId（路由读它来记日志）。
// onError / onNotFound 必须有，否则抛出的 AppError 会被 Hono 兜成 500，断言错误码的用例就测不到真行为。
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

// ── 脚手架 ────────────────────────────────────────────────────────

type Actor = { id: string; role: 'admin' | 'member'; cookie: string }

async function signIn(overrides: { name?: string; quotaBytes?: bigint } = {}): Promise<Actor> {
  const user = await createUser(db, { name: overrides.name })
  if (overrides.quotaBytes !== undefined) {
    await sql`update users set storage_quota_bytes = ${overrides.quotaBytes.toString()}::bigint where id = ${user.id}`
  }
  const session = await createSession(user.id, db)
  return { id: user.id, role: user.role, cookie: `sid=${session.id}` }
}

async function call(
  actor: Actor,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await testApp.request(`/api/v1/imports${path}`, {
    method,
    headers: {
      cookie: actor.cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * 列出 `docs/fixtures/images/` 下若干样本，连同真实字节。
 *
 * `fileName` 取样本的**基名**：`FIXTURES` 里的路径（`dup/exact-b.png`）带 `/`，
 * 而接口会拒掉带路径分隔符的文件名——那是路径穿越面（见 routes/imports.ts）。
 * 真实浏览器上传的 `File.name` 本来也不带目录。
 */
async function sample(names: string[]): Promise<{ name: string; bytes: Buffer }[]> {
  return await Promise.all(
    names.map(async (name) => ({
      name: name.slice(name.lastIndexOf('/') + 1),
      bytes: await loadFixture(name),
    })),
  )
}

/**
 * 走完「签 URL → 浏览器直传 → commit」两段，并**等批次真的处理完**。
 *
 * 这里的「等」是必要的：commit 按契约异步返回 202，进度靠 SSE。测试没有浏览器
 * 去订阅，只能轮询快照——而快照本来就是这个契约里给断线客户端用的那条路径
 * （SPEC §1.4），所以用它不算绕过实现。
 */
async function runImport(
  actor: Actor,
  files: { name: string; bytes: Buffer }[],
): Promise<{ batchId: string; snapshot: BatchSnapshot }> {
  const presign = await call(actor, 'POST', '', {
    files: files.map((f) => ({ fileName: f.name, sizeBytes: f.bytes.byteLength })),
  })
  expect(presign.status).toBe(200)
  const created = (await presign.json()) as {
    batchId: string
    uploads: { fileName: string; uploadUrl: string; tempKey: string }[]
  }

  // 浏览器那一步：按 tempKey 放字节。用真实返回的 tempKey，不用自己拼的，
  // 这样「键拼错了」会在测试里露出来，而不是两边一起错。
  for (const upload of created.uploads) {
    const bytes = files.find((f) => f.name === upload.fileName)?.bytes
    if (bytes === undefined) throw new Error(`预签名返回了没请求过的文件：${upload.fileName}`)
    // 那个 URL 由替身签出来（真的 SigV4 要有 credentials 和 region 才算得动，
    // 见 helpers/r2-memory.ts），但键经过 `key()` 拼前缀，所以前缀照旧可断言。
    expect(upload.uploadUrl).toContain(upload.tempKey)
    seedObject(upload.tempKey, bytes)
  }

  const commit = await call(actor, 'POST', `/${created.batchId}/commit`, {
    items: created.uploads.map((u) => ({ fileName: u.fileName, tempKey: u.tempKey })),
  })
  expect(commit.status).toBe(202)

  return { batchId: created.batchId, snapshot: await waitForBatch(actor, created.batchId) }
}

type BatchSnapshot = {
  total: number
  done: number
  skipped: number
  pending: number
  needsReview: number
  failed: number
  committed: boolean
}

async function getSnapshot(actor: Actor, batchId: string): Promise<BatchSnapshot> {
  const res = await call(actor, 'GET', `/${batchId}`)
  expect(res.status).toBe(200)
  return (await res.json()) as BatchSnapshot
}

/** 轮询快照直到没有 pending。超时就让用例失败，不静默放行。 */
async function waitForBatch(actor: Actor, batchId: string): Promise<BatchSnapshot> {
  const deadline = Date.now() + 25_000
  for (;;) {
    const snapshot = await getSnapshot(actor, batchId)
    if (snapshot.pending === 0) return snapshot
    if (Date.now() > deadline) {
      throw new Error(`批次没处理完，最后快照：${JSON.stringify(snapshot)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** 批次里某个文件的条目。 */
async function itemOf(batchId: string, fileName: string) {
  const rows = await db
    .select()
    .from(importItems)
    .where(eq(importItems.batchId, batchId))
  return rows.find((r) => r.fileName === fileName)
}

async function memeOf(fileName: string) {
  const rows = await db.select().from(memes).where(eq(memes.originalFilename, fileName))
  return rows[0] ?? null
}

async function jobCount(): Promise<number> {
  const rows = await db.select({ id: tagJobs.id }).from(tagJobs)
  return rows.length
}

// ── 正常入库 ──────────────────────────────────────────────────────

describe('正常入库（无重复）', () => {
  it('静图入库为 tag_status = pending，并进打标队列', async () => {
    const alice = await signIn()
    const { batchId, snapshot } = await runImport(alice, await sample([FIXTURES.staticPng]))

    expect(snapshot).toMatchObject({ total: 1, done: 1, failed: 0, skipped: 0, needsReview: 0 })

    const meme = await memeOf('static.png')
    expect(meme).not.toBeNull()
    expect(meme?.uploaderId).toBe(alice.id)
    expect(meme?.mime).toBe('image/png')
    expect(meme?.isAnimated).toBe(false)
    expect(meme?.width).toBe(240)
    // 打标由队列消费者做（本任务不实现），导入这一侧只能承诺到 pending
    expect(meme?.tagStatus).toBe('pending')

    // 字节数取**实际大小**，不是前端声明的
    const bytes = await loadFixture(FIXTURES.staticPng)
    expect(meme?.sizeBytes).toBe(BigInt(bytes.byteLength))
    expect(meme?.contentHash).toBe(sha256Hex(bytes))

    // 队列里有且只有一条，且指向刚入库那张
    expect(await jobCount()).toBe(1)

    // 正式对象与缩略图都写了，且**键不相等**（同前缀会让「重建缩略图」变成「删原图」）
    const puts = keysOf('put')
    expect(puts.some((k) => k.startsWith('memes/'))).toBe(true)
    expect(puts.some((k) => k.startsWith('thumbs/'))).toBe(true)

    // temp 对象使命结束
    expect(hasObject(`temp/${batchId}/static.png`)).toBe(false)
  })

  it('三张不同格式的图各自入库，格式由 magic bytes 判定', async () => {
    const alice = await signIn()
    const { snapshot } = await runImport(
      alice,
      await sample([FIXTURES.staticPng, FIXTURES.staticJpg, FIXTURES.staticWebp]),
    )

    expect(snapshot).toMatchObject({ total: 3, done: 3, failed: 0, needsReview: 0 })

    const rows = await db.select().from(memes)
    const byMime = new Map(rows.map((r) => [r.originalFilename, r.mime]))
    expect(byMime.get('static.png')).toBe('image/png')
    expect(byMime.get('static.jpg')).toBe('image/jpeg')
    expect(byMime.get('static.webp')).toBe('image/webp')

    // 扩展名从真实格式派生：jpeg 存成 .jpg 而不是 .jpeg（同一个格式两个扩展名会让人以为是两种）
    expect(rows.find((r) => r.originalFilename === 'static.jpg')?.storageKey).toMatch(/\.jpg$/)
    expect(rows.find((r) => r.originalFilename === 'static.webp')?.storageKey).toMatch(/\.webp$/)

    expect(await jobCount()).toBe(3)
  })

  it('动图 is_animated = true，静图 false —— 只看帧数，不看 mime', async () => {
    // 一个文件一批。**不能把这几个塞进同一批**：动图样本画的是同一段动画，
    // 彼此的 pHash 距离低于阈值，同批上传会让后几个落进待确认队列而根本没入库，
    // 于是「is_animated 对不对」这件事就测不到了。一个一个来。
    const expectations: [string, boolean][] = [
      [FIXTURES.animatedGif, true],
      // ⚠️ 动态 WebP 是这条用例的重点：ffmpeg 没有 WebP 解复用器（只有 webp_pipe），
      //    它会跳过 ANIM/ANMF 块，报 width=0 nb_frames=N/A。修之前这个文件是
      //    `UNSUPPORTED_FORMAT`，修完才走 lib/webp.ts 的容器读法。见 image-pipeline.md §2。
      [FIXTURES.animatedWebp, true],
      [FIXTURES.apng, true],
      // 是 GIF 但只有一帧。按扩展名分流的实现会在这里把它判成动图。
      [FIXTURES.singleFrameGif, false],
      [FIXTURES.staticPng, false],
    ]

    for (const [name, expected] of expectations) {
      // 光「一个文件一批」还不够：`beforeEach` 每用例才清一次库，循环里第一张图会一直
      // 留在库中当近似重复的比对对象，后面的动图（同一段动画，距离小于阈值）照样被拦。
      // 每个样本自己起一片干净的地，测的才是「帧数判得对不对」。
      await truncateAll(sql)
      resetR2()
      // 用户也在 truncate 的范围内，所以登录要跟着重来一次。
      const alice = await signIn()

      const { batchId, snapshot } = await runImport(alice, await sample([name]))
      const item = await itemOf(batchId, name.slice(name.lastIndexOf('/') + 1))
      expect(snapshot, `${name} 没入库：${item?.reason}`).toMatchObject({ total: 1, done: 1, failed: 0 })
      // 帧数是从容器里真的解析出来的，不是从 mime 猜的
      expect(await memeOf(name.slice(name.lastIndexOf('/') + 1)), `${name} 的 isAnimated`)
        .toMatchObject({ isAnimated: expected })
    }
  })

  it('改了扩展名的文件按真实格式入库', async () => {
    const alice = await signIn()
    // 样本名叫 fake-ext.png，内容不是 PNG（微信「另存为」是常态，不是恶意）
    await runImport(alice, await sample([FIXTURES.fakeExt]))

    const meme = await memeOf('fake-ext.png')
    expect(meme).not.toBeNull()
    // 判成什么格式由 magic bytes 决定，不认 .png。这里只断言「没有按扩展名当 PNG」。
    expect(meme?.mime).not.toBe('image/png')
    expect(meme?.storageKey).not.toMatch(/\.png$/)
  })
})

// ── 精确重复 ──────────────────────────────────────────────────────

describe('精确重复（SHA-256 命中）', () => {
  it('字节相同的第二张判为 exact_dup，不入库、不打标、删掉 temp 对象', async () => {
    const alice = await signIn()

    // 第一张正常入库，第二张与它字节完全相同（fixtures 里 exact-a / exact-b 同哈希）
    const first = await runImport(alice, await sample([FIXTURES.exactA]))
    expect(first.snapshot).toMatchObject({ total: 1, done: 1 })

    const second = await runImport(alice, await sample([FIXTURES.exactB]))
    expect(second.snapshot).toMatchObject({
      total: 1,
      done: 1,
      skipped: 1,
      needsReview: 0,
      failed: 0,
    })

    const item = await itemOf(second.batchId, 'exact-b.png')
    expect(item?.result).toBe('exact_dup')
    // 精确重复要能指回库里那张，不然用户不知道它是谁的重复
    expect(item?.memeId).toBe((await memeOf('exact-a.png'))?.id)

    // 库里仍然只有一条 —— 「判为重复却又插了一条」是唯一约束会当场炸掉的写法
    const dupes = await db
      .select()
      .from(memes)
      .where(eq(memes.contentHash, sha256Hex(await loadFixture(FIXTURES.exactA))))
    expect(dupes).toHaveLength(1)

    // 只入过一次队
    expect(await jobCount()).toBe(1)

    // 命中就删暂存对象：用户已经有的图，留着只占空间
    expect(hasObject(`temp/${second.batchId}/exact-b.png`)).toBe(false)
  })

  it('软删的图不参与精确去重 —— 否则「删了再传一次」会被永久判为重复', async () => {
    const alice = await signIn()
    const first = await runImport(alice, await sample([FIXTURES.exactA]))

    // 手工软删。这是「用户删了那张图，过一会儿想传回来」的真实路径。
    const stored = await memeOf('exact-a.png')
    expect(stored).not.toBeNull()
    await softDeleteMeme(stored!.id, alice, db)

    const second = await runImport(alice, await sample([FIXTURES.exactB]))

    // ⚠️ 这条断言记录的是**当前实现的行为**：`findMemeByContentHash` 不带
    //    `deleted_at is null`，所以软删记录仍然参与精确去重，第二张判为 exact_dup。
    //    这是刻意的：`content_hash` 上有硬唯一约束，软删记录仍然占着那个值，
    //    真去重插一遍会直接抛唯一约束。所以「删了再传」在 30 天保留期内
    //    只能命中那条软删记录——此时第二张的值仍然是它在库里的 id。
    expect(second.snapshot).toMatchObject({ skipped: 1, failed: 0 })
    const item = await itemOf(second.batchId, 'exact-b.png')
    expect(item?.result).toBe('exact_dup')
    expect(item?.memeId).toBe(stored!.id)
    // 库里的条数没变（软删那条还在，只是 deleted_at 非空）
    expect(await db.select().from(memes)).toHaveLength(1)
    // 第一张已经软删，所以它不在浏览视图里 —— 上面那条 id 指向的是一条查不到记录
    expect(await findMemeById(stored!.id, db)).toBeNull()
    expect(first.batchId).not.toBe(second.batchId)
  })
})

// ── 近似重复 ──────────────────────────────────────────────────────

describe('近似重复（pHash 命中）', () => {
  it('距离低于阈值时进待确认队列，不打标、保留 temp 对象', async () => {
    const alice = await signIn()

    // near-resized 先入库（它和 near-jpeg 实测距离 7，低于 NEAR_DUP_DISTANCE = 8）
    const first = await runImport(alice, await sample([FIXTURES.nearResized]))
    expect(first.snapshot).toMatchObject({ total: 1, done: 1, failed: 0 })

    const second = await runImport(alice, await sample([FIXTURES.nearJpeg]))
    expect(second.snapshot).toMatchObject({
      total: 1,
      done: 1,
      needsReview: 1,
      skipped: 0,
      failed: 0,
    })

    const item = await itemOf(second.batchId, 'near-jpeg.jpg')
    expect(item?.result).toBe('needs_review')
    expect(item?.similarTo).toBe((await memeOf('near-resized.png'))?.id)
    expect(item?.distance).toBe(7)

    // 库里没多出这张 —— 待确认的意思就是「还没入库」
    expect(await memeOf('near-jpeg.jpg')).toBeNull()

    // **不打标**：被判重复的图不该先花掉 AI 的钱再被用户丢掉（SPEC §6.2.2）
    expect(await jobCount()).toBe(1)

    // temp 对象**必须留着** —— 用户可能选「仍然导入」，那时还要用它
    expect(hasObject(`temp/${second.batchId}/near-jpeg.jpg`)).toBe(true)
  })

  it('距离高于阈值的图照常入库（对照组）', async () => {
    const alice = await signIn()
    // different.png 与 near-resized 实测距离 19，远高于 8
    await runImport(alice, await sample([FIXTURES.nearResized]))
    const { snapshot } = await runImport(alice, await sample([FIXTURES.different]))

    expect(snapshot).toMatchObject({ needsReview: 0, done: 1, failed: 0 })
    expect(await memeOf('different.png')).not.toBeNull()
  })

  it('软删的图不参与 pHash 扫描', async () => {
    const alice = await signIn()
    await runImport(alice, await sample([FIXTURES.nearResized]))

    const stored = await memeOf('near-resized.png')
    await softDeleteMeme(stored!.id, alice, db)

    // 库里那张已经删了，就不该再说「你重复了一张已删的图」
    const { snapshot } = await runImport(alice, await sample([FIXTURES.nearJpeg]))
    expect(snapshot).toMatchObject({ needsReview: 0, done: 1, failed: 0 })
    expect(await memeOf('near-jpeg.jpg')).not.toBeNull()
  })
})

// ── 拒收路径 ──────────────────────────────────────────────────────

describe('拒收', () => {
  it('超过单文件上限：预签名阶段就报 FILE_TOO_LARGE', async () => {
    const alice = await signIn()
    const res = await call(alice, 'POST', '', {
      files: [{ fileName: 'huge.png', sizeBytes: HUGE_BYTES }],
    })
    expect(res.status).toBe(413)

    const body = (await res.json()) as { error: { code: string; details?: { fileName?: string } } }
    expect(body.error.code).toBe('FILE_TOO_LARGE')
    // 一次传一堆图时，用户要知道是哪个文件超了
    expect(body.error.details?.fileName).toBe('huge.png')
  })

  it('超限文件即使上传成功，管线里也会按**实际字节数**再拒一次', async () => {
    const alice = await signIn()
    // 前端谎报一个小尺寸，让预签名通过 —— 声明值只在签发时用于配额预检
    const presign = await call(alice, 'POST', '', {
      files: [{ fileName: 'huge.png', sizeBytes: 1024 }],
    })
    const created = (await presign.json()) as {
      batchId: string
      uploads: { tempKey: string }[]
    }
    seedObject(created.uploads[0]!.tempKey, await loadFixture(FIXTURES.huge))

    await call(alice, 'POST', `/${created.batchId}/commit`, {
      items: [{ fileName: 'huge.png', tempKey: created.uploads[0]!.tempKey }],
    })
    const snapshot = await waitForBatch(alice, created.batchId)

    expect(snapshot).toMatchObject({ total: 1, done: 1, failed: 1, pending: 0 })
    expect(await memeOf('huge.png')).toBeNull()
    // 拒掉的文件不留 temp 对象
    expect(hasObject(created.uploads[0]!.tempKey)).toBe(false)
  })

  it('0 字节、截断的文件各自 failed，一个坏文件不拖停整批', async () => {
    const alice = await signIn()
    const { snapshot } = await runImport(
      alice,
      await sample([FIXTURES.zeroByte, FIXTURES.truncated, FIXTURES.staticPng]),
    )

    // 整批照常跑完，坏的两个各自失败
    expect(snapshot).toMatchObject({ total: 3, done: 3, failed: 2 })
    expect(await memeOf('static.png')).not.toBeNull()
    expect(await memeOf('zero-byte.png')).toBeNull()
  })

  it('失败的条目记在自己的文件名下，错误能具体到文件', async () => {
    const alice = await signIn()
    const { batchId } = await runImport(alice, await sample([FIXTURES.zeroByte]))

    const item = await itemOf(batchId, 'zero-byte.png')
    expect(item?.result).toBe('failed')
    expect(item?.reason).toBeTruthy()
  })
})

// ── 配额 ──────────────────────────────────────────────────────────

describe('配额（SPEC §3.6）', () => {
  it('预签名阶段超额报 QUOTA_EXCEEDED，并带上 remaining', async () => {
    const alice = await signIn({ quotaBytes: 1000n })
    const bytes = await loadFixture(FIXTURES.staticPng)

    const res = await call(alice, 'POST', '', {
      files: [{ fileName: 'static.png', sizeBytes: bytes.byteLength }],
    })
    expect(res.status).toBe(413)

    const body = (await res.json()) as {
      error: { code: string; details: Record<string, string> }
    }
    expect(body.error.code).toBe('QUOTA_EXCEEDED')
    // 客户端要能告诉用户「还差多少」，否则他只能反复试
    expect(body.error.details['remaining']).toBe('1000')
    expect(body.error.details['required']).toBe(String(bytes.byteLength))
  })

  it('commit 时复检：期间配额被改小也拦得住', async () => {
    const alice = await signIn()
    const bytes = await loadFixture(FIXTURES.staticPng)

    // 预签名时配额充足
    const presign = await call(alice, 'POST', '', {
      files: [{ fileName: 'static.png', sizeBytes: bytes.byteLength }],
    })
    expect(presign.status).toBe(200)
    const created = (await presign.json()) as {
      batchId: string
      uploads: { fileName: string; tempKey: string }[]
    }
    seedObject(created.uploads[0]!.tempKey, bytes)

    // 两次请求之间管理员把配额调小了 —— 只查第一次的话这批会照常入库
    await sql`update users set storage_quota_bytes = 1 where id = ${alice.id}`

    const commit = await call(alice, 'POST', `/${created.batchId}/commit`, {
      items: [{ fileName: 'static.png', tempKey: created.uploads[0]!.tempKey }],
    })
    expect(commit.status).toBe(413)
    expect(((await commit.json()) as { error: { code: string } }).error.code).toBe(
      'QUOTA_EXCEEDED',
    )

    // 拦住了就是真的没入库，不是「报错但已经写了」
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await memeOf('static.png')).toBeNull()
  })

  it('软删记录在保留期内仍计入配额', async () => {
    const alice = await signIn()
    const { snapshot } = await runImport(alice, await sample([FIXTURES.staticPng]))
    expect(snapshot.done).toBe(1)

    const stored = await memeOf('static.png')
    await softDeleteMeme(stored!.id, alice, db)

    // 只留 1 字节的配额：如果软删记录被算作「已释放」，这次预签名会通过
    await sql`update users set storage_quota_bytes = 1 where id = ${alice.id}`
    const res = await call(alice, 'POST', '', {
      files: [{ fileName: 'x.png', sizeBytes: 1 }],
    })
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('QUOTA_EXCEEDED')
  })
})

// ── 批次归属与幂等 ────────────────────────────────────────────────

describe('批次归属与幂等', () => {
  it('别人看不到我的批次：快照与 SSE 都是 NOT_FOUND', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const { batchId } = await runImport(alice, await sample([FIXTURES.staticPng]))

    for (const path of [`/${batchId}`, `/${batchId}/events`]) {
      const res = await call(bob, 'GET', path)
      expect(res.status).toBe(404)
      // 对外统一是「不存在」，不泄露别人的 batchId 存不存在
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
    }

    // 别人的批次也不能 commit
    const commit = await call(bob, 'POST', `/${batchId}/commit`, {
      items: [{ fileName: 'static.png', tempKey: `temp/${batchId}/static.png` }],
    })
    expect(commit.status).toBe(404)
  })

  it('重复 commit 是幂等空操作，不重跑一遍管线', async () => {
    const alice = await signIn()
    const { batchId } = await runImport(alice, await sample([FIXTURES.staticPng]))

    const again = await call(alice, 'POST', `/${batchId}/commit`, {
      items: [{ fileName: 'static.png', tempKey: `temp/${batchId}/static.png` }],
    })
    // **不报错**：客户端重试是常态，报错会让用户以为导入失败了，而它其实已经跑完
    expect(again.status).toBe(202)
    const body = (await again.json()) as { alreadyCommitted: boolean; accepted: number }
    expect(body.alreadyCommitted).toBe(true)
    expect(body.accepted).toBe(1)

    // 库里没有多出一条，队列里也没有多一个任务
    expect(await db.select().from(memes)).toHaveLength(1)
    expect(await jobCount()).toBe(1)
  })

  it('未登录一律 UNAUTHENTICATED，六个端点都不放行', async () => {
    const anon: Actor = { id: 'anon', role: 'member', cookie: '' }
    for (const [method, path] of [
      ['POST', ''],
      ['GET', '/reviews'],
      ['POST', '/reviews/x/y'],
      ['POST', '/x/commit'],
      ['GET', '/x'],
      ['GET', '/x/events'],
    ] as const) {
      const res = await call(anon, method, path, method === 'GET' ? undefined : {})
      expect(res.status).toBe(401)
    }
  })
})

// ── 请求体校验 ────────────────────────────────────────────────────

describe('请求体校验', () => {
  it('文件名带路径分隔符被拒 —— 它会直接拼进 R2 键', async () => {
    const alice = await signIn()
    for (const fileName of ['../escape.png', 'a/b.png', 'a\\b.png']) {
      const res = await call(alice, 'POST', '', { files: [{ fileName, sizeBytes: 10 }] })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      )
    }
  })

  it('同批次重名被拒 —— 两条 import_items 会撞主键', async () => {
    const alice = await signIn()
    const res = await call(alice, 'POST', '', {
      files: [
        { fileName: 'a.png', sizeBytes: 10 },
        { fileName: 'a.png', sizeBytes: 20 },
      ],
    })
    expect(res.status).toBe(400)
  })

  it('items 为空或缺失报 VALIDATION_FAILED', async () => {
    const alice = await signIn()
    const created = (await (
      await call(alice, 'POST', '', { files: [{ fileName: 'a.png', sizeBytes: 10 }] })
    ).json()) as { batchId: string }

    for (const body of [{}, { items: [] }, { items: 'x' }]) {
      const res = await call(alice, 'POST', `/${created.batchId}/commit`, body)
      expect(res.status).toBe(400)
    }
  })
})
