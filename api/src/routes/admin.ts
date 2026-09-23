import { Hono } from 'hono'
import { requireAdmin, type AuthVariables } from '../middleware/auth.js'
import {
  listInviteCodes,
  createInviteCode,
  listUsers,
  updateUser,
} from '../data/admin.js'
import { AppError } from '../lib/app-error.js'
import { isUuid } from '../lib/uuid.js'
import { toIsoSecondsOrNull } from '../serialize/meme.js'
import { enqueueAllStale, getReindexStatus } from '../services/ai-config.js'
import {
  getRuntimeConfig,
  saveRuntimeConfigChecked,
  type RuntimeConfigView,
} from '../services/runtime-config.js'

function inviteStatus(row: {
  usedBy: string | null
  expiresAt: Date | null
}): 'used' | 'expired' | 'unused' {
  if (row.usedBy !== null) return 'used'
  if (row.expiresAt !== null && row.expiresAt < new Date()) return 'expired'
  return 'unused'
}

const QUOTA_RE = /^\d+$/

/**
 * `storageQuotaBytes` 的解析。
 *
 * SPEC §7.1：`bigint` 列在 JSON 里是**十进制字符串**。这里同时接受安全范围内的整数
 * `number`（客户端做算术后传回来时更自然），但**不接受 `BigInt()` 自己会吞下的那些写法**
 * ——`"0x10"`、`" 12 "`、浮点、布尔值都能被 `BigInt()` 静默转成某个数，而它们是
 * 「参数写错了」，不是「配额等于 16 字节」。静默接受的表现是管理员填错一位、保存成功、
 * 配额变成一个他没想过的数。
 *
 * ⚠️ **必须兜住异常**：`BigInt('abc')` 抛 `SyntaxError`，它不是 `AppError`，落到
 *    `app.onError` 就是 500（错误信封只有一个出口，agents/rules/error-handling.md §1）。
 *    一个写错的配额值回应「服务器内部错误」，把管理员送去查日志。
 */
function parseQuotaBytes(value: unknown): bigint {
  const invalid = () =>
    new AppError('VALIDATION_FAILED', 'storageQuotaBytes 必须是非负整数字符串')

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw invalid()
  } else if (typeof value !== 'string' || !QUOTA_RE.test(value)) {
    throw invalid()
  }

  const n = BigInt(value)
  if (n < 0n) throw invalid()
  return n
}

