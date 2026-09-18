import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * `GET /memes?random=true` 的全库随机抽样（SPEC §6.3.2）。
 *
 * 这个参数存在的唯一理由是**首页要在全库里抽，不是「最新的 N 张里抽几张」**。
 * 而它所有的失效方式都是**静默的**——没有一条会报错：
 *
 *   - 漏掉 `deleted_at is null` → 已删的图出现在首页
 *   - 漏掉筛选条件             → 别人上传的、别的标签的图混进来
 *   - 写成「取最新一页再打乱」 → 老图永远出不来，而首页看起来在随机
 *
 * 所以下面的用例几乎都在断言**「不该出现的东西没有出现」**，而不是断言数量。
 * 数量那几条反而最容易过——一个 `limit(10)` 就能让它们全绿。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 必须在 import 任何 src 模块之前：路由读的是默认连接，不改掉就会打到开发库
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme, favoriteMeme } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { softDeleteMeme } = await import('../src/data/memes.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { memesRoutes } = await import('../src/routes/memes.js')

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

type Actor = { id: string; role: 'admin' | 'member'; cookie: string }

async function signIn(role: 'admin' | 'member' = 'member'): Promise<Actor> {
  const user = await createUser(db, { role })
  const session = await createSession(user.id, db)
  return { id: user.id, role, cookie: `sid=${session.id}` }
}

type Item = { id: string; tags: string[]; favorited: boolean }
type ListBody = { items: Item[]; nextCursor: string | null }

async function list(query: string, actor: Actor | null = null): Promise<Response> {
  return testApp.request(`/api/v1/memes?${query}`, {
    headers: actor === null ? {} : { cookie: actor.cookie },
  })
}

async function listBody(query: string, actor: Actor | null = null): Promise<ListBody> {
  const res = await list(query, actor)
  expect(res.status).toBe(200)
  return (await res.json()) as ListBody
}

/** 造 n 张图，返回 id（按创建顺序，`[0]` 最老）。 */
async function seed(uploaderId: string, n: number, tags: string[] = []): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    ids.push((await makeMeme(db, { uploaderId, tags })).id)
  }
  return ids
}

describe('GET /memes?random=true', () => {
  it('返回 limit 条，nextCursor 恒为 null', async () => {
    const alice = await signIn()
    await seed(alice.id, 25)

    const body = await listBody('random=true&limit=10')
    expect(body.items.length).toBe(10)
    // 随机序没有「下一页」。给一个游标会让客户端把「随机的第二页」接在第一页后面，
    // 而那看起来像正常翻页（SPEC §6.3.2）。
    expect(body.nextCursor).toBeNull()
  })

  it('库里的图比 limit 少时给多少算多少', async () => {
    const alice = await signIn()
    await seed(alice.id, 3)

    const body = await listBody('random=true&limit=10')
    expect(body.items.length).toBe(3)
    expect(body.nextCursor).toBeNull()
  })

  it('软删的图抽不出来 —— 漏掉 deleted_at 不报错，只是已删的图出现在首页', async () => {
    const alice = await signIn()
    const actor = { id: alice.id, role: 'member' as const }

    const alive = await makeMeme(db, { uploaderId: alice.id })
    for (const id of await seed(alice.id, 20)) {
      await softDeleteMeme(id, actor, db)
    }

    // limit 开得比存活数大：漏了过滤就一定会把已删的图带出来，不用靠概率
    const body = await listBody('random=true&limit=100')
    expect(body.items.map((m) => m.id)).toEqual([alive.id])
  })

  it('全库都软删了就是空列表', async () => {
    const alice = await signIn()
    const actor = { id: alice.id, role: 'member' as const }
    for (const id of await seed(alice.id, 5)) {
      await softDeleteMeme(id, actor, db)
    }

    const body = await listBody('random=true&limit=10')
    expect(body.items).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  it('标签筛选发生在抽样之前 —— 猫的随机里不混进狗', async () => {
    const alice = await signIn()
    const cats = new Set(await seed(alice.id, 5, ['猫']))
    await seed(alice.id, 30, ['狗'])

    // 抽五轮：漏了筛选的话，每轮 30/35 的图都会是狗，不可能五轮全过
    for (let round = 0; round < 5; round++) {
      const body = await listBody('random=true&limit=5&tags=%E7%8C%AB')
      expect(body.items.length).toBe(5)
      for (const m of body.items) {
        expect(cats.has(m.id)).toBe(true)
        expect(m.tags).toContain('猫')
      }
    }
  })

  it('uploader 筛选发生在抽样之前', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const mine = new Set(await seed(alice.id, 5))
    await seed(bob.id, 30)

    const body = await listBody('random=true&limit=10&uploader=me', alice)
    expect(body.items.length).toBe(5)
    for (const m of body.items) expect(mine.has(m.id)).toBe(true)
  })

  it('favorited 筛选发生在抽样之前 —— 走的是 INNER JOIN 那条路径', async () => {
    const alice = await signIn()
    const favorited = new Set<string>()
    for (const id of await seed(alice.id, 3)) {
      await favoriteMeme(db, alice.id, id)
      favorited.add(id)
    }
    await seed(alice.id, 20)

    const body = await listBody('random=true&limit=10&favorited=true', alice)
    expect(body.items.length).toBe(3)
    for (const m of body.items) {
      expect(favorited.has(m.id)).toBe(true)
      expect(m.favorited).toBe(true)
    }
  })

  it('随机是全库的，不是「最新的那几条打乱」', async () => {
    const alice = await signIn()
    // 40 张，前 20 张最老。客户端做「伪随机」时能拿到的只有最新那一页，
    // 所以判据是**老图也会被抽出来**——这是这个参数存在的全部理由。
    const ids = await seed(alice.id, 40)
    const oldest = new Set(ids.slice(0, 20))

    let sawOldest = false
    for (let round = 0; round < 10 && !sawOldest; round++) {
      const body = await listBody('random=true&limit=10')
      if (body.items.some((m) => oldest.has(m.id))) sawOldest = true
    }
    // 十轮全是新图的概率约 (C(20,10)/C(40,10))^10 ≈ 2e-38，不是一条会偶发红的断言
    expect(sawOldest).toBe(true)
  })

  it('random 与 cursor 互斥，返回 VALIDATION_FAILED', async () => {
    const alice = await signIn()
    await seed(alice.id, 3)

    const res = await list('random=true&limit=2&cursor=whatever')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('random 不绕开 tagStatus 的权限判定', async () => {
    const alice = await signIn()
    const bob = await signIn()
    await makeMeme(db, { uploaderId: alice.id, tagStatus: 'needs_manual' })

    const res = await list('random=true&tagStatus=needs_manual', bob)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('不传 random 时行为逐字不变：照常游标翻页', async () => {
    const alice = await signIn()
    await seed(alice.id, 5)

    const first = await listBody('limit=2')
    expect(first.items.length).toBe(2)
    expect(first.nextCursor).not.toBeNull()

    const second = await listBody(
      `limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    )
    expect(second.items.length).toBe(2)

    // 游标分页的判据是「两页不重叠」，不是「第二页有条数」
    const onFirstPage = new Set(first.items.map((m) => m.id))
    for (const m of second.items) expect(onFirstPage.has(m.id)).toBe(false)
  })
})
