import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { rateLimited } from '../lib/app-error.js'
import { pickClientIp } from '../lib/client-ip.js'
import { log } from '../logger.js'

/**
 * 进程内滑动窗口限流。**机制在这里，阈值在用的地方**（routes/auth.ts）。
 *
 * ## 分桶的键是客户端 IP
 *
 * 不是账号（登录时还不知道是谁），也不是 socket 地址（反代后面所有请求的 socket 都是
 * 反代，等于全站一个桶）。取法见 `lib/client-ip.ts`，那里有完整的推导。
 *
 * ## 计数只在进程内存里
 *
 * 它和 `runtime_config` 那四个并发上限是同一类东西：**生效范围是「每个服务进程」，
 * 不是全站**（SPEC §5.6）。多副本部署时每个副本各限各的，实际阈值 = limit × 副本数。
 * 要精确到全站得引入共享存储，那与本项目「不引入 Redis」（SPEC §9.11）冲突——
 * 限流的目标是挡住脚本和暴力破解，不是给用户记账，进程内够用。
 *
 * ## 窗口是滑动的
 *
 * 固定窗口在窗口边界上会放过约两倍的请求（59 秒打满一轮、60 秒再打满一轮）。
 * 记时间戳列表没有这个问题，代价是每个桶存 limit 个数——阈值是几十，不是几万。
 */

export type RateLimitRule = {
  /**
   * 桶的名字。**同一 IP 在不同规则下各算各的**：登录被限了不该连带把注册也锁上，
   * 反过来更是（注册口被刷时，已登录用户的登录不该受影响）。
   */
  name: string
  /** 窗口内允许的次数。 */
  limit: number
  windowMs: number
}

type Decision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/** 键是 `${rule.name}:${clientIp}`，值是命中时间戳（毫秒，升序）。 */
const hits = new Map<string, number[]>()

/**
 * 桶数上限。正常部署下桶数 ≈ 窗口内的活跃 IP 数，到不了这个量级；
 * 到顶说明有人在轮换 IP 刷，那也不能让它把内存顶爆。
 */
const MAX_BUCKETS = 10_000

export function rateLimit(rule: RateLimitRule): MiddlewareHandler {
  return async (c, next) => {
    const clientIp = resolveClientIp(c)
    const decision = take(`${rule.name}:${clientIp}`, rule, Date.now())

    if (!decision.allowed) {
      // ⚠️ 这一行是 **IP 唯一会出现在日志里的地方**。错误中间件那条 warn 只有
      //    requestId 和路径，查「谁在被限流」时看不到键，所以这里补一条。
      log.warn(
        { requestId: c.get('requestId'), rule: rule.name, clientIp, path: c.req.path },
        'rate limited',
      )
      throw rateLimited(decision.retryAfterSeconds)
    }

    await next()
  }
}

/**
 * 取客户端 IP。
 *
 * `getConnInfo` 在**没有 node-server 的 incoming 时抛异常**——测试里的 `app.request()`
 * 就是这种（它把请求直接交给 app，不经过 socket）。那不是错误，是「这个运行环境没有
 * 这一层信息」，所以兜成 null 由 `pickClientIp` 决定用 XFF 还是 `unknown`。
 */
function resolveClientIp(c: Context): string {
  let socket: string | null = null
  try {
    socket = getConnInfo(c).remote.address ?? null
  } catch {
    socket = null
  }
  return pickClientIp(c.req.header('x-forwarded-for') ?? null, socket)
}

function take(key: string, rule: RateLimitRule, now: number): Decision {
  const cutoff = now - rule.windowMs
  const recent = (hits.get(key) ?? []).filter((at) => at > cutoff)

  if (recent.length >= rule.limit) {
    // 裁剪后的数组要写回：不写回的话下一次命中会从一个空窗口重新数起，
    // 表现是「第一次限流生效、之后再来一次就放行」
    hits.set(key, recent)
    const oldest = recent[0] ?? now
    return {
      allowed: false,
      // 最早那次滑出窗口时才能再试，这就是退避秒数的来历。向上取整，
      // 免得返回 0 让客户端立刻重试又被拒
      retryAfterSeconds: Math.ceil((oldest + rule.windowMs - now) / 1000),
    }
  }

  recent.push(now)
  hits.set(key, recent)
  if (hits.size > MAX_BUCKETS) sweep(cutoff)
  return { allowed: true }
}

/** 清掉整个窗口都已滑出的桶。只在桶数超限时跑，正常路径不遍历 Map。 */
function sweep(cutoff: number): void {
  for (const [key, times] of hits) {
    if (times.every((at) => at <= cutoff)) hits.delete(key)
  }
  // 全都在窗口内（真被大量 IP 同时刷）时，只能整体丢掉。
  // 宁可短暂放宽，也不要让一个 Map 无限涨到把进程打挂
  if (hits.size > MAX_BUCKETS) hits.clear()
}

/** 仅供测试：每个用例自己清计数，不靠用例之间的执行顺序（agents/rules/testing.md §2）。 */
export function resetRateLimits(): void {
  hits.clear()
}
