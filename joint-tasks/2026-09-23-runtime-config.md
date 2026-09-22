# 运行参数：并发上限进管理页，改完不用重启（`GET` / `PUT /admin/runtime`）

**状态**：`in_progress`——契约已转 `accepted`（2026-09-23），两端实现都已落。**未转 `done`**：联合验收要求真 api × 真浏览器跑一次，而本任务 web 侧的全部断言都对着替身。理由与解除路径见文末「总管裁定」。

**性质**：**跨端**——新增接口、新增数据表、改 SPEC 五处；web 需要新的表单卡片（类型仍从 Hono RPC 来，没有生成步骤）。
**来历**：产品负责人 2026-09-23：「应该放在设置页面作为一个配置项，可以动态变化。」三个选型当面定下（见下表）。
**SPEC**：[§3.3](../spec/03-auth-permission.md)（权限矩阵 +1 行）、[§5.6](../spec/05-data-models.md)（新增）、[§6.5.5](../spec/06-endpoints.md)（新增）、[§9.9](../spec/09-decisions.md)（文案是契约）、[§9.11](../spec/09-decisions.md)（不引入 Redis）、[§9.25](../spec/09-decisions.md) ③（本次的触发条件）、[§9.26](../spec/09-decisions.md)（新增，划线判据）
**相关规则**：[queue.md](../api/agents/rules/queue.md) §1 / §3 / §4、[image-pipeline.md](../api/agents/rules/image-pipeline.md) §8、[env-validation.md](../api/agents/rules/env-validation.md) §1、[project-structure.md](../api/agents/rules/project-structure.md)、[web/agents/rules/settings-ux.md](../web/agents/rules/settings-ux.md)

---

## 为什么要做

**症状**：并发上限是四处模块级 `const`，而它们是**机器规格相关**的数——一台 2 核小机器和一台 16 核机器需要不同的值，改一次却要改代码 + 重新部署。

| 常量 | 位置 | 值 |
|---|---|---|
| `CONCURRENCY`（打标） | `queue/worker.ts:28` | 2 |
| `PER_USER_INFLIGHT` | `queue/worker.ts:36` | 1 |
| `PIPELINE_CONCURRENCY`（导入） | `services/import.ts:37` | 2 |
| `FFMPEG_CONCURRENCY` | `image/constants.ts:40` | 2 |

第一条痛点已经写在 [§9.25](../spec/09-decisions.md) 的推翻条件里：**`PER_USER_INFLIGHT = 1` 让单用户库的吞吐退化成 1 条/次**，`CONCURRENCY = 2` 的第二个槽空转，75 张重打要 9–20 分钟。那次结论是「要论证的是**并发分配规则**在单用户库上的退化」——本任务就是那次论证。

第二条痛点只有管理员能感觉到：**导入那条线的真旋钮不是 `PIPELINE_CONCURRENCY`，是 ffmpeg 的进程级全局 2 槽**（`image/probe.ts:19-34` 的 `running` + `waiters`）。只暴露前者，调完会发现一点没变快，然后不知道为什么。两者必须一起给。

**为什么不放普通用户的设置页。** 并发是机器资源与 AI 账单，不是用户配额。按 [§3.3](../spec/03-auth-permission.md) 的权限矩阵，全站一份的配置（Embedding）是「仅 admin」，[§9.9](../spec/09-decisions.md) 也写明「全站一份的配置在管理页」。放普通用户的设置页，等于让任何 member 一个人把机器和账单打爆——这是「错了会出事故」那一类。

---

## 三个选型（已定）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 暴露哪几个 | **打标 + 导入两条线共 4 项**：`tagConcurrency`、`tagPerUserInflight`、`importConcurrency`、`ffmpegConcurrency`。重建索引并发、任务超时、轮询间隔**不做**（理由见 §9.26：超时与 `STALE_RUNNING_MS` 有硬关系，可独立调节就会有人调反，表现是同一张图付两次钱） |
| 2 | ffmpeg 上限怎么控 | **可下调，上调封顶 `min(CPU 核数, 16)`**。核数是「这台机器同时能跑几个 ffmpeg」唯一有依据的判据 |
| 3 | 生效证据 | **不新增状态端点**，复用 [§6.6.1](../spec/06-endpoints.md) 的 `GET /memes/tag-status`——`counts.pending` 的下降速率就是它 |

**对选型 2 措辞的一处修正（总管）**：越界**报错**（`VALIDATION_FAILED`），不静默 clamp。静默截断的表现是「填了 16、提示保存成功、回显 2」，管理员会以为没存上——这个仓已经因为「静默」吃过几次亏（`retag` 对已 `done` 行的入队、`filter.uploader` 的形状校验排在角色判断之后）。「不信客户端」这条不变：服务端是唯一校验点，前端只为体验做即时提示。

---

## 契约

新增单行表 `runtime_config`（[§5.6](../spec/05-data-models.md)），四个列**可空，`NULL` = 用代码默认值**。空表是正常状态，不是未初始化。

| 字段 | 下限 | 上限 | 默认 |
|---|---|---|---|
| `tagConcurrency` | 1 | 16 | 2 |
| `tagPerUserInflight` | 1 | 4 | 1 |
| `importConcurrency` | 1 | 8 | 2 |
| `ffmpegConcurrency` | 1 | `min(CPU 核数, 16)` | 2 |

交叉约束：`tagPerUserInflight ≤ tagConcurrency`，违反按越界处理（大于总槽数时这一项等于不存在，**静默无效的配置比报错更难查**）。

