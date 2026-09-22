# 批量重打标 `POST /memes/retag` + 设置页「全部重新打标」

**状态**：`in_progress`——2026-09-22 开工，两端实现均已完成并各自回填了验收（见文末）。
**剩下的一件事**：对真库全量重打**要花钱**（75 张过一遍 `deepseek-flash`，约 9–20 分钟），**还没跑，要产品负责人点头**。它同时是「`ratings` 从全空变成有值」这条真正验收标准的唯一验证方式，也是下面「顺带能销的旧账」的 fixture。全绿之后转 `done`。

**性质**：**跨端**——新增接口、新增响应字段、改 SPEC 四处；web 需要新的类型来源（Hono RPC 直接消费 `api` 导出的类型，没有生成步骤）。
**来历**：契约早已在 SPEC §6.4 里（路径、权限、两个 body 形状），本次兑现它并补 §6.4.3 的正文；**六个选型由产品负责人 2026-09-22 当面选定**（见下表）。
**SPEC**：[§3.3](../spec/03-auth-permission.md)（`assertCanMutate`）、[§6.4](../spec/06-endpoints.md)（新增 §6.4.3）、[§6.6](../spec/06-endpoints.md)（进度复用，不另做端点）、[§9.3](../spec/09-decisions.md)（谁的钱）、[§9.5](../spec/09-decisions.md)（模型侧拒答）、[§9.23](../spec/09-decisions.md)（多问一问的未测风险）

---

## 为什么要做

**症状**：库里的图是旧提示词打的，而**没有任何机制让它们重跑**。

2026-09-22 的两件事改了打标输入——词表升到 v0.3.0（新增第七维 `ratings`，词条「成人向」）、提示词从八个键改成九个键并多问了一问。查真库：

| 实测（真库，非软删） | 值 |
|---|---|
| 总数 | **75**，全部 `tag_status = ok`、全部有向量 |
| `ratings` 非空 | **0** ← 症状 |
| 人工编辑过（`edited_by` 非空） | **1** |
| `tag_jobs` | 75 行，**全部 `status = done`** |
| 上传者 / 视觉通道 | 75/75 是 admin；只有 admin 配了（`deepseek-flash`） |

所以「R18 标不出来」不是 bug。今天前端能触发的只有「重建索引」，而它按 §6.5.4 **只重算 embedding、明确不调视觉**（`services/reindex.ts` 的 import 列表里根本没有 `ai/vision.js`）。

**为什么是这个形状。** `needs_manual` 的图至今**只能人工补标签、不能重跑模型**——§6.6.2 把这条写成了「当前功能的边界」，并在同一节里写明正确做法是 `POST /memes/retag`（**尚未实现**），且**不许在 §6.4 之外另造一个「重试」端点**（同一个语义不能有两条实现）。本任务就是补上缺的那一半。

**为什么不能复用 `enqueueTagJob`。** `tag_jobs_meme_id_key` 是 `meme_id` 上的唯一索引，`markTagJobDone` **保留 done 行**（不同于 `reindex_jobs` 的完成即删行）——所以对 75 张已打完的图调 `enqueueTagJob` 是**静默空操作**。这就是本次必须新写一个重置助手的原因，也是对 75 行 `done` 的实测解释。

---

## 六个选型（已定）

| # | 问题 | 结论 | 一句话理由 |
|---|---|---|---|
| 1 | 人工编辑过的图会被九个字段整条覆盖 | **跳过**（`edited_by is not null`），响应里报 `skippedEditedCount` | §6.6.2 把「人工补」和「重跑模型」分成两条路，机器输出不该冲掉人的工作 |
| 2 | 按钮放哪 | **设置页**，管理员区块，紧挨「重建索引」 | 它是全库运维动作，不是「处理积压」；形态与 `ReindexPanel` 同构 |
| 3 | 重打期间这几张算什么状态 | **置回 `tag_status = 'pending'`** | 见下方「两个必须写进注释的陷阱」——它同时关掉了快速路径 |
| 4 | 配置归属（SPEC 说调用者的，代码用上传者的） | **保持上传者口径，把偏差记进 SPEC**；`useDefaultConfig` 不实现 | 当前库里两者是同一个人，偏差不可观测；改它要加列 + 改 worker |
| 5 | 接口范围 | **`{ memeIds[] }` 与 `{ filter: { uploader?, tagStatus? } }` 都做** | 以后想在单张卡片上加「重跑模型」不用再动接口 |
| 6 | 进度端点 | **不新造**，轮询已有的 `GET /memes/tag-status?scope=all` | `settings-ux.md §9` 原文：「数据来自 `GET /memes/tag-status`，**不另做接口**」；且 retag 无状态——跑完后库里没有「这张被重打过」的痕迹，专门造端点只能把 `tag_jobs` 的计数换个地方再说一遍 |

