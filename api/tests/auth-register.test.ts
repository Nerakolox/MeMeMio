import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 注册的三条硬约束（SPEC §3.1 / §3.2）：
 *
 *   ① 库里没有用户时，第一个注册的人**自动成为 admin**，且不需要邀请码（引导期）；
 *   ② 之后每个注册都必须消耗一个**未使用、未过期**的邀请码，一个码只能用一次；
 *   ③ 校验顺序是 **邀请码 → 查重名 → scrypt**，顺序本身就是安全属性。
 *
 * 三条都不是「逻辑写对了就行」的：①和②在并发下会各错各的，而错的样子都不报错。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createInviteCode, listUsers } = await import('../src/data/admin.js')
const { findUserByName } = await import('../src/data/auth.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { resetRateLimits } = await import('../src/middleware/rate-limit.js')
const { authRoutes } = await import('../src/routes/auth.js')

const { sql, db } = createTestDb()

const testApp = new Hono().use('*', requestId).route('/api/v1/auth', authRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
  // 注册口 5 次/分钟的限额是**进程内**的，用例之间不加清理会互相顶掉
  // （testing.md §2：每个用例自己清状态，不靠用例之间的执行顺序）
  resetRateLimits()
})

afterAll(async () => {
  await sql.end()
})

type RegisterBody = {
  id?: string
  role?: string
  error?: { code: string; message: string }
}

/**
 * 发一次注册。`ip` 用来把并发的两个请求分到不同的限流桶里
 * （取法见 lib/client-ip.ts：XFF 的**最后一项**才是真实客户端）。
 */
async function register(
  body: Record<string, unknown>,
  ip = '203.0.113.7',
): Promise<{ status: number; body: RegisterBody }> {
  const res = await testApp.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as RegisterBody }
}

/** 库里 admin 的个数。判断「只有一个 admin」要用它，不能用某次响应的 role。 */
async function adminCount(): Promise<number> {
  const users = await listUsers(db)
  return users.filter((u) => u.role === 'admin').length
}

/**
 * 引导第一个用户（admin）并返回它的 id。
 *
 * 后面的用例都要用它去签发邀请码，而 `invite_codes.created_by` 有外键——
 * 空字符串会直接撞 FK 约束，失败原因看起来和被测代码毫无关系。
 * 所以这里顺手断言注册真的成功了。
 */
async function bootstrap(): Promise<string> {
  const res = await register({ name: 'boss', password: 'password-1' })
  expect(res.status).toBe(201)
  const id = res.body.id
  if (id === undefined) throw new Error('注册没返回 id')
  return id
}