- `GET /admin/runtime` → 四个**生效值** + `cpuCount` + `updatedAt` / `updatedBy`。**没有 `source` 字段**——这里没有「用户配置 vs 部署方 env 默认」两层来源，默认值只有代码常量这一处，见 §5.6
- `PUT /admin/runtime` → 四个字段**全部必填**，一次性提交整组（不做部分更新：它本来就是四格表单，部分更新会让界面不知道该显示哪一次的值）
- **返回生效值而不是原始值**，界面不需要知道哪些列是空的。等于默认值的输入保存时**归一成 `NULL`**——否则一个显式存的 `2` 会在默认值改成别的数之后把它钉住，而界面上看不出「这是被钉住的旧默认值」
- 生效**不是「立即」**：承诺的措辞是「保存后**新开的**任务按新值跑」。打标 worker 下一轮 tick 读到，而那一轮可能正卡在等一个在途任务完成上；导入按批次读，**已经在跑的批次整批用旧值**

---

## 必须写进注释的陷阱

### 陷阱一 · ffmpeg 上调必须主动唤醒等待者，否则静默失效

`image/probe.ts:19-34`：`waiters` 只在 `releaseSlot()` 里被唤醒。管理员把上限从 2 调到 4 时，若此刻 4 个任务在等、2 个在跑，**没有 `releaseSlot` 会发生**（在跑的还没结束）→ 新上限不生效，直到某个 ffmpeg 自然结束。不报错、不告警，表现就是「调了没用」。

`setFfmpegConcurrency(n)` 在**上调**时必须自己补足唤醒 `waiters`。下调不需要做任何事（多出来的会自然排走）。

### 陷阱二 · 读配置必须在 tick 的 early-return 之前

`queue/worker.ts:131` 的 `if (self.inFlight.size >= CONCURRENCY) { await Promise.race(...); return }` 今天比的是常量。如果把读配置放在 `isVisionConfigured()`（`:141`）旁边，那么这一轮 tick 仍按旧值判断，而且它可能正卡在 race 上——**调高的生效延迟会变成「一个在途任务的自然耗时」，最长 90 秒**（`JOB_TIMEOUT_MS`）。放到 tick 开头读。

**不要为了让「立即生效」更快去打断那个 race。** 见陷阱三。

### 陷阱三 · 不要打断在途任务

`queue/worker.ts:89-97` 写明停机要等在途任务跑完，理由是砍掉的任务会永远停在 `running`，表现是「这几张图再也不会被打标」——不报错、不告警。并发变更走同一条约束：**不重新读配置就改行为的做法一律不做**。

### 陷阱四 · 默认值只有一个真源

`NULL` = 代码默认，归一化在保存时做。四个默认值仍然只在 `worker.ts:28`/`:36`、`services/import.ts:37`、`image/constants.ts:40` 各写一次——**不要在 `data/` 或 `services/` 里再抄一份「默认值表」**，那会变成两处会分叉的知识。

### 陷阱五 · 「每进程」不能写成「全站」

四个数都是**每个服务进程**的。多副本时实际全局上限 = 配置值 × 进程数（这个仓的 `GET /memes/tag-status` 的 `running` 也已经是「合计所有副本」，两处口径要能对上）。接口文案、UI 文案、SPEC 三处措辞都必须按「每个服务进程」说。**写「全站最多 N 张」在多副本下就是假的。**

### 陷阱六 · 导入并发的收益低于预期，不要为此改哈希

`services/import.ts:167` 的 `createHash('sha256').update(bytes).digest('hex')` 是**同步** CPU 工作（20MB 文件几十毫秒），它会挡住本进程所有在途任务。所以「管线并发 2→8」不会线性变快。**不要为了绕过它去改 `content_hash` 的算法**——那是 `memes.content_hash` 唯一约束的依据，改它等于换一套去重口径。

---

## api 端要改什么

| 文件 | 改什么 |
|---|---|
| `api/migrations/0008_*.sql`（新） | 建 `runtime_config`，照 `embedConfig`（`schema.ts:221-233`）的单行模式带 `check (id = 1)`。**不改已合入的迁移**（`project-structure.md:48-50`） |
| `api/src/data/schema.ts` | 新增 `runtimeConfig` 表。注意 `schema.ts:19-22`：表结构主源是 SPEC §5，**本次 SPEC 已先改** |
| `api/src/data/runtime-config.ts`（新） | 唯一的 SQL 落点：`loadRuntimeConfig()`（现查单行，照 `data/ai-configs.ts:270-283` 的 `loadEmbedCredentials`）、`saveRuntimeConfig()`（等于默认值归一成 `NULL`）。**不缓存**——多副本下只有读库才能跨进程 |
| `api/src/services/runtime-config.ts`（新） | 校验（四组上下限 + 交叉约束）+ 组装响应（补 `cpuCount`）。校验写法参照 `services/ai-config.ts:210-257` 的三道闸门。`cpuCount` 用 `os.availableParallelism()`，**一处取值、两处用**（校验上限 + 响应字段），不要在两处各算一次 |
| `api/src/routes/admin.ts` | `GET` / `PUT /runtime`。整组已经是 `.use('*', requireAdmin)`（`admin.ts:28`），**优先挂进这个已有路由组**——新开一组要在 `app.ts:23-27` 注册，而那条链断了 RPC 类型会退化成 `any`（`app.ts:16` 的注释） |
| `api/src/queue/worker.ts` | ①tick 开头读一次运行参数，替换 `:131` 与 `:146-147` 两个使用点；②**在同一处调 `setFfmpegConcurrency`**——打标路径也过 ffmpeg（`services/tagging.ts:186-193` 的 `withTempFile` → `probeMetadata` / `extractFrames`），不设的话打标那条路永远用默认值 |
| `api/src/services/import.ts` | `runBatch` 开头读一次（`:47`），替换 `:56-57` 的 `PIPELINE_CONCURRENCY`，并调 `setFfmpegConcurrency` |
| `api/src/image/probe.ts` | 新增 `setFfmpegConcurrency(n)`：改上限 + **上调时唤醒 `waiters`**。⚠️ `image/` 层不认识 `db`（`project-structure.md` 分层），**上限由调用方传入，这里不读库** |
| `api/src/image/constants.ts` | 文件头注释按 §9.26 收窄适用范围：写清「保护机器」的四个数已移到 §5.6 的单行表，而 `MAX_FRAMES` / `AI_LONG_EDGE` / `COLLAGE_FRAMES` / 两个阈值**仍然留在这里**，判据是「改变产出 vs 改变吞吐」。`FFMPEG_CONCURRENCY` 那个常量要标明它现在只是**默认值**（不再是唯一来源） |
| `api/src/queue/reindex-worker.ts`、`services/import.ts` 的「本进程」注释 | 保留，补一句指向 §5.6——这几处注释今天写得对，加了配置之后更容易被误读成「全站」 |