---

## 两个必须写进代码注释的陷阱

### 陷阱一 · 快速路径会让重打静默地不调视觉

`services/tagging.ts:58`：

```ts
if (meme.tagStatus === 'ok' && meme.embedding === null && meme.searchText !== null) {
  return embedAndStore(memeId, meme.searchText)   // ← 不调视觉
}
```

这是「只差向量」的省钱快速路径（`embed_failed` 的终局按 `retry-policy.ts:104` **不动 `tag_status`**，所以「打标成功、向量没算出来」的图恰好就在这组三连上）。

**如果 retag 只重置 `tag_jobs` 行、不写 `memes.tag_status`，这些图会走这条分支——接口报成功、花了 embedding 的钱、标签一个都没变。** 选型 3 正好关掉它：`tag_status` 与入队在**同一个事务**里提交（`queue.md §2`），worker 认领时看到的已经是 `pending`。

⚠️ 但要把话说完：**成功的视觉调用之后 `embedAndStore` 仍可能终局失败**，于是 `tag_status` 回到 `ok`、`embedding` 仍是 null——陷阱会**重新武装**。所以「重打一次」并不持久地修好「ok + 空向量」这个群体，只有**成功的 embedding** 才能。

### 陷阱二 · `running` 行不能踩

`claimTagJob` 只看 `status = 'pending'`，所以把一个正在跑的行改回 `pending`，第二个 worker 会认领同一条、**同一张图付两次钱**。入队必须带 `setWhere`（只更新非 `running` 的行）。

**连带的一条**：`tag_status` 的批量更新必须用 upsert 的 `returning` 结果，**不能**用输入 id 列表——否则某个 id 因为 `running` 被跳过时，它的图仍被翻成 `pending`，两个写入互相矛盾。

---

## 这个按钮可能让情况变差，要提前说清

提示词这次多问了「这张图是不是成人向」，而对**无害的图也照问**。[§9.23](../spec/09-decisions.md) 记着这条**没有实测支撑**；[§9.5](../spec/09-decisions.md) 更早就认定境内模型对这类内容会拒，且是合规问题、调提示词绕不过去。

叠加选型 3 之后：**一批本来 `ok` 的图可能在重打中终局失败、落成 `needs_manual`，而它们的旧标签其实完好可用。** 界面上表现为「需人工 N」——一个真实的回退信号，虽然数据没坏。

三件事如实做：①确认框里说出来，文案先落 SPEC 再落 web；②跑完记下 `failures` 分布（**75 张是第一次能量出这个数**，但样本量不足以判定，当观察记）；③不因此缩小范围——语义维度拆分那次的六维也是旧提示词打的。

---

## 做完的标准

**api 端**

- `POST /memes/retag` 两种 body 形状都通；**恰好给一个**，都给或都不给 → `VALIDATION_FAILED`
- `memeIds: []` **不能**退化成「全库」；`filter.tagStatus` 必须**先校验枚举、再判角色**（`scope=foo` 静默越权的同一条教训）
- 跳过的两类要能区分：`skippedEditedCount`（人工编辑过）、以及因 `tag_status` 未配置被跳过的
- `tag_status` 只对**真的入队成功**的 id 置 `pending`（用 `returning`，不是输入列表）
- `running` 行不被踩；重复触发对**已 `pending`** 的行是幂等的（`enqueuedCount: 0`）
- **没配视觉通道时是空操作**，且**按上传者逐个解析**（不是全局 `isVisionConfigured()`）
- 非上传者传别人的 `memeIds` → `FORBIDDEN`（不是静默跳过）；未登录 → `UNAUTHENTICATED`
- `npx vitest run` 全绿
- **没有迁移**——复用 `tag_jobs`，不加列、不改表

