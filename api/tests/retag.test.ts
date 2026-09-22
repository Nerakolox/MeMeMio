import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `POST /memes/retag` 的端到端集成测试（SPEC §6.4.3，
 * 任务 joint-tasks/2026-09-22-retag-endpoint.md）。
 *
 * 这个接口的风险全在**它看起来成功了但其实没做事**：库里的图全部 `tag_status = ok`
 * 且 `tag_jobs` 全是 `done` 行，而 `enqueueTagJob` 对已完成的图是静默空操作。
 * 所以本文件的重心不是「排上了没有」，是**下面四条各自都能让重打变成空操作或双花**：
 *
 * 1. **快速路径**（`services/tagging.ts:58`）—— `ok` + 无向量 + 有文本的图只重算向量、
 *    **不调视觉**。不把 `tag_status` 置回 `pending` 的话，重打会报成功、花掉 embedding
 *    的钱、标签一个都不变。第 12 组是它的哨兵，**对照组是它成立的理由**。
 * 2. **`running` 的行不能被改成 `pending`** —— `claimTagJob` 只看 `pending`，
 *    重置一个正在跑的行就是**同一张图付两次钱**。
 * 3. **读写顺序** —— `filter.tagStatus` 筛的正是本接口要改的那个字段，边读边写会
 *    让循环提前结束**而且报成功**。第 13 组用 1001 行把它钉住。
 * 4. **`attempts` 要归零** —— 留着上一轮的终局值，重打的图在第一次抖动时就直接
 *    判 `needs_manual`，本该还有五次机会。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 全部 env 必须在 import 任何 src 模块之前设好：env.ts 在首次 import 时就冻结。
// 这里**故意留着部署方默认视觉通道**——「没配通道」那一支要的是相反的前提，
// 单开在 retag-unconfigured.test.ts 里。
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
process.env['DEFAULT_VISION_BASE_URL'] = 'https://vision.test'
process.env['DEFAULT_VISION_API_KEY'] = 'vision-key-not-real'
process.env['DEFAULT_VISION_MODEL'] = 'test-vision'
process.env['DEFAULT_EMBED_BASE_URL'] = 'https://embed.test'
process.env['DEFAULT_EMBED_API_KEY'] = 'embed-key-not-real'
process.env['DEFAULT_EMBED_MODEL'] = 'test-embed'

const { installR2Memory, resetR2, seedObject } = await import('./helpers/r2-memory.js')
installR2Memory()

const { Hono } = await import('hono')
const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme, TEST_EMBED_DIM } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { tagMeme } = await import('../src/services/tagging.js')
const { RETAG_PAGE } = await import('../src/services/retag.js')
const { memes, tagJobs } = await import('../src/data/schema.js')
const { loadFixture, FIXTURES } = await import('./helpers/fixtures.js')
// `sql` 这个名字下面还有一份（`createTestDb` 返回的 postgres.js 句柄），所以别名一下
const { eq, sql: drizzleSql } = await import('drizzle-orm')

const { sql, db } = createTestDb()

const testApp = new Hono().use('*', requestId).route('/api/v1/memes', memesRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

// ── fetch 替身 ─────────────────────────────────────────────────────
//
// 只关心「视觉到底有没有被调用」，所以替身只有一个计数器 + 一份合法的最小返回。
// 供应商的真实返回形态由 `src/lib/vision-output.test.ts` 对着真样本测。

let visionCallCount = 0

const VISION_OUTPUT = JSON.stringify({
  ocr_text: '',
  description: '重打之后的描述',
  expressions: [],
  emotions: [],
  tones: [],
  purposes: [],
  scenes: [],
  tags: [],
  ratings: [],
})

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/v1/chat/completions')) {
      visionCallCount += 1
      return new Response(
        JSON.stringify({ choices: [{ message: { content: VISION_OUTPUT }, finish_reason: 'stop' }] }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/v1/embeddings')) {
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array(TEST_EMBED_DIM).fill(0.1) }] }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`测试里出现了预期外的外部调用：${url}`)
  })
}

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
  visionCallCount = 0
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

