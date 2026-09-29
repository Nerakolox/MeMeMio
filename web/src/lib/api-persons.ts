import type { InferRequestType, InferResponseType } from 'hono/client'
import { api, toApiError } from './api'

/**
 * 人物与系列的请求（SPEC §6.7，`proposed`）。遵守「只有一个地方发请求」——
 * 组件里不出现 fetch。
 *
 * **响应类型与请求体类型全部从 api 的 Hono RPC 派生，不手写**（web/AGENTS.md §4）。
 * 这一条在这里真的是免费的：第二批复用了 `routes/persons.ts` 的 `jsonBody` 中间件，
 * 所以 `InferRequestType` 拿得到请求体形状。对比 `api-config.ts` 的 `ConfigInput` /
 * `api.ts` 的 `RetagInput`——那两个接口是 handler 里手工校验的，推不出来，只能手写。
 *
 * 仍然用 `fetch` 而不是 RPC 客户端的方法调用，理由同 `api.ts`：RPC 客户端把非 2xx
 * 直接当异常抛，拿不到 SPEC §2.1 的错误信封，而 `code` 与 `requestId` 是必须展示的。
 * 类型走 RPC、请求走 fetch，两者不冲突——字段改名会编译失败，路径写错不会。
 */

// ---------------------------------------------------------------------------
// 响应类型：从 api 派生
// ---------------------------------------------------------------------------

/**
 * SPEC §6.7.2 的 Person。**`cover` 恒非 null**——图数 ≥ 1 的人物一定有封面，
 * 图数为 0 的根本不出现（§5.7.4）。所以界面不用为「人物没封面」写分支；
 * 真写了也不会被执行到，而那正是让人以为「这里可能没有封面」的假分支。
 *
 * 三个字段的含义不在类型里，读的时候要记得：
 *   - `name` 为 `null` 是「**未命名**」，不是空字符串。界面显示「未命名」，不是留白。
 *   - `isHidden` 是布尔，库里那一列是 `hidden_at` 时间戳（§5.7）。
 *   - `seriesId` / `seriesName` **同进同出**：不属于任何系列时两者都是 `null`。
 *
 * ⚠️ **没有 `assignedBy` 之类的东西，更没有相似度数值**（§6.7.2）。阈值与口径归
 *    api：数值一旦外露，前端就会长出第二套阈值。**不要试图从响应里反推排序依据。**
 */
export type Person = InferResponseType<typeof api.api.v1.persons[':id']['$get']>

/**
 * `GET /persons` 的一页。**形状与 `GET /memes` 一致**：`items` + `nextCursor`。
 *
 * 分页是游标制，`nextCursor === null` 才是收工条件（http.md §8）——不要按
 * 「这一页不满 `limit`」猜：排序是 `memeCount desc, id`，而图数在翻页途中会变，
 * **可能重复或漏一格**（§6.7.3 明写不做快照，这是一个浏览面）。
 */
export type PersonsPage = InferResponseType<typeof api.api.v1.persons.$get>

/**
 * `GET /persons/{id}/suggestions` —— 「可能是同一个」（SPEC §6.7.3）。
 *
 * ⚠️ **是 `{ items }` 信封，不是裸数组**（与 `GET /persons` 同形，但没有
 *    `nextCursor`——这里不存在分页，3 条就是全部）。按裸数组写会静默拿到
 *    `undefined`：`.map` 报错还能发现，`for (const x of res)` 直接抛，但
 *    `res.length` 会安静地是 `undefined`。
 *
 * `items` 最多 3 条、**最像的在前**（顺序是服务端算的，客户端不重排）、可以为空。
 * **按组给，没有全站清单**：探测里按组给 12.7/12.7 全对，排成一张全站列表时收全
 * 碎片要点掉 68 条错的（§9.34）。所以界面上只在某个人物的语境里问「这一组可能和谁
 * 是同一个」，**不承诺能清空**。
 *
 * ⚠️ `items` 为**空数组**与整个请求 `NOT_FOUND` 是两回事：前者渲染「暂时没有可
 *    合并的」，后者要报错。api 为此专门先查了一次人物存在性。
 */
export type PersonSuggestions = InferResponseType<
  typeof api.api.v1.persons[':id']['suggestions']['$get']
>

/** SPEC §6.7.2 的 Series。与 Person 的差别：`cover` **可以为 null**（空系列没有封面）。 */
export type Series = InferResponseType<typeof api.api.v1.series[':id']['$get']>

/** `GET /series` 的一页。排序与人物相同，**空系列照样出现**（§6.7.3）。 */
export type SeriesPage = InferResponseType<typeof api.api.v1.series.$get>

