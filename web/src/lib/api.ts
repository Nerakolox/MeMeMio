import { hc, type InferResponseType } from 'hono/client'
import type { AppType } from '@api/app'

/**
 * **唯一发请求的地方。** 组件里不出现 fetch。
 *
 * 类型从 api 直接 import，没有生成步骤、不手写接口类型（SPEC §0.2）。
 * 但**类型只保证形状，SPEC 保证含义** —— 软删语义、degraded、tagStatus 的取值
 * 都不在类型里，类型检查通过不等于契约遵守。
 *
 * 同域：cookie 自动带，不手动加 Authorization header。本地靠 Vite proxy。
 */
export const api = hc<AppType>('/')

/** SPEC §2.1 的错误信封。客户端按 code 分支，**不解析 message 文本**。 */
export type ApiErrorBody = {
  error: {
    code: string
    message: string
    requestId: string
    details?: Record<string, unknown>
  }
}

export class ApiError extends Error {
  readonly code: string
  /** 必须展示给用户 —— 报问题时它是唯一能对上服务端日志的东西。 */
  readonly requestId: string
  readonly status: number
  readonly details: Record<string, unknown> | undefined

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.requestId = body.requestId
    this.details = body.details
  }
}

/** 服务端可能新增错误码（那是兼容变更），所以解析不出信封时也要给出能用的错误，不能白屏。 */
export async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as ApiErrorBody
    if (body?.error?.code) return new ApiError(res.status, body.error)
  } catch {
    // 落到下面的兜底
  }
  return new ApiError(res.status, {
    code: 'INTERNAL',
    message: `请求失败（HTTP ${res.status}）`,
    requestId: res.headers.get('X-Request-Id') ?? '未知',
  })
}

/**
 * SPEC §5.2.6 对外表示。storageKey、contentHash、phash、embedding 不在响应里。
 *
 * **从 api 派生，不手写。** 手写一份意味着接口加了字段这边不会有编译错误，
 * 而「改字段名 web 编译失败」正是类型同步的全部价值（code-style.md）。
 *
 * 注意一个反直觉的字段，手写很容易写错：
 *   - `sizeBytes` 是**字符串**（bigint 走 JSON 会丢精度，服务端 toString 了）
 */
export type Meme = InferResponseType<typeof api.api.v1.memes.$get>['items'][number]

export type FetchMemesParams = {
  emotions?: string[]
  scenes?: string[]
  tags?: string[]
  isAnimated?: boolean
  favorited?: boolean
  uploader?: string
  tagStatus?: string
  cursor?: string
  limit?: number
}

export async function fetchMemes(
  params: FetchMemesParams = {},
): Promise<{ items: Meme[]; nextCursor: string | null }> {
  const qs = new URLSearchParams()
  params.emotions?.forEach((v) => qs.append('emotions', v))
  params.scenes?.forEach((v) => qs.append('scenes', v))
  params.tags?.forEach((v) => qs.append('tags', v))
  if (params.isAnimated !== undefined) qs.set('isAnimated', String(params.isAnimated))
  if (params.favorited) qs.set('favorited', 'true')
  if (params.uploader) qs.set('uploader', params.uploader)
  if (params.tagStatus) qs.set('tagStatus', params.tagStatus)
  if (params.cursor) qs.set('cursor', params.cursor)
  if (params.limit !== undefined) qs.set('limit', String(params.limit))

  const res = await fetch(`/api/v1/memes?${qs.toString()}`)
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<{ items: Meme[]; nextCursor: string | null }>
}

/**
 * `GET /memes/tag-status` 的汇总（SPEC §6.6.1）。**从 api 派生，不手写。**
 *
 * 两处含义不在类型里，读的时候要记得（web/AGENTS.md §4）：
 *   - `counts` 只统计未软删的记录，口径与 `fetchMemes({ uploader:'me', tagStatus })` 一致；
 *   - `failures` 里会有 `tag_status = ok` 的图（`embed_failed`），
 *     所以 `sum(failures)` 与 `counts.needsManual` **不相等是对的**。
 */
// 路径段带连字符，只能走下标访问；而 `typeof x['a'].b` 这种混写不合法，
// 所以先把客户端类型取出来再下两层——两行是为了过语法，不是为了绕类型检查。
type MemesClient = typeof api.api.v1.memes
export type TagStatusSummary = InferResponseType<MemesClient['tag-status']['$get']>

/** 本人的打标汇总。`scope=all` 是管理员那一段的事，界面还没接（任务里明确不做）。 */
export async function fetchTagStatus(): Promise<TagStatusSummary> {
  const res = await fetch('/api/v1/memes/tag-status')
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<TagStatusSummary>
}