**web 端**

- 设置页多一张「重新打标」卡片，管理员区块内、`ReindexPanel` 之后
- 按钮**带确认框**（`AlertDialog`），跑着的时候**禁用**，文案**不能**抄「重复触发是安全的」
- `npm run typecheck` + `npm run build` 过
- **在真浏览器里开过**（窄屏 + 桌面两档）

---

## api 端要改什么

| 文件 | 改什么 |
|---|---|
| `src/data/tag-jobs.ts` | 新增 `requeueTagJobsForRetag(rows: {memeId, userId}[], db)`：一条 `insert … onConflictDoUpdate({ target: memeId, set: { status:'pending', attempts:0, runAfter:new Date(), lastError:null }, setWhere: <不踩 running> }).returning({id})`，返回行数即 `enqueuedCount`。⚠️`setWhere` 在 `drizzle-orm@0.38.4` 里存在且**非废弃**（废弃的是 `where`），但**本仓零处用过**，要有针对性测试；且**不能和 `where` 同时传**（会抛）。`attempts: 0` 是承重的——`decideRetry` 就靠它当重试预算，留着终局值会让重打的图在第一次抖动时判 `needs_manual` |
| `src/data/memes.ts` | ①`listMemesForRetag(params, limit, offset, db)` → `{id, uploaderId, editedBy}[]`，照 `listStaleEmbeddingMemeIds`（`:444`）但 **`ORDER BY` 要带 `id` 做 tiebreaker**（`createdAt` 默认 `now()`，同事务同微秒会并列；reindex 靠「再点一次」兜，retag 再点一次是**重新花钱**，兜不了）②`markTagStatusPending(ids, db)` ③`assertCanMutate` 的首参由 `MemeRow` 放宽到 `Pick<MemeRow,'uploaderId'>`（一行，实现不动，避免强转） |
| `src/services/retag.ts`（新） | 编排。照 `ai-config.ts:279` 的 `enqueueAllStale` 结构，但**三处必须偏离**：①**先读完全部页、再开事务写**——`filter.tagStatus` 合法可筛 `ok`，而选型 3 改的正是这个字段，边读边写会让第 2 页读不到、循环提前结束还报成功；②**按 uploaderId 逐个解析 `resolveVisionConfig`**（缓存），解析不出来的行**不入队也不翻 `tag_status`**，单独计数——用全局 `isVisionConfigured()` 的表现是 75 张永远停在 `pending`、每 60 秒被 `deferTagJob` 重取、**不报错**；③**分批写**（每批 ≤1000 行一条语句），`ENQUEUE_CAP = 100_000` 照抄会在约 1.1 万行时撞 postgres.js 的 `MAX_PARAMETERS_EXCEEDED`（65534 个参数硬上限，且**不自动分块**） |
| `src/routes/memes.ts` | `POST /retag`，局部 `parseRetagBody` 照 `parseEditBody`（`:57-110`）拒绝未知键。**不要抄 `listMemes` 的 `uploader` 分支**（`:651-657`）——`'me'` + `actorId === null` 时它两个分支都不进、等于不加条件＝全库，写路径上不能有这个形状。⚠️ 路由顺序**不是**承重的（`POST /retag` 没有竞争的 POST 路由，实测注册在 `/:id` 之后照样命中），所以**不要**照抄 `/tag-status` 那句「会被 `/:id` 吃掉」的注释——那个机制不适用；要配一条**请求级测试**断言它不是 404 |

**响应**：`{ enqueuedCount, skippedEditedCount, skippedUnconfiguredCount }`——**名字带 `Count`**（§6.5.3 的理由：叫得像布尔的数字会让客户端写 `=== true`，静默判错）。

## web 端要改什么

