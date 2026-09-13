import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql as raw } from 'drizzle-orm'
import type { Db } from './db.js'
import { MIGRATIONS_DIR } from '../paths.js'

/**
 * 迁移版本检查。
 *
 * 启动顺序第 3 步**只检查，不执行**（agents/rules/env-validation.md §3）。
 * 生产环境自动跑迁移是事故来源：多副本时会并发迁移，而那种故障发生在启动瞬间，最难排查。
 * 执行走独立命令：docker compose run --rm app node dist/migrate.js
 */

type Journal = {
  entries: Array<{ idx: number; tag: string }>
}

/** 仓库里应该有的迁移（migrations/meta/_journal.json 是 drizzle 维护的）。 */
export function expectedMigrations(): string[] {
  const journalPath = join(MIGRATIONS_DIR, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as Journal
  return journal.entries.map((entry) => entry.tag)
}

/** 数据库里已经跑过的迁移条数。表不存在 = 一条都没跑过。 */
export async function appliedMigrationCount(db: Db): Promise<number> {
  const rows = await db.execute<{ count: string }>(raw`
    select count(*)::text as count
    from drizzle.__drizzle_migrations
  `).catch(() => null)

  if (rows === null) return 0
  const first = rows[0] as { count?: string } | undefined
  return Number(first?.count ?? 0)
}

export type MigrationState = {
  expected: number
  applied: number
  upToDate: boolean
  pending: string[]
}

export async function checkMigrations(db: Db): Promise<MigrationState> {
  const expected = expectedMigrations()
  const applied = await appliedMigrationCount(db)
  return {
    expected: expected.length,
    applied,
    upToDate: applied >= expected.length,
    pending: expected.slice(applied),
  }
}
