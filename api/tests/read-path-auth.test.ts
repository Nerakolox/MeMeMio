import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 读路径的登录门槛（SPEC §3.3：搜索 / 浏览 / 使用 = **所有登录用户**）。
 *
 * 这组用例存在的理由是一次**静默**的越权：浏览与搜索曾经挂 `optionalAuth`，
 * 于是未登录的人能拿到全库内容和部署方的 AI 额度，而代码不报错、测试全绿——
 * 「匿名也能用」看起来只是「更宽容」。所以这里的断言都是**外部可观测的行为**：
 * 没有 cookie 的请求必须是 401，而不是「也能用但 favorited 恒 false」。
 *
 * 第二半（`uuid 形状`）挡的是另一类静默：非法 id 撞 Postgres 的 22P02，
 * 落到统一出口变成 500 —— 客户端传错一个字符，得到「服务器内部错误」。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 必须在 import 任何 src 模块之前：路由读的是默认连接，不改掉就会打到开发库
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { searchRoutes } = await import('../src/routes/search.js')

const { sql, db } = createTestDb()

// 两组路由挂在同一个 app 上：它们「要求登录」这件事必须是同一套行为，
// 分成两个 app 的话，「只有一处改对了」在测试里看不出来。
const testApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/memes', memesRoutes)
  .route('/api/v1/search', searchRoutes)
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

/*
 * `request` 的返回类型是 `Response | Promise<Response>`，直接 return 会撞上声明里的
 * `Promise<Response>`（与 search.test.ts 同一个坑）。包一层 async 最省事。
 */

/** 不带任何 cookie 的请求 —— 这就是「未登录」在接口上的样子。 */
async function anon(path: string, init: RequestInit = {}): Promise<Response> {
  return await testApp.request(path, init)
}

async function as(actor: Actor, path: string, init: RequestInit = {}): Promise<Response> {
  return await testApp.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: actor.cookie },
  })
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } }
  return body.error.code
}

const UNKNOWN_UUID = '2f4a1c9e-6b3d-4a17-9f0c-8c2b5d7e1a44'

describe('读路径要求登录', () => {
  /*
   * 四条路径各来一条。**都断言 code 而不只是 401**：401 也可能是别的中间件给的，
   * 而契约里未登录就是 `UNAUTHENTICATED`（SPEC §2.2），客户端按 code 决定跳登录页。
   */
  it('GET /memes 未登录是 401 UNAUTHENTICATED', async () => {
    const res = await anon('/api/v1/memes')
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('UNAUTHENTICATED')
  })

  it('GET /memes?random=true（首页随机墙）未登录是 401', async () => {
    // 首页是唯一会主动打这个接口的地方，它要是匿名可达，
    // 等于把「全库随机抽」这个接口挂在公网上
    const res = await anon('/api/v1/memes?random=true&limit=10')
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('UNAUTHENTICATED')
  })

  it('GET /memes/{id} 未登录是 401，不是 404', async () => {
    // ⚠️ **不能是 404**：404 会让客户端以为「这张图没了」，
    // 而实际上它可能就在那儿、只是没登录。判定的顺序必须是「先登录、后存在」
    const res = await anon(`/api/v1/memes/${UNKNOWN_UUID}`)
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('UNAUTHENTICATED')
  })

  it('GET /search 未登录是 401，且不烧 embedding', async () => {
    const res = await anon('/api/v1/search?q=%E7%8C%AB')
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('UNAUTHENTICATED')
  })

  it('未登录的写路径同样是 401（不是靠 handler 里那句判断兜的）', async () => {
    const paths: [string, string][] = [
      ['PATCH', `/api/v1/memes/${UNKNOWN_UUID}`],
      ['DELETE', `/api/v1/memes/${UNKNOWN_UUID}`],
      ['PUT', `/api/v1/memes/${UNKNOWN_UUID}/favorite`],
      ['DELETE', `/api/v1/memes/${UNKNOWN_UUID}/favorite`],
      ['POST', '/api/v1/memes/retag'],
      ['GET', '/api/v1/memes/tag-status'],
    ]
    for (const [method, path] of paths) {
      const res = await anon(path, { method })
      expect([path, res.status]).toEqual([path, 401])
      expect([path, await errorCode(res)]).toEqual([path, 'UNAUTHENTICATED'])
    }
  })

  it('会话失效（cookie 里的 session 不存在）同样是 401', async () => {
    const res = await testApp.request('/api/v1/memes', {
      headers: { cookie: `sid=${UNKNOWN_UUID}` },
    })
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('UNAUTHENTICATED')
  })

  it('登录后同样的请求是 200 —— 上面的 401 不是因为路径写错了', async () => {
    const alice = await signIn()
    const list = await as(alice, '/api/v1/memes')
    expect(list.status).toBe(200)

    const search = await as(alice, '/api/v1/search?q=%E7%8C%AB')
    expect(search.status).toBe(200)
  })
})