| 文件 | 改什么 |
|---|---|
| `features/settings/RetagPanel.tsx`（新） | 照 `ReindexPanel.tsx` 写，但**四处不能照抄**：①**按钮要有确认框**（这个仓里「动全库要打断一次」的先例是 `EmbedSettings.tsx:230-259`：受控 `open`/`onOpenChange`、不用 `AlertDialogTrigger`、因为没有 trigger 所以要 `MemeActions.tsx:232-236` 那个 `onCloseAutoFocus` 把焦点还回去、默认焦点落「取消」）②**跑着时禁用**③文案不能有「重复触发是安全的」——再点一次就是再花一遍视觉的钱④`enqueuedCount === 0` 现在有**三种**含义（没选中 / 全是人工编辑过的 / 视觉通道没配），要能分开说 |
| `routes/settings.tsx` | `SECTIONS` 加一项 + 管理员区块 `ReindexPanel` 之后 |
| `lib/api.ts` | `startRetag(body)`；`fetchTagStatus` 加可选 `scope`（现在硬编不传，注释写着「`scope=all` …界面还没接（任务里明确不做）」——本次要接，连带改 `settings-ux.md §9` 那句「管理员那一行的界面**还没做**」） |
| `lib/api-contract.ts` | 加 retag 的形状断言，理由照 `:99-109` 那段 |

**预期耗时**：`queue/worker.ts` 是 `CONCURRENCY = 2` 但 `PER_USER_INFLIGHT = 1`，而全库同属一个上传者——按人分配那条规则（`queue.md §4`，为「一个人导入一千张不该堵住别人」而设）在单用户库上把吞吐压成 **1 条/次**，第二个槽空转，且取不到任务要干等 `IDLE_POLL_MS = 2_000`。75 张按单张约 6 秒视觉调用估：**约 9–10 分钟**；若调用都打满 15 秒超时则**约 20 分钟**。**不改并发**（改它是 api 侧调参，要单独论证），但确认框和面板要说清楚，否则管理员会以为卡死了。

## 契约要改哪四处（**不是一处**）

配置归属那句话在 SPEC 里出现三次，只改 §6.4 会让文档自相矛盾：

| 位置 | 现状 |
|---|---|
| `spec/06-endpoints.md:179` | 「`POST /memes/retag` 用**调用者自己配置**的视觉模型，除非 admin 显式指定 `useDefaultConfig: true`」 |
| `spec/06-endpoints.md:413` | §6.6.2 的费用表：「调用者自己的 AI 预算」 |
| `spec/09-decisions.md` §9.3 | 「贵的是视觉打标，仍由上传者自己的 key 承担」——**这句才和实现一致**；但同节又说「因此还需要给管理员一个『对任意图片重新打标』的兜底入口」，而 `useDefaultConfig` 不实现，那个兜底就落不了地 |
| `spec/06-endpoints.md` §6.6.2 末段 | 「`retag` 目前只有契约没有实现，所以 `needs_manual` 的图**能人工补标签、不能重跑模型**——这是当前功能的边界，不是缺陷」 |

**要落成**：实际口径是「每张图用**其上传者**的配置」，`useDefaultConfig` 在 v1 **被拒绝（400）**而不是被忽略（跟随 `parseEditBody` 的未知键规则）；并写明它落不了地的**原因**（worker 没有请求上下文，要真做需要 `tag_jobs` 加一列 + 串到 `resolveVisionConfig`），不是简单写「未实现」。还要写明：九个字段是**破坏性覆盖**，`edited_by` 跳过是唯一的保护，且**被跳过的那张图不会再有 `ratings`**——出路是管理员用 `PATCH /memes/{id}` 手工补（`updateMemeContent` 永远写 `editedBy`，仓里没有「取消编辑」的路径）。

---

## 风险与观测项

