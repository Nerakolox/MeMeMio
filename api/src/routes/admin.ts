import { Hono } from 'hono'
import { requireAdmin, type AuthVariables } from '../middleware/auth.js'
import {
  listInviteCodes,
  createInviteCode,
  listUsers,
  updateUser,
} from '../data/admin.js'
import { AppError } from '../lib/app-error.js'
import { enqueueAllStale, getReindexStatus } from '../services/ai-config.js'

/** ISO 8601 UTC 精确到秒。SPEC §1.2 */
function toIsoSeconds(d: Date | null): string | null {
  if (d === null) return null
  return `${d.toISOString().slice(0, 19)}Z`
}

function inviteStatus(row: {
  usedBy: string | null
  expiresAt: Date | null
}): 'used' | 'expired' | 'unused' {
  if (row.usedBy !== null) return 'used'
  if (row.expiresAt !== null && row.expiresAt < new Date()) return 'expired'
  return 'unused'
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
      usedAt: toIsoSeconds(r.usedAt),
      expiresAt: toIsoSeconds(r.expiresAt),
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
        usedAt: toIsoSeconds(row.usedAt),
        expiresAt: toIsoSeconds(row.expiresAt),
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
      createdAt: toIsoSeconds(r.createdAt)!,
    }))
    return c.json({ items })
  })

  .patch('/users/:id', async (c) => {
    const id = c.req.param('id')
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
      const n = BigInt(storageQuotaBytes as string | number)
      if (n < 0n) throw new AppError('VALIDATION_FAILED', 'storageQuotaBytes 不能为负')
      patch.storageQuotaBytes = n
    }

    const updated = await updateUser(id, patch)
    return c.json({
      id: updated.id,
      name: updated.name,
      role: updated.role,
      storageQuotaBytes: updated.storageQuotaBytes.toString(),
      createdAt: toIsoSeconds(updated.createdAt)!,
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
