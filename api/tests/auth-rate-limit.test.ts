import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 登录 / 注册的限流（SPEC §2.2 的 `RATE_LIMITED` + `Retry-After`）。
 *
 * 限流的失效方式有两种，**都不报错**，所以两条都要有用例盯着：
 *
 *   ① 限得太松或压根没生效 → 脚本能一直刷 scrypt（注册口）和试密码（登录口）；
 *   ② 分桶的键取错 → **反代后面所有请求的 socket 地址都是反代**，
 *      按它分桶等于全站共用一个计数器：一个人刷满，全站登不上。
 *      这里用不同的 `X-Forwarded-For` 才是「两个客户端」。
 *
 * 计数是**进程内**的，用例之间必须互不影响 —— `resetRateLimits()` 放在 beforeEach，
 * 谁都不依赖执行顺序（agents/rules/testing.md §2）。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser } = await import('./helpers/factories.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { resetRateLimits } = await import('../src/middleware/rate-limit.js')
const { authRoutes } = await import('../src/routes/auth.js')

const { sql, db } = createTestDb()

const testApp = new Hono().use('*', requestId).route('/api/v1/auth', authRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

/** 登录口的阈值（routes/auth.ts）：10 次 / 分钟 / IP。 */
const LOGIN_LIMIT = 10

beforeEach(async () => {
  await truncateAll(sql)
  resetRateLimits()
})

afterAll(async () => {
  await sql.end()
})

/**
 * 发一次登录。**故意用不存在的用户名**：登录失败在查到用户不存在时就返回，
 * 不烧 scrypt，于是「打满一桶」只要几十毫秒。被测的是限流，不是密码校验。
 */
// `request` 的返回类型是 `Response | Promise<Response>`，包一层 async 才配得上
// 声明里的 `Promise<Response>`（同一个坑在 search.test.ts 里注释过）
async function login(ip: string | null, name = 'nobody'): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // null 表示**完全不发 XFF**：那是「没有反代、也没有伪造头」的那种请求
  if (ip !== null) headers['x-forwarded-for'] = ip
  return await testApp.request('/api/v1/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, password: 'whatever-1' }),
  })
}

async function errorBody(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } }
  return body.error
}

describe('登录限流', () => {
  it('超过阈值返回 429 RATE_LIMITED，并带 Retry-After', async () => {
    for (let i = 0; i < LOGIN_LIMIT; i += 1) {
      const res = await login('203.0.113.7')
      // 前 10 次是「密码不对」，不是「太快」——否则下面的 429 可能只是阈值配错了
      expect(res.status).toBe(401)
    }

    const limited = await login('203.0.113.7')
    expect(limited.status).toBe(429)

    const error = await errorBody(limited)
    expect(error.code).toBe('RATE_LIMITED')

    /*
     * `Retry-After` 是**协议层的头**，不是 `details` 里的一个字段：客户端
     * （web 的 lib/api.ts）读的就是这个头，规范里也写的是它（SPEC §2.2）。
     * 值必须是正整数秒——回 0 会让客户端立刻重试、又被拒，变成忙等。
     */
    const retryAfter = limited.headers.get('Retry-After')
    expect(retryAfter).not.toBeNull()
    const seconds = Number(retryAfter)
    expect(Number.isInteger(seconds)).toBe(true)
    expect(seconds).toBeGreaterThan(0)
    // 窗口是一分钟，退避秒数不可能超过它
    expect(seconds).toBeLessThanOrEqual(60)
  })

  it('不同客户端 IP 各算各的 —— 一个人刷满不影响别人', async () => {
    for (let i = 0; i < LOGIN_LIMIT; i += 1) await login('203.0.113.7')
    expect((await login('203.0.113.7')).status).toBe(429)

    // 另一个 IP 从头开始：这是**按客户端分桶**与「全站一个计数器」的分界点。
    // 反代后面 socket 地址全是反代的，取错就退化成后者（lib/client-ip.ts）
    expect((await login('198.51.100.9')).status).toBe(401)
  })

  /*
   * ⚠️ 取 XFF 的**最后一项**，不是第一项。
   *
   * 反代是**追加**真实客户端 IP 到 `X-Forwarded-For` 末尾的，客户端自己伪造的那些
   * 排在前面。取第一项的话，攻击者只要每次换一个前缀就是无限桶——限流形同虚设，
   * 而且看代码完全看不出来（它「取了 XFF」，只是取错了那一头）。
   */
  it('伪造的 XFF 前缀不产生新桶', async () => {
    for (let i = 0; i < LOGIN_LIMIT; i += 1) await login(`10.0.0.${i}, 203.0.113.7`)

    const forged = await login('172.16.0.1, 203.0.113.7')
    expect(forged.status).toBe(429)
  })

  it('没有 XFF 也没有 socket 信息时共用一个桶，不会绕过去', async () => {
    // app.request() 没有 node-server 的 incoming，取不到 socket 地址。
    // 这时兜底成 `unknown`，仍然是**一个**桶——不能因为取不到 IP 就放行
    for (let i = 0; i < LOGIN_LIMIT; i += 1) await login(null)
    expect((await login(null)).status).toBe(429)
  })

  it('登录被限不连带锁住注册（两条规则各算各的）', async () => {
    for (let i = 0; i < LOGIN_LIMIT + 1; i += 1) await login('203.0.113.7')
    expect((await login('203.0.113.7')).status).toBe(429)

    // 引导期注册（库里还没有用户）：同一个 IP 的注册桶是空的
    const res = await testApp.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ name: 'boss', password: 'password-1' }),
    })
    expect(res.status).toBe(201)
  })
})

describe('注册限流', () => {
  it('注册口比登录口更紧：第 6 次是 429', async () => {
    // 配额：注册 5 次/分钟（routes/auth.ts）。注册要烧 scrypt，所以比登录更早拦。
    // 库里已经有用户之后，这些请求根本不进 scrypt——被拒在邀请码预检。
    await createUser(db, { name: 'boss' })

    for (let i = 0; i < 5; i += 1) {
      const res = await testApp.request('/api/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        body: JSON.stringify({ name: `u${i}`, password: 'password-1' }),
      })
      expect(res.status).toBe(400)
    }

    const limited = await testApp.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ name: 'u9', password: 'password-1' }),
    })
    expect(limited.status).toBe(429)
    expect((await errorBody(limited)).code).toBe('RATE_LIMITED')
  })
})
