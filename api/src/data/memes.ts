import { and, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { memes, users, userFavorites } from './schema.js'
import { AppError } from '../lib/app-error.js'

/**
 * memes 的**唯一入口**。
 *
 * ⚠️ 本项目三条硬边界里的两条落在这个文件里（AGENTS.md §5、agents/rules/database.md）：
 *
 *   1. 读路径强制 deleted_at is null —— 不靠调用方记得传参数
 *   2. 写路径强制 assertCanMutate    —— 判断在函数内部，调用方不自己拼条件
 *
 * 不允许在别处写涉及 memes 的 SQL。绕过一次，这两条保证就不再成立了。
 */

export type MemeRow = typeof memes.$inferSelect
export type NewMeme = typeof memes.$inferInsert

/** 当前操作者。role 取值见 SPEC §3.2。 */
export type Actor = { id: string; role: string }

export type MutateAction = 'edit' | 'delete' | 'retag'

/**
 * 三个 action 规则不同，见 SPEC §3.3：
 *
 *   edit   —— **所有登录用户**
 *   delete —— 上传者或 'User'
 *   retag  —— 上传者或 'User'
 *
 * ⚠️ edit 全员开放是有意的不对称，不是漏写。标签在共享库里是公共品，谁发现标错了
 *    顺手改掉对所有人都是净收益。**不要「顺手补一个归属检查」** —— 那会把共享库
 *    最核心的一条产品决策改掉。见 SPEC §9.1。
 */
export function assertCanMutate(meme: MemeRow, actor: Actor, action: MutateAction): void {
  if (action === 'edit') return

  const isUploader = meme.uploaderId === actor.id
  const isAdmin = actor.role === 'admin'
  if (isUploader || isAdmin) return

  const what = action === 'delete' ? '删除' : '重新打标'
  throw new AppError('FORBIDDEN', `只有上传者或管理员才能${what}`)
}

/** 永远不返回软删的记录。 */
export async function findMemeById(id: string, db: Db = defaultDb): Promise<MemeRow | null> {
  const rows = await db
    .select()
    .from(memes)
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * 管理员「已删除」视图专用。
 *
 * 方法名带 includeDeleted 是故意的：**它在 code review 里必须是显眼的**。
 * 漏掉软删过滤的表现是「删掉的图又出现了」，不报错、不崩溃，比漏权限检查更隐蔽。
 */
export async function findMemeByIdIncludeDeleted(
  id: string,
  db: Db = defaultDb,
): Promise<MemeRow | null> {
  const rows = await db.select().from(memes).where(eq(memes.id, id)).limit(1)
  return rows[0] ?? null
}

export async function createMeme(input: NewMeme, db: Db = defaultDb): Promise<MemeRow> {
  const rows = await db.insert(memes).values(input).returning()
  const row = rows[0]
  if (row === undefined) throw new AppError('INTERNAL', '写入失败')
  return row
}

/** 软删。物理删除由定时任务在 30 天后做，见 SPEC §5.2.5。 */
export async function softDeleteMeme(
  id: string,
  actor: Actor,
  db: Db = defaultDb,
): Promise<void> {
  const meme = await findMemeById(id, db)
  if (meme === null) throw new AppError('NOT_FOUND', '这张表情不存在')

  assertCanMutate(meme, actor, 'delete')

  await db
    .update(memes)
    .set({ deletedAt: new Date() })
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
}

// ── 浏览接口（SPEC §6.3.2） ─────────────────────────────────────────

export type ListMemesParams = {
  emotions?: string[]
  scenes?: string[]
  tags?: string[]
  isAnimated?: boolean
  /** true 时只返回 actorId 收藏的记录。 */
  favorited?: boolean
  /** 'me' 或具体 user id。 */
  uploader?: string
  /** pending | ok | refused | needs_manual。仅本人或 admin 可传，否则抛 FORBIDDEN。SPEC §3.3 */
  tagStatus?: string
  cursor?: string
  limit?: number
}

/**
 * 游标解码结果。游标是 base64(created_at ISO + '|' + id)，不透明，客户端不解析。SPEC §1.3
 *
 * 用 created_at + id 双字段确保同秒上传的多张图也有稳定游标。
 */
function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const sep = raw.indexOf('|')
    if (sep < 0) return null
    const createdAt = new Date(raw.slice(0, sep))
    const id = raw.slice(sep + 1)
    if (isNaN(createdAt.getTime()) || id === '') return null
    return { createdAt, id }
  } catch {
    return null
  }
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url')
}

/**
 * 浏览全库，带游标分页与多条件过滤。
 *
 * tagStatus 参数的权限检查在调用方（handler）完成——数据层只负责查询，
 * 不重复做授权判断，但调用方必须先验，否则普通用户能查到他人的待处理图。
 *
 * 软删过滤硬编码在这里，调用方不能绕过。SPEC §3.4
 */
