import postgres from 'postgres'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { maintenanceUrl, testDatabaseUrl } from './helpers/db-url.js'
import { FIXTURES, fixturePath } from './helpers/fixtures.js'

/**
 * 建测试库 + 跑迁移 + 补齐缺失的图片样本，整个 vitest 进程跑一次。
 *
 * 注意这里**显式调 migrate**，而服务端启动时只做版本检查、从不自动迁移
 * （SPEC §5 / agents/rules/database.md §4）。测试库是唯一可以自动建的库。
 *
 * ⚠️ 这个文件里**任何通向 src/env.ts 的 import 都是禁止的**。它会在下面 loadEnvFile
 *    之前执行，然后 env 校验失败 exit(1)——错误信息和真正的原因毫无关系。
 *
 *    静态 import 因此只有两个，都只依赖 node 内置模块：`db-url.ts` 和 `helpers/fixtures.ts`。
 *    样本生成器（sharp）走**动态 import**，只在真缺样本时才加载——它不通向 env.ts，
 *    但把一个原生模块塞进每次测试启动的路径上没有理由。
 */

const envPath = fileURLToPath(new URL('../../.env', import.meta.url))

export async function setup(): Promise<void> {
  // vitest 不认 --env-file，自己加载一次。缺 .env 时不报错 —— CI 里变量从环境来。
  if (existsSync(envPath)) process.loadEnvFile(envPath)

  await ensureFixtures()

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

/**
 * 缺什么补什么。
 *
 * `huge.png` 是 23 MB 的纯噪声，**不进仓库**（docs/fixtures.md §2），所以新克隆里它必然
 * 缺席。少了它的表现是导入测试「单文件超限」那两条失败——**看起来像代码坏了，实际只是
 * 样本没生成**。靠 README 里写一句「先跑 npm run fixtures」是记不住的，所以放在这里。
 *
 * 清单取 `helpers/fixtures.ts` 的 `FIXTURES`，不在这里抄第二份路径：抄一份的结果是
 * 将来加样本时只改了一边，而漏的那边不报错、只是又回到「测试莫名其妙失败」。
 */
async function ensureFixtures(): Promise<void> {
  const missing = Object.values(FIXTURES).filter((rel) => !existsSync(fixturePath(rel)))
  if (missing.length === 0) return

  console.log(`缺 ${missing.length} 个图片样本，正在生成：${missing.join(', ')}`)
  // 动态 import：只有真缺样本时才把 sharp 拉进来
  const { generateFixtures } = await import('../scripts/gen-fixtures.js')
  // 'missing' 而不是 'all'：已存在的样本一个字节都不能重写，否则依赖固定哈希的断言会飘
  await generateFixtures('missing')
}