**响应**：`{ tagConcurrency, tagPerUserInflight, importConcurrency, ffmpegConcurrency, cpuCount, updatedAt, updatedBy }`。`updatedAt` 用 `toIsoSecondsOrNull`（`routes/config.ts:93` 同款）。

## web 端要改什么

| 文件 | 改什么 |
|---|---|
| `web/src/features/settings/RuntimeSettings.tsx`（新） | 照 `EmbedSettings.tsx` 的形态（SettingsCard + 状态 Badge + 表单 + 行内反馈）——它就是「全站一份、仅管理员」那一个形态。**不要套 `use-config-form.ts`**：那个 hook 是「必须先测连接才能保存」的流程，纯数字配置没有测试环节 |
| `web/src/routes/settings.tsx` | `SECTIONS`（`:37-42`）加一项「运行参数」，渲染位置紧挨 `Embedding` 之后（同为全站一份的配置），**在 `users` 之前**。⚠️ `ReindexPanel` / `RetagPanel` 不进 `SECTIONS`（它们没有 `id`，是运维动作面板）——本卡片是**配置项**，与 `EmbedSettings` 同类，所以进 |
| `web/src/lib/api-config.ts` | 派生类型（照 `:26-67`）+ `fetchRuntimeConfig` / `putRuntimeConfig` 薄函数（照 `:102-164`，走 `readJson` 拿到错误信封的 `code` / `requestId`） |
| `web/src/lib/api-contract.ts` | 加编译期形状断言（照 `:20-74`）。这四个字段都是「编译得过但含义可能错」的（比如 `tagPerUserInflight` 是每进程不是全站），值得一条 |
| `web/src/features/settings/settings-copy.ts` | 落文案（该文件是「逐字抄自 `settings-ux.md §4`」的搬运点） |
| `web/agents/rules/settings-ux.md` | §2 的分段表加一行「运行参数 / 仅 admin / 并发上限，全站一份」 |

**数字输入的形态**：照 `UsersSettings.tsx:173-180`（裸 `<Input type="number">` + 本地按字符串存 + 不做前端 clamp + 服务端校验 + 行内 `role="alert"` 小字）。**不引入新组件**——仓里没有带 min/max 校验的数字输入组件，为四个格子造一个不值得。`ffmpegConcurrency` 的 `max` 用接口返回的 `cpuCount`。

**反馈**：保存成功 → 行内 `<p role="status">已保存</p>`，**不自动消失**（`http.md §5` 明确不弹 toast）；失败 → `Alert variant="destructive"` + `AlertTitle` 带 message 与 requestId。触摸目标走 `lib/touch.ts` 的 `TOUCH`。

## 文案（契约，先落 SPEC 再落 web）

`§9.9` 要求约束写在输入框旁边。**✅ 已落 [§9.9](../spec/09-decisions.md) 第三块（2026-09-23，总管）——现行版本以 SPEC 为准**，下面这段是当时的初稿，留在这里只为记过程。web 执行者不要自行改写或删减，要改回总管：

```
⚠️ 这几个数改的是全站资源分配，不是你的偏好

打标
  · 并发任务数 —— 同时打标几张。调大等于同时烧几份视觉调用的钱
  · 每用户在途 —— 一个人最多占几个槽；填得比「并发任务数」大是无效配置，会被拒绝

导入
  · 管线并发 —— 同时处理几个文件。超过下面的 ffmpeg 上限不会更快，只会排队
  · ffmpeg 上限 —— 同时几个 ffmpeg 子进程。每个可能吃数百 MB 内存，
    所以上限锁在本机核数

生效
  · 保存后**新开的**任务按新值跑。正在打的图和正在跑的导入批次不中途改
  · 有没有生效看这里：打标队列的积压下降速度（导入页 · 打标页签）
  · 跑多个服务进程时，实际并发是这里的数 × 进程数
```

---

## 做完的标准

**api 端**

- 新增 `runtime_config` 表；**没有改动已合入的迁移**
- `GET` / `PUT /admin/runtime` 仅 `admin`：member → `FORBIDDEN`，未登录 → `UNAUTHENTICATED`（`middleware/auth.ts:53-59` 是唯一落点，**不在 handler 里手写一遍角色判断**）
- 四组上下限各自越界 → `VALIDATION_FAILED`；`tagPerUserInflight > tagConcurrency` → 同样拒绝
- `ffmpegConcurrency` 的上限来自 `cpuCount`，且**上限与响应字段是同一个取值的两处使用**
- 等于默认值的输入存成 `NULL`；`GET` 回显生效值而不是原始值
- 打标 tick 用的是新值（不是常量）；`setFfmpegConcurrency` 在**上调时唤醒等待者**有专门测试（构造：把上限从 1 调到 3，断言等待者被唤醒而不是干等到一次 `releaseSlot`）
- 打标路径与导入路径**都**会把 ffmpeg 上限传进 `image/` 层
- `npx vitest run` 全绿
- **默认值不变、行为不变**：不填配置时四处并发与今天逐字相同——**既有测试一条都不该需要改**，如果需要改，说明动了不该动的东西
- `image/constants.ts` 的文件头注释已按 §9.26 改写

