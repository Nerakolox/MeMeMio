/**
 * 零 import —— **global-setup 只能依赖这个文件**。
 *
 * 踩过的坑：global-setup 里先 `process.loadEnvFile()` 再用变量，看着没问题，
 * 但 import 在函数体之前就执行完了。只要它间接 import 到 `src/env.ts`，
 * env 校验就会在 .env 加载之前跑，然后 exit(1)，整个测试一个用例都没跑就死。
 */

/** 从 DATABASE_URL 推出测试库地址：库名后缀 `_test`。 */
export function testDatabaseUrl(base: string): string {
  const url = new URL(base)
  const name = url.pathname.replace(/^\//, '')
  if (name === '') throw new Error('DATABASE_URL 里没有库名')
  if (name.endsWith('_test')) return url.toString()
  url.pathname = `/${name}_test`
  return url.toString()
}

/** 连到 postgres 维护库，用来 CREATE DATABASE —— 目标库还不存在时连不上它自己。 */
export function maintenanceUrl(base: string): string {
  const url = new URL(base)
  url.pathname = '/postgres'
  return url.toString()
}

export function requireDatabaseUrl(): string {
  const value = process.env['DATABASE_URL']
  if (value === undefined || value === '') {
    throw new Error(
      '测试需要 DATABASE_URL。先跑：docker compose -f compose.yaml -f compose.dev.yaml up -d db',
    )
  }
  return value
}