describe('POST /auth/register', () => {
  it('第一个用户自动是 admin，且不需要邀请码', async () => {
    const res = await register({ name: 'boss', password: 'password-1' })
    expect(res.status).toBe(201)
    expect(res.body.role).toBe('admin')
  })

  it('有用户之后，没有邀请码就是 400', async () => {
    await register({ name: 'boss', password: 'password-1' })
    const res = await register({ name: 'member', password: 'password-2' })
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('VALIDATION_FAILED')
    expect(await findUserByName('member', db)).toBeNull()
  })

  it('邀请码只能用一次', async () => {
    const boss = await bootstrap()
    const invite = await createInviteCode(boss, null, db)

    const ok = await register({ name: 'bob', password: 'password-2', inviteCode: invite.code })
    expect(ok.status).toBe(201)

    const reused = await register({
      name: 'carol',
      password: 'password-3',
      inviteCode: invite.code,
    })
    expect(reused.status).toBe(400)
    expect(reused.body.error?.code).toBe('VALIDATION_FAILED')
    expect(await findUserByName('carol', db)).toBeNull()
  })

  it('过期的邀请码不能用', async () => {
    const boss = await bootstrap()
    const invite = await createInviteCode(boss, new Date(Date.now() - 1000), db)

    const res = await register({ name: 'bob', password: 'password-2', inviteCode: invite.code })
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('VALIDATION_FAILED')
  })

  /*
   * ⚠️ **顺序即安全**：这条用例是「邀请码要在查重名之前」的唯一判据。
   *
   * 反过来的话，一个没持邀请码的人只要拿一个用户名去试，就能从
   * `409 该用户名已被使用` 和 `400 邀请码无效` 的差别里读出「这个用户名在不在」——
   * 邀请制的站本来没有比这更省事的用户名枚举器。
   */
  it('没带邀请码时，即使重名也报邀请码的错，不泄漏用户名是否存在', async () => {
    const boss = await bootstrap()
    const invite = await createInviteCode(boss, null, db)

    // 先造一个已存在的用户名
    await register({ name: 'taken', password: 'password-2', inviteCode: invite.code })

    const noInvite = await register({ name: 'taken', password: 'password-3' })
    expect(noInvite.status).toBe(400)
    expect(noInvite.body.error?.code).toBe('VALIDATION_FAILED')
    // 报的是邀请码，不是「重名」——这一句是整条用例的重点
    expect(noInvite.body.error?.message).toContain('邀请码')

    const badInvite = await register({
      name: 'taken',
      password: 'password-4',
      inviteCode: 'not-a-real-code',
    })
    expect(badInvite.status).toBe(400)
    expect(badInvite.body.error?.message).toContain('邀请码')
  })

  it('持有效邀请码但重名是 409 CONFLICT', async () => {
    const boss = await bootstrap()
    const invite = await createInviteCode(boss, null, db)
    await register({ name: 'taken', password: 'password-2', inviteCode: invite.code })

    const second = await createInviteCode(boss, null, db)
    const res = await register({ name: 'taken', password: 'password-3', inviteCode: second.code })
    expect(res.status).toBe(409)
    expect(res.body.error?.code).toBe('CONFLICT')
  })

  /*
   * 并发下的「第一个用户」判定。
   *
   * 没有 `pg_advisory_xact_lock` 的话，两个请求会**都**数到 0 个用户、
   * **都**建成 admin——而这不是理论上的：两句话（数一下 → 按结果定角色）之间
   * 天然有一个窗口，本地跑两次并发就能撞上。
   *
   * ⚠️ **落败的那个请求是 400，不是「第二个 member」，这个结果是正确的。**
   *    它轮到锁的时候库里已经有一个人了，于是它不再享受引导期的豁免、
   *    必须出示邀请码（SPEC §3.1）；而此刻邀请码还不存在——admin 刚建出来，
   *    还没来得及签发。它能得到的唯一诚实回应就是「你没有邀请码」。
   *    让它静默变成 member 反而是错的：那等于绕过 §3.1 的邀请制。
   *
   *    所以这里断言的不是「两个都成功」，而是**全库只有一个 admin**，
   *    且只有一个请求真的建出了用户（另一个整个事务回滚了）。
   */
  it('两个并发注册同时抢第一个用户，只有一个成为 admin', async () => {
    const [a, b] = await Promise.all([
      register({ name: 'one', password: 'password-1' }, '203.0.113.7'),
      register({ name: 'two', password: 'password-2' }, '203.0.113.8'),
    ])

    const results = [
      { status: a.status, role: a.body.role },
      { status: b.status, role: b.body.role },
    ]

    // 恰好一个 201，且它就是 admin —— 两个 201 说明锁没起作用
    const created = results.filter((r) => r.status === 201)
    expect(created).toHaveLength(1)
    expect(created[0]?.role).toBe('admin')

    // 另一个是被拒的，不是「悄悄成了 member」
    const rejected = results.find((r) => r.status !== 201)
    expect(rejected?.status).toBe(400)

    // 响应里的角色是事务里定下的那一刻的值；再回库里数一遍，防止它是「写完之后又改的」。
    // 被拒那个必须一条记录都不留 —— 半个人比没有更坏（它没有密码之外的任何东西）
    expect(await adminCount()).toBe(1)
    expect(await listUsers(db)).toHaveLength(1)
  })

  /*
   * 并发下的邀请码消耗。
   *
   * 「先 select 看能不能用，再 update」的写法在这里会放两个人进来：
   * 两个请求都读到 `used_by is null`、都认为可以用。判定必须在
   * `UPDATE ... RETURNING` 一条语句里（data/auth.ts 的 consumeInviteCode）。
   */
  it('两个并发注册用同一个邀请码，只有一个成功', async () => {
    const boss = await bootstrap()
    const invite = await createInviteCode(boss, null, db)

    const [a, b] = await Promise.all([
      register({ name: 'bob', password: 'password-2', inviteCode: invite.code }, '203.0.113.7'),
      register({ name: 'carol', password: 'password-3', inviteCode: invite.code }, '203.0.113.8'),
    ])

    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([201, 400])
    // 被拒的那个不能留下半个人：整个事务回滚，库里只有 admin + 成功的那一个
    expect(await listUsers(db)).toHaveLength(2)
  })
})