**web 端**

- 设置页管理员分段多一张「运行参数」卡片，首个管理项是「Embedding」之后、「用户」之前；`SECTIONS` 里有它、锚点能跳
- 四个输入框；`ffmpegConcurrency` 的 `max` 是接口给的 `cpuCount`（把它调到 `min(核数, 16)` 之上要有即时反馈）
- 越界时**展示服务端的 `VALIDATION_FAILED`**（含 requestId），不前端静默截断成合法值
- 保存成功后回显服务端返回的生效值（不是本地那一份）
- 文案逐字落 `settings-copy.ts`，**「每个服务进程」那句在**
- `npm run typecheck`（闸门）+ `npm run build` 过
- **在真浏览器里开过**（桌面 1264×805 鼠标 / 390×844 粗指针两档）

## 风险与观测项

| 项 | 说明 |
|---|---|
| **调大 = 账单线性上涨** | `tagConcurrency` 是唯一直接影响钱的旋钮，翻倍就是同时烧两份视觉调用。文案必须说，且这是它归 admin 的理由 |
| 调大 ffmpeg 可能打满机器 | 核数上限是有依据的近似，**不是内存保证**——每个 ffmpeg 几百 MB 是估算，不是实测。调到核数仍可能在大图/损坏文件上吃紧 |
| 多副本语义 | 见陷阱五。本次**不修**（要分布式限流，而 §9.11 已排除 Redis） |
| 生效延迟 | 打标最长「一个在途任务的自然耗时」，导入按批次。承诺措辞是「新任务按新值跑」，不是「立刻变快」 |
| 调低不打断在途任务 | 有意为之（陷阱三）。表现是「改成 1 之后还有 2 个在跑一会儿」，**不是 bug** |
| 导入并发收益低于预期 | 陷阱六（同步 sha256 挡事件循环） |
| **验收通过 ≠ 速度提升** | 唯一能证明提速的是真库上 `tag-status` 的 `counts.pending` 下降速率。**替身测试证明不了这件事**——选型 3 已经决定不为此加端点，所以这条只能人工量一次，量到的数写进验收段落，**不要用「测试全绿」代替** |
| 评测集 | **不需要跑**。本任务不碰打标提示词、词表、检索参数（`api/AGENTS.md §5` 的门槛不成立），明确写出来省得纠结 |

## 契约要改哪几处（**不是一处**）

| 位置 | 要做什么 | 结果 |
|---|---|---|
| `spec/03-auth-permission.md` §3.3 | 权限矩阵 +1 行「配置运行参数（并发上限）」 | ✅ 总管（2026-09-23） |
| `spec/05-data-models.md` §5.6 | 新增：表结构、上下限、可空语义、每进程警告、交叉约束 | ✅ 总管（2026-09-23） |
| `spec/06-endpoints.md` §6.5.5 | 新增：两个端点、必填整组、生效语义的三种时机表、不做恢复默认 / 状态端点 | ✅ 总管（2026-09-23） |
| `spec/09-decisions.md` §9.26 | 新增：划线判据、为什么是 DB 不是 env、每进程偏差、什么情况下推翻 | ✅ 总管（2026-09-23） |
| `spec/09-decisions.md` §9.9 | 第三块文案（此前只存在于本任务文件，见「总管裁定」裁定 1） | ✅ 总管（2026-09-23），并写明 `**` 的渲染约定 |
| `api/src/image/constants.ts` 文件头 | 立场按 §9.26 收窄 | ✅ api——四个并发数移走，`MAX_FRAMES` / `AI_LONG_EDGE` / `COLLAGE_FRAMES` / 两个阈值留下 |
| `api/agents/rules/image-pipeline.md` §3 或 §8 | 若引用了「是常量，不是环境变量」，同步收窄 | ✅ **查过，不需要改**——唯一那句在 §3 关于 `MAX_FRAMES` 处，而它是**改变产出**的参数，§9.26 正好把它划在常量那一侧 |
| `web/agents/rules/settings-ux.md` §2 | 分段表 +1 行 | ✅ web |

SPEC 条目（§5.6 / §6.5.5 / §9.26）已按 [§8.1](../spec/08-collaboration.md) 第 3 步转 `accepted`（§3.3 是权限矩阵的一行，不带状态）。**第 4 步转 `stable` 还没到**——它要联合验收通过，见「总管裁定」裁定 3。

## api 端验收

**已完成。** `npm run typecheck` 无输出；`npx vitest run` **37 文件 / 425 用例全过**（其中新增 26 条：`tests/runtime-config.test.ts` 21 条 + `src/lib/slot-pool.test.ts` 5 条）。**既有测试一条都没有改**——唯一被动过的既有测试文件是 `tests/helpers/test-db.ts`，改的是 `truncateAll` 的表名列表（加 `runtime_config`），不是任何断言。

### 逐文件

