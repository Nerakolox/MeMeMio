import { api, toApiError } from './api'
import type { InferResponseType } from 'hono/client'

/**
 * 导入相关的请求。仍然遵守「只有一个地方发请求」（http.md §1）——组件里不出现 fetch，
 * 包括直传 R2 的那一次 PUT。
 *
 * 响应类型从 api 派生（InferResponseType），不手写——改字段名时 web 编译失败是这套
 * 类型同步机制的核心价值（code-style.md）。SSE 事件类型是例外：流式响应 Hono RPC
 * 无法推导，按 SPEC §1.4 手写。
 */

// ---------------------------------------------------------------------------
// 请求体输入类型（非响应，不从 InferResponseType 派生）
// ---------------------------------------------------------------------------

export type ImportFileSpec = { fileName: string; sizeBytes: number }

// ---------------------------------------------------------------------------
// 响应类型：从 api 派生
// ---------------------------------------------------------------------------

export type PresignResponse = InferResponseType<typeof api.api.v1.imports.$post>

/** R2 预签名直传目标。字节直传 R2，不经过 api（SPEC §6.2.1）。 */
export type ImportUploadTarget = PresignResponse['uploads'][number]

/** SPEC §6.2 的批次快照。读取当前计数，用于 SSE 断线后补齐。 */
export type BatchStatus = InferResponseType<(typeof api.api.v1.imports)[':batchId']['$get']>

type _ReviewsResponse = InferResponseType<typeof api.api.v1.imports.reviews.$get>

/**
 * `GET /imports/reviews` 的条目（SPEC §6.2.3）。
 *
 * `existing` 可为 null——待审图关联的已有图若已被删除，服务端查不到则返回 null。
 * `sizeBytes` 是字符串（bigint 走 JSON 会丢精度，服务端 toString 了）。
 */
export type ReviewItem = _ReviewsResponse['items'][number]

// ---------------------------------------------------------------------------
// SSE 事件类型（流式响应，Hono RPC 无法推导，按 SPEC §1.4 手写）
// ---------------------------------------------------------------------------

/** SSE `progress` 事件载荷（SPEC §1.4）。 */
export type ImportProgressEvent = {
  total: number
  done: number
  skipped: number
  pending: number
}

/** SSE `item` 事件载荷。`result` 是开放取值，服务端可能新增（http.md §4）。 */
export type ImportItemEvent = {
  fileName: string
  result: string
  memeId?: string
  reason?: string
}

/** SSE `done` 事件载荷。三个数分开报（import-ux.md §6）。 */
export type ImportDoneEvent = {
  total: number
  imported: number
  exactDup: number
  needsReview: number
  failed: number
}

/** SSE `error` 事件载荷，之后连接关闭。 */
export type ImportBatchErrorEvent = {
  code: string
  message: string
}

// ---------------------------------------------------------------------------

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

/** `POST /imports`：签发预签名直传 URL，同时做配额检查（SPEC §6.2.1）。 */
export async function presignImport(files: ImportFileSpec[]): Promise<PresignResponse> {
  const res = await fetch('/api/v1/imports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  })
  return unwrap<PresignResponse>(res)
}

/**
 * 直传 R2。**文件字节不经过 api**——改成 POST 到后端再转发会让 Node 进程被大文件拖垮
 * （import-ux.md §2）。
 *
 * R2 的失败响应不是本项目的错误信封，所以这里自己造一个 ApiError：`toApiError`
 * 解析不出信封时会给出可用的兜底（http.md §4），把 HTTP 状态和 requestId 都带上。
 */
export async function uploadToR2(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, { method: 'PUT', body: file })
  if (!res.ok) throw await toApiError(res)
}

/** `POST /imports/{batchId}/commit`：触发服务端处理，202，不同步等待。 */
export async function commitImport(
  batchId: string,
  items: { fileName: string; tempKey: string }[],
): Promise<void> {
  const res = await fetch(`/api/v1/imports/${encodeURIComponent(batchId)}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
  if (!res.ok) throw await toApiError(res)
}

/** `GET /imports/{batchId}`：批次快照。SSE 断线补齐靠它，别只靠重连（http.md §7）。 */
export async function fetchBatchStatus(batchId: string): Promise<BatchStatus> {
  const res = await fetch(`/api/v1/imports/${encodeURIComponent(batchId)}`)
  return unwrap<BatchStatus>(res)
}

/** `GET /imports/reviews`：当前用户全部待确认条目，跨批次。 */
export async function fetchReviews(): Promise<ReviewItem[]> {
  const res = await fetch('/api/v1/imports/reviews')
  if (!res.ok) throw await toApiError(res)
  const data = (await res.json()) as { items: ReviewItem[] }
  return data.items
}

/** `POST /imports/reviews/{batchId}/{fileName}`：处理后移出队列。 */
export async function resolveReview(
  batchId: string,
  fileName: string,
  action: 'import' | 'skip',
): Promise<void> {
  const res = await fetch(
    `/api/v1/imports/reviews/${encodeURIComponent(batchId)}/${encodeURIComponent(fileName)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    },
  )
  if (!res.ok) throw await toApiError(res)
}
