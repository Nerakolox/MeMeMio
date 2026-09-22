import type { InferResponseType } from 'hono/client'
import { api, type TagStatusSummary } from './api'

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

/**
 * 搜索接口的编译期断言（SPEC §6.3.1）。
 *
 * 搜索结果是 `Meme & { matchedBy }`，而 `Meme` 里 `sizeBytes` 这类字段是字符串——
 * 形状对不上时这里先炸，而不是等到运行时 UI 上出现 `undefined`。
 */
export type SearchResponse = InferResponseType<typeof api.api.v1.search.$get>

const _searchShape: SearchResponse = {
  items: [
    {
      id: '00000000-0000-0000-0000-000000000000',
      uploaderId: '00000000-0000-0000-0000-000000000001',
      uploaderName: 'someone',
      url: 'https://example.invalid/a.png',
      thumbUrl: 'https://example.invalid/thumb/a.png',
      mime: 'image/png',
      width: 100,
      height: 100,
      sizeBytes: '1024',
      isAnimated: false,
      originalFilename: 'a.png',
      ocrText: null,
      description: null,
      // 六个数组字段一个不少（SPEC §4.3）。少写一个这里就编译不过——
      // v0.2.0 新增的 expressions / tones / purposes 正是靠这条断言证明
      // 「服务端真的把新维度序列化出来了」，而不是前端自己以为有。
      expressions: [],
      emotions: [],
      tones: [],
      purposes: [],
      scenes: [],
      tags: [],
      tagStatus: 'ok',
      visionModel: null,
      favorited: false,
      editedBy: null,
      editedAt: null,
      createdAt: '2026-09-13T00:00:00Z',
      matchedBy: ['vector', 'ocr'],
    },
  ],
  degraded: false,
  rewritten: null,
}

void _searchShape

/**
 * 打标汇总的编译期断言（SPEC §6.6.1）。
 *
 * `counts` 四个取值**全给、没有的写 0**，`failures[].reason` 只有五个类别——
 * 这两条是契约的一部分，字段名或取值集合变了这里先炸。
 *
 * ⚠️ 类型管不到的那两条仍然要靠测试和联合验收（web/AGENTS.md §4）：
 *    `counts` 只算未软删的记录；`failures` 里会有 `tag_status = ok` 的图。
 */
const _tagStatusShape: TagStatusSummary = {
  scope: 'mine',
  visionConfigured: false,
  counts: { ok: 982, pending: 120, refused: 0, needsManual: 7 },
  running: 2,
  failures: [
    { reason: 'unreachable', count: 4 },
    { reason: 'embed_failed', count: 1 },
  ],
}

void _tagStatusShape
