import { Hono } from 'hono'
import { requireAdmin, type AuthVariables } from '../middleware/auth.js'
import {
  listInviteCodes,
  createInviteCode,
  listUsers,
  updateUser,
} from '../data/admin.js'
import { AppError } from '../lib/app-error.js'

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
