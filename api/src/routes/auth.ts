import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { AppError } from '../lib/app-error.js'
import {
  findUserByName,
  findUserById,
  createUser,
  hashPassword,
  verifyPassword,
  countUsers,
  consumeInviteCode,
  createSession,
  findValidSession,
  deleteSession,
  getStorageUsedBytes,
} from '../data/auth.js'
import { SESSION_COOKIE } from '../middleware/auth.js'
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

  .post('/register', async (c) => {
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

    const existing = await findUserByName(trimmedName)
    if (existing) throw new AppError('CONFLICT', '该用户名已被使用')

    const passwordHash = await hashPassword(password)

    // 事务：创建用户 → 消耗邀请码（第一个用户跳过）→ 建会话
    const { user, session } = await db.transaction(async (tx) => {
      const total = await countUsers(tx as never)
      // 第一个注册的用户自动成 admin，且不需要邀请码（引导：admin 还不存在时无处获取邀请码）。SPEC §3.2
      const isFirst = total === 0
      const role = isFirst ? 'admin' : 'member'

      const user = await createUser({ name: trimmedName, passwordHash, role }, tx as never)

      if (!isFirst) {
        // 非第一个用户必须提供有效邀请码；先建用户再消耗，used_by 才能填真实 id
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

  .post('/login', async (c) => {
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