| 文件 | 实际改动 |
|---|---|
| `src/data/schema.ts` | 新增 `runtimeConfig` 表，照 `embedConfig` 的单行模式带 `check (id = 1)` |
| `migrations/0008_create_runtime_config.sql`（新） | drizzle-kit 生成后补了注释头。`meta/_journal.json` 追加 idx 8、`meta/0008_snapshot.json` 生成。**已合入的迁移一个字节没动** |
| `src/data/runtime-config.ts`（新） | `loadRuntimeConfig()` 现查 `id = 1` 单行；`saveRuntimeConfig()` 走 `onConflictDoUpdate` 上插。**不缓存**——多副本下只有读库能跨进程。四个默认值**故意不在这里**：真源仍是 `queue/worker.ts`、`services/import.ts`、`image/constants.ts` 里的常量 |
| `src/services/runtime-config.ts`（新） | 四组上下限 + 交叉约束的校验、归一化、组装响应。`cpuCount` 用 `os.availableParallelism()`，**一处取值两处用**（`limitsFor()` 算 ffmpeg 上限 + 响应字段）。上下限用一张 `FieldLimit[]` 表驱动，四道闸门不分叉 |
| `src/routes/admin.ts` | `GET` / `PUT /runtime` **挂在已有的 `.use('*', requireAdmin)` 那组里**（`:28`），没有新开路由组、没有动 `app.ts` 的类型链。handler 里**没有一句角色判断**。顺手删掉了本文件里和 `serialize/meme.ts` 重复的 `toIsoSeconds`，改用 `toIsoSecondsOrNull` |
| `src/queue/worker.ts` | 两个常量改成**导出**（`TAG_CONCURRENCY_DEFAULT` / `TAG_PER_USER_INFLIGHT_DEFAULT`）；`tick()` 开头读配置——**在 early-return 之前**（陷阱二），同一处调 `setFfmpegConcurrency`。启动日志改成打默认值 |
| `src/services/import.ts` | `PIPELINE_CONCURRENCY` → `PIPELINE_CONCURRENCY_DEFAULT`（导出）；`runBatch` 在 `try` 开头读一次，**整批用同一个值**（§6.5.5），并调 `setFfmpegConcurrency`。注释补了「每进程」与同步 sha256 两条 |
| `src/image/probe.ts` | `setFfmpegConcurrency()` + `ffmpegConcurrency()`（后者只为诊断/测试，注释写明不要当配置源）。**不读库**：上限由调用方传入，`image/` 仍不认识 `db` |
| `src/image/constants.ts` | 文件头按 §9.26 改写：写清「保护机器」的四个数已移到 §5.6，`MAX_FRAMES` / `AI_LONG_EDGE` / `COLLAGE_FRAMES` / 两个阈值**仍留在这里**（判据是「改变产出 vs 改变吞吐」）；两个超时也留在原处并写明理由（与 `STALE_RUNNING_MS` 有硬关系）。`FFMPEG_CONCURRENCY` 的 docblock 标明它现在只是默认值 |
| `src/queue/reindex-worker.ts` | 补注释：它的 `CONCURRENCY = 4` **有意不进** `runtime_config`（§9.26） |
| `src/lib/slot-pool.ts`（新） | **偏离任务的文件表**，理由见下 |
| `tests/helpers/test-db.ts` | `truncateAll` 加上 `runtime_config`（另一张单行表 `embed_config` 原本就在列表里，同类） |

**一处偏离**：任务表把「改上限 + 上调唤醒等待者」直接写在 `src/image/probe.ts`。我把槽池本体抽到了 `src/lib/slot-pool.ts`——它没有 import，不起 Postgres 就能测，于是**陷阱一那条最该被抓住的逻辑有了独立单测**（5 条）。`setFfmpegConcurrency` 仍按计划留在 `probe.ts`，只是转调 `slots.setLimit()`。不抽的话，要测「上调唤醒」就只能给 `probe.ts` 加测试专用导出，而那是要起真实子进程的层。

### 逐条对照「做完的标准」

- **新增表，没改已合入的迁移** ✅
- **仅 admin** ✅ 落在 `middleware/auth.ts:53-59`，handler 里零角色判断。测试：member 读写都 `403 FORBIDDEN`（读也拒——不像 `/config/vision` 那样「写不了但看得见」），未登录 `401 UNAUTHENTICATED`
- **四组越界 + 交叉约束** ✅ `it.each` 逐字段试 7 个边界值，全部 `400 VALIDATION_FAILED`，且**每次都断言库里那一行和拒绝前一模一样**（证明没有部分落库）。另外覆盖：缺字段、`2.5`、字符串 `"4"` 一律拒（服务端是唯一校验点）。交叉约束的报错带具体数字：「每用户在途（3）不能大于打标并发任务数（2），否则这一项等于不存在」
- **越界报错，不静默 clamp** ✅ 明确走了总管的修正
- **`cpuCount` 一处取值两处用** ✅ 测试断言 `min(核数, 16)` 收、`+1` 拒，并且**同一个响应里 `ffmpegConcurrency` 与 `cpuCount` 对得上**。测试自己也不写死 8 或 16，用 `availableParallelism()` 现算
- **等于默认值存 `NULL`，GET 回显生效值** ✅ 读的是库里的原始行，不是端点回显——「落成 NULL」只有库能证明。另有一条专测「填回去等于默认值时不留旧值」
- **worker 用新值不是常量** ✅ 见下
- **上调唤醒等待者有专门测试** ✅ `slot-pool.test.ts` 用「限 1、1 个在跑、2 个等待 → `setLimit(3)` → 两个都醒」构造，**全程没有任何 `release`**；另有一条断言只醒放得下的那几个（限 2、4 个等待、上调到 4 → 恰好醒 2 个，不是 4 个）
- **两条路径都传 ffmpeg 上限** ✅ 打标那条用「tick 跑一轮后 `ffmpegConcurrency()` 变成 3」验证；导入那条用空文件列表跑一次 `runBatch` 验证变成 4
- **`npx vitest run` 全绿** ✅ 425/425
- **默认值不变、行为不变、既有测试不用改** ✅
- **`image/constants.ts` 文件头按 §9.26 改写** ✅

**worker 真的读配置是怎么测的**：把视觉调用的 `fetch` 桩挂在一个人工闸门上，任务就停在 `running`，于是「同时有几条 `running`」是一个稳定可数的观测量。`tagConcurrency: 3` + 3 个用户 → 恰好 3 条；`tagPerUserInflight: 2` + 同一用户 3 张 → 恰好 2 条（默认 1 时只会是 1 条，这条因此同时证明了两项都在生效）。**这两条不可能由 `GET` 的响应证明**——响应只说明存进去了，不说明有人读它。等待用的是轮询到条件的 `until()`，不是猜时长的 `sleep`。