// ── 脚手架 ─────────────────────────────────────────────────────────

type Actor = { id: string; cookie: string }

async function signIn(role: 'admin' | 'member' = 'member'): Promise<Actor> {
  const user = await createUser(db, { role })
  const session = await createSession(user.id, db)
  return { id: user.id, cookie: `sid=${session.id}` }
}

function headers(actor: Actor | null): Record<string, string> {
  return actor === null ? {} : { cookie: actor.cookie }
}

async function post(body: unknown, actor: Actor | null): Promise<Response> {
  return await testApp.request('/api/v1/memes/retag', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers(actor) },
    body: JSON.stringify(body),
  })
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } }
  return body.error.code
}

/**
 * 一张「已经打完标」的图：`ok` + 有向量 + 有 search_text，并带一条 `done` 的队列行。
 *
 * **这就是库里的真实形态**（真库 75 张全部如此）。它同时也是「`enqueueTagJob` 会
 * 静默空操作」的现场：`tag_jobs_meme_id_key` 是唯一索引，而 `markTagJobDone` 保留 done 行。
 */
async function taggedMeme(
  uploaderId: string,
  overrides: { editedBy?: string; embedding?: number[] | null; tagStatus?: string } = {},
) {
  const meme = await makeMeme(db, {
    uploaderId,
    tagStatus: overrides.tagStatus ?? 'ok',
    searchText: '旧提示词打出来的文本',
    embedding: overrides.embedding === undefined ? new Array(TEST_EMBED_DIM).fill(0.2) : overrides.embedding,
    editedBy: overrides.editedBy,
    ...(overrides.editedBy === undefined ? {} : { editedAt: new Date() }),
  })
  await db.insert(tagJobs).values({ memeId: meme.id, userId: uploaderId, status: 'done' })
  return meme
}

async function memeRow(id: string) {
  const [row] = await db.select().from(memes).where(eq(memes.id, id))
  if (row === undefined) throw new Error('meme 不见了')
  return row
}

async function jobRow(memeId: string) {
  const [row] = await db.select().from(tagJobs).where(eq(tagJobs.memeId, memeId))
  return row
}

type RetagResponse = {
  enqueuedCount: number
  skippedEditedCount: number
  skippedUnconfiguredCount: number
}

async function ok(res: Response): Promise<RetagResponse> {
  expect(res.status).toBe(200)
  return (await res.json()) as RetagResponse
}

// ── 请求体（SPEC §6.4.3） ──────────────────────────────────────────

