import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { inviteCodes, memes, sessions, users } from './schema.js'
import { AppError } from '../lib/app-error.js'

const scryptAsync = promisify(scrypt)

const SALT_LEN = 16
const KEY_LEN = 64
/** 默认存储配额 10 GiB。SPEC §5.1 不定义默认值，这里用合理常量。 */
const DEFAULT_QUOTA_BYTES = BigInt(10 * 1024 * 1024 * 1024)

export type UserRow = typeof users.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type InviteCodeRow = typeof inviteCodes.$inferSelect

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

/**
 * 邀请码是否可用。**只是预检，不消耗、不判定**——判定在 `consumeInviteCode` 那条
 * 单语句 UPDATE 里。调用方（routes/auth.ts）拿它挡掉没有邀请码的注册请求，
 * 让注册顺序能排成「邀请码 → 查重名 → scrypt」。
 */
export async function findUsableInviteCode(
  code: string,
  db: Db = defaultDb,
): Promise<InviteCodeRow | null> {
  const rows = await db
    .select()
    .from(inviteCodes)
    .where(
      and(
        eq(inviteCodes.code, code),
        isNull(inviteCodes.usedBy),
        sql`(${inviteCodes.expiresAt} is null or ${inviteCodes.expiresAt} > now())`,
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

/**
 * 消耗一个邀请码。同一个码只能用一次（SPEC §3.1）。
 *
 * ⚠️ **`UPDATE ... RETURNING` 是唯一判定点，`where` 里的三个条件缺一不可。**
 *    「先 select 看能不能用，再 update」在并发下是错的：两个请求会都读到
 *    `used_by is null`、都认为可以用，然后两条 UPDATE 都成功——同一个码进了两个人。
 *    改成单语句之后，第二个 UPDATE 在行锁解开时会重新求值 where，影响 0 行。
 *
 *    过期判定也必须在 `where` 里（不是先读出来再比 JS 的 Date）：读出来的那一刻
 *    还没过期、写下去时过期了，那是同一个竞态。`now()` 用数据库时钟。
 */
export async function consumeInviteCode(
  code: string,
  userId: string,
  db: Db = defaultDb,
): Promise<void> {
  const rows = await db
    .update(inviteCodes)
    .set({ usedBy: userId, usedAt: sql`now()` })
    .where(
      and(
        eq(inviteCodes.code, code),
        isNull(inviteCodes.usedBy),
        sql`(${inviteCodes.expiresAt} is null or ${inviteCodes.expiresAt} > now())`,
      ),
    )
    .returning({ code: inviteCodes.code })

  if (rows.length > 0) return

  /*
   * 影响 0 行。**判定已经做完了**，下面这一次读只为了让 message 准一点
   * （「已被使用」和「已过期」对用户是两件事）——它不承担任何判定责任，
   * 所以读出来的结果和刚才那条 UPDATE 不一致也无所谓。
   */
  const existing = await findInviteCode(code, db)
  if (existing === null || existing.usedBy !== null) {
    throw new AppError('VALIDATION_FAILED', '邀请码无效或已被使用')
  }
  throw new AppError('VALIDATION_FAILED', '邀请码已过期')
}

async function findInviteCode(code: string, db: Db): Promise<InviteCodeRow | null> {
  const rows = await db.select().from(inviteCodes).where(eq(inviteCodes.code, code)).limit(1)
  return rows[0] ?? null
}

// ── 会话 ──────────────────────────────────────────────────────────────

export async function createSession(userId: string, db: Db = defaultDb): Promise<SessionRow> {
  const rows = await db
    .insert(sessions)
    .values({
      userId,
      // 30 天：SPEC §3.1 未定义过期时长，取常规值。cookie 的 maxAge（routes/auth.ts）
      // 必须跟这个数字一致，否则会出现「cookie 还在但会话已失效」。
      //
      // 让数据库算时间，绕过 drizzle + postgres.js 的 Date 序列化问题。也因此这里是
      // SQL 字面量而不是 JS 常量——曾经的 SESSION_TTL_MS 在改成 interval 之后就没人用了。
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
 *
 * ⚠️ `sum()` 的结果 postgres.js **不认** `bigint` 的解析器，原样给回字符串，
 *    哪怕 SQL 里已经 `::bigint`、Drizzle 也标了 `sql<bigint>`。类型注释骗人，
 *    运行期拿到的是 `'0'`。这里显式转一次——调用方拿到的一定是 bigint。
 *
 *    这个坑的杀伤力在于它不报错：`quota - '0'` 才是「Cannot mix BigInt and other types」。
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
  return rows[0] === undefined ? 0n : BigInt(rows[0].total)
}