// ---------------------------------------------------------------------------
// 请求体：同样从 api 派生
// ---------------------------------------------------------------------------

/**
 * `PATCH /persons/{id}` 的请求体：**只有四个字段**，部分更新，未知字段 `VALIDATION_FAILED`
 * （§6.7.4）。三种传法含义不同：
 *   - 字段不出现 → 不改这个字段（所以只发改过的那些）
 *   - `name: null` → 回到未命名
 *   - `seriesId: null` / `coverMemeId: null` → 移出系列 / 回到自动取封面
 *
 * ⚠️ **`isHidden` 只认真正的布尔值**，`"true"` 这类字符串被拒（api 的 `parseBoolean`）。
 *    在 URL 那一侧服务端认字面量，因为那里只有字符串；请求体里 JSON 有真布尔值，
 *    接受字符串等于承认两种写法，而 `isHidden: "false"` 判真**会把人物隐藏起来**。
 */
export type PersonPatchInput = InferRequestType<typeof api.api.v1.persons[':id']['$patch']>['json']

/**
 * `POST /persons/{id}/merge` 的请求体：`{ sourceIds }`，1–20 个（§6.7.4）。
 *
 * ⚠️ **不可撤销。** 合错了的出路是把图移出来（`assignments`）。界面的确认框必须说出
 *    这一点和涉及的图数。另外「留哪个名字」由**选谁当目标**决定——目标未命名时服务端
 *    会取 `sourceIds` 里第一个有名字的，所以界面上要看得出来谁当目标。
 */
export type MergeInput = InferRequestType<typeof api.api.v1.persons[':id']['merge']['$post']>['json']

/** `POST /persons/{id}/rejections` 的请求体：`{ otherId }`。204，**幂等**（§6.7.4）。 */
export type RejectionInput = InferRequestType<
  typeof api.api.v1.persons[':id']['rejections']['$post']
>['json']

/**
 * `POST /persons/assignments` 的请求体：**三种去处恰好给一种**（§6.7.4）。
 *
 * api 把它写成了判别联合，所以「都不给」和「给两种」在**编译期**就被挡掉了——
 * 那两个正是服务端唯一会拒的形状。客户端不要把它拆成三个可选字段再自己拼。
 *
 * ⚠️ `memeIds` **不能有重复**：服务端报 `VALIDATION_FAILED` 而不是去重。
 *    去重会让 `movedCount` 报一个比实际改动多的数，**静默地说谎**。
 */
export type AssignmentsInput = InferRequestType<
  typeof api.api.v1.persons.assignments.$post
>['json']

/** `POST /series` 的请求体。`personIds` 不给 = 空系列（§6.7.3：空系列照样在列表里）。 */
export type CreateSeriesInput = InferRequestType<typeof api.api.v1.series.$post>['json']

/**
 * `PATCH /series/{id}` 的请求体。
 *
 * ⚠️ **两处与人物不一样，都是故意的**（§10.7.4 第 4 条）：
 *   - `name` **不能是 `null`**（系列名是系列的标识，清空没有意义），传了是 400。
 *     人物的 `name: null` 则是「回到未命名」。所以这个类型里没有 `| null`。
 *   - `personIds` 是**完整成员名单，不是增量**：没列出的原成员移出系列。界面上是
 *     「勾选哪些人物属于它」，整份提交与之对应。当成增量的话，取消勾选一个人物会
 *     **什么都没发生**——不报错，只是那个人物还在系列里。
 */
export type PatchSeriesInput = InferRequestType<typeof api.api.v1.series[':id']['$patch']>['json']

/** `POST /persons/assignments` 的响应：`person` 在 `none` 时是 `null`（§6.7.4）。 */
export type AssignmentsOutcome = InferResponseType<typeof api.api.v1.persons.assignments.$post>

/** `GET /admin/persons/reindex/status`（SPEC §6.7.5）。五个字段与文本那条同形同义。 */
export type PersonReindexStatus = InferResponseType<
  typeof api.api.v1.admin.persons.reindex.status.$get
>

/**
 * `POST /admin/persons/reindex` 的响应：`{ enqueuedCount, ...status }`。
 *
 * **幂等**，所以 `enqueuedCount` 为 0 不是错误——再点一次就是 0。但它**每张图都是一次
 * 付费调用**，界面上点之前要说清条数（SPEC §6.7.5）。是数字不是布尔，判断写 `> 0`。
 */
export type PersonReindexTriggered = InferResponseType<
  typeof api.api.v1.admin.persons.reindex.$post
>

// ---------------------------------------------------------------------------
// 查询参数
// ---------------------------------------------------------------------------

