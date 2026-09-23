/**
 * uuid 的形状判定。**纯函数、零 import**。
 *
 * 它挡的不是业务规则，是 Postgres 的转换错误：拿一个 `abc` 去查 uuid 列会撞
 * `invalid input syntax for type uuid`（22P02），而 `app.onError` 把非 AppError 一律
 * 当 INTERNAL —— 客户端把一个 uuid 敲错一个字符，拿到的是「服务器内部错误，请把下面的
 * 编号告诉管理员」。既不是他能修的，也没告诉我们发生了什么。
 *
 * **「形状对但库里没有」是 NOT_FOUND，那是业务结果，不是校验失败。** 所以这个函数只回答
 * 「形状对不对」，不查库、不判存在性——调用方按上下文决定把形状不合法报成哪个码
 * （路径参数报 NOT_FOUND，查询参数报 VALIDATION_FAILED）。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}
