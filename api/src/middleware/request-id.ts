import type { MiddlewareHandler } from 'hono'

/**
 * requestId：每个请求生成一次，同时出现在响应和该请求的所有日志里。排障以它为准。
 * 见 SPEC §2.1、agents/rules/error-handling.md §1。
 */

export type RequestIdVariables = { requestId: string }

export const requestId: MiddlewareHandler<{ Variables: RequestIdVariables }> = async (c, next) => {
  const id = crypto.randomUUID()
  c.set('requestId', id)
  c.header('X-Request-Id', id)
  await next()
}
