import { probeEmbed, probeVision, type EmbedProbeReport, type VisionProbeReport } from '../ai/probe.js'
import { asCredentials } from '../ai/provider.js'
import {
  findEmbedTest,
  getEmbedConfigView,
  getEmbedModel,
  getVisionConfigView,
  recordEmbedTest,
  recordVisionTest,
  resolveSubmittedEmbedKey,
  resolveSubmittedVisionKey,
  saveEmbedConfig,
  saveUserVisionConfig,
  type ProviderInput,
} from '../data/ai-configs.js'
import {
  countEmbeddingProgress,
  hasEmbeddedMemes,
  listStaleEmbeddingMemeIds,
} from '../data/memes.js'
import {
  clearFailedReindexJobs,
  countReindexJobs,
  enqueueReindexJobs,
  hasUnfinishedReindexJobs,
} from '../data/reindex-jobs.js'
import { env } from '../env.js'
import { AppError } from '../lib/app-error.js'
import { maskApiKey } from '../lib/redact.js'
import { EMBED_DIM } from '../lib/vector.js'
import { log } from '../logger.js'

/**
 * 配置与测试连接的编排（SPEC §6.5）。
 *
 * 分层（`project-structure.md`）：`routes/` 只做参数校验和序列化，**不调 AI、不写 SQL**，
 * 所以「探测 → 落测试记录 → 回查测试记录 → 写配置」这条链在这里。
 *
 * ## 明文 key 在这一层活多久
 *
 * 一次请求里，明文 key 从 `resolveSubmitted*Key`（脱敏串换回库里那把）拿到，交给
 * 探测或加密，然后随着函数返回一起消失。**不进日志、不进返回值、不进 AppError 的
 * `details`**（`ai-providers.md §7`、SPEC §3.5）。本文件里所有 `log.*` 调用只记
 * `baseUrl` 和 `model` 两个字段，加字段之前先回读这一段。
 */

// ── 视觉配置 ────────────────────────────────────────────────────────

/** SPEC §6.5.3 的对外形状。`apiKey` 永远是 "****1234" 或 null，**没有明文这条路**。 */
export type VisionConfigResponse = {
  source: 'user' | 'default'
  baseUrl: string
  model: string
  apiKey: string | null
  verifiedAt: Date | null
  jsonModeWorks: boolean | null
  multiImageWorks: boolean | null
}

export type EmbedConfigResponse = {
  source: 'user' | 'default'
  baseUrl: string
  model: string
  apiKey: string | null
  verifiedAt: Date | null
  nativeDim: number | null
  dimParamWorks: boolean | null
}

/**
 * `GET /config/vision`。没配过就回显部署方默认值并带 `source: "default"`。
 *
 * 部署方那一套的能力位**固定 null**：它同样没有测试连接记录，不能因为「这是我们
 * 自己配的」就假设它支持什么（同 `resolveVisionConfig` 的口径）。
 */
export async function getVisionConfig(userId: string): Promise<VisionConfigResponse> {
  const view = await getVisionConfigView(userId)
  if (view !== null) {
    return {
      source: 'user',
      baseUrl: view.baseUrl,
      model: view.model,
      apiKey: view.maskedApiKey,
      verifiedAt: view.verifiedAt,
      jsonModeWorks: view.jsonModeWorks,
      multiImageWorks: view.multiImageWorks,
    }
  }

  const fallback = asCredentials(env.defaultVision)
  return {
    source: 'default',
    baseUrl: fallback?.baseUrl ?? '',
    model: fallback?.model ?? '',
    // 部署方的 key 同样只给后四位。「不论用户的还是部署方的」——AGENTS.md §5
    apiKey: maskApiKey(fallback?.apiKey ?? null),
    verifiedAt: null,
    jsonModeWorks: null,
    multiImageWorks: null,
  }
}

/**
 * `POST /config/vision/test`。**不改变当前生效的配置**（§6.5.3）——只落一条测试记录。
 *
 * 不通过也是 200，结果在响应体里（`http.md`）。这里不抛 AppError，抛了前端就会
 * 按 HTTP 错误处理，把 `rawResponse` 丢掉，而那是这个接口的核心价值。
 */