| 项 | 说明 |
|---|---|
| **不是幂等的（钱）** | 再点一次 = 再花一遍全库视觉调用。与「重建索引」相反，那条是幂等且免费的。界面必须挡住误点 |
| 全库会短暂变「待打标」 | 75 张翻成 `pending` 之后，**每一张卡片都带角标**、`/import?tab=tag` 的子筛选默认就是 `pending`、`?tagStatus=ok` 的收藏视图会变空。这是选型 3 的代价，也是进度唯一的可见来源；**不新增角标类型**（`MemeCard` 复用的是既有的 `tag_status` 角标） |
| `running` 计数会被别的打标干扰 | `countRunningTagJobs` 数的是**所有** running 任务。单用户库无所谓，面板文案要按「全站」说，不能声称「本次批次剩余 N 张」 |
| `lastError: null` 抹掉旧诊断 | 入队时清的，是有意的（新一轮的失败计数该从零开始），但要记下来：重打之前的 `failures` 分布**没被留档** |
| 重打与重建索引的竞态 | `services/reindex.ts` 先读 `search_text` 再写向量、中间不复核。retag 会重写全库 `search_text`，两者并发时可能存下**重打前文本**的向量，而 `embed_model` 匹配、`stale` 看不见、`degraded` 也是 false。既有问题，本次**放大**它，不改 |
| 评测集 | **跑不了**（前置欠账：标注还是两维口径）。所以「重打之后这一维准不准」**没有数据**——只能验证「`ratings` 从全空变成有值」，不能声称准确率 |
| 那 1 张被跳过的图 | 它会**永久**保留 `ratings = []`，因为 `edited_by` 不会被清。这是选型的直接后果，要在 SPEC 和界面上都写出来 |

## 顺带能销的旧账

`joint-tasks/README.md` 记着[打标状态界面](2026-09-19-tagging-status.md) **卡在联合验收**，原因是「本地库里没有 `pending` / `needs_manual` 的图，而『汇总的 `needsManual` = 列表条数』这条正是替身验不了的」。**一次全库重打就会造出正好这批 fixture**——跑完顺手把那条验收做掉，SPEC §6.6 转 `accepted` 也挂在那一条上。

## api 端验收

**实测（2026-09-22，真库、无 mock）**

- `npx vitest run` **35 文件 / 399 条全绿**。本次新增两条：
  - `tests/retag.test.ts` **22 条**——请求体两个形状（都给 / 都不给 / 空 body / 未知键含 `useDefaultConfig` / `memeIds: []` 不退化成全库 / 非 uuid 不炸成 500 / 不是 404）、入队即重置（`attempts` 与 `lastError` 归零、连点两次第二次 `0`、`running` 行不被踩且它的图 `tag_status` 不动）、跳过人工编辑过的、快速路径哨兵、先读完全部页再写、权限五条。
  - `tests/retag-unconfigured.test.ts` **2 条**——单开一个文件是因为 `env.ts` 在首次 import 时把 `DEFAULT_VISION_*` 冻住。断言「A 配了自己的一套 → 全局 `isVisionConfigured()` 为真」与「B 的图不排上、不算进 `enqueuedCount`、单独计入 `skippedUnconfiguredCount`、**`tag_status` 一个字不动**」**同时成立**。
- **没有迁移**：复用 `tag_jobs`，不加列、不改表。`api/migrations/` 无新增文件。
- `npm run typecheck` 干净。

**实现中改掉的一处与任务书不符的判断**

`parseRetagBody` 里 `filter.uploader` 的形状校验原本排在角色判断**之后**，是我自己写的测试抓出来的：非 admin 传 `{ uploader: 'everyone' }` 得到 `FORBIDDEN` 而不是 `VALIDATION_FAILED`。任务书只写了 `filter.tagStatus` 要「先枚举、再角色」，**同一条规矩对 `uploader` 一样成立**——403 会把用户送去要管理员权限，而他要改的是一个错字。已把形状校验提到角色之前，并补了一条专门的测试。

**两处与任务书的偏离（都是有意的）**

1. `requeueTagJobsForRetag` 除了 `scheduledMemeIds` 还回了 `alreadyPendingCount`，多做一次 SELECT。原因：`RETURNING` 在 `ON CONFLICT DO UPDATE` 里给的是**新行**，看不出它原先是不是 `pending`，而「对同一批连点两次、第二次是 0」必须落在 `enqueuedCount` 上（客户端的进度基线拿它当分母）。`setWhere` 仍是 `status <> 'running'`，所以**非 running 的行每次都拿到新的 `attempts: 0` 预算**，只是不计入「新排上」。
2. `RETAG_BATCH = 1000` 是**独立常量**，不是照抄 `RETAG_PAGE`。它必须存在：postgres.js 在 65534 个绑定参数处硬抛且**不自动分块**，一次写十万行的结果是 500。

**没跑的**

