import postgres from 'postgres'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { maintenanceUrl, testDatabaseUrl } from './helpers/db-url.js'

/**
 * 建测试库 + 跑迁移，整个 vitest 进程跑一次。
 *
 * 注意这里**显式调 migrate**，而服务端启动时只做版本检查、从不自动迁移
 * （SPEC §5 / agents/rules/database.md §4）。测试库是唯一可以自动建的库。
 *
 * ⚠️ 这个文件**只能 import 零依赖的 db-url.ts**。任何通向 src/env.ts 的 import
 *    都会在下面 loadEnvFile 之前执行，然后 env 校验失败 exit(1)。
 */

const envPath = fileURLToPath(new URL('../../.env', import.meta.url))

export async function setup(): Promise<void> {
  // vitest 不认 --env-file，自己加载一次。缺 .env 时不报错 —— CI 里变量从环境来。
  if (existsSync(envPath)) process.loadEnvFile(envPath)

  const base = process.env['DATABASE_URL']
  if (base === undefined || base === '') {
    throw new Error(
      '测试需要 DATABASE_URL。本地先跑：docker compose -f compose.yaml -f compose.dev.yaml up -d db',
    )
  }

  const target = testDatabaseUrl(base)
  const name = new URL(target).pathname.replace(/^\//, '')

  const admin = postgres(maintenanceUrl(base), { max: 1, onnotice: () => {} })
  try {
    const rows = await admin`select 1 from pg_database where datname = ${name}`
    if (rows.length === 0) await admin.unsafe(`create database "${name}"`)
  } finally {
    await admin.end()
  }

  const sql = postgres(target, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    })
  } finally {
    await sql.end()
  }
}
