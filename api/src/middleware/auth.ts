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

export type OptionalAuthVariables = RequestIdVariables & {
  currentUser: AuthUser | null
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

/** 要求已登录，未登录抛 UNAUTHENTICATED。 */
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

/** 不强制登录，会话有效时注入 currentUser，否则为 null。 */
export const optionalAuth: MiddlewareHandler<{ Variables: OptionalAuthVariables }> = async (
  c,
  next,
) => {
  const user = await resolveUser(c)
  c.set('currentUser', user)
  await next()
}
