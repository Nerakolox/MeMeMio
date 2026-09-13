import type { ErrorHandler, NotFoundHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { isAppError } from '../lib/app-error.js'
import { log } from '../logger.js'
import type { RequestIdVariables } from './request-id.js'

/**
 * 错误的**统一出口**。handler 里不手写错误响应体 —— 手写的那几个迟早会漏字段。
 * 信封结构见 SPEC §2.1，实现约束见 agents/rules/error-handling.md §1。
 */

type Env = { Variables: RequestIdVariables }

function envelope(
  code: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
) {
  return { error: { code, message, requestId, ...(details ? { details } : {}) } }
}

export const onError: ErrorHandler<Env> = (err, c) => {
  const requestId = c.get('requestId')

  if (isAppError(err)) {
    log.warn({ requestId, code: err.code, path: c.req.path }, err.message)
    return c.json(
      envelope(err.code, err.message, requestId, err.details),
      err.status as ContentfulStatusCode,
    )
  }

  // ⚠️ 未捕获异常的原始 message **只进日志，不进响应**。
  //    数据库错误、第三方 SDK 的报错里可能带连接串、带 key。
  log.error({ requestId, err, path: c.req.path }, 'unhandled error')
  return c.json(
    envelope('INTERNAL', '服务器内部错误，请把下面的编号告诉管理员', requestId),
    500,
  )
}

/** 软删记录返回 NOT_FOUND 而不是 410：对客户端而言它就是不存在。SPEC §2.2 */
export const onNotFound: NotFoundHandler<Env> = (c) => {
  return c.json(envelope('NOT_FOUND', '没有这个接口', c.get('requestId')), 404)
}
