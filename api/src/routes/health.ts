import { Hono } from 'hono'
import { vocabulary } from '../vocab.js'

/**
 * GET /api/v1/health
 *
 * 它同时是骨架的类型链路样本：web 通过 Hono RPC 消费这里的返回类型，
 * **改掉任何一个字段名，web 侧 npm run typecheck 会失败**。
 * 见 joint-tasks/2026-09-13-skeleton.md 的验证点 1。
 */

const startedAt = toIsoSeconds(new Date())

export const healthRoutes = new Hono().get('/', (c) => {
  return c.json({
    status: 'ok' as const,
    startedAt,
    /** 证明 api 读到的是 shared/vocab/vocab.json 那一份，不是自己抄的副本 */
    vocabVersion: vocabulary.version,
  })
})

/** ISO 8601 UTC，带 Z，精确到秒。SPEC §1.2 */
function toIsoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`
}