export async function testVisionConfig(
  userId: string,
  input: ProviderInput,
): Promise<VisionProbeReport> {
  const report = await probeVision(input)

  // 探测结果只经这一条路进库。客户端传不进来（`data/ai-configs.ts` 的签名挡着）
  await recordVisionTest(userId, input, {
    ok: report.ok,
    jsonModeWorks: report.jsonModeWorks,
    multiImage: report.multiImageWorks,
  })

  log.info(
    { userId, baseUrl: input.baseUrl, model: input.model, ok: report.ok },
    '视觉通道测试连接',
  )
  return report
}

/** `PUT /config/vision`。校验（有没有通过的测试记录）在数据层，这里只负责编排。 */
export async function saveVisionConfig(userId: string, input: ProviderInput): Promise<void> {
  await saveUserVisionConfig(userId, input)
  log.info({ userId, baseUrl: input.baseUrl, model: input.model }, '保存视觉通道配置')
}

/** 脱敏串 → 库里那把明文。路由把用户填的串原样递进来，判断只在数据层有一份。 */
export async function resolveVisionKey(userId: string, submitted: string): Promise<string> {
  return resolveSubmittedVisionKey(userId, submitted)
}

// ── Embedding 配置（全站单行） ──────────────────────────────────────

export async function getEmbedConfig(): Promise<EmbedConfigResponse> {
  const view = await getEmbedConfigView()
  if (view !== null) {
    return {
      source: 'user',
      baseUrl: view.baseUrl,
      model: view.model,
      apiKey: view.maskedApiKey,
      verifiedAt: view.verifiedAt,
      nativeDim: view.nativeDim,
      dimParamWorks: view.dimParamWorks,
    }
  }

  const fallback = asCredentials(env.defaultEmbed)
  return {
    source: 'default',
    baseUrl: fallback?.baseUrl ?? '',
    model: fallback?.model ?? '',
    apiKey: maskApiKey(fallback?.apiKey ?? null),
    verifiedAt: null,
    nativeDim: null,
    dimParamWorks: null,
  }
}

export async function testEmbedConfig(input: ProviderInput): Promise<EmbedProbeReport> {
  const report = await probeEmbed(input)

  await recordEmbedTest(input, {
    ok: report.ok,
    nativeDim: report.nativeDim,
    dimParamWorks: report.dimParamWorks,
  })

  log.info(
    { baseUrl: input.baseUrl, model: input.model, ok: report.ok, nativeDim: report.nativeDim },
    'embedding 通道测试连接',
  )
  return report
}

export async function resolveEmbedKey(submitted: string): Promise<string> {
  return resolveSubmittedEmbedKey(submitted)
}

export type SaveEmbedOutcome = {
  /** 这次保存换了模型。换了就意味着全站向量作废。 */
  modelChanged: boolean
  /** 顺带排进队列的重算任务数。没换模型时为 0。 */
  enqueued: number
}

/**
 * `PUT /config/embed`。三道闸门，**顺序不能换**：
 *
 *   1. 有没有通过的测试记录 → `CONFIG_TEST_REQUIRED`
 *   2. 实测维度够不够 → `EMBED_DIM_TOO_SMALL`
 *   3. 换模型且库里有数据、又没带确认 → `EMBED_MODEL_CHANGED`（409）
 *
 * 维度排在换模型前面，是因为一个 512 维的模型**无论如何都不该被保存**，
 * 先问「你确定要全站重算吗」再告诉他「这个模型根本不能用」是在耍人。
 */