### 没做 / 没量的（这部分请连同结论一起看）

- **没有量过真实提速，本端不声称任何提速。** 唯一能证明它的是真库上 `GET /memes/tag-status` 的 `counts.pending` 下降速率（风险表末行），选型 3 又明确不为此加端点——所以这条**只能人工在一个真实库上量一次**，本次没有量。**测试全绿不等于变快。** 请在合并前或首次上线时补这一次测量。
- **`importConcurrency` 的那次读取只由代码检视 + 一条「空批次也会读配置」的用例覆盖**，没有真的用不同并发度跑一批文件去数管线里的在途数。管线并发本身确实没有 ffmpeg 槽位那样的可观测量（陷阱六：同步 sha256 挡事件循环，调大的收益本就低于预期）。
- **迁移没有在真实/开发库上跑过。** 测试库由 `tests/global-setup.ts` 自动建库 + 迁移，因此 0008 的 DDL 是**在测试库上真跑过**的；但 `dev`/生产库没动过。
- **评测集不需要跑** ✅ 本任务不碰打标提示词、词表、检索参数，`api/AGENTS.md §5` 的门槛不成立。
- **多副本语义没修**（陷阱五），与任务一致：注释、响应、后续文案都写「每进程」，不写「全站」。

### 契约表里留给 api 的那一行

`api/agents/rules/image-pipeline.md` §3 或 §8 —— **查过了，不需要改。** 该文件里唯一一句「不要做成环境变量」在 §3 关于 `MAX_FRAMES` 的那段（`:48`），而 `MAX_FRAMES` 是**改变产出**的参数，§9.26 正好把它划在常量那一侧。§8 只说「必须有超时和并发上限」，没有「是常量」的措辞。真正被划到运行期的只有 `FFMPEG_CONCURRENCY`，它的立场已改在 `image/constants.ts` 里。

**状态行没有动**（与 web 端同样处理），本端只回填了本节。

## web 端验收

**web 端确认契约，无异议。** 两端都确认后 总管 可把状态转 `in_progress`——状态行本端没有动。

**实测（2026-09-23，零依赖 CDP 驱动系统 Chrome `--headless=new`，桩在 `127.0.0.1:8791`、
`MEMEMIO_API_PROXY` 指向它）**

⚠️ **用的是替身，不是真服务端**。替身按 SPEC §5.6 / §6.5.5 写（四组上下限 + 交叉约束 + 等于默认值
的输入归一成 `NULL` + 两个审计字段），`cpuCount` 给 8。

替身**已按 api 侧的 `services/runtime-config.ts` 逐字校准**：`limitsFor()` 的四组上下限、四个默认值
（2/1/2/2，分别来自 `queue/worker.ts` ×2、`services/import.ts`、`image/constants.ts`）、`validate()` 的
报错文案，以及 `toIsoSecondsOrNull` 给出的 `updatedAt` 形状，都跟真服务端一致。

**这是第二轮——第一轮的替身其实是自证的。** 第一轮把范围报错写成「必须在 1–16 之间，收到 99」、
交叉约束写成 `tagPerUserInflight 不能大于 tagConcurrency`；真服务端的文案是「打标并发任务数 必须在
1–16 之间」（**不回显收到的值**，值在 `details.value` 里）与「每用户在途（4）不能大于打标并发任务数
（2），否则这一项等于不存在」（**字段名只在 `details.field` 里，不在 `message` 里**）。界面是**原样
展示 `message`**（`describeSaveError` 走 `default` 分支），所以第一轮有两条断言等于拿我编的中文自证，
换成真服务端就会失败。现在断言盯的是真文案。

| 项 | 1264×805（鼠标） | 390×844（粗指针） |
|---|---|---|
| 卡片在管理员分段、Embedding 之后、用户之前；`SECTIONS` 有它、点锚点能跳 | ✅ | ✅ |
| 标题「运行参数」、徽标「每个服务进程」、分组「打标 / 导入」、四格标签 | ✅ | ✅ |
| `ffmpegConcurrency` 的 `max` = `min(cpuCount, 16)` = 8，说明行「上限 8（本机 8 核）」 | ✅ | ✅ |
| **其余三格没有 `max`**（上下限不往前端再抄一份，服务端是唯一校验点） | ✅ | ✅ |
| ffmpeg 填 9 → 即时反馈变错误色 + `role="alert"`「本机 8 核，这一项最大只能填 8」 | ✅ | ✅ |
| 空着一格 → 本地「「管线并发」要填一个整数」，不发请求 | ✅ | ✅ |
| 打标并发填 99 → 服务端 `VALIDATION_FAILED` 原样展示「打标并发任务数 必须在 1–16 之间」+ requestId | ✅ | ✅ |
| **格子里仍是 99**，替身收到的请求体里也是 `99`——前端没有静默截断 | ✅ | ✅ |
| 每用户在途 4 > 并发任务数 2 → 服务端拒绝并说明「每用户在途（4）不能大于打标并发任务数（2）…」 | ✅ | ✅ |
| 保存成功 → 行内「已保存」（不自动消失、不弹 toast）、错误 Alert 收掉、四格回显**服务端返回的**生效值 | ✅ | ✅ |
| 填回默认值 2/1/2/2 → 仍回显生效值（服务端归一成 `NULL`，界面看不出差别是对的） | ✅ | ✅ |
| 改过任一格 → 「已保存」收掉（它不再代表现在这四个格） | ✅ | ✅ |
| 契约文案逐字在位，末句「跑多个服务进程时，实际并发是这里的数 × 进程数」在 | ✅ | ✅ |
| `**新开的**` 渲染成加粗，`<pre>` 里没有字面星号 | ✅ | ✅ |
| 触摸目标：保存按钮与四格各 44；四格单列；无横向溢出（`scrollWidth` 390） | — | ✅ |

