import type { InferResponseType } from 'hono/client'
import { api, type MemesResponse, type RetagResult, type TagStatusSummary } from './api'
import type { ImageEmbedTestResult, ReindexTriggered, RuntimeConfig } from './api-config'
import type {
  AssignmentsOutcome,
  Person,
  PersonReindexTriggered,
  PersonSuggestions,
  Series,
} from './api-persons'

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
 * 列表端点的编译期断言（SPEC §6.3）。
 *
 * 列表条目是 `Meme & { matchedBy }`，而 `Meme` 里 `sizeBytes` 这类字段是字符串——
 * 形状对不上时这里先炸，而不是等到运行时 UI 上出现 `undefined`。
 *
 * ⚠️ 落点跟着**列表端点**走。`/search` 已随检索筛选合流删掉（SPEC §9.29），`GET /memes`
 *    是这个形状（§6.3「响应形状恒定」）现在唯一的载体，它守的仍是
 *    「条目 = `Meme & { matchedBy }`、七个数组字段一个不少」（§4.3 / §6.3.1）。
 */
const _memesShape: MemesResponse = {
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
  // ⚠️ `nextCursor` 是 **`string | null`**，不是恒为 `null`（SPEC §6.3）：检索时它指向
  // 一次检索快照里的位置、浏览时是 `(created_at, id)` 全序上的位置，到头了才是 `null`。
  // 这里写 `null` 只是**取了一个合法值**——它能编过，不代表真实响应里恒是它。
  // 它是恒在的键（两个分支都给，§6.3「响应形状恒定」）：哪天它从响应里消失，这里就编译不过。
  nextCursor: null,
  // 两个检索字段同样恒在：无 `q` 时是常量 `false` / `null`，不是「字段不存在」（§6.3）。
  degraded: false,
  rewritten: null,
}

void _memesShape

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

/**
 * 人物与系列的编译期断言（SPEC §6.7.2、人物与系列那一批 2026-09-30）。
 *
 * ## 为什么这几条值得单列
 *
 * 三条都踩在「字段没了不会报错，只会变成一个自信的错答案」上——这正是本文件存在的理由：
 *
 * 1. **`Person.cover` 恒非 null**，而 `Series.cover` 可以为 null（空系列）。
 *    把后者当非空用，界面上是一张加载失败的图；把前者当可空用，是空系列那条路
 *    被写成了「封面缺失」——两种都只在特定数据下才看得见。
 * 2. **`/suggestions` 是包着 `items` 的信封，不是裸数组**（§6.7.3）。
 *    ⚠️ 这一条是**这次真踩过的**：网页这一侧一开始按裸数组读，类型检查照样过
 *    （`.map` 在 `any` 上不报错），跑起来才是 `items.map is not a function`。
 *    断言把它钉死在编译期。
 * 3. **`enqueuedCount` 是那个补跑面板唯一的记账**（`PersonsReindexPanel`），
 *    它改名之后前端不报错，只会永远说「没有新排队的记录」，而实际排了——
 *    与 `_reindexTriggeredShape` 是同一个失败模式，只是这次花的是按张计费的钱。
 */
const _personShape: Person = {
  id: '00000000-0000-0000-0000-000000000000',
  name: null,
  seriesId: null,
  seriesName: null,
  isHidden: false,
  memeCount: 3,
  // 恒非 null：图数 ≥ 1 的人**一**定有封面（§5.7.4）
  cover: { memeId: '00000000-0000-0000-0000-000000000001', thumbUrl: 'https://example.invalid/t.webp' },
  updatedBy: null,
  updatedAt: null,
}

void _personShape

const _seriesShape: Series = {
  id: '00000000-0000-0000-0000-000000000000',
  name: '某个作品',
  personCount: 2,
  memeCount: 8,
  // 可以为 null——**空系列没有封面**（§6.7.2）
  cover: null,
  createdBy: '00000000-0000-0000-0000-000000000002',
  createdAt: '2026-09-30T00:00:00Z',
  updatedBy: null,
  updatedAt: null,
}

void _seriesShape

/** 信封，不是裸数组。少写这一层就是上面第 2 条那个失败。 */
const _suggestionsShape: PersonSuggestions = { items: [_personShape] }

void _suggestionsShape

/**
 * `{ movedCount, person }`——`person` 在 `none: true` 那一支是 **null**（§6.7.4）。
 * 「不是 X」之后界面对这两个字段各有各的用法：`movedCount` 是回执，`person` 为 null
 * 恰好是「它现在不属于任何人物」的确认。
 */
const _assignmentsShape: AssignmentsOutcome = { movedCount: 1, person: null }

void _assignmentsShape

const _personReindexTriggeredShape: PersonReindexTriggered = {
  enqueuedCount: 0,
  running: false,
  total: 0,
  done: 0,
  stale: 0,
  failed: 0,
}

void _personReindexTriggeredShape

/**
 * 图片向量的测试结果（SPEC §6.7.5）。
 *
 * ⚠️ `imageInputWorks` 改名或消失的后果**比别处更坏**：`imageEmbedProbes` 判的是
 *    `value === null ? 未探测 : value ? ✓ : ✗`，而 `undefined` 三种都不是——它会落进
 *    ✗ 那一支，界面上就是**「上游没有在编码图片，图片被丢掉了」**，
 *    一个言之凿凿的错结论。管理员会照它去换模型，而模型本来是好的。
 */
const _imageEmbedTestShape: ImageEmbedTestResult = {
  ok: false,
  nativeDim: 1024,
  dimParamWorks: true,
  willTruncate: false,
  imageInputWorks: false,
  rawError: null,
}

void _imageEmbedTestShape
