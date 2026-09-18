import { Hono } from 'hono'
import type { ProviderInput } from '../data/ai-configs.js'
import { AppError } from '../lib/app-error.js'
import { requireAdmin, requireAuth, type AuthVariables } from '../middleware/auth.js'
import { toIsoSecondsOrNull } from '../serialize/meme.js'
import {
  getEmbedConfig,
  getVisionConfig,
  resolveEmbedKey,
  resolveVisionKey,
  saveEmbedConfigChecked,
  saveVisionConfig,
  testEmbedConfig,
  testVisionConfig,
} from '../services/ai-config.js'

/**
 * `/api/v1/config/*` —— 模型配置与测试连接（SPEC §6.5）。
 *
 * ## 为什么是两个 Hono 实例
 *
 * `/config/vision` 是**本人**，`/config/embed` 是**管理员**（§6.5 的权限列）。
 * 权限只能由中间件表达（`api/AGENTS.md §3`：在 handler 里手写角色判断，哪怕写对了
 * 也是错的），而一个路由组只能挂一套中间件——所以拆成两个组，各自 `.use('*', …)` 一次。
 * 塞进一个组再用路径前缀去分流，就等于把权限判断写回了业务代码里。
 *
 * ## 这一层不做什么
 *
 * 不写 SQL、不调 AI、不判断权限（`project-structure.md`）。只有三件事：
 * 校验请求体的形状、把脱敏串换回明文（走数据层）、把结果序列化。
 *
 * ⚠️ **响应里的 `apiKey` 永远是 "****1234" 或 null。** 它不是在这里脱敏的——
 *    service 返回的就已经是脱敏串，本文件拿不到明文。想加一个「回显完整 key」的
 *    开关之前先回读 AGENTS.md §5。
 */

// ── 请求体 ─────────────────────────────────────────────────────────

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON')
  })
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象')
  }
  return body as Record<string, unknown>
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string') {
    throw new AppError('VALIDATION_FAILED', `${field} 必须是字符串`)
  }
  const trimmed = value.trim()
  if (trimmed === '') throw new AppError('VALIDATION_FAILED', `${field} 不能为空`)
  return trimmed
}

/**
 * `PUT /config/<scope>` 和 `POST /config/<scope>/test` 的请求体**同形**，只有三个字段
 * （§6.5.3：探测结果字段不出现在请求体里）。
 *
 * 多余的字段直接忽略而不是报错——将来加字段时老前端不会突然全挂。能忽略是因为
 * 探测位根本没有落库的路径（`data/ai-configs.ts` 的 `ProviderInput` 只有这三个），
 * 所以「忽略」在这里等于「写不进去」，不是「悄悄接受了」。
 *
 * `baseUrl` 只校验形状不校验可达性——可达性是测试连接的事，在这里做一次 DNS
 * 解析只会让内网地址填不进来。
 */
function readProviderInput(body: Record<string, unknown>): { raw: ProviderInput } {
  const baseUrl = requireString(body, 'baseUrl')
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new AppError('VALIDATION_FAILED', 'baseUrl 必须以 http:// 或 https:// 开头')
  }
  return {
    raw: {
      baseUrl,
      model: requireString(body, 'model'),
      // 这里的 apiKey 可能是脱敏串。换成明文由 service 经数据层做，本文件不判断
      apiKey: requireString(body, 'apiKey'),
    },
  }
}

// ── 视觉：本人 ──────────────────────────────────────────────────────

export const visionConfigRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', requireAuth)

  .get('/', async (c) => {
    const user = c.get('currentUser')
    const config = await getVisionConfig(user.id)
    return c.json({ ...config, verifiedAt: toIsoSecondsOrNull(config.verifiedAt) })
  })

  .put('/', async (c) => {
    const user = c.get('currentUser')
    const { raw } = readProviderInput(await readJson(c))
    const apiKey = await resolveVisionKey(user.id, raw.apiKey)

    await saveVisionConfig(user.id, { ...raw, apiKey })

    const config = await getVisionConfig(user.id)
    return c.json({ ...config, verifiedAt: toIsoSecondsOrNull(config.verifiedAt) })
  })

  /**
   * ⚠️ **不通过也是 200**（`http.md`、`settings-ux.md §5`）。只有请求本身非法才是 4xx。
   *
   *    把 `ok: false` 做成 HTTP 错误的后果很具体：前端会走错误分支，
   *    而错误分支里没有 `rawResponse`——那恰恰是用户唯一能用来判断
   *    「是模型不行还是我填错了」的东西。
   */
  .post('/test', async (c) => {
    const user = c.get('currentUser')
    const { raw } = readProviderInput(await readJson(c))
    const apiKey = await resolveVisionKey(user.id, raw.apiKey)

    return c.json(await testVisionConfig(user.id, { ...raw, apiKey }))
  })

// ── Embedding：管理员 ───────────────────────────────────────────────

export const embedConfigRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', requireAdmin)

  .get('/', async (c) => {
    const config = await getEmbedConfig()
    return c.json({ ...config, verifiedAt: toIsoSecondsOrNull(config.verifiedAt) })
  })

  .put('/', async (c) => {
    const body = await readJson(c)
    const { raw } = readProviderInput(body)

    const confirmReindex = body['confirmReindex']
    if (confirmReindex !== undefined && typeof confirmReindex !== 'boolean') {
      throw new AppError('VALIDATION_FAILED', 'confirmReindex 必须是布尔值')
    }

    const apiKey = await resolveEmbedKey(raw.apiKey)
    const outcome = await saveEmbedConfigChecked({ ...raw, apiKey }, confirmReindex === true)

    const config = await getEmbedConfig()
    return c.json({
      ...config,
      verifiedAt: toIsoSecondsOrNull(config.verifiedAt),
      // 换了模型才有意义的两个字段。前端据此决定要不要把管理员送去看重建进度
      reindexTriggered: outcome.modelChanged,
      reindexEnqueued: outcome.enqueued,
    })
  })

  .post('/test', async (c) => {
    const { raw } = readProviderInput(await readJson(c))
    const apiKey = await resolveEmbedKey(raw.apiKey)

    return c.json(await testEmbedConfig({ ...raw, apiKey }))
  })
