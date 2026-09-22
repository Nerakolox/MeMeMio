import { api, toApiError } from './api'
import type { InferResponseType } from 'hono/client'

/**
 * `/config/*` 与重建索引的请求。遵守「只有一个地方发请求」（http.md §1）——
 * 组件里不出现 fetch。
 *
 * 类型全部从 api 的 Hono RPC 派生，**这里不再有一份手写的响应形状**
 * （web/AGENTS.md §4）。阻塞期的占位类型已在 api 挂上路由后删掉。
 *
 * 仍然用 `fetch` 而不是 RPC 客户端的方法调用，理由同 `api.ts`：RPC 客户端把非 2xx
 * 直接当异常抛，拿不到 SPEC §2.1 的错误信封，而 `code` 和 `requestId` 是必须展示的。
 * 类型走 RPC、请求走 fetch，两者不冲突——路径写错编译不报错，但字段改名会报。
 */

// ---------------------------------------------------------------------------
// 响应类型：从 api 派生
// ---------------------------------------------------------------------------

/**
 * `GET /config/vision`（SPEC §6.5.3）。
 *
 * 能力位三态：`true` / `false` / `null`。**`null` 是「还没测过」，不是「不支持」**——
 * 把它渲染成「不支持多图」会让用户以为换了个模型才有的问题。
 */
export type VisionConfig = InferResponseType<typeof api.api.v1.config.vision.$get>

/** `GET /config/embed`，与 VisionConfig 同构，能力字段换成维度相关的两项（SPEC §6.5.3）。 */
export type EmbedConfig = InferResponseType<typeof api.api.v1.config.embed.$get>

/**
 * `PUT /config/embed` 的响应**比 GET 多两个字段**：`reindexTriggered`（这一次保存有没有
 * 换掉模型）与 `reindexEnqueuedCount`（这一次排进重算队列的**条数**，没换模型或库里
 * 没有向量时为 0）。后者是数字不是布尔，用它判断时写 `> 0`，别写 `=== true`——
 * 那是静默判错，不报错只是进度条不跳（SPEC §6.5.3）。
 *
 * 它们回答的是「**这一次保存**引发了重算吗」——`GET /admin/reindex/status` 只能说明
 * 此刻有没有重算在跑，分不出是不是你刚才那一下造成的（SPEC §6.5.3）。
 */
export type EmbedConfigSaved = InferResponseType<typeof api.api.v1.config.embed.$put>

/** 当前生效的是用户自己的配置还是部署方默认（SPEC §5.3）。 */
export type ConfigSource = VisionConfig['source']

/**
 * `POST /config/vision/test`（SPEC §6.5.1）。
 *
 * `rawResponse` 是这个接口的核心价值，**原样展示，不截断不包装**（settings-ux.md §5）。
 * 注意视觉这一路只有 `rawResponse`、embedding 那一路只有 `rawError`，两边不对称，
 * 这是 SPEC §6.5.1 两段示例本来的样子。
 */
export type VisionTestResult = InferResponseType<typeof api.api.v1.config.vision.test.$post>

/** `POST /config/embed/test`（SPEC §6.5.1）。`nativeDim` 是实测值，不信文档也不让人填。 */
export type EmbedTestResult = InferResponseType<typeof api.api.v1.config.embed.test.$post>

/** `GET /admin/reindex/status`（SPEC §6.5.4）。计数来自库里的真实统计。 */
export type ReindexStatus = InferResponseType<typeof api.api.v1.admin.reindex.status.$get>

/**
 * `POST /admin/reindex` 的响应：`{ enqueuedCount, ...status }`（SPEC §6.5.4）。
 *
 * `enqueuedCount` 是**这一次点击**新排进队列的条数，**`0` 不是错误**——它要么表示全库
 * 已是最新，要么表示该排的早就排上了（`onConflictDoNothing`，幂等）。它是**数字不是布尔**，
 * 判真值必须写 `> 0`：写成 `=== true` 不报错，只是那一下的反馈永远是「一条都没排」。
 */
export type ReindexTriggered = InferResponseType<typeof api.api.v1.admin.reindex.$post>

/**
 * `PUT /config/<scope>` 与 `POST /config/<scope>/test` 的请求体同形，只有这三个字段——
 * **探测结果字段不出现在请求体里**（SPEC §6.5.3，探测结果不接受客户端写入）。
 *
 * ⚠️ 这一个类型推不出来，只能写在这里：api 侧的请求体是在 handler 里手工校验的
 *    （`routes/config.ts` 的 `readProviderInput`），没有走 validator，Hono RPC 的
 *    `InferRequestType` 对它只能给出 `unknown`。所以它没有「api 改字段名 web 编译失败」
 *    那层保护，改请求体形状时这里要人工跟着改。
 */
export type ConfigInput = {
  baseUrl: string
  model: string
  /** 脱敏串（`****1234`）视为「不修改」，所以不改 key 时把回显值原样提交即可。 */
  apiKey: string
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

// --- Embedding（仅管理员，全站一份） ---------------------------------------

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
 *
 * 返回体带 `reindexTriggered` / `reindexEnqueuedCount`，调用方据此决定要不要刷进度，
 * 而不是「我传了 confirmReindex 所以一定排了队」——库里没有向量时不会排。
 */
export async function putEmbedConfig(
  input: ConfigInput,
  confirmReindex = false,
): Promise<EmbedConfigSaved> {
  const body = confirmReindex ? { ...input, confirmReindex: true } : input
  return readJson<EmbedConfigSaved>(await postJson('/api/v1/config/embed', body, 'PUT'))
}

// --- 重建索引（仅管理员） --------------------------------------------------

/**
 * 手动补触发，幂等——换模型时由 `PUT /config/embed` 自动入队（SPEC §6.5.4）。
 *
 * **响应体要读。** 进度条仍然以 `GET /admin/reindex/status` 为准（那才是库里的真实计数，
 * 而且会被 worker 和并发触发改写），`enqueuedCount` 只回答「**这一下**排进去几条」，
 * 两者不是一回事。
 *
 * 这里原先合并成了「所以不读响应体」，代价是 `enqueuedCount` 为 0 时**点完的界面和点之前
 * 逐像素相同**（徽标还是「空闲」、进度还是 100%、三个计数一动不动），用户无从判断按钮
 * 生效没有——而这不报错、不告警，只是让人反复点。把条数交给调用方，它才能给一句反馈。
 */
export async function startReindex(): Promise<ReindexTriggered> {
  return readJson<ReindexTriggered>(await postJson('/api/v1/admin/reindex', {}))
}

export async function fetchReindexStatus(): Promise<ReindexStatus> {
  return readJson<ReindexStatus>(await fetch('/api/v1/admin/reindex/status'))
}
