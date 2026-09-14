import { randomBytes } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { inviteCodes, memes, users } from './schema.js'
import { AppError } from '../lib/app-error.js'

export type InviteCodeRow = typeof inviteCodes.$inferSelect
export type UserRow = typeof users.$inferSelect & { storageUsedBytes: bigint }

export async function listInviteCodes(db: Db = defaultDb): Promise<InviteCodeRow[]> {
  return db.select().from(inviteCodes)
}

export async function createInviteCode(
  createdBy: string,
  expiresAt: Date | null,
  db: Db = defaultDb,
): Promise<InviteCodeRow> {
  // 18 random bytes → 24 URL-safe base64url chars
  const code = randomBytes(18).toString('base64url')
  const rows = await db
    .insert(inviteCodes)
    .values({ code, createdBy, expiresAt })
    .returning()
  const row = rows[0]
  if (!row) throw new AppError('INTERNAL', '写入邀请码失败')
  return row
}

export async function listUsers(db: Db = defaultDb): Promise<UserRow[]> {
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      name: users.name,
      passwordHash: users.passwordHash,
      storageQuotaBytes: users.storageQuotaBytes,
      createdAt: users.createdAt,
      storageUsedBytes: sql<bigint>`coalesce(sum(${memes.sizeBytes}), 0)::bigint`,
    })
    .from(users)
    .leftJoin(
      memes,
      and(
        eq(memes.uploaderId, users.id),
        // 软删记录在 30 天内仍计入配额，SPEC §3.6
        sql`(${memes.deletedAt} is null or ${memes.deletedAt} > now() - interval '30 days')`,
      ),
    )
    .groupBy(users.id)
    .orderBy(desc(users.createdAt))
  return rows
}

export async function updateUser(
  id: string,
  patch: { role?: 'admin' | 'member'; storageQuotaBytes?: bigint },
  db: Db = defaultDb,
): Promise<typeof users.$inferSelect> {
  const existing = await db.select().from(users).where(eq(users.id, id)).limit(1)
  if (!existing[0]) throw new AppError('NOT_FOUND', '用户不存在')

  if (patch.role === undefined && patch.storageQuotaBytes === undefined) {
    return existing[0]
  }

  const set: Partial<typeof users.$inferInsert> = {}
  if (patch.role !== undefined) set.role = patch.role
  if (patch.storageQuotaBytes !== undefined) set.storageQuotaBytes = patch.storageQuotaBytes

  const rows = await db.update(users).set(set).where(eq(users.id, id)).returning()
  const row = rows[0]
  if (!row) throw new AppError('INTERNAL', '更新用户失败')
  return row
}
