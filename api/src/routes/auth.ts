import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { sql } from 'drizzle-orm'
import { AppError } from '../lib/app-error.js'
import {
  findUserByName,
  findUserById,
  createUser,
  hashPassword,
  verifyPassword,
  countUsers,
  consumeInviteCode,
  findUsableInviteCode,
  createSession,
  findValidSession,
  deleteSession,
  getStorageUsedBytes,
} from '../data/auth.js'
import { SESSION_COOKIE } from '../middleware/auth.js'
import { rateLimit, type RateLimitRule } from '../middleware/rate-limit.js'
import type { RequestIdVariables } from '../middleware/request-id.js'
import { isProduction } from '../env.js'
import { db } from '../data/db.js'

/**
 * 认证路由**不挂 requireAuth / optionalAuth**，所以这里的 Vars 只有 RequestIdVariables。
 *
 * 四个端点全都要在「会话无效」时自己决定怎么办：register / login 根本还没有会话，
 * logout 对无效 session 也要返回 204。中间件解析会话是为了后面的 handler 用 currentUser，
 * 这条路由上没有那个需求。
 */
type Vars = RequestIdVariables

// ── 限流阈值 ───────────────────────────────────────────────────────
//
// 登录和注册是唯一两条「未登录就能打」的写路径，正好也是三个放大面的入口：
// 密码暴力破解、用户名枚举（`409` 和 `400` 的差别就是答案）、以及每次都要烧掉几百毫秒
// CPU 的 scrypt。邀请制的站，正常人一分钟不会登录十次。
//
// **按客户端 IP 分桶**，取法见 `middleware/rate-limit.ts`（反代后面那个坑在那里）。
const LOGIN_RATE_LIMIT: RateLimitRule = { name: 'auth:login', limit: 10, windowMs: 60_000 }
const REGISTER_RATE_LIMIT: RateLimitRule = { name: 'auth:register', limit: 5, windowMs: 60_000 }

/**
 * 首个用户判定的锁（SPEC §3.2「第一个注册的用户自动成为 admin」）。
 *
 * 那是「数一下有几个用户 → 按结果决定角色」两句话，没有锁的话两个并发请求会**都**数到
 * 0、**都**建成 admin。事务级 advisory lock 把这一段串起来，后来者拿到锁时读到的是
 * 已提交的计数；提交或回滚即自动释放，不需要手写 finally。
 *
 * 常数只要全库一致即可（换个值等于换一把锁），没有别的含义。
 */
const FIRST_USER_LOCK_KEY = 76_453_102

