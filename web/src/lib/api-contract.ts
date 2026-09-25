import type { InferResponseType } from 'hono/client'
import { api, type RetagResult, type TagStatusSummary } from './api'
import type { ReindexTriggered, RuntimeConfig } from './api-config'

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
      // 七个数组字段一个不少（SPEC §4.3）。少写一个这里就编译不过——
      // v0.2.0 新增的 expressions / tones / purposes、v0.3.0 新增的 ratings
      // 正是靠这条断言证明「服务端真的把新维度序列化出来了」，而不是前端自己以为有。
      expressions: [],
      emotions: [],
      tones: [],
      purposes: [],
      scenes: [],
      tags: [],
      ratings: [],
      tagStatus: 'ok',
      visionModel: null,
      favorited: false,
      editedBy: null,
      editedAt: null,
      createdAt: '2026-09-13T00:00:00Z',
      matchedBy: ['vector', 'ocr'],
    },
  ],
  // ⚠️ **恒为 `null`，不是「碰巧是 null」**：`/search` 不分页，它 ≡ `GET /memes?q=`
  // 的冻结子集，新能力只加在 `/memes` 上（SPEC §6.3.3）。写成别的值这里就编译不过。
  nextCursor: null,
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

/**
 * 手动触发重建索引的编译期断言（SPEC §6.5.4）。
 *
 * 为什么值得单列一条：响应是 `{ enqueuedCount, ...ReindexStatus }`，而 `ReindexPanel`
 * 的反馈**整句都压在这个数上**——`> 0` 显示「已排队 N 条」，否则显示「没有新排队的记录」。
 * 字段一旦改名或消失，**前端不会报错**，只会永远走 else 那一支，也就是永远告诉管理员
 * 「没排上队」，而实际排了。这类静默在类型层拦一次比在界面上发现便宜。
 *
 * `enqueuedCount` 是**条数不是布尔**（`enqueued` 这个名字会诱导人写 `=== true`），
 * `0` 合法且常见：全库已是最新、或该排的已经排上了（幂等）。
 */
const _reindexTriggeredShape: ReindexTriggered = {
  enqueuedCount: 0,
  running: false,
  total: 0,
  done: 0,
  stale: 0,
  failed: 0,
}

void _reindexTriggeredShape

/**
 * 批量重打标的编译期断言（SPEC §6.4.3）。
 *
 * 为什么值得单列一条：`RetagPanel` 点完的反馈**整句都压在这三个数上**
 * （`enqueuedCount > 0` → 「已排上 N 张」，否则要分「全被跳过」和「本来就都在队列里」
 * 两种），而它们一旦改名前端**不会报错**，只会全部读到 `undefined`——
 * `undefined > 0` 是 false，于是永远走「没排上」那一支，**而实际排了**。
 *
 * 三个都是**条数不是布尔**（`enqueued` 这种名字会诱导人写 `=== true`），
 * `enqueuedCount` 为 `0` 合法且常见。手写请求体那个类型（`RetagInput`）推不出来，
 * 但**响应这一侧是推出来的**——所以这份断言盯的正是「服务端真的把三个计数都序列化出来了」。
 */
const _retagShape: RetagResult = {
  enqueuedCount: 74,
  skippedEditedCount: 1,
  skippedUnconfiguredCount: 0,
}

void _retagShape

/**
 * 运行参数的编译期断言（SPEC §6.5.5 / §5.6）。
 *
 * 为什么值得单列一条：两张卡片**四个格子之外的东西全压在这三个字段上**——
 *  - `cpuCount` 是 ffmpeg 那一格 `max` 的唯一来源。它改名之后前端不报错，
 *    只会在 `Math.min(undefined, 16)` 上算出 `NaN`，于是 `max="NaN"`：
 *    **上限校验静默失效**（服务端还会拒，但用户在本地看不到即时反馈）；
 *  - `updatedAt` 决定状态行说「上次修改：…」还是「这张表还没人改过」——
 *    读到 `undefined` 会永远走后者，也就是**管理员改完再进来，界面说没人改过**。
 *
 * 请求体那一侧（`RuntimeInput`）推不出来、只能手写（见 `api-config.ts`），所以这份
 * 断言盯的是**响应这一侧**：服务端真的把这三个字段序列化出来了，四个数也没改名。
 */
const _runtimeShape: RuntimeConfig = {
  tagConcurrency: 2,
  tagPerUserInflight: 1,
  importConcurrency: 2,
  ffmpegConcurrency: 2,
  cpuCount: 8,
  updatedAt: null,
  updatedBy: null,
}

void _runtimeShape