/**
 * `GET /persons` 的查询条件（SPEC §6.7.3）。
 *
 * 类型是手写的、与 `fetchMemes` 同一套写法，**但这是形状的便利层，不是契约的第二份**：
 * 五个参数的含义都在 §6.7.3。两个容易写错的：
 *
 *   - **`minCount` 没有服务端默认值**（不传 = 全返，任务 §10.6.3）。§2 那条
 *     「modal 默认 `minCount=2`」是**这一端的**默认值，服务端不兜。
 *   - **`named` / `hidden` 是三态，`true` / `false` 与「不传」各是一件事**（§10.6.2）。
 *     服务端只认这两个字面量，别的值 400——与 `GET /memes` 的 `isAnimated`
 *     （非 `true` 一律当 false）**刻意不同**：那边「当 false」是无害的保守取值，
 *     这边「当没传」是静默放宽。
 */
export type PersonListParams = {
  /** 名字包含，去首尾空白、不区分大小写。空串按不传（§6.7.3）。 */
  q?: string
  /** 系列 id，或 `none`（不属于任何系列）。**只在这个端点上有 `none`**。 */
  series?: string
  /** `true` 只要有名字的，`false` 只要未命名的；不传两种都要。 */
  named?: boolean
  /** `true` 只要隐藏的；**不传或 `false` 只要没隐藏的**（§6.7.3）。 */
  hidden?: boolean
  /** 图数下限。**不传是全返**，服务端没有默认值。 */
  minCount?: number
  cursor?: string
  limit?: number
}

/** `GET /series` 的查询条件。只有 `q`——系列没有图数下限与隐藏（§6.7.3）。 */
export type SeriesListParams = {
  q?: string
  cursor?: string
  limit?: number
}

// ---------------------------------------------------------------------------

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

