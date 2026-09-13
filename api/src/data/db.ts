import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env.js'
import * as schema from './schema.js'

/**
 * 数据库连接。这一层之上（services / routes）不认识 sql 客户端，只认识 db。
 */

export type Db = ReturnType<typeof createDb>['db']

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