- `npm run typecheck`（**闸门**）+ `npm run build` 均通过。
- 状态行：`updatedAt` 为 `null` 时显示「这张表还没人改过，四个数都是代码默认值」（这一条是等价的
  ——没人保存过 ⇔ 四个列都是 `NULL`），有值时显示「上次修改：…」。这两行不在任务书的清单里，
  是响应里那两个字段唯一的用处，**总管若不想要可以删**。

**类型已换成推出来的那一份**（原「三处待裁决」的第 1 条，已在工作区里办掉）

api 侧把 `/admin/runtime` 挂上了，阻塞解除，于是：`RuntimeConfig = InferResponseType<typeof
api.api.v1.admin.runtime.$get>`，并在 `api-contract.ts` 补了 `_runtimeShape` 断言。

**那条断言是承重的，验过**：把 `cpuCount` 改成 `cpuCountBogus` 后 `npm run typecheck` 报 `TS2353`，
报出的真实形状是 `{ updatedAt: string | null; tagConcurrency: number; tagPerUserInflight: number;
importConcurrency: number; ffmpegConcurrency: number; cpuCount: number; updatedBy: string | null }`
——所以 RPC 链路没退化成 `any`，那一次「typecheck 通过」不是空过。

请求体的 `RuntimeInput` 是另一回事：api 侧在 handler 里手工校验（同 `ConfigInput` / `RetagInput`），
`InferRequestType` 对它只能给 `unknown`，**换成 RPC 也推不出来**，所以它是常驻手写的，已注明。
「api 改字段名 web 编译失败」那层保护在请求体这一侧永久没有。

**两处要总管裁决的**

1. **文案没有 SPEC 落点。** 任务书那一节的标题是「文案（契约，先落 SPEC 再落 web）」，但 **SPEC §9.9
   今天只有视觉模型与 Embedding 两段**，运行参数这一段只存在于本任务文件里。按 §8.1「先改 SPEC，
   再改代码」，它应该是 §9.9 的第三块。`settings-copy.ts` 里已注明当前出处是任务文件，**SPEC 补上
   之后改掉那行注释**。本端没有代为改 SPEC（措辞归总管）。
2. **`**新开的**` 怎么渲染。** 字符串**逐字**留在 `settings-copy.ts`（含两个星号，便于和规则原文
   diff），加粗在渲染层做——`<pre>` 不解析 markdown，直接渲染出来就是字面星号。**若总管要的是别的
   形态**（比如不要加粗、或换成 `⚠️`），改 `RuntimeSettings.tsx` 的 `renderNotice` 一处即可。

### 两处裁决的落地（2026-09-23，总管已裁，本端收尾）

**裁决 1 的两半都办了，且第二半比裁决要求的更大一点——这一点本端补记在此。**

- 文案已进 [SPEC §9.9](../spec/09-decisions.md) 第三块（总管）；本端把 `settings-copy.ts` 的注释头
  改成指向 §9.9。
- **但只改那一行注释是假的。** 本文件头写明的校验方式是「把下面的字符串和
  `web/agents/rules/settings-ux.md §4` 的代码块 diff」，而 §4 里**根本没有运行参数这一段**
  （它当时写着「这**两**段是契约」）。也就是说：一个 diff 目标里缺席的段落，**diff 不出来**——
  拿 §4 去校验只会得到「没有差异」这个假阳性。所以同批把这一段补进 §4、改「两段」为「三段」，
  并把三句承重的话与 `**新开的**` 的渲染约定一并写在那里。
- 改完用脚本逐字比对了三处（SPEC §9.9 / settings-ux.md §4 / `settings-copy.ts` 的模板字符串）：
  `VISION_NOTICE` / `EMBED_NOTICE` / `RUNTIME_NOTICE` **三块全部三处逐字相同**（改之前
  `RUNTIME_NOTICE` 那一格是 §4 缺失）。`settings-copy.ts` 的 `export const` 一行未动，
  只动了注释（`git diff` 里 `^[+-]export const` 计数为 0）。
- `npm run typecheck`（闸门）在改完后重跑通过。

**裁决 2 照办：保留加粗，`RuntimeSettings.tsx` 一行未动**——本端此前已实测「加粗渲染出来、
`<pre>` 里没有字面星号」，那一档本来就是要的形态。约定已由总管写进 §9.9。

**没做的**

- **真服务端联调仍然没做。** api 侧现在已经挂上路由了，但**本端拿不到一个可用的 admin 会话**：dev
  库不是空库，注册会要求邀请码，而邀请码要 admin 会话才能建。直接往 `sessions` 表插一行是**伪造凭据
  绕过登录**，被工具链挡下（理由正当），**没有绕**。所以下面这两条仍是**替身按 SPEC 演的，不算实测**，
  等有一份可用的 admin 会话（或由 api 端跑同一组断言）再复看：
  「服务端把等于默认值的输入归一成 `NULL`」；「`updatedAt` / `updatedBy` 真的写进去」。
  替身上能证的只是**界面行为**，不能替代这一条。
- **副作用一处，需 api 端知悉**：为了让 api 能起（它拒绝在迁移落后时启动），本端跑了
  `cd api && npm run migrate`，**0008 已应用到 dev 库**。这是附加式迁移（新表 + 外键），未改任何已有
  表。若不希望 dev 库被本端推进，请告知，但无法回退到「未应用」的语义（只能删表）。
- **「保存后新开的任务按新值跑」读不到。** 它要真的打标 worker 与导入批次，替身证明不了——
  与本任务「验收通过 ≠ 速度提升」是同一条限制。这一条只能人工量一次。
- 深色模式没单独看这一屏（改动只用了既有 token，没有新色值）。
- 评测集**没跑**（任务书已明确不需要：不碰打标提示词、词表、检索参数）。