- **对的真库手工跑还没做**（`{"filter":{}}` → 期望 `enqueuedCount: 74` / `skippedEditedCount: 1`）。它等于真花一遍 `deepseek-flash`，**交付前问一句**再跑。
- `needs_manual` 那条路（`filter.tagStatus: 'needs_manual'`）只有替身测试覆盖，真库没有这种图。

## web 端验收

**实测（2026-09-22，零依赖 CDP 驱动系统 Chrome `--headless=new`，桩在 `127.0.0.1:8791`）**

| 项 | 1264×805（鼠标） | 390×844（触屏） |
|---|---|---|
| 卡片在位、管理员区块、`ReindexPanel` 之后 | ✅ | ✅ |
| 初始计数 = 真库现状（已完成 75 / 待处理 0 / 需人工 0）、徽标「空闲」、按钮可用 | ✅ | ✅ |
| **按钮不直接开跑，先弹确认框** | ✅ | ✅ |
| 确认框四句话（花上传者的钱 / 需人工可能变多而旧标签不丢 / 人工编辑过的被跳过 / **不是幂等的**） | 全 ✅ | 全 ✅ |
| 默认焦点落「取消」、焦点锁在模态内 | ✅ | ✅ |
| 确认后跟着服务端走：55 / 20 / 0、徽标「进行中」、按钮禁用且文案变「队列在跑，稍后再试」 | ✅ | ✅ |
| 进度条 73%（基线 74、剩 20）、`aria-valuenow="73"` | ✅ | ✅ |
| 结束后焦点去处 | 按钮已禁用 → 落回按钮那一行（非 `body`） | 同左 |
| 触摸目标（`pointer: coarse` 档） | 触发按钮 44、确认框两个按钮各 44 | 同左 |
| 横向溢出 | — | 无（卡片 24→366，`scrollWidth` 390 = 视口） |

- `npm run typecheck`（**闸门**，会把 `api/src/` 一起编译，从而验证 RPC 推出来的 `RetagResult`）+ `npm run build` 均通过。
- **卡片上不出现**「重复触发是安全的」（那条属于 `ReindexPanel`，在同一屏上方），出现「花的是**图片上传者**的配置和额度」。

**验收时量出来、顺手修掉的两个既有缺陷**（都不在本任务范围内，但都在这一屏上）

1. **全站进度条读不出值**（`components/ui/progress.tsx`）：注册表版本把 `value` 解构掉只留给内层算 `transform`，`Root` 收到 undefined → Radix 判定「不确定进度」，`aria-valuenow` **根本不进 DOM**（实测进度条画到 73% 时读回来是 `null`）。视觉一直是对的，屏幕阅读器读到的是没有值的进度条。`ReindexPanel` 同样中招。已把 `value` 一并交给 `Root`。
2. **确认后焦点掉回 `body`**：确认之后按钮随 `busy` 变 `disabled`，而**禁用元素收不到焦点**，`onCloseAutoFocus` 里的 `.focus()` 静默失效。已改为按钮可用时交回按钮、不可用时交回按钮所在的那一行（`tabIndex={-1}`）。

**一处文案在截图里读出来才发现的毛病**：`skippedEditedCount` 的说明原本写成「1 张人工编辑过，重打会冲掉人的工作」——挤在一串「被跳过」里读起来像「已经冲掉了」。改成「跳过以免冲掉人补的标签」。

**没做的**

- 真库全量重打**没有执行**（见上，要先问）。所以「进度条真的往下走完」「跑完 `ratings` 非空」这两条只有替身数据支撑。
- 深色模式没单独看这一屏（改动只用了既有 token，没有新色值）。
- 截图里确认框的**背板看着没变暗**：`Emulation` 量到的 overlay 是 `oklab(0 0 0 / 0.3)`、`opacity: 1`，DOM 是对的——是 `--headless=new` 下 `backdrop-filter` 的合成表现，不是缺陷，但**我没有在真实窗口里肉眼复看过**。

**与任务书不符的一点**：`SECTIONS` 没有加「重新打标」一项。`ReindexPanel` 也不在 `SECTIONS` 里（它没有 `id`，加了就是一个点不动的死锚点）。两张卡是同一种东西，同一种处置。