describe('路径参数与游标里的 uuid 形状', () => {
  /*
   * 判据统一是「**不是 500**」。这里每一条在修之前都是 500：
   * Postgres 收到 `'abc'` 只会说 `invalid input syntax for type uuid`，
   * 而那不是 AppError，统一出口把它变成 INTERNAL + requestId。
   */
  it('GET /memes/abc 是 404，不是 500', async () => {
    const alice = await signIn()
    const res = await as(alice, '/api/v1/memes/abc')
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('NOT_FOUND')
  })

  it('形状合法但不存在的 uuid 同样是 404 —— 两种对客户端是同一件事', async () => {
    const alice = await signIn()
    const malformed = await as(alice, '/api/v1/memes/abc')
    const missing = await as(alice, `/api/v1/memes/${UNKNOWN_UUID}`)
    expect(missing.status).toBe(malformed.status)
    expect(await errorCode(missing)).toBe('NOT_FOUND')
  })

  it('PATCH / DELETE / 收藏 上的非法 id 也是 404', async () => {
    const alice = await signIn()
    for (const [method, path] of [
      ['PATCH', '/api/v1/memes/abc'],
      ['DELETE', '/api/v1/memes/abc'],
      ['PUT', '/api/v1/memes/abc/favorite'],
      ['DELETE', '/api/v1/memes/abc/favorite'],
    ] as [string, string][]) {
      const res = await as(alice, path, { method, body: '{}' })
      expect([path, res.status]).toEqual([path, 404])
    }
  })

  it('?uploader=abc 是 400 —— 这是参数写错了，不是「查不到」', async () => {
    const alice = await signIn()
    const res = await as(alice, '/api/v1/memes?uploader=abc')
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('坏游标是 400 VALIDATION_FAILED，不是「从第一页开始」', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id })

    // 游标是客户端拿来就用的不透明串，改一个字符就能造出这种输入。
    //
    // **这里曾经断言 200 + 第一页**（「解不出来就当没传」）。那条约定单独看很宽容，
    // 放进无限滚动就是另一种东西：客户端拿到的是**第一页**，它会把它**追加**到已经
    // 渲染出来的列表后面——屏幕上凭空多出一份重复，而没有任何一层报错。
    // 所以现在是**明确的 400**（SPEC §1.3）：丢弃游标、回第一页这个动作由客户端做，
    // 服务端只负责说清楚「这个游标不能用」。
    const cursor = Buffer.from(`2026-01-01T00:00:00.000Z|abc`).toString('base64url')
    const res = await as(alice, `/api/v1/memes?cursor=${cursor}`)
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')

    // 同一份数据不带游标是拿得到的 —— 400 挡的是游标，不是这一页
    const first = await as(alice, '/api/v1/memes')
    const body = (await first.json()) as { items: { id: string }[] }
    expect(body.items.map((m) => m.id)).toContain(meme.id)
  })
})
