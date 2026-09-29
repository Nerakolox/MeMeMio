import type { Env, MiddlewareHandler } from 'hono'
import { AppError } from '../lib/app-error.js'

/**
 * 带类型的 JSON 请求体校验：解析一次、形状定死、RPC 推得出请求体类型。
 *
 * ## 为什么不用 `hono/validator`（hono 4.13.7 实测）
 *
 * 本仓一开始没有校验器，`PATCH /memes/{id}` 因此是**手接 JSON 的**，代价写在
 * `web/src/lib/api.ts` 的注释里：`InferRequestType` 对它只能给出 `unknown`，
 * web 只能手写一份请求体类型——而那两份定义迟早会漂。
 *
 * 直觉是换 `hono/validator`。它**能用，但两种写法各坏一处**：
 *
 * 1. **不给类型实参**（`validator('json', parse)`）：编译通过，`c.req.valid('json')`
 *    也有类型，但 RPC 推给客户端的 `json` 参数是**校验函数的返回类型**，也就是解析
 *    *之后* 的形状。`in` 与 `out` 一致的接口看不出问题；`assignments` 那种
 *    「三种键组合进来、一种内部表示出去」就会让 web 被告知「请发 `target` 字段」——
 *    服务端一定拒它。这比 `unknown` 更坏：`unknown` 会逼人去读 SPEC，而这个是
 *    **一个自信的错答案**。
 * 2. **给类型实参**（`validator<Wire, string, 'post'>('json', parse)`）：直接
 *    `TS2558 Expected 4-8 type arguments, but got 3`——这个版本的 `validator` 有 8 个
 *    类型形参且前几个没有默认值，要得到 `Wire` 就必须把 `U`（目标）也写死。写了之后
 *    `U` 不再被推断，`c.req.valid('json')` 报错，`hc` 那边整条路由退化成 `unknown`。
 *
 * 所以这里手写一个等价物，只做两件事：**跑解析**、**把类型同时声明给两端**。
 * `in` 是客户端能发的（RPC 用它生成 `json` 参数），`out` 是 handler 拿到的
 * （`c.req.valid('json')`）。形状与 `hono/validator` 的 `V` 一样，将来官方实现能表达
 * 「`in` ≠ `out`」时，各调用点只需删掉类型实参。
 *
 * ## `In` 必须显式写出来
 *
 * ⚠️ **`In` 没有推断点，只能由调用方给定。** 解析函数的入参是 `unknown`（原始 JSON
 *    就是 `unknown`），所以 `In` 不可能从它推出来。写成 `jsonBody<T, Out = T>` 而
 *    调用处一个类型实参都不给时，`T` 取约束的默认值 —— 类型检查**照样通过**，
 *    `hc` 那边的 `json` 参数却是 `unknown`。这正是本文件想消灭的那个失败模式，
 *    所以它写在调用处、显式可见。
 *
 *    大多数接口线上形状与解析结果一致，写一个就够（`Out` 用默认值 = `In`，并且
 *    解析函数的返回类型会被这个默认值反过来检查）；`assignments` 那种「三种形状进来、
 *    一种内部表示出去」的写两个。见 `routes/persons.ts` 的调用点。
 *
 * ## 与 `c.req.json().catch(...)` 的关系
 *
 * 行为**逐字保留**：不看 `Content-Type`，直接解析；解析不了报
 * `VALIDATION_FAILED`「请求体不是合法 JSON」，与 `routes/memes.ts` 那两处一致。
 * 这一点不能省——按 `Content-Type` 分流的话，客户端漏发那个头时会得到一个被当成
 * 「空请求体」的请求：改名失败但返回 200，界面上看不出任何异常。
 *
 * @param parse 收原始值、回处理好的形状。**它抛的 `AppError` 直接成为响应**，
 *              所以字段规则写在里面，不要在这一层再判一次。
 */
export function jsonBody<In extends object, Out extends object = In>(
  parse: (raw: unknown) => Out,
): MiddlewareHandler<Env, string, { in: { json: In }; out: { json: Out } }> {
  const middleware: MiddlewareHandler<Env, string, { in: { json: In }; out: { json: Out } }> = async (
    c,
    next,
  ) => {
    const raw: unknown = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON')
    })

    c.req.addValidatedData('json', parse(raw))
    await next()
  }

  return middleware
}

/**
 * 请求体必须是一个 JSON 对象。**每个 parser 的第一句。**
 *
 * 数组与 `null` 都要挡：`typeof null === 'object'`，而 `Object.keys(null)` 抛
 * `TypeError`——那不是 `AppError`，`app.onError` 会把它当 `INTERNAL`，客户端拿到 500。
 * 一个写错的请求体不该看起来像服务器崩了。
 */
export function asJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象')
  }
  return raw as Record<string, unknown>
}
