import type { InferResponseType } from 'hono/client'
import { api } from './api'

/**
 * 骨架任务的**验证点 1**，留在仓库里当编译期断言：
 *
 *   改掉 api 里 health 响应的任何一个字段名 → `npm run typecheck` 在这个文件上失败。
 *
 * 它证明类型链路真的通了，而不是两边各写了一份长得像的类型。
 * 这个断言没有运行时代价 —— 整个文件在构建后会被擦除。
 *
 * ⚠️ `npm run build` 走的是 vite（esbuild），**不做类型检查**。这条保证由
 *    `npm run typecheck` 提供，提交前必须跑，见 agents/rules/git-and-delivery.md。
 */

export type HealthResponse = InferResponseType<typeof api.api.v1.health.$get>

// 字段名对不上就编译不过；字段多了少了也编译不过。
const _healthShape: HealthResponse = {
  status: 'ok',
  startedAt: '2026-09-13T00:00:00Z',
  vocabVersion: '0.1.0',
}

void _healthShape