export async function saveEmbedConfigChecked(
  input: ProviderInput,
  confirmReindex: boolean,
): Promise<SaveEmbedOutcome> {
  const test = await findEmbedTest(input)
  if (test === null || !test.ok) {
    throw new AppError('CONFIG_TEST_REQUIRED', '保存前需要先通过测试连接')
  }

  if (test.nativeDim !== null && test.nativeDim < EMBED_DIM) {
    // 维度不足没法截断补齐，向量库是 1024 维的固定形状（SPEC §9.6）
    throw new AppError(
      'EMBED_DIM_TOO_SMALL',
      `实测输出 ${test.nativeDim} 维，低于要求的 ${EMBED_DIM} 维`,
      { nativeDim: test.nativeDim, required: EMBED_DIM },
    )
  }

  const currentModel = await getEmbedModel()
  const modelChanged = currentModel !== null && currentModel !== input.model

  if (modelChanged && !confirmReindex) {
    // **没数据就不拦**：第一次配置、或者库里一张图都没向量化过时，
    // 用一个 409 挡住换模型只会让人困惑——没有东西需要重算
    if (await hasEmbeddedMemes()) {
      throw new AppError(
        'EMBED_MODEL_CHANGED',
        '更换 embedding 模型会让全站已有向量作废，需要确认后重建索引',
        { currentModel, nextModel: input.model },
      )
    }
  }

  await saveEmbedConfig(input)
  log.info({ baseUrl: input.baseUrl, model: input.model, modelChanged }, '保存 embedding 配置')

  if (!modelChanged) return { modelChanged: false, enqueued: 0 }

  // 换模型 = 开启新一轮重建。上一轮遗留的 failed 行在这里清掉，
  // 它们记的是**旧模型**下的失败，留着会让新一轮的 `failed` 数从一开始就不对
  const cleared = await clearFailedReindexJobs()
  const enqueued = await enqueueAllStale()
  log.info({ model: input.model, cleared, enqueued }, '换 embedding 模型，全站重建索引入队')
  return { modelChanged: true, enqueued }
}

// ── 重建索引（SPEC §6.5.4） ────────────────────────────────────────

/**
 * 一次取多少个 id 去入队。
 *
 * 取小了要翻很多页，取大了一次把几万个 uuid 拉进内存。1000 条 uuid 约 36 KB，
 * 翻页也只在管理员点一次按钮时发生。
 */
const ENQUEUE_PAGE = 1000

/** 单次触发最多排多少条。防的是「一个手滑点了重建，库里有两百万条」那种场面。 */
const ENQUEUE_CAP = 100_000

/**
 * 把所有向量过期的记录排进队列。**幂等**（§6.5.4）——`onConflictDoNothing`，
 * 重复调用不会让同一条记录重算两遍。
 *
 * 没配 embedding 模型时直接返回 0：没有「当前模型」就没有「过期」可言，
 * 这时候入队等于给每条记录排一个必然 `not_configured` 的任务。
 */
export async function enqueueAllStale(): Promise<number> {
  const currentModel = await getEmbedModel()
  if (currentModel === null) return 0

  let enqueued = 0
  for (let offset = 0; offset < ENQUEUE_CAP; offset += ENQUEUE_PAGE) {
    const ids = await listStaleEmbeddingMemeIds(currentModel, ENQUEUE_PAGE, offset)
    if (ids.length === 0) break
    enqueued += await enqueueReindexJobs(ids)
    if (ids.length < ENQUEUE_PAGE) break
  }
  return enqueued
}

export type ReindexStatus = {
  running: boolean
  total: number
  done: number
  stale: number
  failed: number
}

/**
 * `GET /admin/reindex/status`。
 *
 * 四个数**全部来自库**（§6.5.4：不能是进程内存里的计数器——重启后内存计数归零，
 * 进度条会从头开始，那是假的）。`total` / `done` / `stale` 一次扫 `memes` 算完，
 * `failed` 来自队列表。
 */
export async function getReindexStatus(): Promise<ReindexStatus> {
  const currentModel = await getEmbedModel()
  const [progress, queue, running] = await Promise.all([
    // 没配模型时拿空串去比对：`embed_model = ''` 不会命中任何行，于是 done = 0、
    // stale = 全部有 search_text 的记录。这正是「还没配 embedding」该显示的样子
    countEmbeddingProgress(currentModel ?? ''),
    countReindexJobs(),
    hasUnfinishedReindexJobs(),
  ])

  return {
    running,
    total: progress.total,
    done: progress.done,
    stale: progress.stale,
    failed: queue.failed,
  }
}
