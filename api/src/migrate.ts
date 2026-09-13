import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './data/db.js'
import { env } from './env.js'
import { log } from './logger.js'
import { MIGRATIONS_DIR } from './paths.js'

/**
 * 迁移命令。**独立执行，不在容器启动流程里自动跑**（docs/deployment.md §6）。
 *
 *   本机    cd api && npm run migrate
 *   部署机  docker compose run --rm app node dist/migrate.js
 *
 * 可重复执行：drizzle 在 drizzle.__drizzle_migrations 里记账，跑过的不会再跑一遍。
 */
async function main(): Promise<void> {
  const { sql, db } = createDb()
  try {
    log.info({ dir: MIGRATIONS_DIR, nodeEnv: env.nodeEnv }, '开始迁移')
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
    log.info({}, '迁移完成')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, '迁移失败')
  process.stderr.write(`\n迁移失败：${error instanceof Error ? error.message : String(error)}\n\n`)
  process.exit(1)
})
