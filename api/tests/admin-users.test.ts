import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * `PATCH /admin/users/{id}` 的两个入参边界。
 *
 * 两条都曾经是 500：
 *
 *   - `storageQuotaBytes: "abc"` → `BigInt('abc')` 抛 `SyntaxError`，它不是 `AppError`，
 *     统一出口只能当未捕获异常 → INTERNAL。一个填错的配额值回应「服务器内部错误」，
 *     把管理员送去查日志（SPEC §2.1：底层 message 不外露，所以日志里也没有线索）。
 *   - `{id}` 不是 uuid → Postgres 的 `invalid input syntax for type uuid`，同一个下场。
 *
 * **配额是 bigint，JSON 里是十进制字符串**（SPEC §7.1）。`BigInt()` 自己会吞下的那些
 * 写法（`0x10`、前导空格、布尔）是「参数写错了」，不是「配额等于 16 字节」——
 * 静默接受的表现是管理员填错一位、保存成功、配额变成一个他没想过的数。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { adminRoutes } = await import('../src/routes/admin.js')

const { sql, db } = createTestDb()

const testApp = new Hono().use('*', requestId).route('/api/v1/admin', adminRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

/** 一个 admin 和一个等着被改配额的 member。 */
async function setup(): Promise<{ targetId: string; cookie: string }> {
  const admin = await createUser(db, { role: 'admin' })
  const target = await createUser(db, { role: 'member' })
  const session = await createSession(admin.id, db)
  return { targetId: target.id, cookie: `sid=${session.id}` }
}

async function patch(
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { error?: { code: string }; storageQuotaBytes?: string } }> {
  const res = await testApp.request(`/api/v1/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as never }
}

describe('PATCH /admin/users/{id} 的 storageQuotaBytes', () => {
  it('十进制字符串照收', async () => {
    const { targetId, cookie } = await setup()

    const res = await patch(cookie, targetId, { storageQuotaBytes: '1073741824' })

    expect(res.status).toBe(200)
    expect(res.body.storageQuotaBytes).toBe('1073741824')
  })

  /*
   * 这一条就是任务里的 `BigInt('abc')`。判据是 **400 而不是 500**：
   * 「你填的不是数字」是客户端的事，「服务器内部错误」不是。
   */
  it('"abc" 是 400 VALIDATION_FAILED，不是 500', async () => {
    const { targetId, cookie } = await setup()

    const res = await patch(cookie, targetId, { storageQuotaBytes: 'abc' })

    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('VALIDATION_FAILED')
  })

  it('BigInt() 自己会吞下的那些写法一律拒绝', async () => {
    const { targetId, cookie } = await setup()

    // '0x10' → 16、' 12 ' → 12、true → 1：BigInt 全都接受，但它们是写错了参数
    for (const value of ['0x10', ' 12 ', '-5', '1e3', '1.5', '', '12n', true, null, 1.5, {}, []]) {
      const res = await patch(cookie, targetId, { storageQuotaBytes: value })
      expect([value, res.status]).toEqual([value, 400])
      expect([value, res.body.error?.code]).toEqual([value, 'VALIDATION_FAILED'])
    }
  })

  it('整数 number 照收（客户端做完算术后传回来）', async () => {
    const { targetId, cookie } = await setup()

    const res = await patch(cookie, targetId, { storageQuotaBytes: 2048 })

    expect(res.status).toBe(200)
    expect(res.body.storageQuotaBytes).toBe('2048')
  })

  it('超过安全整数范围的 number 拒绝，不静默丢精度', async () => {
    const { targetId, cookie } = await setup()

    // 2^53 之后 number 已经表示不了每一个整数，转成字符串会悄悄变成另一个值
    const res = await patch(cookie, targetId, { storageQuotaBytes: 2 ** 53 + 2 })

    expect(res.status).toBe(400)
  })
})

describe('PATCH /admin/users/{id} 的路径参数', () => {
  it('{id} 不是 uuid 时是 404，不是 500', async () => {
    const { cookie } = await setup()

    const res = await patch(cookie, 'abc', { role: 'member' })

    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('NOT_FOUND')
  })

  it('形状合法但不存在的用户也是 404 —— 两种对客户端是同一件事', async () => {
    const { cookie } = await setup()

    const res = await patch(cookie, '2f4a1c9e-6b3d-4a17-9f0c-8c2b5d7e1a44', { role: 'member' })

    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('NOT_FOUND')
  })

  it('非 admin 调它仍然是 401/403，形状校验不改变权限判定', async () => {
    const member = await createUser(db, { role: 'member' })
    const target = await createUser(db, { role: 'member' })
    const session = await createSession(member.id, db)

    const res = await patch(`sid=${session.id}`, target.id, { role: 'admin' })

    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe('FORBIDDEN')
  })
})
