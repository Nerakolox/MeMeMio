import { drizzle } from 'drizzle-orm/postgres-js'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import postgres from 'postgres'
import { env } from '../env.js'
import * as schema from './schema.js'

/**
 * 数据库连接。这一层之上（services / routes）不认识 sql 客户端，只认识 db。
 *
 * `Db` 刻意写成 `PgDatabase` 的形状而不是 `ReturnType<typeof createDb>['db']`：
 * 事务里的 `tx` 和连接上的 `db` **不是同一个类型**（后者多一个 `$client`），
 * 用具体类型会让「能把 db 传进去」的函数收不下 `tx`，于是同事务写入只能各写各的，
 * 而 `createMeme` + `enqueueTagJob` 必须同事务——见 data/tag-jobs.ts 的说明。
 *
 * 收窄成 `PgDatabase` 之后两者都能传，代价是这一层不再能用 `$client`。
 * 这是有意的：数据层本来就不该直接摸连接。
 */
export type Db = PgDatabase<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>

export function createDb(databaseUrl: string = env.databaseUrl) {
  const sql = postgres(databaseUrl, {
    max: 10,
    // 静默的连接泄漏比慢查询难查得多，宁可早点报出来
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  })
  const db = drizzle(sql, { schema })
  return { sql, db }
}

const connection = createDb()

export const sql = connection.sql
export const db = connection.db

/** 启动顺序第 2 步：连不上就重试几次再 exit(1)，不要带着坏连接起 HTTP。 */
export async function waitForDatabase(attempts = 5, delayMs = 1000): Promise<void> {
  let lastError: unknown
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await sql`select 1`
      return
    } catch (error) {
      lastError = error
      if (i < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new Error(`数据库连接失败（试了 ${attempts} 次）：${String(lastError)}`)
}
