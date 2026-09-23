import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * `GET /search` 的接口级集成测试：融合顺序、`matchedBy`、`degraded`、软删过滤。
 *
 * 语法同 `search-paths.test.ts`：src 模块全走动态 import，环境变量必须在它们之前设好。
 * 这里**故意不配** embedding，测的就是降级态——向量路不跑，接口仍然 200。
 *
 * 只挂 searchRoutes，不挂整个 app：这个用例关心的是搜索这一条链路的对外表现，
 * 认证中间件的行为在别的测试里。
 */
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''

const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

/**
 * ⚠️ 这个文件走的是**真实路由**，而路由读 `src/data/db.ts` 的默认连接——它认进程里的
 *    `DATABASE_URL`。不在这里改掉，请求就会打到**开发库**上，而这里的 beforeEach 是要
 *    truncate 的。测试连 `<库名>_test`（testing.md §1），所以先把环境变量指过去，
 *    再去 import 任何 src 模块。
 *
 *    `.env` 由 setup-env.ts 用 `process.loadEnvFile` 读入，已存在的键不会被覆盖，
 *    所以这一行在整个进程里都生效。
 */
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, favoriteMeme, makeMeme, unitVector } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { softDeleteMeme } = await import('../src/data/memes.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { searchRoutes } = await import('../src/routes/search.js')

const { sql, db } = createTestDb()

// 与 app.ts 一致地链式挂载，并且带上 requestId 中间件 —— 路由会读它来记日志。
// onError/notFound 也必须有：少了它们，抛出的 AppError 会被 Hono 默认兜成 500，
// 断言错误码的用例就测不到真实行为
const testApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/search', searchRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

type Actor = { id: string; role: 'admin' | 'member'; cookie: string }

/**
 * 建一个用户并给他一个会话。**每个用例里的 alice 都得是登录状态**：
 * 搜索整条路由要求登录（SPEC §3.3），没有 cookie 的请求是 401，
 * 那样测的就不是搜索而是认证了。
 */
async function signIn(role: 'admin' | 'member' = 'member'): Promise<Actor> {
  const user = await createUser(db, { role })
  const session = await createSession(user.id, db)
  return { id: user.id, role, cookie: `sid=${session.id}` }
}

// `request` 的返回类型是 `Response | Promise<Response>`，直接 return 会撞上声明里的
// `Promise<Response>`。这个 app 没有 requestId 之外的异步中间件，包一层 async 最省事。
async function search(qs: string, actor: Actor): Promise<Response> {
  return await testApp.request(`/api/v1/search${qs}`, { headers: { cookie: actor.cookie } })
}

describe('GET /search', () => {
  it('三路融合，被多路召回的排在前面', async () => {
    const alice = await signIn()
    // 查询是两个词条，两条记录**都有这两个标签**，所以标签路上各召回一次、名次也相同。
    // 差别只在文字路：只有 bothPaths 的正文里含「无语 猫」这个串。
    //   bothPaths → tags + ocr → 2/(k+r)
    //   tagOnly   → tags 一路   → 1/(k+r)
    // 顺序因此完全由「被几路召回」决定，不牵扯两边的相似度谁更高。
    const bothPaths = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '无语 猫 的表情',
      emotions: ['无语'],
      tags: ['猫'],
    })
    const tagOnly = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '一只面无表情的猫',
      emotions: ['无语'],
      tags: ['猫'],
    })

    const res = await search('?q=无语 猫', alice)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { items: { id: string; matchedBy: string[] }[] }
    const ids = body.items.map((i) => i.id)

    expect(ids).toContain(bothPaths.id)
    expect(ids).toContain(tagOnly.id)
    // 两路召回的那条排在只有一路的前面
    expect(ids.indexOf(bothPaths.id)).toBeLessThan(ids.indexOf(tagOnly.id))

    expect(body.items.find((i) => i.id === bothPaths.id)?.matchedBy).toEqual(
      expect.arrayContaining(['ocr', 'tags']),
    )
    expect(body.items.find((i) => i.id === tagOnly.id)?.matchedBy).toEqual(['tags'])
  })

  it('embedding 未配置时 degraded: true，OCR + 标签仍然出结果，不报错', async () => {
    const alice = await signIn()
    const hit = await makeMeme(db, { uploaderId: alice.id, ocrText: '一只趴在桌上的猫' })

    const res = await search('?q=趴在桌上的猫', alice)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      items: { id: string; matchedBy: string[] }[]
      degraded: boolean
      rewritten: string | null
    }

    expect(body.degraded).toBe(true)
    // 向量路没跑，所以任何一条结果都不该声称被 vector 召回
    expect(body.items.every((i) => !i.matchedBy.includes('vector'))).toBe(true)
    expect(body.items.map((i) => i.id)).toContain(hit.id)
    // 没配模型就没有改写，且这不该影响上面两条
    expect(body.rewritten).toBeNull()
  })

  it('软删的记录不出现在结果里', async () => {
    const alice = await signIn()
    const alive = await makeMeme(db, { uploaderId: alice.id, ocrText: '一只很生气的猫' })
    const deleted = await makeMeme(db, { uploaderId: alice.id, ocrText: '一只很生气的猫' })
    await softDeleteMeme(deleted.id, alice, db)

    const body = (await (await search('?q=生气的猫', alice)).json()) as { items: { id: string }[] }
    const ids = body.items.map((i) => i.id)

    expect(ids).toContain(alive.id)
    expect(ids).not.toContain(deleted.id)
  })

  it('结果带 favorited（当前登录用户）', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id, ocrText: '一只打哈欠的猫' })
    await favoriteMeme(db, bob.id, meme.id)

    // 收藏的人看到 true、没收藏的人看到 false —— **两个方向都要断言**：
    // 只测一边的话，「恒 true」和「恒 false」这两种写法各有一次能过。
    // 这曾经是个恒 false 的断言，理由是「这个测试挂的 app 没有鉴权中间件」；
    // 现在路由要求登录（SPEC §3.3），currentUser 一定存在，没有那个中间态可测了。
    const asBob = (await (await search('?q=打哈欠的猫', bob)).json()) as {
      items: { id: string; favorited: boolean }[]
    }
    expect(asBob.items.find((i) => i.id === meme.id)?.favorited).toBe(true)

    const asAlice = (await (await search('?q=打哈欠的猫', alice)).json()) as {
      items: { id: string; favorited: boolean }[]
    }
    expect(asAlice.items.find((i) => i.id === meme.id)?.favorited).toBe(false)
  })

  it('q 缺失或全空白返回 VALIDATION_FAILED', async () => {
    const alice = await signIn()
    for (const qs of ['', '?q=', '?q=%20%20']) {
      const res = await search(qs, alice)
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('limit 非法报错，超过上限则截断', async () => {
    const alice = await signIn()
    expect((await search('?q=猫&limit=0', alice)).status).toBe(400)
    expect((await search('?q=猫&limit=abc', alice)).status).toBe(400)

    for (let i = 0; i < 3; i += 1) {
      await makeMeme(db, { uploaderId: alice.id, ocrText: '一只睡觉的猫' })
    }

    const body = (await (await search('?q=睡觉的猫&limit=999', alice)).json()) as {
      items: unknown[]
    }
    // 999 被压到 100，而库里只有 3 条 —— 能跑通就说明没有因为超上限而报错
    expect(body.items).toHaveLength(3)
  })

  it('没有任何一路召回时返回空数组，不是 404', async () => {
    const alice = await signIn()
    await makeMeme(db, { uploaderId: alice.id, ocrText: '一只狗' })

    const res = await search('?q=完全不相干的一句话', alice)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { items: unknown[]; degraded: boolean }
    expect(body.items).toEqual([])
    // 没有结果也不改变降级判定：degraded 说的是「向量路没跑」，与命中数无关
    expect(body.degraded).toBe(true)
  })

  it('响应里不含 storageKey', async () => {
    const alice = await signIn()
    await makeMeme(db, { uploaderId: alice.id, ocrText: '一只很开心的猫' })

    const body = (await (await search('?q=开心的猫', alice)).json()) as {
      items: Record<string, unknown>[]
    }
    expect(body.items.length).toBeGreaterThan(0)
    // 与浏览接口共用 serializeMeme，这条断言挡的是「搜索自己手写一份序列化」的改动
    expect(body.items[0]).not.toHaveProperty('storageKey')
    expect(body.items[0]).toHaveProperty('url')
    expect(body.items[0]).toHaveProperty('thumbUrl')
  })
})

describe('向量路可用时', () => {
  it('unitVector 造的数据在向量路上能被召回', async () => {
    // 这个用例不经过 HTTP（上面挂的 app 没有 embedding 配置），直接验证
    // 「塞了向量的记录，查询向量能找到它」这条链路在真库上成立。
    // `embedModel` 两边必须是同一个：向量路按它过滤（SPEC §9.20），
    // 种子不写的话这里会查出空数组，而那不是这条用例想测的东西。
    const model = 'test-embed-model'
    const alice = await signIn()
    const meme = await makeMeme(db, {
      uploaderId: alice.id,
      embedding: unitVector(7),
      embedModel: model,
    })

    const { vectorPathCandidates } = await import('../src/data/search.js')
    expect(await vectorPathCandidates(unitVector(7), model, [], db)).toContain(meme.id)
  })
})