export async function listMemes(
  params: ListMemesParams,
  actorId: string | null,
  db: Db = defaultDb,
): Promise<{ items: (MemeRow & { uploaderName: string; favorited: boolean })[]; nextCursor: string | null }> {
  const limit = Math.min(params.limit ?? 40, 100)

  const conditions: SQL[] = [isNull(memes.deletedAt)]

  // 多值 AND 过滤——每个值必须在对应数组里出现
  if (params.emotions && params.emotions.length > 0) {
    for (const e of params.emotions) {
      conditions.push(sql`${memes.emotions} @> ARRAY[${e}]::text[]`)
    }
  }
  if (params.scenes && params.scenes.length > 0) {
    for (const s of params.scenes) {
      conditions.push(sql`${memes.scenes} @> ARRAY[${s}]::text[]`)
    }
  }
  if (params.tags && params.tags.length > 0) {
    for (const t of params.tags) {
      conditions.push(sql`${memes.tags} @> ARRAY[${t}]::text[]`)
    }
  }

  if (params.isAnimated !== undefined) {
    conditions.push(eq(memes.isAnimated, params.isAnimated))
  }

  if (params.uploader) {
    if (params.uploader === 'me' && actorId) {
      conditions.push(eq(memes.uploaderId, actorId))
    } else if (params.uploader !== 'me') {
      conditions.push(eq(memes.uploaderId, params.uploader))
    }
  }

  if (params.tagStatus) {
    conditions.push(eq(memes.tagStatus, params.tagStatus))
  }

  // 游标分页：按 created_at desc, id desc；游标取「上一页最后一条」之后
  if (params.cursor) {
    const decoded = decodeCursor(params.cursor)
    if (decoded) {
      // (created_at < cursor_ts) OR (created_at = cursor_ts AND id < cursor_id)
      conditions.push(
        or(
          lt(memes.createdAt, decoded.createdAt),
          and(eq(memes.createdAt, decoded.createdAt), lt(memes.id, decoded.id)),
        ) as SQL,
      )
    }
  }

  // 收藏过滤必须 JOIN，放在最后减少其他 OR 的影响
  if (params.favorited === true && actorId) {
    const rows = await db
      .select({
        meme: memes,
        uploaderName: users.name,
        favoritedAt: userFavorites.createdAt,
      })
      .from(memes)
      .innerJoin(users, eq(memes.uploaderId, users.id))
      .innerJoin(
        userFavorites,
        and(eq(userFavorites.memeId, memes.id), eq(userFavorites.userId, actorId)),
      )
      .where(and(...conditions))
      .orderBy(desc(memes.createdAt), desc(memes.id))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? encodeCursor(last.meme.createdAt, last.meme.id) : null
    return {
      items: page.map((r) => ({ ...r.meme, uploaderName: r.uploaderName, favorited: true })),
      nextCursor,
    }
  }

  // 通用路径：LEFT JOIN userFavorites 计算 favorited 字段
  const rows = await db
    .select({
      meme: memes,
      uploaderName: users.name,
      favoritedAt: userFavorites.createdAt,
    })
    .from(memes)
    .innerJoin(users, eq(memes.uploaderId, users.id))
    .leftJoin(
      userFavorites,
      actorId
        ? and(eq(userFavorites.memeId, memes.id), eq(userFavorites.userId, actorId))
        : sql`false`,
    )
    .where(and(...conditions))
    .orderBy(desc(memes.createdAt), desc(memes.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? encodeCursor(last.meme.createdAt, last.meme.id) : null

  return {
    items: page.map((r) => ({
      ...r.meme,
      uploaderName: r.uploaderName,
      favorited: r.favoritedAt !== null,
    })),
    nextCursor,
  }
}

/**
 * 单条浏览，含 favorited 字段。软删记录返回 null（调用方抛 NOT_FOUND）。SPEC §6.3.2
 */
export async function getMemeById(
  id: string,
  actorId: string | null,
  db: Db = defaultDb,
): Promise<(MemeRow & { uploaderName: string; favorited: boolean }) | null> {
  const rows = await db
    .select({
      meme: memes,
      uploaderName: users.name,
      favoritedAt: userFavorites.createdAt,
    })
    .from(memes)
    .innerJoin(users, eq(memes.uploaderId, users.id))
    .leftJoin(
      userFavorites,
      actorId
        ? and(eq(userFavorites.memeId, memes.id), eq(userFavorites.userId, actorId))
        : sql`false`,
    )
    .where(and(eq(memes.id, id), isNull(memes.deletedAt)))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  return { ...row.meme, uploaderName: row.uploaderName, favorited: row.favoritedAt !== null }
}
