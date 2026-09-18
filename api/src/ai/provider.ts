import type { ProviderDefaults } from '../lib/env.js'

/**
 * AI 供应商调用的公共部分。
 *
 * **只有两个供应商接口**（agents/rules/ai-providers.md §1）：视觉与 Embedding。这里放的是
 * 两者共用的东西——超时、配置解析顺序、凭据来源。
 *
 * ⚠️ **禁止任何供应商特有的分支**，尤其禁止按 baseUrl 猜能力：
 *
 *     ✗ if (baseUrl.includes('dashscope')) { ... }
 *     ✓ if (config.dimParamWorks) { ... }
 *
 * baseUrl 是用户填的一个字符串，中转服务的域名和它背后是什么模型毫无关系（SPEC §9.7）。
 */

/** 单次外部调用的超时。没有超时的 fetch 会在中转服务卡住时挂死队列 worker。 */
export const AI_TIMEOUT_MS = 15_000

/**
 * HyDE 改写的超时。**比通用超时短得多是有意的**：改写是锦上添花，
 * 不值得让搜索等它（agents/rules/retrieval.md §3）。
 */
export const HYDE_TIMEOUT_MS = 2_000

export type ProviderCredentials = {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 拼一个 OpenAI 兼容的端点地址。
 *
 * 用户填的 baseUrl 末尾带不带 `/` 都可能，两种都当同一个意思——
 * 让用户因为一个斜杠去猜自己的配置哪里错了不值得。
 */
export function joinEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * 把环境变量里的一组默认值当作可用的供应商配置。
 *
 * 三个字段齐全才算「配了」。半套配置去调 AI 只会得到一个难懂的 401，
 * 不如当成未配置走兜底。
 */
export function asCredentials(defaults: ProviderDefaults | null): ProviderCredentials | null {
  if (defaults === null) return null
  const { baseUrl, apiKey, model } = defaults
  if (baseUrl === '' || apiKey === '' || model === '') return null
  return { baseUrl, apiKey, model }
}

/** 这套凭据是用户（或管理员）自己配的，还是部署方的默认值。SPEC §6.5.3 的 `source`。 */
export type CredentialSource = 'user' | 'default'

export type ResolvedCredentials = {
  credentials: ProviderCredentials
  source: CredentialSource
}

/**
 * **「DB 里的记录排在环境变量前面」的唯一落点。**
 *
 * 三个解析落点（`resolveVisionConfig` / `resolveEmbedConfig` / HyDE 经前者）全都走这里，
 * 各自不许再写一遍 `if (stored) ... else ...`。多一处就多一个会忘记查 `verified_at`
 * 的地方——而忘了查的表现不是报错，是「测失败的配置被拿去打标」。
 *
 * ⚠️ `stored` 必须已经过滤过 `verified_at`：**测过但没通过的行不能进生产打标**
 *    （任务 E 项）。过滤在 `data/ai-configs.ts` 的 `loadUserVisionCredentials` /
 *    `loadEmbedCredentials` 里做，那是唯一能看见那一列的地方。
 *
 * 两处都没有就是没配置，调用方按降级处理而不是报错（SPEC §2.4）。
 */
export function resolveCredentials(
  stored: ProviderCredentials | null,
  defaults: ProviderDefaults | null,
): ResolvedCredentials | null {
  if (stored !== null) return { credentials: stored, source: 'user' }
  const fallback = asCredentials(defaults)
  return fallback === null ? null : { credentials: fallback, source: 'default' }
}

/**
 * 带超时的 fetch。
 *
 * 超时、网络错误、5xx 都归到 AI_UNREACHABLE 那一类（SPEC §2.4），
 * 由调用方决定是回队列重跑还是降级，这里只负责别让请求无限挂着。
 *
 * `init.signal` 会**和本函数的超时叠加**，不是被它覆盖：队列里每个任务有整体超时
 * （queue.md §5），任务超时时要能把正在跑的这次调用也一起掐掉。写成覆盖的话，
 * 任务超时了但 fetch 还在跑，表现是「任务已经算失败了，AI 的钱照花」。
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = AI_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const outer = init.signal
  const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal
  try {
    return await fetch(url, { ...init, signal })
  } finally {
    clearTimeout(timer)
  }
}