describe('POST /memes/retag 的请求体', () => {
  it('两个形状恰好给一个：都给、都不给、空 body 都是 VALIDATION_FAILED', async () => {
    const alice = await signIn()

    expect(await errorCode(await post({}, alice))).toBe('VALIDATION_FAILED')
    expect(
      await errorCode(await post({ memeIds: [], filter: {} }, alice)),
    ).toBe('VALIDATION_FAILED')
  })

  it('未知键被拒绝，**包括 `useDefaultConfig`**——接受一个不生效的参数会让管理员以为兜底生效了', async () => {
    const alice = await signIn()
    const meme = await taggedMeme(alice.id)

    expect(
      await errorCode(await post({ memeIds: [meme.id], useDefaultConfig: true }, alice)),
    ).toBe('VALIDATION_FAILED')
    expect(await errorCode(await post({ filter: { uploader: 'everyone' } }, alice))).toBe(
      'VALIDATION_FAILED',
    )
    expect(await errorCode(await post({ filter: { tagStatus: 'ok', limit: 5 } }, alice))).toBe(
      'VALIDATION_FAILED',
    )
  })

  it('形状先于角色：非管理员传一个**格式就不对**的 uploader 是 400，不是 403', async () => {
    const alice = await signIn()

    // 判成 403 会把用户送去要管理员权限，而他要改的是一个错字
    expect(await errorCode(await post({ filter: { uploader: 'nope' } }, alice))).toBe(
      'VALIDATION_FAILED',
    )
  })

  it('`memeIds: []` 是合法的空集，**不退化成全库**', async () => {
    const alice = await signIn()
    const meme = await taggedMeme(alice.id)

    const res = await ok(await post({ memeIds: [] }, alice))
    expect(res).toEqual({
      enqueuedCount: 0,
      skippedEditedCount: 0,
      skippedUnconfiguredCount: 0,
    })

    // 全库退化的表现是这张图被排上了——钱花了，而用户想重打的只有 0 张
    expect((await memeRow(meme.id)).tagStatus).toBe('ok')
    expect((await jobRow(meme.id))?.status).toBe('done')
  })

  it('`filter.tagStatus` 的非法取值先于角色判断：管理员也是 VALIDATION_FAILED，不是「没加条件」', async () => {
    const admin = await signIn('admin')

    expect(await errorCode(await post({ filter: { tagStatus: 'foo' } }, admin))).toBe(
      'VALIDATION_FAILED',
    )
  })

  it('`memeIds` 里的非 uuid 是 VALIDATION_FAILED，不是 500', async () => {
    const alice = await signIn()

    // 不挡的话 `inArray(memes.id, ['abc'])` 会撞 Postgres 的 uuid 转换错误，
    // 而 app.onError 把非 AppError 一律当 INTERNAL——客户端传了个错字得到「服务器内部错误」
    expect(await errorCode(await post({ memeIds: ['not-a-uuid'] }, alice))).toBe(
      'VALIDATION_FAILED',
    )
  })

  it('**不是 404**——它注册在 `GET /:id` 之后，而那条顺序规则只管同方法的路由', async () => {
    const alice = await signIn()
    const res = await post({ filter: {} }, alice)
    expect(res.status).toBe(200)
  })

  it('`memeIds` 里有一个不存在的 id → NOT_FOUND，**不是静默少排一张**', async () => {
    const alice = await signIn()
    const meme = await taggedMeme(alice.id)

    const res = await post({ memeIds: [meme.id, crypto.randomUUID()] }, alice)
    expect(await errorCode(res)).toBe('NOT_FOUND')
    // 整条请求失败：那张存在的图也不能被排上，否则客户端看到的是「3 张里排了 2 张」
    expect((await jobRow(meme.id))?.status).toBe('done')
  })

  it('软删的 id 也走 NOT_FOUND（§3.4：软删过滤在写路径上就是「查不到」）', async () => {
    const alice = await signIn()
    const meme = await taggedMeme(alice.id)
    await db.update(memes).set({ deletedAt: new Date() }).where(eq(memes.id, meme.id))

    expect(await errorCode(await post({ memeIds: [meme.id] }, alice))).toBe('NOT_FOUND')
  })
})

// ── 重置的是队列行，不是插一条新的 ───────────────────────────────