export const adminRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', requireAdmin)

  .get('/invites', async (c) => {
    const rows = await listInviteCodes()
    const items = rows.map((r) => ({
      code: r.code,
      status: inviteStatus(r),
      createdBy: r.createdBy,
      usedBy: r.usedBy,
      usedAt: toIsoSecondsOrNull(r.usedAt),
      expiresAt: toIsoSecondsOrNull(r.expiresAt),
    }))
    return c.json({ items })
  })

  .post('/invites', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON')
    })

    const { expiresAt } = body as Record<string, unknown>

    let expiresAtDate: Date | null = null
    if (expiresAt !== undefined && expiresAt !== null) {
      if (typeof expiresAt !== 'string') {
        throw new AppError('VALIDATION_FAILED', 'expiresAt 必须是 ISO 8601 字符串')
      }
      expiresAtDate = new Date(expiresAt)
      if (isNaN(expiresAtDate.getTime())) {
        throw new AppError('VALIDATION_FAILED', 'expiresAt 格式无效')
      }
    }

    const admin = c.get('currentUser')
    const row = await createInviteCode(admin.id, expiresAtDate)
    return c.json(
      {
        code: row.code,
        status: inviteStatus(row),
        createdBy: row.createdBy,
        usedBy: row.usedBy,
        usedAt: toIsoSecondsOrNull(row.usedAt),
        expiresAt: toIsoSecondsOrNull(row.expiresAt),
      },
      201,
    )
  })

  .get('/users', async (c) => {
    const rows = await listUsers()
    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      storageQuotaBytes: r.storageQuotaBytes.toString(),
      storageUsedBytes: r.storageUsedBytes.toString(),
      createdAt: toIsoSecondsOrNull(r.createdAt)!,
    }))
    return c.json({ items })
  })

  .patch('/users/:id', async (c) => {
    /*
     * ⚠️ **形状要先挡掉。** 不挡的话 `eq(users.id, 'abc')` 会撞 Postgres 的
     *    `invalid input syntax for type uuid` —— 那是 500，不是 404。
     *    报 404 而不是 400：与「uuid 合法但库里没这个人」对客户端是同一件事，
     *    分开报只会让人以为格式对了就查得到（memes 那边同一条规矩）。
     */
    const id = c.req.param('id')
    if (!isUuid(id)) throw new AppError('NOT_FOUND', '用户不存在')

    const body = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON')
    })

    const { role, storageQuotaBytes } = body as Record<string, unknown>

    const patch: { role?: 'admin' | 'member'; storageQuotaBytes?: bigint } = {}

    if (role !== undefined) {
      if (role !== 'admin' && role !== 'member') {
        throw new AppError('VALIDATION_FAILED', 'role 必须是 admin 或 member')
      }
      patch.role = role
    }

    if (storageQuotaBytes !== undefined) {
      patch.storageQuotaBytes = parseQuotaBytes(storageQuotaBytes)
    }

    const updated = await updateUser(id, patch)
    return c.json({
      id: updated.id,
      name: updated.name,
      role: updated.role,
      storageQuotaBytes: updated.storageQuotaBytes.toString(),
      createdAt: toIsoSecondsOrNull(updated.createdAt)!,
    })
  })

  /**
   * 手动补触发全站重建索引（SPEC §6.5.4）。
   *
   * **幂等**：重复点不会让同一条记录重算两遍（`onConflictDoNothing`），所以前端
   * 不需要防重复提交，`enqueuedCount: 0` 也不是错误——它的意思是「该排的都已经排上了」。
   *
   * ⚠️ 字段名带 `Count`（SPEC §6.5.4）：它是**条数**不是布尔。叫 `enqueued` 会让客户端
   *    顺手写成 `=== true`，那样不报错也不告警，只是点完不跳进度条。同一个概念在
   *    `PUT /config/embed` 那边叫 `reindexEnqueuedCount`，两个端点不能有两个名字。
   *
   * 换模型时由 `PUT /config/embed` 自动触发，这里是管理员发现 `stale` 不降时的补手。
   * ⚠️ 这个端点**不清 failed 行**：清了等于把「有 12 条重试耗尽了」这个事实抹掉，
   *    而那正是他点进来要看的东西。清 failed 只发生在换模型开启新一轮时。
   */
  .post('/reindex', async (c) => {
    const enqueuedCount = await enqueueAllStale()
    return c.json({ enqueuedCount, ...(await getReindexStatus()) })
  })

  .get('/reindex/status', async (c) => {
    return c.json(await getReindexStatus())
  })

  /**
   * 运行参数（SPEC §6.5.5）。全站一份、仅 `admin`——它改的是**全站资源分配与 AI 账单**，
   * 不是谁的偏好（§3.3），放普通用户的设置页等于让任何 member 把机器和账单打爆。
   *
   * ⚠️ **权限不在 handler 里判断**：整组已经 `.use('*', requireAdmin)`，在这里再写一遍
   *    角色判断哪怕写对了也是错的（api/AGENTS.md §3）。挂进这个已有的路由组而不是新开一组，
   *    是因为 `app.ts` 那条链断一次 RPC 类型就退化成 `any`。
   *
   * ⚠️ **返回的是生效值**，四个数都是**每个服务进程**的上限，不是全站的（§5.6）。
   *    这里只做序列化：上下限、归一化、`cpuCount` 都在 `services/runtime-config.ts`。
   */
  .get('/runtime', async (c) => {
    return c.json(serializeRuntime(await getRuntimeConfig()))
  })

  /**
   * 一次性提交整组，**不做部分更新**——它本来就是一个四格表单，而部分更新会让界面
   * 不知道该显示哪一次的值（§6.5.5）。
   *
   * 越界 / 缺字段 / `tagPerUserInflight > tagConcurrency` 都是 `VALIDATION_FAILED`，
   * **不静默截断**：截断的表现是「填了 16、提示保存成功、回显 2」（§9.26）。
   */
  .put('/runtime', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON')
    })
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象')
    }

    const admin = c.get('currentUser')
    return c.json(serializeRuntime(await saveRuntimeConfigChecked(body as Record<string, unknown>, admin.id)))
  })

function serializeRuntime(view: RuntimeConfigView) {
  return { ...view, updatedAt: toIsoSecondsOrNull(view.updatedAt) }
}