function postJson(path: string, body: unknown, method: 'POST' | 'PATCH' | 'PUT' = 'POST'): Promise<Response> {
  return fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * 三态布尔 → 查询串。**`false` 要写出来，不能省略**（§6.7.3）：
 * `hidden` 上「不传」与「`false`」的含义恰好相同，但 `named` 上不是——
 * 不传是「两种都要」，`false` 是「只要未命名的」。省略 `false` 的表现是
 * 「筛了未命名，结果里还有有名字的」，不报错。
 */
function writeTriBool(qs: URLSearchParams, key: string, value: boolean | undefined): void {
  if (value === undefined) return
  qs.set(key, value ? 'true' : 'false')
}

// --- 人物（读） ------------------------------------------------------------

export async function fetchPersons(params: PersonListParams = {}): Promise<PersonsPage> {
  const qs = new URLSearchParams()
  if (params.q?.trim()) qs.set('q', params.q.trim())
  if (params.series) qs.set('series', params.series)
  writeTriBool(qs, 'named', params.named)
  writeTriBool(qs, 'hidden', params.hidden)
  if (params.minCount !== undefined) qs.set('minCount', String(params.minCount))
  if (params.cursor) qs.set('cursor', params.cursor)
  if (params.limit !== undefined) qs.set('limit', String(params.limit))

  return readJson<PersonsPage>(await fetch(`/api/v1/persons?${qs.toString()}`))
}

/**
 * 单个。**图全被软删时是 `NOT_FOUND`**（§5.7.4）——那个人物的行还在，但它此刻不该
 * 出现在任何地方。所以「按人物筛的浏览页头部」拿到 `NOT_FOUND` 要当**空状态**处理
 * （http.md §3 那张表），不是错误页。
 */
export async function fetchPerson(id: string): Promise<Person> {
  return readJson<Person>(await fetch(`/api/v1/persons/${id}`))
}

/**
 * 「可能是同一个」。**人物不存在时是 `NOT_FOUND` 而不是空数组**（api 专门先查一次
 * 存在性）：空数组要渲染成「暂时没有可合并的」，`NOT_FOUND` 要报错，两者对客户端
 * 不是一回事。
 */
export async function fetchPersonSuggestions(id: string): Promise<PersonSuggestions> {
  return readJson<PersonSuggestions>(await fetch(`/api/v1/persons/${id}/suggestions`))
}

// --- 人物（写） ------------------------------------------------------------

/** 响应是**更新后的完整 Person**，就地替换，不用再拉一次（§6.7.4）。 */
export async function patchPerson(id: string, patch: PersonPatchInput): Promise<Person> {
  return readJson<Person>(await postJson(`/api/v1/persons/${id}`, patch, 'PATCH'))
}

/**
 * 把 `sourceIds` 合进 `id`。响应是合并后的目标 Person。
 *
 * ⚠️ **整个请求一个事务**：任何一个人物不存在就 `NOT_FOUND` 且什么都不改。
 *    半合并（图搬过去了、来源还在）是这里最坏的失败。
 */
export async function mergePersons(id: string, input: MergeInput): Promise<Person> {
  return readJson<Person>(await postJson(`/api/v1/persons/${id}/merge`, input))
}

/** 记一条「不是同一个」。**204、幂等**——双击、重试都该成功，所以不处理 404 之类。 */
export async function rejectPerson(id: string, input: RejectionInput): Promise<void> {
  const res = await postJson(`/api/v1/persons/${id}/rejections`, input)
  if (!res.ok && res.status !== 204) throw await toApiError(res)
}

/**
 * 把几张图放进一个人物 / 拆成新人物 / 移出（§6.7.4）。
 *
 * ⚠️ **图不存在或已软删是 `NOT_FOUND`，整个请求不生效**；人物那一侧不存在是
 *    `VALIDATION_FAILED`（§10.7.4 第 2 条，服务端的口径，客户端照着展示 message 即可
 *    ——**不要自己按 code 猜是哪一侧出错**，两种都被 SPEC 允许、服务端可能改）。
 */
export async function assignMemes(input: AssignmentsInput): Promise<AssignmentsOutcome> {
  return readJson<AssignmentsOutcome>(await postJson('/api/v1/persons/assignments', input))
}

// --- 系列 ------------------------------------------------------------------

export async function fetchSeries(params: SeriesListParams = {}): Promise<SeriesPage> {
  const qs = new URLSearchParams()
  if (params.q?.trim()) qs.set('q', params.q.trim())
  if (params.cursor) qs.set('cursor', params.cursor)
  if (params.limit !== undefined) qs.set('limit', String(params.limit))

  return readJson<SeriesPage>(await fetch(`/api/v1/series?${qs.toString()}`))
}

/** 单个。**空系列照样返回**，只有不存在才是 `NOT_FOUND`（§6.7.3）。 */
export async function fetchSeriesById(id: string): Promise<Series> {
  return readJson<Series>(await fetch(`/api/v1/series/${id}`))
}

/**
 * 新建。**同名是 `CONFLICT`**（去首尾空白、不区分大小写，§6.7.4）——服务端有唯一索引，
 * 撞车是 409 不是 400。界面要就地提示「这个名字已经有了」，不是弹一个通用错误。
 *
 * ⚠️ **状态码是 200，不是 201**（§10.7.4 第 1 条）。任务文件明确写着这一条定下来之前
 *    别写状态码分支——所以这里和别的写接口一样只判 `res.ok`，**没有 201 的特判**。
 */
export async function createSeries(input: CreateSeriesInput): Promise<Series> {
  return readJson<Series>(await postJson('/api/v1/series', input))
}

/** 改名 / 改成员。`personIds` 是**完整名单**，见 `PatchSeriesInput` 的注释。 */
export async function patchSeries(id: string, input: PatchSeriesInput): Promise<Series> {
  return readJson<Series>(await postJson(`/api/v1/series/${id}`, input, 'PATCH'))
}

/**
 * 删系列，204。**权限是「创建者或 admin」**，其余 `FORBIDDEN`（§6.7.1）。
 *
 * 删的只是 `series` 这一行：其下人物还在，`seriesId` 置空（§5.7.3）。所以确认框里
 * 那句「人物不会被删」是要说出来的——不说的话没人敢点。
 *
 * 已删的再删一次是 `NOT_FOUND`，理由同 `DELETE /memes/{id}`（§6.4.2）。
 */
export async function deleteSeries(id: string): Promise<void> {
  const res = await fetch(`/api/v1/series/${id}`, { method: 'DELETE' })
  if (res.ok || res.status === 204) return
  throw await toApiError(res)
}

// --- 人物向量补跑（仅管理员，SPEC §6.7.5） ---------------------------------

/**
 * 手动补跑存量。**第一次配好图片向量不会自动补**（§6.7.5）——这是有意的：
 * 每张图都是一次付费调用，不能由「保存配置」这个动作静默触发。
 *
 * **幂等**：只排「未软删且没有当前口径向量」的，再点一次是 0。
 */
export async function startPersonReindex(): Promise<PersonReindexTriggered> {
  return readJson<PersonReindexTriggered>(await postJson('/api/v1/admin/persons/reindex', {}))
}

/**
 * 补跑进度。来自库里的真实计数。
 *
 * ⚠️ **它不影响 `degraded`**——那个字段只说检索的向量路，人物不参与检索召回
 * （§6.7.5）。所以「人物向量没算完」不会让搜索结果打上降级提示，这是对的。
 */
export async function fetchPersonReindexStatus(): Promise<PersonReindexStatus> {
  return readJson<PersonReindexStatus>(await fetch('/api/v1/admin/persons/reindex/status'))
}
