import { and, eq, isNull } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { memes } from './schema.js'
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

/** 当前操作者。role 取值见 SPEC §3.2，'User' 是管理员。 */
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
  const isAdmin = actor.role === 'User'
  if (isUploader || isAdmin) return

  const what = action === 'delete' ? '删除' : '重新打标'
  throw new AppError('FORBIDDEN', `只有上传者或管理员可以${what}`)
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
