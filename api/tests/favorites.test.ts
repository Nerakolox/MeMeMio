import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 收藏端点的端到端集成测试（SPEC §6.4 / joint-tasks/2026-09-16-tag-queue.md）。
 *
 * 这两个端点 web 早就在调了（`web/src/lib/api.ts` 的 `toggleFavorite`），api 侧一直缺，
 * 所以「收藏」在界面上是坏的。本文件测的是契约本身，不是实现细节：
 * **幂等**、**软删过滤**、**未登录拒绝**，以及「收藏是人和图的关系，不是图的属性」。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 必须在 import 任何 src 模块之前：路由读的是默认连接，不改掉就会打到开发库
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { softDeleteMeme } = await import('../src/data/memes.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { memes, userFavorites } = await import('../src/data/schema.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

const testApp = new Hono().use('*', requestId).route('/api/v1/memes', memesRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

type Actor = { id: string; cookie: string }

async function signIn(): Promise<Actor> {
  const user = await createUser(db)
  const session = await createSession(user.id, db)
  return { id: user.id, cookie: `sid=${session.id}` }
}

async function call(method: string, memeId: string, actor: Actor | null): Promise<Response> {
  return testApp.request(`/api/v1/memes/${memeId}/favorite`, {
    method,
    headers: actor === null ? {} : { cookie: actor.cookie },
  })
}

async function favoriteCount(userId: string, memeId: string): Promise<number> {
  const rows = await db
    .select()
    .from(userFavorites)
    .where(eq(userFavorites.memeId, memeId))
  return rows.filter((row) => row.userId === userId).length
}

describe('PUT /memes/:id/favorite', () => {
  it('收藏成功，写的是 user_favorites', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })

    const res = await call('PUT', meme.id, alice)
    expect(res.status).toBe(204)
    expect(await favoriteCount(alice.id, meme.id)).toBe(1)
  })

  it('重复收藏是幂等的——前端双击、断网重发都会来第二次', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })

    expect((await call('PUT', meme.id, alice)).status).toBe(204)
    expect((await call('PUT', meme.id, alice)).status).toBe(204)

    // 幂等的判据是「库里仍然只有一条」，不是「第二次没报错」
    expect(await favoriteCount(alice.id, meme.id)).toBe(1)
  })

  it('收藏别人的图是正常用法，不是对那张图的改动', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })

    expect((await call('PUT', meme.id, bob)).status).toBe(204)

    // **收藏是人和图的关系，不是图的属性**（SPEC §5.4）：memes 一个字节都不该动。
    // 这条用例挡的是「顺手在 memes 上加个 favorite_count 缓存」那种改动
    const [row] = await db.select().from(memes).where(eq(memes.id, meme.id))
    expect(row?.editedBy).toBeNull()
    expect(row?.editedAt).toBeNull()
    expect(row?.tagStatus).toBe('pending')
  })

  it('两个人各收藏同一张图，互不影响', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })

    await call('PUT', meme.id, alice)
    await call('PUT', meme.id, bob)
    await call('DELETE', meme.id, alice)

    expect(await favoriteCount(alice.id, meme.id)).toBe(0)
    expect(await favoriteCount(bob.id, meme.id)).toBe(1)
  })

  it('软删的图返回 NOT_FOUND —— 外键只保证图存在，不保证它没被删', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })
    await softDeleteMeme(meme.id, { id: alice.id, role: 'member' }, db)

    const res = await call('PUT', meme.id, alice)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(await favoriteCount(alice.id, meme.id)).toBe(0)
  })

  it('未登录是 UNAUTHENTICATED', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })

    const res = await call('PUT', meme.id, null)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })
})

describe('DELETE /memes/:id/favorite', () => {
  it('取消收藏', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })
    await call('PUT', meme.id, alice)

    expect((await call('DELETE', meme.id, alice)).status).toBe(204)
    expect(await favoriteCount(alice.id, meme.id)).toBe(0)
  })

  it('没收藏过也返回 204 —— 和 PUT 对称，否则前端乐观更新会莫名回滚', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })

    expect((await call('DELETE', meme.id, alice)).status).toBe(204)
    expect((await call('DELETE', meme.id, alice)).status).toBe(204)
  })

  it('软删的图返回 NOT_FOUND，和 PUT 一致', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })
    await call('PUT', meme.id, alice)
    await softDeleteMeme(meme.id, { id: alice.id, role: 'member' }, db)

    const res = await call('DELETE', meme.id, alice)
    expect(res.status).toBe(404)
  })

  it('未登录是 UNAUTHENTICATED', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })

    const res = await call('DELETE', meme.id, null)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })
})
