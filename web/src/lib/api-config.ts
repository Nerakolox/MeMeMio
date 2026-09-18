import { toApiError } from './api'

/**
 * `/config/*` 与重建索引的请求。遵守「只有一个地方发请求」（http.md §1）——
 * 组件里不出现 fetch。
 *
 * ⚠️ **下面的类型是阻塞态的临时占位，不是本端自留的第二份契约。**
 *
 * api 还没把这六个端点挂进 `app.ts`（joint-tasks/2026-09-16-ai-config.md「阻塞点」），
 * Hono RPC 推不出类型，所以这里照 SPEC §6.5.3 / §6.5.4 的形状写了一份。
 * api 挂上路由后**每一个都换成一行 InferResponseType**，不要在这里继续维护：
 *
 *     export type VisionConfig = InferResponseType<typeof api.api.v1.config.vision.$get>
 *     export type VisionTestResult = InferResponseType<typeof api.api.v1.config.vision.test.$post>
 *     export type EmbedConfig = InferResponseType<typeof api.api.v1.config.embed.$get>
 *     export type EmbedTestResult = InferResponseType<typeof api.api.v1.config.embed.test.$post>
 *     export type ReindexStatus = InferResponseType<typeof api.api.v1.admin.reindex.status.$get>
 *
 * 在那之前这里没有「改字段名 web 编译失败」的保证，字段对不上只会在运行时显示成空值。
 */

// ---------------------------------------------------------------------------
// 占位类型：SPEC §6.5.3 / §6.5.4 的形状
// ---------------------------------------------------------------------------

/** 当前生效的是用户自己的配置还是部署方默认（SPEC §5.3）。 */
export type ConfigSource = 'user' | 'default'

/**
 * `GET /config/vision`（SPEC §6.5.3）。
 *
 * 能力位三态：`true` / `false` / `null`。**`null` 是「还没测过」，不是「不支持」**——
 * 把它渲染成「不支持多图」会让用户以为换了个模型才有的问题。
 */
export type VisionConfig = {
  source: ConfigSource
  baseUrl: string | null
  model: string | null
  /** 固定 `"****" + 后四位`，未配置时 null。原样回传视为「不修改」（SPEC §3.5）。 */
  apiKey: string | null
  verifiedAt: string | null
  jsonModeWorks: boolean | null
  multiImageWorks: boolean | null
}

/** `GET /config/embed`，与 VisionConfig 同构，能力字段换成维度相关的两项（SPEC §6.5.3）。 */
export type EmbedConfig = {
  source: ConfigSource
  baseUrl: string | null
  model: string | null
  apiKey: string | null
  verifiedAt: string | null
  nativeDim: number | null
  dimParamWorks: boolean | null
}

/**
 * `PUT /config/vision` 与 `POST /config/vision/test` 的请求体同形，只有这三个字段——
 * **探测结果字段不出现在请求体里**（SPEC §6.5.3，探测结果不接受客户端写入）。
 * Embedding 那一组同理。
 */
export type ConfigInput = {
  baseUrl: string
  model: string
  /** 脱敏串（`****1234`）视为「不修改」，所以不改 key 时把回显值原样提交即可。 */
  apiKey: string
}

/**
 * `POST /config/vision/test`（SPEC §6.5.1）。
 *
 * `rawResponse` / `rawError` 是这个接口的核心价值，**原样展示，不截断不包装**
 * （settings-ux.md §5）。
 */
export type VisionTestResult = {
  ok: boolean
  canReceiveImage: boolean | null
  jsonModeWorks: boolean | null
  multiImageWorks: boolean | null
  vocabCompliant: boolean | null
  rawResponse: string | null
  rawError: string | null
}

/** `POST /config/embed/test`（SPEC §6.5.1）。`nativeDim` 是实测值，不信文档也不让人填。 */
export type EmbedTestResult = {
  ok: boolean
  nativeDim: number | null
  dimParamWorks: boolean | null
  willTruncate: boolean | null
  rawResponse: string | null
  rawError: string | null
}

/** `GET /admin/reindex/status`（SPEC §6.5.4）。计数来自库里的真实统计。 */
export type ReindexStatus = {
  running: boolean
  total: number
  done: number
  stale: number
  failed: number
}

// ---------------------------------------------------------------------------

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

function postJson(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<Response> {
  return fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// --- 视觉通道（本人） ------------------------------------------------------

export async function fetchVisionConfig(): Promise<VisionConfig> {
  return readJson<VisionConfig>(await fetch('/api/v1/config/vision'))
}

/**
 * **不通过也是 200**，结果在响应体里（http.md §5）。把它当 HTTP 错误处理会丢掉
 * `rawResponse`，而那是这个接口的全部价值。只有请求本身非法才是 4xx，那时才抛。
 */
export async function testVisionConfig(input: ConfigInput): Promise<VisionTestResult> {
  return readJson<VisionTestResult>(await postJson('/api/v1/config/vision/test', input))
}

/** 无匹配的成功测试记录时服务端回 `CONFIG_TEST_REQUIRED`（SPEC §6.5.2）。 */
export async function putVisionConfig(input: ConfigInput): Promise<VisionConfig> {
  return readJson<VisionConfig>(await postJson('/api/v1/config/vision', input, 'PUT'))
}

// --- Embedding（仅 admin，全站一份） ---------------------------------------

export async function fetchEmbedConfig(): Promise<EmbedConfig> {
  return readJson<EmbedConfig>(await fetch('/api/v1/config/embed'))
}

/** 同视觉测试：不通过也是 200。 */
export async function testEmbedConfig(input: ConfigInput): Promise<EmbedTestResult> {
  return readJson<EmbedTestResult>(await postJson('/api/v1/config/embed/test', input))
}

/**
 * 换模型且库里已有数据时缺 `confirmReindex` 会被拒（`EMBED_MODEL_CHANGED`，409），
 * 确认后服务端自动触发全站重建索引（SPEC §6.5.2）。
 */
export async function putEmbedConfig(
  input: ConfigInput,
  confirmReindex = false,
): Promise<EmbedConfig> {
  const body = confirmReindex ? { ...input, confirmReindex: true } : input
  return readJson<EmbedConfig>(await postJson('/api/v1/config/embed', body, 'PUT'))
}

// --- 重建索引（仅 admin） --------------------------------------------------

/**
 * 手动补触发，幂等——换模型时由 `PUT /config/embed` 自动入队（SPEC §6.5.4）。
 *
 * 不读响应体：SPEC 没有规定这个端点回什么，进度一律以 `GET /admin/reindex/status`
 * 为准（那才是库里的真实计数），调用方触发完重新拉一次状态。
 */
export async function startReindex(): Promise<void> {
  const res = await postJson('/api/v1/admin/reindex', {})
  if (!res.ok) throw await toApiError(res)
}

export async function fetchReindexStatus(): Promise<ReindexStatus> {
  return readJson<ReindexStatus>(await fetch('/api/v1/admin/reindex/status'))
}