**本端改到的文件**

| 文件 | 改什么 |
|---|---|
| `web/src/features/settings/RuntimeSettings.tsx`（新） | 卡片本体：加载 / 保存 / 两种错误 / 行内反馈 |
| `web/src/features/settings/settings-copy.ts` | `RUNTIME_NOTICE` 逐字落 |
| `web/src/lib/api-config.ts` | `RuntimeConfig` 改成 RPC 派生 / `RuntimeInput`（常驻手写）/ 两个薄函数 |
| `web/src/lib/api-contract.ts` | 新增 `_runtimeShape` 编译期断言（`cpuCount` / `updatedAt` 的守门人） |
| `web/src/routes/settings.tsx` | `SECTIONS` +1 项，渲染在 `EmbedSettings` 之后、`ReindexPanel` 之前 |
| `web/agents/rules/settings-ux.md` | §2 分段表 +1 行，并写明「全站一份配置、每个数是每进程」的区别；**收尾轮**再补：§4「必须有的文案」补进运行参数那一段（「两段」改「三段」）——它是 `settings-copy.ts` 文件头的 diff 目标，缺了它逐字校验会得到假阳性 |

## 总管裁定

**2026-09-23。契约转为 `accepted`，任务留在 `in_progress`。** 本节的四条裁定都是对 web 验收里「两处要总管裁决」及两端共同提出的限制的回应。

### 裁定 1 · 文案没有 SPEC 落点 → 已补进 §9.9 第三块

web 报得对。§9.9 是「约束写在输入框旁边」，它自己写明这些文案**是契约的一部分**；而运行参数这一段此前只活在本任务文件里。照那个状态走，将来读 SPEC 的人看不到这段契约，读任务文件的人读到的又是一份按 [§8.5](../spec/08-collaboration.md) 不产生约束力的副本。

已补进 [§9.9](../spec/09-decisions.md)「管理页 · 运行参数区域的提示文案」，并写明哪三句是承重的。

**这一处给 web 留了一个小尾巴**：`settings-copy.ts` 的注释头现在写着「这一段目前只在跨端任务书里……SPEC §9.9 还没有它这一块」——**那句已经过期**。请 web 执行者把注释头改成指向 §9.9，**只改注释**：字符串逐字不动、渲染不动。

### 裁定 2 · `**新开的**` 保留加粗，并把它写成 §9.9 的约定

web 问要不要换形态。**保留，`RuntimeSettings.tsx` 一个字都不动**——web 已经实测「加粗渲染出来、`<pre>` 里没有字面星号」，那一档是对的。约定（星号逐字留在字符串里便于与 SPEC 逐字 diff；加粗在渲染层做、渲染时剥掉星号）已写进 §9.9。

理由：「新开的」是这段话里最容易被读反的一个词。管理员点完保存，若理解成「立即生效」，就会在第二个还在跑的任务上看出「没生效」。强调它是**语义承重**，不是装饰。这段文案总共三句承重（首句定权限归属、这句定生效时机、末句定每进程口径），只有一个词带强调刚好；再加一处就等于没有强调。

### 裁定 3 · 为什么是 `in_progress`，不是 `done`

两端各自的验收都扎实：api 425/425（新增 26 条，既有断言一条没改）、web 在真 Chrome 两档视口过了几十条断言、RPC 类型链还用一次故意的 `TS2353` 证明没退化成 `any`。**问题不在质量，在两端从未对话。**

web 侧全部断言对着**替身**。那个替身按 api 的 `services/runtime-config.ts` 逐字校准过（连报错文案都对齐了，这是第二轮才做到的——第一轮等于拿自编的中文自证），**但校准过的替身仍是替身**。这个仓对这件事有明确先例，写在 [_archive/joint-tasks/README.md](../_archive/joint-tasks/README.md) 的模型配置那行：

> **四轮验收**——第一轮因「两端各自全绿但从未对接」判不通过，真接上后立刻暴露两处偏差。

那次的形态与本任务今天逐字相同：两端各自全绿、口径都对、就是没接过。**所以不转 `done`**，SPEC 也停在 `accepted`（[§8.1](../spec/08-collaboration.md) 第 4 步要「实现完成并通过验证」才转 `stable`）。

**解除阻塞的路只有一条，但它很好走**：web 拿不到可用的 admin 会话（dev 库非空 → 注册要邀请码 → 邀请码要 admin 会话），**这个环由 api 端一步破掉**——api 在自己的测试库上起服务、造一个 admin 会话，跑这一组断言；或者给 web 一个 dev 库上现成可用的邀请码。web 拒绝往 `sessions` 表插一行是**对的**（那是伪造凭据绕过登录），不要再提这条路。

**真接上时要盯这三条**（替身天然证不了，前两条 web 已自己点出）：

1. 等于默认值的输入被真服务端归一成 `NULL`；
2. `updatedAt` / `updatedBy` 真的写进库；
3. 「保存后新开的任务按新值跑」——这条要真的打标 worker 与导入批次，与本任务另一条限制同源（见裁定 4）。

### 裁定 4 · 本次没有量过真实提速，不要读成「速度问题已解决」

**唯一能证明提速的是真库上 `GET /memes/tag-status` 的 `counts.pending` 下降速率。** 本任务做出来的是**机制**并验证了机制本身——越界被拒、等于默认值归一成 `NULL`、上调时等待者被唤醒、两条路径都把 ffmpeg 上限传了下去。**「调大之后确实更快」这一条没有量过**，选型 3 又明确决定不为此加端点，所以它只能人工量一次。

这条与裁定 3 的第 3 点一起构成转 `done` 的条件。两者都要真环境，都是**首次部署后的联合回归**，那时必须真的盯一次 `counts.pending` 的下降速率再关单。
