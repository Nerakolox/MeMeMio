/**
 * 业务错误。
 *
 * 纯函数、零 import。错误结构与错误码见 SPEC §2，
 * 响应信封由 middleware/error.ts 统一产出 —— handler 里不手写错误响应体。
 */

export type ErrorCode =
  // §2.2 通用
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  // §2.3 导入与去重
  | 'DUPLICATE_EXACT'
  | 'UNSUPPORTED_FORMAT'
  | 'FILE_TOO_LARGE'
  // §2.4 AI 调用失败
  | 'AI_NOT_CONFIGURED'
  | 'AI_REFUSED'
  | 'AI_INVALID_OUTPUT'
  | 'AI_UNREACHABLE'
  | 'AI_UNSUPPORTED'
  // §2.5 配置与测试连接
  | 'CONFIG_TEST_REQUIRED'
  | 'EMBED_DIM_TOO_SMALL'
  | 'EMBED_MODEL_CHANGED'

/** SPEC §2.2 / §2.3 / §2.5 的状态码映射。没列的一律 500。 */
const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA_EXCEEDED: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,

  DUPLICATE_EXACT: 409,
  UNSUPPORTED_FORMAT: 415,
  FILE_TOO_LARGE: 413,

  AI_NOT_CONFIGURED: 500,
  AI_REFUSED: 500,
  AI_INVALID_OUTPUT: 500,
  AI_UNREACHABLE: 503,
  AI_UNSUPPORTED: 400,

  CONFIG_TEST_REQUIRED: 400,
  EMBED_DIM_TOO_SMALL: 400,
  EMBED_MODEL_CHANGED: 409,
}

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code] ?? 500
}

export class AppError extends Error {
  readonly code: ErrorCode
  /** 结构随 code 而定，客户端按 code 分支，不解析 message。见 SPEC §2.1。 */
  readonly details: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }

  get status(): number {
    return httpStatusFor(this.code)
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}
