import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { AppError } from '../lib/app-error.js'
import { findValidSession, findUserById } from '../data/auth.js'
import type { RequestIdVariables } from './request-id.js'

export const SESSION_COOKIE = 'sid'

export type AuthUser = {
  id: string
  name: string
  role: string
  storageQuotaBytes: bigint
  createdAt: Date
}

export type AuthVariables = RequestIdVariables & {
  currentUser: AuthUser
}

async function resolveUser(c: { req: { raw: Request } }): Promise<AuthUser | null> {
  const sessionId = getCookie(c as never, SESSION_COOKIE)
  if (!sessionId) return null

  const session = await findValidSession(sessionId)
  if (!session) return null

  const user = await findUserById(session.userId)
  if (!user) return null

  return {
    id: user.id,
    name: user.name,
    role: user.role,
    storageQuotaBytes: user.storageQuotaBytes,
    createdAt: user.createdAt,
  }
}

/**
 * 要求已登录，未登录抛 UNAUTHENTICATED。
 *
 * ⚠️ **这个文件里没有 `optionalAuth`，是刻意删掉的。** 读路径（浏览、搜索）曾经挂它，
 *    效果是「未登录也能用」——而 SPEC §3.3 给的是「所有登录用户」，没给过匿名。
 *    真有端点需要「登录与否都行」时，那是 SPEC 要先改的事，不是把这一份加回来：
 *    加回来的那一天，调用方会顺手写一个 `currentUser ?? 匿名` 的分支，
 *    而那个分支就是全库内容对公网敞开的地方。
 */
export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const user = await resolveUser(c)
  if (!user) throw new AppError('UNAUTHENTICATED', '请先登录')
  c.set('currentUser', user)
  await next()
}

/** 要求已登录且 role === 'admin'，否则抛 FORBIDDEN。 */
export const requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const user = await resolveUser(c)
  if (!user) throw new AppError('UNAUTHENTICATED', '请先登录')
  if (user.role !== 'admin') throw new AppError('FORBIDDEN', '仅管理员可操作')
  c.set('currentUser', user)
  await next()
}