/** ISO 8601 UTC，精确到秒，带 Z。SPEC §1.2 */
function toIsoSeconds(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`
}

function serializeUser(user: {
  id: string
  role: string
  storageQuotaBytes: bigint
  createdAt: Date
  storageUsedBytes: bigint
}) {
  return {
    id: user.id,
    role: user.role,
    storageQuotaBytes: user.storageQuotaBytes.toString(),
    storageUsedBytes: user.storageUsedBytes.toString(),
    createdAt: toIsoSeconds(user.createdAt),
  }
}

function writeCookie(c: { header: (name: string, value: string) => void }, sessionId: string) {
  setCookie(c as never, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction,
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  })
}

export const authRoutes = new Hono<{ Variables: Vars }>()

  .post('/register', rateLimit(REGISTER_RATE_LIMIT), async (c) => {
    const body = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON')
    })

    const { inviteCode, name, password } = body as Record<string, unknown>

    if (typeof name !== 'string' || name.trim() === '') {
      throw new AppError('VALIDATION_FAILED', 'name 不能为空')
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new AppError('VALIDATION_FAILED', '密码至少 8 位')
    }

    const trimmedName = name.trim()

    /*
     * ⚠️ **顺序是这一段的一半：邀请码 → 查重名 → scrypt。**
     *
     * 反过来的代价分别是：先查重名，未持邀请码的人就有了一个用户名枚举器
     * （`409` 与 `400` 的差别直接回答了「这个用户名在不在」）；先算 scrypt，
     * 一个注定被拒的请求也能让服务端烧掉几百毫秒 CPU，注册口就成了放大面。
     *
     * 这里是一次**只读预检**，不承担判定责任——真正的判定是事务里
     * `consumeInviteCode` 那条单语句 UPDATE（并发下先 select 再 update 会把同一个码用两次）。
     * 它在这里的作用只是「别为一个已经注定失败的请求做后面那些事」。
     *
     * 引导期（库里一个用户都没有）没有邀请码可发，跳过。计数在事务里带锁重做一次，
     * 以那一次为准。
     */
    const needsInvite = (await countUsers()) > 0
    if (needsInvite) {
      if (typeof inviteCode !== 'string' || inviteCode.trim() === '') {
        throw new AppError('VALIDATION_FAILED', '邀请码不能为空')
      }
      if ((await findUsableInviteCode(inviteCode.trim())) === null) {
        throw new AppError('VALIDATION_FAILED', '邀请码无效或已被使用')
      }
    }

    const existing = await findUserByName(trimmedName)
    if (existing) throw new AppError('CONFLICT', '该用户名已被使用')

    const passwordHash = await hashPassword(password)

    // 事务：抢锁 → 判定首个用户 → 创建用户 → 消耗邀请码 → 建会话
    const { user, session } = await db.transaction(async (tx) => {
      // 锁必须在 countUsers 之前：它管的就是「数出来是 0」这件事（见 FIRST_USER_LOCK_KEY）
      await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_USER_LOCK_KEY}::bigint)`)

      const total = await countUsers(tx as never)
      // 第一个注册的用户自动成 admin，且不需要邀请码（引导：admin 还不存在时无处获取邀请码）。SPEC §3.2
      const isFirst = total === 0
      const role = isFirst ? 'admin' : 'member'

      const user = await createUser({ name: trimmedName, passwordHash, role }, tx as never)

      if (!isFirst) {
        // 非第一个用户必须提供有效邀请码；先建用户再消耗，used_by 才能填真实 id。
        // 预检到这里可能已经过期（这个码被并发的另一个请求用掉了），所以异常照抛——
        // 整个事务回滚，不会留下一个没有邀请码的用户
        if (typeof inviteCode !== 'string' || inviteCode.trim() === '') {
          throw new AppError('VALIDATION_FAILED', '邀请码不能为空')
        }
        await consumeInviteCode(inviteCode.trim(), user.id, tx as never)
      }

      const session = await createSession(user.id, tx as never)
      return { user, session }
    })

    writeCookie(c, session.id)

    const storageUsedBytes = await getStorageUsedBytes(user.id)
    return c.json(serializeUser({ ...user, storageUsedBytes }), 201)
  })

  .post('/login', rateLimit(LOGIN_RATE_LIMIT), async (c) => {
    const body = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON')
    })

    const { name, password } = body as Record<string, unknown>

    if (typeof name !== 'string' || name.trim() === '') {
      throw new AppError('VALIDATION_FAILED', 'name 不能为空')
    }
    if (typeof password !== 'string' || password === '') {
      throw new AppError('VALIDATION_FAILED', '密码不能为空')
    }

    const user = await findUserByName(name.trim())
    // 用户不存在和密码错误返回同一条消息，避免枚举用户名
    const valid = user ? await verifyPassword(password, user.passwordHash) : false
    if (!user || !valid) {
      throw new AppError('UNAUTHENTICATED', '用户名或密码不正确')
    }

    const session = await createSession(user.id)
    writeCookie(c, session.id)

    const storageUsedBytes = await getStorageUsedBytes(user.id)
    return c.json(serializeUser({ ...user, storageUsedBytes }))
  })

  .post('/logout', async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE)
    if (sessionId) await deleteSession(sessionId)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })

  .get('/me', async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE)
    if (!sessionId) throw new AppError('UNAUTHENTICATED', '请先登录')

    const session = await findValidSession(sessionId)
    if (!session) throw new AppError('UNAUTHENTICATED', '会话已过期，请重新登录')

    const user = await findUserById(session.userId)
    if (!user) throw new AppError('UNAUTHENTICATED', '用户不存在')

    const storageUsedBytes = await getStorageUsedBytes(user.id)
    return c.json(serializeUser({ ...user, storageUsedBytes }))
  })
