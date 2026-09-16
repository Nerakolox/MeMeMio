import { createMeme, type MemeRow } from '../../src/data/memes.js'
import type { Db } from '../../src/data/db.js'
import { users, userFavorites } from '../../src/data/schema.js'
import { randomUUID } from 'node:crypto'

/**
 * 工厂函数，不写 SQL 种子文件（agents/rules/testing.md §2）。
 * 未指定的字段填合法默认值，**测试里只写出与该测试相关的字段**。
 */

/** `role` 用联合类型不用 `string`：调用方拿它去构造 Actor 时才有编译期保障。 */
export async function createUser(
  db: Db,
  overrides: { role?: 'admin' | 'member'; name?: string } = {},
): Promise<{ id: string; role: 'admin' | 'member'; name: string }> {
  const rows = await db
    .insert(users)
    .values({
      role: overrides.role ?? 'member',
      name: overrides.name ?? `user-${randomUUID().slice(0, 8)}`,
      passwordHash: 'test-hash-not-real',
      storageQuotaBytes: 1_073_741_824n,
    })
    .returning()
  const row = rows[0]
  if (row === undefined) throw new Error('建用户失败')
  // `users.role` 在库里是 `text`，Drizzle 只能把它标成 `string`（check 约束不是类型）。
  // 断言一次，让调用方拿到的 `role` 真的是那两个值之一——Actor 用它决定要不要带 cookie。
  return { id: row.id, role: row.role as 'admin' | 'member', name: row.name }
}

export async function makeMeme(
  db: Db,
  input: { uploaderId: string } & Partial<Parameters<typeof createMeme>[0]>,
): Promise<MemeRow> {
  const unique = randomUUID()
  return createMeme(
    {
      storageKey: `test/${unique}.png`,
      // content_hash 有硬唯一约束，工厂必须每次给不同值，否则第二个用例莫名其妙挂
      contentHash: unique.replace(/-/g, ''),
      phash: 0n,
      mime: 'image/png',
      sizeBytes: 1024n,
      isAnimated: false,
      ...input,
    },
    db,
  )
}

/** 与 schema 里的 `vector(1024)` 一致。向量路要有东西可搜，就得先能塞进向量。 */
export const TEST_EMBED_DIM = 1024

/**
 * 造一个单位向量：`axis` 那一维是 1，其余是 0。
 *
 * 正交向量之间的 cosine 距离都是 1，所以「离查询最近的那条」完全由轴决定，测试里一眼看得懂。
 * 用真随机向量则排序不可预期，得先算一遍才知道谁该排第一。
 */
export function unitVector(axis: number): number[] {
  const vector = new Array<number>(TEST_EMBED_DIM).fill(0)
  vector[axis] = 1
  return vector
}

/**
 * 与 `unitVector(axis)` 余弦距离最小的查询向量：稍微偏一点，但同一象限。
 *
 * 直接用 `unitVector(axis)` 当查询也行，这里偏一点是为了让「按距离升序」这件事真的被测到——
 * 查询和两条候选的相似度完全相同的话，谁在前就只取决于排序稳定性了。
 */
export function nearVector(axis: number, weight = 1, otherAxis = 1, otherWeight = 0.1): number[] {
  const vector = new Array<number>(TEST_EMBED_DIM).fill(0)
  vector[axis] = weight
  vector[otherAxis] = otherWeight
  return vector
}

export async function favoriteMeme(db: Db, userId: string, memeId: string): Promise<void> {
  await db.insert(userFavorites).values({ userId, memeId })
}