describe('入队即重置（这是本任务必须新写一个队列助手的原因）', () => {
  it('对 `done` 的图真的排上了：队列行回到 pending、attempts 归零、last_error 清空', async () => {
    const alice = await signIn()
    const meme = await taggedMeme(alice.id)
    // 上一轮的终局值。留着它，重打的图在第一次网络抖动时就直接判 needs_manual
    await db.update(tagJobs).set({ attempts: 5, lastError: 'unreachable: 上游超时' }).where(eq(tagJobs.memeId, meme.id))

    const res = await ok(await post({ filter: {} }, alice))
    expect(res.enqueuedCount).toBe(1)

    const job = await jobRow(meme.id)
    expect(job?.status).toBe('pending')
    expect(job?.attempts).toBe(0)
    expect(job?.lastError).toBeNull()
    // 图也翻回 pending——进度唯一的可见来源，而且它同时关掉了快速路径
    expect((await memeRow(meme.id)).tagStatus).toBe('pending')
  })

  it('连点两次：第二次 enqueuedCount 是 0（它报的是「本次新排上的」，不是「选中了几张」）', async () => {
    const alice = await signIn()
    await taggedMeme(alice.id)
    await taggedMeme(alice.id)

    expect((await ok(await post({ filter: {} }, alice))).enqueuedCount).toBe(2)
    // 客户端拿 enqueuedCount 当进度基线（`web` 的 RetagPanel），所以它必须是新排上的条数
    expect((await ok(await post({ filter: {} }, alice))).enqueuedCount).toBe(0)
  })

  it('`running` 的行一个字都不动——否则同一张图付两次钱', async () => {
    const alice = await signIn()
    const meme = await taggedMeme(alice.id)
    await db
      .update(tagJobs)
      .set({ status: 'running', attempts: 1 })
      .where(eq(tagJobs.memeId, meme.id))

    const res = await ok(await post({ filter: {} }, alice))
    expect(res.enqueuedCount).toBe(0)

    expect((await jobRow(meme.id))?.status).toBe('running')
    // 连带的一条：图也不能翻成 pending。翻了的话两个写入互相矛盾，
    // 而矛盾的表现只是「那张图一直显示待打标」，不报错
    expect((await memeRow(meme.id)).tagStatus).toBe('ok')
  })
})

// ── 跳过人工编辑过的图（SPEC §9.25） ───────────────────────────────

describe('跳过人工编辑过的图', () => {
  it('`edited_by` 非空的既不入队也不动 tag_status，单独计数', async () => {
    const alice = await signIn()
    const human = await taggedMeme(alice.id, { editedBy: alice.id })
    const machine = await taggedMeme(alice.id)

    const res = await ok(await post({ filter: {} }, alice))
    expect(res).toEqual({
      enqueuedCount: 1,
      skippedEditedCount: 1,
      skippedUnconfiguredCount: 0,
    })

    expect((await jobRow(human.id))?.status).toBe('done')
    expect((await memeRow(human.id)).tagStatus).toBe('ok')
    // 机器打的那张照常
    expect((await memeRow(machine.id)).tagStatus).toBe('pending')
  })
})

// ── 快速路径哨兵（本任务最要害的一条） ─────────────────────────────

describe('快速路径：不把 tag_status 置回 pending 的话重打会静默地不调视觉', () => {
  /**
   * `ok` + `embedding is null` + `search_text` 非空 —— 正好命中
   * `services/tagging.ts:58` 那条「只差向量」的省钱分支。而这条三连在真实库里
   * 是**会出现的**：embedding 终局失败不回滚打标（`retry-policy.ts` 的
   * `embed_failed` 终局 `tagStatus: null`），所以「标打好了、向量没算出来」的图就在这。
   */
  async function fastPathMeme(uploaderId: string) {
    const bytes = await loadFixture(FIXTURES.staticPng)
    const storageKey = `memes/${crypto.randomUUID()}.png`
    seedObject(storageKey, bytes)

    const meme = await makeMeme(db, {
      uploaderId,
      storageKey,
      tagStatus: 'ok',
      searchText: '旧提示词打出来的文本',
      embedding: null,
    })
    await db.insert(tagJobs).values({ memeId: meme.id, userId: uploaderId, status: 'done' })
    return meme
  }

  it('对照组：不重打时走快速路径，视觉**一次都没调**（这就是哨兵成立的理由）', async () => {
    const alice = await signIn()
    const meme = await fastPathMeme(alice.id)

    const outcome = await tagMeme(meme.id, new AbortController().signal)
    expect(outcome).toEqual({ kind: 'done', embedded: true })
    expect(visionCallCount).toBe(0)
  })

  it('重打之后视觉真的被调了', async () => {
    const alice = await signIn()
    const meme = await fastPathMeme(alice.id)

    await ok(await post({ filter: {} }, alice))
    const outcome = await tagMeme(meme.id, new AbortController().signal)

    expect(outcome).toEqual({ kind: 'done', embedded: true })
    expect(visionCallCount).toBe(1)
    // 标签真的换了，不只是「没报错」
    expect((await memeRow(meme.id)).description).toBe('重打之后的描述')
  })
})

