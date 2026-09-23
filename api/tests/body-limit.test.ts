import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 全局请求体上限（`src/app.ts` 的 `bodyLimit`）。
 *
 * ⚠️ 这个文件挂的是**真的 `app`**（别的集成测试都只挂一组路由）。理由是这个中间件
 * 挂在 `app.use('*')` 上，只挂一组路由的话测不到「全局」这件事——而漏挂的表现是
 * **没有任何表现**：一个客户端把 200 MiB 的 JSON 推进来，进程的内存就是它的了。
 *
 * 第一版实现里 `onError` 走的是 `hono/body-limit` 的默认值，它抛 `HTTPException(413)`——
 * 那不是 `AppError`，统一出口只能当未捕获异常 → 500。所以这里断言的是
 * **400 `VALIDATION_FAILED`**（SPEC §2.2/§2.3 里没有「请求体过大」这个码，
 * 不为一次超限去加一个；`QUOTA_EXCEEDED` 说的是存储配额，不是请求体）。
 *
 * 图片字节**不经过 api**（浏览器预签名直传 R2，SPEC §6.2.1），所以合法 JSON 的
 * 上限就是导入清单那 1 MiB 左右。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { app } = await import('../src/app.js')

const { sql } = createTestDb()

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

// 上限是 `MAX_FILES_PER_BATCH * 1 KiB` = 1000 KiB。这里给 2 MiB，是它的两倍。
// **故意明显超出而不是刚好压线**：压线的用例会随着 `MAX_FILES_PER_BATCH` 的调整
// 莫名其妙地红/绿，而它想守的是「超限的请求被挡住」这件事。
const OVERSIZED = 'x'.repeat(2 * 1024 * 1024)

describe('全局请求体上限', () => {
  it('超大 JSON 是 400 VALIDATION_FAILED，不是 500', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: OVERSIZED, password: 'whatever-1' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('超限判定发生在路由之前，所以未登录也拦得住', async () => {
    // 若上限只在某个 handler 里判，一个没有 cookie 的请求会先撞 401 再谈体积。
    // 全局中间件先跑：这样「谁在推大包」在认证之前就被挡住
    const res = await app.request('/api/v1/memes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: OVERSIZED }),
    })

    expect(res.status).toBe(400)
  })

  it('正常大小的请求体照常通过', async () => {
    // 上限不能顺手把合法请求也挡了：这条会走到登录逻辑，得到的是「密码不对」
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nobody', password: 'whatever-1' }),
    })

    expect(res.status).toBe(401)
  })
})
