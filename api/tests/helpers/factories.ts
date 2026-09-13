import { createMeme, type MemeRow } from '../../src/data/memes.js'
import type { Db } from '../../src/data/db.js'
import { users } from '../../src/data/schema.js'
import { randomUUID } from 'node:crypto'

/**
 * 工厂函数，不写 SQL 种子文件（agents/rules/testing.md §2）。
 * 未指定的字段填合法默认值，**测试里只写出与该测试相关的字段**。
 */

export async function createUser(
  db: Db,
  overrides: { role?: string } = {},
): Promise<{ id: string; role: string }> {
  const rows = await db
    .insert(users)
    .values({
      role: overrides.role ?? 'member',
      storageQuotaBytes: 1_073_741_824n,
    })
    .returning()
  const row = rows[0]
  if (row === undefined) throw new Error('建用户失败')
  return { id: row.id, role: row.role }
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