/**
 * 检索通路标识。**只用于展示，不参与排序**——顺序由服务端 RRF 融合决定（SPEC §6.3.1）。
 * 服务端可能新增通路，所以用 Record<string, string> 查表并保留原值兜底，不做穷举联合。
 */
export const MATCHED_BY_LABELS: Record<string, string> = {
  vector: '向量',
  ocr: 'OCR',
  tags: '标签',
}

/** 单条搜索结果：Meme 加一个召回来源标注（SPEC §6.3.1）。类型从 api 派生，不手写。 */
export type SearchResult = InferResponseType<typeof api.api.v1.search.$get>['items'][number]

export type SearchResponse = InferResponseType<typeof api.api.v1.search.$get>

/**
 * `GET /search`。三路融合，**不分页**——服务端返回什么就展示什么，默认 50 最大 100（SPEC §6.3.1）。
 *
 * 和 fetchMemes 一样用 fetch 而不是 RPC 客户端方法：RPC 客户端把非 2xx 直接当异常抛，
 * 拿不到 SPEC §2.1 的错误信封，而 code 和 requestId 是必须展示给用户的。
 */
export async function fetchSearch(q: string, limit?: number): Promise<SearchResponse> {
  const qs = new URLSearchParams({ q })
  if (limit !== undefined) qs.set('limit', String(limit))

  const res = await fetch(`/api/v1/search?${qs.toString()}`)
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<SearchResponse>
}

/**
 * 收藏/取消收藏。`favorited=true` 发 PUT，`false` 发 DELETE（SPEC §6.4）。
 * 调用前已乐观更新，失败时调用方负责回滚。
 */
export async function toggleFavorite(memeId: string, favorited: boolean): Promise<void> {
  const res = await fetch(`/api/v1/memes/${memeId}/favorite`, {
    method: favorited ? 'PUT' : 'DELETE',
  })
  if (!res.ok && res.status !== 204) throw await toApiError(res)
}

export async function fetchHealth() {
  const res = await api.api.v1.health.$get()
  if (!res.ok) throw await toApiError(res)
  return res.json()
}

// stub — replace with InferResponseType<typeof api.auth.me.$get> once api exports the route
export type User = {
  id: string
  role: 'admin' | 'member'
  storageQuotaBytes: number
  storageUsedBytes: number
  createdAt: string
}

export async function fetchMe(): Promise<User> {
  const res = await fetch('/api/v1/auth/me')
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<User>
}

export async function login(name: string, password: string): Promise<User> {
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  })
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<User>
}

export async function register(name: string, password: string, inviteCode: string): Promise<User> {
  const res = await fetch('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password, inviteCode }),
  })
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<User>
}

export async function postLogout(): Promise<void> {
  const res = await fetch('/api/v1/auth/logout', { method: 'POST' })
  if (!res.ok && res.status !== 204) throw await toApiError(res)
}

export type InviteCode = {
  code: string
  status: 'unused' | 'used' | 'expired'
  createdBy: string
  createdAt?: string
  expiresAt: string | null
  usedBy: string | null
}

export async function fetchInvites(): Promise<InviteCode[]> {
  const res = await fetch('/api/v1/admin/invites')
  if (!res.ok) throw await toApiError(res)
  const data = (await res.json()) as { items: InviteCode[] }
  return data.items
}

export async function createInvite(expiresAt?: string): Promise<InviteCode> {
  const res = await fetch('/api/v1/admin/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresAt: expiresAt ?? null }),
  })
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<InviteCode>
}

export type AdminUser = {
  id: string
  name: string
  role: 'admin' | 'member'
  storageQuotaBytes: number
  storageUsedBytes: number
  createdAt: string
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const res = await fetch('/api/v1/admin/users')
  if (!res.ok) throw await toApiError(res)
  const data = (await res.json()) as { items: { id: string; name: string; role: 'admin' | 'member'; storageQuotaBytes: string; storageUsedBytes: string; createdAt: string }[] }
  return data.items.map((u) => ({
    ...u,
    storageQuotaBytes: Number(u.storageQuotaBytes),
    storageUsedBytes: Number(u.storageUsedBytes),
  }))
}

export async function patchAdminUser(
  id: string,
  patch: { role?: 'admin' | 'member'; storageQuotaBytes?: number },
): Promise<{ id: string; name: string; role: 'admin' | 'member'; storageQuotaBytes: number; createdAt: string }> {
  const res = await fetch(`/api/v1/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw await toApiError(res)
  const data = (await res.json()) as { id: string; name: string; role: 'admin' | 'member'; storageQuotaBytes: string; createdAt: string }
  return { ...data, storageQuotaBytes: Number(data.storageQuotaBytes) }
}
