import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 重打标在「视觉通道没配齐」时的行为（SPEC §6.4.3）。
 *
 * 单开一个文件是因为它要的是「进程启动时 `DEFAULT_VISION_*` 就是空的」——
 * `env.ts` 在首次 import 时把值冻住，同一个文件里没法既有部署方默认通道、又没有。
 *
 * 本文件测的是**那条一眼看不出来的错误**：
 *
 * > 用全局的 `isVisionConfigured()` 当闸门。
 * >
 * > 那个函数回答的是「全站有没有任意一条通道」，而配置是**按人**解析的。
 * > 在「A 配了自己 key、B 没配」的库里，错的闸门会把 B 的图也排上，而那批任务
 * > 永远解析不出配置 —— 表现是**永远停在 `pending`、每轮被重新认领、任何地方都不报错**。
 * > 没有异常、没有失败计数，只有一个永远不动的进度。
 *
 * 所以这里断言的是两件事同时成立：A 的图**排上了**，B 的图**没排上而且报了数**。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
// 三个都清空。只清一个也够触发 `asCredentials` 返回 null，但那测的是「缺一项」，
// 不是「压根没配」
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''

const { installR2Memory, resetR2 } = await import('./helpers/r2-memory.js')
installR2Memory()

const { Hono } = await import('hono')
const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { recordVisionTest, saveUserVisionConfig } = await import('../src/data/ai-configs.js')
const { isVisionConfigured } = await import('../src/ai/vision.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { memes, tagJobs } = await import('../src/data/schema.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

const testApp = new Hono().use('*', requestId).route('/api/v1/memes', memesRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

/** 走真实保存路径（要有成功的测试记录才存得进去，SPEC §6.5.2），不手写那两行。 */
const VISION_INPUT = {
  baseUrl: 'https://own-relay.example.test',
  model: 'user-vision-model',
  apiKey: 'sk-user-own-key-4d2f9a1b',
}

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
  // 任何一次外部调用都是 bug：这个文件里没人配齐通道，更不该有人去调
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    throw new Error(`没配视觉通道却发起了调用：${String(input)}`)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

type Actor = { id: string; cookie: string }

async function signIn(role: 'admin' | 'member' = 'member'): Promise<Actor> {
  const user = await createUser(db, { role })
  const session = await createSession(user.id, db)
  return { id: user.id, cookie: `sid=${session.id}` }
}

async function post(body: unknown, actor: Actor | null): Promise<Response> {
  return await testApp.request('/api/v1/memes/retag', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(actor === null ? {} : { cookie: actor.cookie }) },
    body: JSON.stringify(body),
  })
}

/** 一张已经打完标的图 + 一条 `done` 的队列行——库里的真实形态。 */
async function taggedMeme(uploaderId: string) {
  const meme = await makeMeme(db, {
    uploaderId,
    tagStatus: 'ok',
    searchText: '旧提示词打出来的文本',
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

describe('没配齐视觉通道时的重打标', () => {
  it('前提：部署方没配，A 配了自己的一套，B 什么都没配', async () => {
    // 这个断言是下面两条的立足点。`isVisionConfigured()` 为真（因为 A 配了），
    // 而 B 的图解析不出来——**两个事实同时成立**，正是错的闸门会漏掉的那一格
    const alice = await signIn()
    await recordVisionTest(alice.id, VISION_INPUT, { ok: true, jsonModeWorks: null, multiImage: null })
    await saveUserVisionConfig(alice.id, VISION_INPUT)

    expect(await isVisionConfigured()).toBe(true)
  })

  it('按上传者逐个解析：配了的排上、没配的**不排**，且单独报数', async () => {
    const alice = await signIn('admin')
    await recordVisionTest(alice.id, VISION_INPUT, { ok: true, jsonModeWorks: null, multiImage: null })
    await saveUserVisionConfig(alice.id, VISION_INPUT)

    const bob = await signIn()
    const hers = await taggedMeme(alice.id)
    const his = await taggedMeme(bob.id)

    const res = await post({ filter: {} }, alice)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      enqueuedCount: number
      skippedEditedCount: number
      skippedUnconfiguredCount: number
    }

    expect(body.enqueuedCount).toBe(1)
    expect(body.skippedUnconfiguredCount).toBe(1)

    expect((await memeRow(hers.id)).tagStatus).toBe('pending')
    // B 的图**连 tag_status 都不能动**：翻了它就是在库里留下「待打标」的假象，
    // 而那个任务永远不会被消费——正是本文件要挡的那种静默
    expect((await memeRow(his.id)).tagStatus).toBe('ok')
    expect((await jobRow(his.id))?.status).toBe('done')
  })
})