// ── 读写顺序：filter.tagStatus 筛的正是要改的那个字段 ──────────────

describe('先读完全部页、再开始写', () => {
  it('一页装不下的筛选集全部排上，不会因为「改掉了筛选字段」而提前结束', async () => {
    const alice = await signIn()
    const total = RETAG_PAGE + 1

    // 批量插，不用 makeMeme：这里要的是行数，一个用例一千次 insert 太慢
    const values = Array.from({ length: total }, (_, i) => ({
      uploaderId: alice.id,
      storageKey: `bulk/${i}.png`,
      contentHash: `bulk-hash-${i}`,
      phash: 0n,
      mime: 'image/png',
      sizeBytes: 1024n,
      isAnimated: false,
      tagStatus: 'ok' as const,
    }))

    for (let start = 0; start < values.length; start += 500) {
      const chunk = values.slice(start, start + 500)
      const rows = await db.insert(memes).values(chunk).returning({ id: memes.id })
      await db.insert(tagJobs).values(rows.map((row) => ({ memeId: row.id, userId: alice.id, status: 'done' })))
    }

    // 边读边写的表现是第二页读不到东西 → 报 enqueuedCount: 1000 并「成功」
    const res = await ok(await post({ filter: { tagStatus: 'ok' } }, alice))
    expect(res.enqueuedCount).toBe(total)

    const [remaining] = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(memes)
      .where(eq(memes.tagStatus, 'ok'))
    expect(remaining?.count).toBe(0)
  })
})

// ── 权限（SPEC §3.3 / §6.4.3） ────────────────────────────────────

describe('权限', () => {
  it('未登录 → UNAUTHENTICATED', async () => {
    expect(await errorCode(await post({ filter: {} }, null))).toBe('UNAUTHENTICATED')
  })

  it('非上传者传别人的 memeIds → FORBIDDEN，**不是静默跳过**', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const meme = await taggedMeme(alice.id)

    expect(await errorCode(await post({ memeIds: [meme.id] }, bob))).toBe('FORBIDDEN')
    expect((await jobRow(meme.id))?.status).toBe('done')
  })

  it('`filter: {}` 对非管理员**收窄到自己**，别人的图一张都不动', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const hers = await taggedMeme(alice.id)
    const his = await taggedMeme(bob.id)

    const res = await ok(await post({ filter: {} }, bob))
    expect(res.enqueuedCount).toBe(1)

    expect((await memeRow(his.id)).tagStatus).toBe('pending')
    expect((await memeRow(hers.id)).tagStatus).toBe('ok')
  })

  it('非管理员显式指向别人 → FORBIDDEN（**不是静默收窄**：那会让人以为别人的图也重打了）', async () => {
    const alice = await signIn()
    const bob = await signIn()
    await taggedMeme(alice.id)

    const res = await post({ filter: { uploader: alice.id } }, bob)
    expect(await errorCode(res)).toBe('FORBIDDEN')
  })

  it('管理员可以按 uploader 指定别人的图', async () => {
    const alice = await signIn()
    const admin = await signIn('admin')
    const meme = await taggedMeme(alice.id)

    const res = await ok(await post({ filter: { uploader: alice.id } }, admin))
    expect(res.enqueuedCount).toBe(1)
    expect((await memeRow(meme.id)).tagStatus).toBe('pending')
  })

  it('`uploader: "me"` 对管理员也是自己（显式指定不该被角色放大）', async () => {
    const alice = await signIn()
    const admin = await signIn('admin')
    await taggedMeme(alice.id)

    const res = await ok(await post({ filter: { uploader: 'me' } }, admin))
    expect(res.enqueuedCount).toBe(0)
  })
})
