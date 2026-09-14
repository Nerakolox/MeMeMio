import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { inviteCodes, memes, sessions, users } from './schema.js'
import { AppError } from '../lib/app-error.js'

const scryptAsync = promisify(scrypt)

const SALT_LEN = 16
const KEY_LEN = 64
/** 30 天。SPEC §3.1 未定义过期时长，取常规值。 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 默认存储配额 10 GiB。SPEC §5.1 不定义默认值，这里用合理常量。 */
const DEFAULT_QUOTA_BYTES = BigInt(10 * 1024 * 1024 * 1024)

export type UserRow = typeof users.$inferSelect
export type SessionRow = typeof sessions.$inferSelect

// ── 密码 ─────────────────────────────────────────────────────────────

export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LEN).toString('hex')
  const key = (await scryptAsync(plaintext, salt, KEY_LEN)) as Buffer
  return `${salt}:${key.toString('hex')}`
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const [salt, hex] = stored.split(':')
  if (!salt || !hex) return false
  const storedBuf = Buffer.from(hex, 'hex')
  const derived = (await scryptAsync(plaintext, salt, KEY_LEN)) as Buffer
  // 时序安全比较，防止 timing attack
  return derived.byteLength === storedBuf.byteLength && timingSafeEqual(derived, storedBuf)
}

// ── 用户 ─────────────────────────────────────────────────────────────

export async function findUserByName(name: string, db: Db = defaultDb): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.name, name)).limit(1)
  return rows[0] ?? null
}

export async function findUserById(id: string, db: Db = defaultDb): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return rows[0] ?? null
}

export async function countUsers(db: Db = defaultDb): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(users)
  return rows[0]?.count ?? 0
}

export async function createUser(
  input: { name: string; passwordHash: string; role: 'admin' | 'member' },
  db: Db = defaultDb,
): Promise<UserRow> {
  const rows = await db
    .insert(users)
    .values({
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role,
      storageQuotaBytes: DEFAULT_QUOTA_BYTES,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new AppError('INTERNAL', '写入用户失败')
  return row
}

// ── 邀请码 ────────────────────────────────────────────────────────────

export async function consumeInviteCode(
  code: string,
  userId: string,
  db: Db = defaultDb,
): Promise<void> {
  const rows = await db
    .select()
    .from(inviteCodes)
    .where(
      and(
        eq(inviteCodes.code, code),
        isNull(inviteCodes.usedBy),
      ),
    )
    .limit(1)

  const invite = rows[0]
  if (!invite) throw new AppError('VALIDATION_FAILED', '邀请码无效或已被使用')

  // 检查是否过期
  if (invite.expiresAt !== null && invite.expiresAt < new Date()) {
    throw new AppError('VALIDATION_FAILED', '邀请码已过期')
  }

  await db
    .update(inviteCodes)
    .set({ usedBy: userId, usedAt: new Date() })
    .where(and(eq(inviteCodes.code, code), isNull(inviteCodes.usedBy)))
}

// ── 会话 ──────────────────────────────────────────────────────────────

export async function createSession(userId: string, db: Db = defaultDb): Promise<SessionRow> {
  const rows = await db
    .insert(sessions)
    .values({
      userId,
      // 让数据库算时间，绕过 drizzle + postgres.js 的 Date 序列化问题
      expiresAt: sql`now() + interval '30 days'`,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new AppError('INTERNAL', '写入会话失败')
  return row
}

/** 返回 null 表示 session 不存在或已过期。 */
export async function findValidSession(
  sessionId: string,
  db: Db = defaultDb,
): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), sql`${sessions.expiresAt} > now()`))
    .limit(1)
  return rows[0] ?? null
}

export async function deleteSession(sessionId: string, db: Db = defaultDb): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}

// ── storageUsedBytes ──────────────────────────────────────────────────

/**
 * 聚合用户已用空间。软删记录在 30 天内仍计入，SPEC §3.6。
 */
export async function getStorageUsedBytes(userId: string, db: Db = defaultDb): Promise<bigint> {
  const rows = await db
    .select({ total: sql<bigint>`coalesce(sum(size_bytes), 0)::bigint` })
    .from(memes)
    .where(
      and(
        eq(memes.uploaderId, userId),
        // 软删记录在 30 天内仍计入配额，SPEC §3.6。用 SQL interval 避免 JS Date 序列化问题。
        sql`(${memes.deletedAt} is null or ${memes.deletedAt} > now() - interval '30 days')`,
      ),
    )
  return rows[0]?.total ?? BigInt(0)
}
