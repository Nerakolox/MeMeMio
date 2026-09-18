# 打标状态界面（含待处理列表）

**状态：`in_progress`** · 创建 2026-09-19 · 跨端任务（api 新增只读接口，web 新建视图）

**涉及的 SPEC：** [§6.6](../spec/06-endpoints.md)（本节随本任务新增，现在标 `proposed`）、§5.2.3（`tag_status` 四个取值与「待处理列表」）、§6.3.2（`tagStatus` 筛选参数与权限）、§3.3 / §3.4（权限与软删）、§2.1（不把底层 message 回显给用户）、§2.4（`AI_NOT_CONFIGURED` 是降级不是错误）。

## 为什么

打标是异步的：导入把图写成 `tag_status = pending` 就返回了（SPEC §6.2.2），什么时候打完、有没有打失败，**用户在界面里看不到任何反馈**。导入页在「已入库 N 张」之后就没有下文了——用户不知道这 N 张是打好了、还在排队、还是已经失败了。

这不只是「少个页面」。**这条流水线现在断在最后一米，而且断得让人误解**：

1. `web/src/features/import/ImportProgress.tsx:149` 至今写着「已入库的图**尚未打标**（队列消费者是独立任务），当前状态为 pending」。这句话在 2026-09-16 就过期了——消费者已经上线（[打标队列任务](../_archive/joint-tasks/2026-09-16-tag-queue.md)），代码在 `api/src/queue/worker.ts`。**界面现在明着告诉用户这个功能还没做**，比什么都不说更糟。
2. 用户唯一能看见打标状态的地方，是浏览页那个直出英文枚举的筛选下拉（`web/src/routes/browse.tsx:183`），卡片角标也是原样吐 `pending` / `needs_manual`（`web/src/components/MemeCard.tsx:35`）。
3. **规则里已经设计过这块界面，三处，一处都没实现**——这是本任务真正的性质：
   - SPEC §5.2.3 写 `needs_manual` = 「需要人工补，**在待处理列表里**」
   - `web/agents/rules/styling.md` 写这类图「角标「需人工」，**可点进去补**」
   - `web/agents/rules/settings-ux.md §9` 写视觉模型分段要有「自己上传的：已完成 / 待处理 / 需人工」

   所以本任务**不是新设计，是兑现**。缺的也不是列表本身（`GET /memes?tagStatus=` 早就能筛），而是**计数和入口**：没人知道有 7 张图卡着，自然也不会去看那个列表。

**为什么现在做：** `needs_manual` 的图是**不会自己好的**——任务已经终局失败（`lib/retry-policy.ts`），不重试、不告警。库里的图越多，静默烂掉的那部分越多，而它们本该修好之后重新进入所有人的搜索结果。在打标链路跑过真实流量之前把这块补上，代价最低。

## 一个必须先说清的取舍

**这一版只能看，不能改。**

「人工补」需要一个写动作，而 SPEC §6.4 的 `PATCH /memes/{id}` 与 `POST /memes/retag` **都还没实现**（见 [任务板](README.md) 的已知缺口）。所以本任务交付后，用户能看到「7 张需人工、其中 4 张连不上」，但**点不动**。

这是有意的，不是漏了：

- **不在 §6.4 之外另造一个「重试」端点。** 那个语义 §6.4 已经定了（`{ memeIds[] }`、用调用者自己的配置、admin 的 `useDefaultConfig` 兜底、走 `assertCanMutate`），再做一个单张版就是同一个语义两条实现——下一个人照着其中一条改，另一条就悄悄分叉了。[总管入口 §4](../AGENTS.md) 反对的就是这个。
- **只读版本身仍然值得单独交付**：`pending` 那一批的信息量已经足够——「120 张待打标，因为你的视觉通道没配，配好会自动补」是一句可执行的结论。而 `needs_manual` 从「不可见」变成「可见且知道原因」，就已经把它从静默烂掉变成了一个待办。SPEC §5.2.3 承诺的正是「在待处理列表里」。

补标动作**排在 §6.4 那批接口里**，不占本任务。

## 做完的标准

### api 端

- [x] `GET /api/v1/memes/tag-status` 按 [SPEC §6.6.1](../spec/06-endpoints.md) 返回：`scope` / `visionConfigured` / `counts` / `running` / `failures`
- [x] `scope` 缺省 `mine`；`admin` 传 `all` 生效；非 admin 传 `all` 返回 `FORBIDDEN`；未登录返回 `UNAUTHENTICATED`
- [x] `counts` 四个取值齐全（没有的写 `0`），**只统计 `deleted_at is null`**，且与 `GET /memes?uploader=me&tagStatus=X` 的同一批图**条数对得上**（这条要有测试，它挡的是「有一处漏了软删过滤」）
- [x] `visionConfigured` 走 `resolveVisionConfig(actorId)`，**不在 handler 里直接读 `env`**——没配 env 也没有用户配置时为 `false`
- [x] `failures[].reason` 只允许 `unreachable` / `refused` / `invalid_output` / `unsupported` / `embed_failed` 五个值，**不返回原始 `last_error` 串**（理由见 §6.6.1：它来自供应商响应）
- [x] `failures` 含 `embed_failed`（那些图 `tag_status` 仍是 `ok`），并在代码注释里写明「所以 `sum(failures)` 与 `counts.needsManual` 不相等是对的」
- [x] `running` 取库里 `status = 'running'` 的真实计数，不是进程内存计数器
- [x] 测试覆盖：空库全 0；四种 `tag_status` 各自的分布；软删的图**不计入** `counts` 也**不计入** `failures`；`scope=all` 覆盖他人上传；member 传 `all` → 403；未登录 → 401

### web 端

- [x] `/import` 加第三个页签「**打标**」（`?tab=tag`），与「导入」「待确认」并列
- [x] 汇总区：`已完成 / 待打标 / 需人工 / 已拒绝` 四个数，外加「正在打标 N 张」
- [x] **`visionConfigured: false` 时必须说清「配好之后会自动补打标，不需要手动操作」**，并给一个去设置页的链接。**不是错误态、不用红色、不阻断任何操作**（`web/agents/rules/styling.md`、SPEC §2.4）
- [x] 列表按状态分开请求 `GET /memes?uploader=me&tagStatus=...`，复用浏览页的卡片组件；待打标 / 需人工 两个子筛选
- [x] 需人工那一段把 `failures` 的原因分布显示出来，中文文案（如「4 张连不上模型服务」「3 张被模型拒绝」），**不用原始英文类别**
- [x] `MemeCard` 的 `tagStatus` 角标改中文：`pending` → 「待打标」、`needs_manual` → 「需人工」、`refused` → 「已拒绝」，`ok` 不显示角标；**`pending` 和 `needs_manual` 不用错误色**（`styling.md` 的「状态的视觉表达」）
- [x] 浏览页 `tagStatus` 筛选下拉同样改中文（`src/routes/browse.tsx:183`）
- [x] **删掉 `ImportProgress.tsx:149` 那句过期文案**，换成真话 + 一个进入打标页签的入口
- [x] 空状态；`needs_manual` 为 0 时不留一个空列表框
- [x] 只写结构性 CSS，不写颜色 / 边框 / 阴影等装饰性样式（`web/AGENTS.md §5`）

## 明确不做

写清楚是为了不让它们悄悄长进这个任务：

| 不做 | 归哪 |
|---|---|
| 「人工补」的动作：`PATCH /memes/{id}`、`POST /memes/retag` | SPEC §6.4 整批接口，另开任务（本任务把这几张图**变成可见的待办**，就是它的前置） |
| 管理员的全站统计**面板** | `settings-ux.md §9` 的管理员分段。本任务把 `scope=all` 的**接口**做出来，界面等设置页那边动的时候接 |
| 设置页视觉分段的统计（`settings-ux.md §9`） | 同一个接口，**本任务不建界面**——那一段回答的是「我配的模型成绩如何」，和「我的图打好了没」是两个问题，硬凑在一起会让设置页变重。接口做好之后那次改动只剩几行 |
| 打标进度推送（SSE / 轮询） | 本任务是**拉取式**的，用户打开页签才查一次。做一个实时进度条要新开事件通道，而打标本来就要跑几分钟，进来刷新一下够了 |
| 给 `needs_manual` 的图做「为什么失败」的逐图详情 | `failures` 只给聚合分布。逐图原因要等 §6.4 的动作一起做，否则是一堆看得到改不了的信息 |

## 两端各自做什么

**先改契约：** [SPEC §6.6](../spec/06-endpoints.md) 已按 [§8.1](../spec/08-collaboration.md) 写好，状态 `proposed`。两端确认后转 `accepted`，**转换之前不写实现代码**。

### api 端

**接口一个，只读。** `GET /api/v1/memes/tag-status`，接在 `api/src/routes/memes.ts` 上，业务编排进 `services/`，SQL 进 `data/`——分层见 `api/agents/rules/project-structure.md`。

⚠️ **注册顺序**：`/memes/tag-status` 必须排在 `GET /memes/:id` **之前**，否则 `tag-status` 会被当成一个 id 匹配进去，返回 `NOT_FOUND`——**不报错、不告警，只是永远查不到**。同一个坑 `GET /imports/reviews` 和 `GET /imports/{batchId}` 已经踩过并解决了，照那条的写法来。

1. **`counts`** 走 `data/memes.ts` 新增的按 `uploader_id` + `tag_status` 分组计数，复用该文件里已有的软删过滤写法。
2. **`running`** 走 `data/tag-jobs.ts` 的计数，按 `status = 'running'`（`scope=mine` 时加 `user_id`）。
3. **`failures`** 需要 `tag_jobs.last_error` 的类别前缀，且要**排除软删的图**——所以这条查询要 join `memes` 并显式带 `deleted_at is null`。

   ⚠️ `api/agents/rules/queue.md §8` 写着「不要在队列表上 join `memes`」，**那条讲的是入队这条写路径**（省一次查询导致给已删除的图打标）。这里是读路径，join 的目的恰恰是**应用**软删过滤而不是绕过它。本任务已把 §8 的措辞收紧到写路径，读路径这条以本节为准。实现时在代码注释里点明这一层区分，别让下一个人以为是照抄 §8 抄错了。

4. **`visionConfigured`** 调 `ai/vision.ts` 的 `resolveVisionConfig(actorId)`，`scope=all` 时用 `isVisionConfigured()`（`queue/worker.ts` 里已经在用同一个判断）。
5. **`last_error` 的类别**在写入时就是 `` `${failure}: ${detail}` ``（`queue/worker.ts` 的 `applyFailure`），取 `:` 之前那段即可。**不要把 `detail` 带出去**。

### web 端

1. **`src/features/tagging/`**（新目录）：汇总区与待处理列表两个组件。目录归属见 `web/agents/rules/project-structure.md`——本任务已把「待处理列表」从 `manage/` 挪到 `tagging/`，因为它是打标状态的一部分，而 `manage/` 留给 §6.4 的编辑与删除。
2. **`src/routes/import.tsx`** 加第三个页签。页签状态放 URL（`?tab=tag`），与现有两个页签一致——理由见该文件顶部注释。
3. **`src/lib/api.ts`** 加 `fetchTagStatus()`。响应类型从 api 派生，**不手写**（`web/AGENTS.md §4`）。
4. **`ImportProgress.tsx:149`** 的那句话删掉，换成指向打标页签的入口。
5. **`MemeCard.tsx` 与 `browse.tsx`** 的枚举文案按 `web/agents/rules/styling.md` 的「状态的视觉表达」表改中文。

### 交接语

**api 端：** SPEC §6.6.1 定死了响应形状和五个 `failure` 类别，实现前先确认 `failures` 的 join 那一步——那是本任务唯一有争议的地方，理由写在上面第 3 条。做完在「api 端验收」回填，不要代填 web 端。

**web 端：** 全部依赖 `GET /memes/tag-status` 上线。`GET /memes?tagStatus=` 那一半现在就能用，可以先搭骨架对着它联调列表部分。做完在「web 端验收」回填。

## api 端验收

**状态：完成，待联合验收。** 2026-09-19 · 执行者：api

**契约确认：** api 端确认 §6.6.1 定死的响应形状与五个 `failure` 类别可实现，已按它实现，
**未改动 SPEC 一个字节**（spec/ 的改动全部来自总管）。§6.6 的 `proposed → accepted`
转换由总管操作，本端只提供这条确认。

**实测（`npm run typecheck` 干净；`npx vitest run` 30 个文件 / 304 条全绿，
本任务新增 `tests/tag-status.test.ts` 18 条）：**

- `GET /api/v1/memes/tag-status` 按 §6.6.1 返回 `scope` / `visionConfigured` / `counts` /
  `running` / `failures`；`scope` 缺省 `mine`，admin 传 `all` 生效，非 admin 传 `all` → 403
  `FORBIDDEN`，未登录 → 401 `UNAUTHENTICATED`，**会话过期也走 401 那条路**（三条都断言到 `code`）。
- `counts` 四个取值齐全（空库全 0），只统计 `deleted_at is null`；
  **与 `GET /memes?uploader=me&tagStatus=X` 逐状态对账通过**——对账用的数据里每种状态
  各带一张已软删的图，所以任何一处漏过滤都会让两个数字不等（用例：`counts 与 GET /memes?...对得上`）。
- 软删的图不计入 `counts`，也不计入 `failures`（join 的目的就是这一条）。
- `visionConfigured` 走 `resolveVisionConfig(actorId)`，handler 不读 `env`：
  没配 → `false`；本人配过而对方没配 → 本人 `true`、对方 `false`；
  `scope=all` 走 `isVisionConfigured()`（全站有没有任一可用通道）。
- `failures[].reason` 只出现契约里的五个值，**响应原文里既没有 `last_error` 的诊断串，
  也没有它可能夹带的上游内容**（用例拿一条带 key 痕迹的串断言响应不含它）；
  表里出现第六种类别时被丢掉而不是原样返回。
- `failures` 含 `embed_failed`（那张图 `tag_status` 仍是 `ok`），
  并有一条用例断言 `sum(failures) ≠ counts.needsManual` 是**预期**而不是 bug。
- `running` 取库里 `status = 'running'` 的计数；退避重试中的任务（`status = pending`
  但 `last_error` 里已有类别）不计入失败分布。

**实现落点：**

| 文件 | 内容 |
|---|---|
| `api/src/data/memes.ts` | `countMemesByTagStatus`（只碰 `memes`，复用现有软删过滤写法） |
| `api/src/data/tag-jobs.ts` | `countRunningTagJobs`（不 join）、`countFailedTagJobsByReason`（**读路径 join `memes` 并显式带 `deleted_at is null`**，函数与文件头两处注释写明了这与 queue.md §8 不矛盾的方向区分） |
| `api/src/services/tag-status.ts` | 新增，口径与五个类别的折算 |
| `api/src/routes/memes.ts` | 注册在 `/:id` **之前**（带那条「被吃掉就是永远 NOT_FOUND」的警告） |
| `api/src/lib/retry-policy.ts` | `TagJobFailure` 改成从运行时数组 `TAG_JOB_FAILURES` 派生，五个类别的清单只有一份 |

**两处实现决策，请总管在联合验收时过目：**

1. `failures` 的归类没有再加一层 SQL `IN`，而是**按 `TAG_JOB_FAILURES` 数组读分组结果**——
   表里的第六种前缀读不出来，自然进不了响应。守约点只有一处，不会和 SQL 分叉。
2. **`scope` 的取值校验写在角色判断之前**：漏掉的话 `scope=foo` 会掉进「不是 `mine`」那一支，
   等于给非管理员开了 `all` 的口子，且不报错。用例 `非法 scope 是 VALIDATION_FAILED` 挡的就是它。

**没做（按任务「明确不做」）：** 列表本身（复用 `GET /memes?tagStatus=`）、
`scope=all` 的管理员面板界面、补标动作（等 §6.4）、SSE/轮询。
**没跑评测集**——本任务没动打标提示词、词表或检索参数，按 `api/AGENTS.md` §5 不属于要跑的那一类。

**下一步（web 端）：** 接口已上线，`AppType` 里的响应类型直接可用，不需要手写。
`GET /memes?tagStatus=` 那一半在本任务之前就能用。

## web 端验收

**状态：完成，待联合验收。** 2026-09-19 · 执行者：web

**契约确认：** web 端确认 §6.6.1 的响应形状可直接消费，`counts` 四个键与
`failures[].reason` 的五个类别都在类型里，**未改动 SPEC 一个字节**。
`proposed → accepted` 的转换由总管操作。

### 实测环境（先说清楚这次测的是什么）

这次**汇总区没被阻塞**：开工时 `api/` 那半边还没动静，做到一半 `GET /memes/tag-status`
已经在工作区里了（`routes/memes.ts` 的 `.get('/tag-status')` + `services/tag-status.ts`）。
所以列表部分是先搭骨架跑通的，汇总部分是**照 api 的真实类型写的**：

- 响应类型走 `InferResponseType<MemesClient['tag-status']['$get']>`，**一行都没手写**
  （路径段带连字符，`typeof a.b['c'].d` 这种混写法不合法，所以先取客户端类型再下两层，
  两行是为了过语法，注释里写明了）。`api-contract.ts` 里加了一条形状断言：
  字段名或取值集合一变，`npm run typecheck` 在那边先炸。
- **但没有跟真接口联调**：本地库（27 张图）**全是 `ok`**，没有 `pending` / `needs_manual`
  的数据，而造这种数据要往共享库里写——不动别人库里的图。所以行为验收走的是替身：
  - 临时替身服务按 §6.6.1 / §6.3.2 返回数据，经 `MEMEMIO_API_PROXY` 接进 dev server
    （5173 上已经有个在跑的 dev server，验收走的是 5174）
  - 真 Chromium（Playwright）跑了一遍，**手机 390×844 与桌面 1280×900 各 35 条断言、
    合计 70 条全过**。这一轮是**跑在最终代码上**的：中途改过一次空状态的写法（三元改成查表 +
    兜底），改完重跑了全套，下面报的数字对应仓库里现在这份代码
  - 替身和驱动脚本都是临时文件，跑完已删，没有进仓库

替身验的是**前端行为**：页签与 URL、四个数（含 `running = 0` 时那一格不出现）、子筛选计数、
游标翻页与「换状态整段换掉」、五种失败文案（并断言整块 DOM 里不出现英文类别）、
`embed_failed` 的差额说明、降级不是错误（取色 + 不阻断列表 + 配好后整段消失）、
空状态不留空列表框、角标与下拉的中文与**无颜色 / 无边框**、过期文案已删、入口跳转、
汇总失败时的三态（报 `requestId`、可重试、不影响列表、页签不挂错误数字）。
**验不了的是契约含义**——软删过滤对不对、
`counts` 与 `GET /memes?tagStatus=` 条数对不对得上、`running` 是不是真实计数，
这些归 api 端的测试（那边已覆盖）与联合验收。

闸门：`npm run typecheck` 0 错误、`npm run build` 通过（74 modules）。

### 与完成标准逐条对照

| 完成标准 | 实测 |
|---|---|
| 第三个页签 `?tab=tag` | 三个页签为「导入 / 待确认 / 打标」，点打标后 URL 带 `tab=tag`；页签状态仍在 URL 里（`state-navigation.md §1`） |
| 汇总区四个数 + 正在打标 | 替身给 `ok 982 / pending 2 / refused 0 / needsManual 1 / running 2`，界面逐项渲染成「已完成 982 / 待打标 2 / 需人工 1 / 已拒绝 0 / 正在打标 2」——**四个数全给，没有的写 0**；`running` 为 0 时那一格不出现 |
| `visionConfigured: false` 的说明 | 断言了「配好之后会自动补打标，不需要手动操作」在、链接指向 `/settings`、**没有红字**（`getComputedStyle` 取色）、**列表照常渲染**（不阻断）。把替身切成 `visionConfigured: true` 后这一段**整段消失**（不是永远挂着） |
| 列表按状态分开请求 | 一个 `tagStatus` 一次 `GET /memes?uploader=me&tagStatus=…`（`TaggingList` 只拿 `status` 一个 prop）；复用 `MemeCard`；换子筛选时**整段换掉不合并**（断言上一段的图不在 DOM 里），游标不跨状态复用；翻页沿用按钮，`nextCursor` 为 `null` 时按钮消失 |
| 需人工段的失败分布 | 替身把五个类别全给了，逐条渲染成「4 张连不上模型服务 / 3 张被模型拒绝 / 2 张模型返回的内容不合规范 / 1 张模型不支持这类图片 / 6 张打标成功但没算出向量」，**整块 DOM 文本里一个英文类别都不出现**（五条一起断言）；切回「待打标」时这一块整体消失 |
| `MemeCard` 角标 | `pending / needs_manual / refused` → 「待打标 / 需人工 / 已拒绝」，`ok` 不显示角标；浏览页四张混合状态的图实测只出现三个角标。**角标没有任何颜色样式**（本端只写结构性 CSS），修饰类名 `--pending` / `--needs_manual` 留给风格定稿那次挂 |
| 浏览页下拉 | `全部 / 已完成 / 待打标 / 已拒绝 / 需人工`，值与文案**同一份表**（`lib/tag-status.ts`，`Object.entries` 出的顺序即选项顺序） |
| `ImportProgress.tsx:149` 的过期文案 | 「尚未打标…当前状态为 pending」整句已删（断言这句不在摘要里）；换成「已入库的图会在后台依次打标，进度和失败情况在「打标」页签里」，**保留**原来那句「打标结果会进入公共库」；动作区新增「查看打标状态」，点它直达 `?tab=tag` |
| 空状态 | `needs_manual = 0` 时 `.tagging__grid` 不存在，只有一句「没有需要人工处理的图片——打标成功的图不在这里」，**不留空列表框** |
| 只写结构性 CSS | 新增样式全部是 flex / grid / gap / min-height(44px 触摸目标) / font-size，**没有颜色、边框、阴影**；断言的取色就是默认色 |

### 交付里超出清单的两处（都是为了让「卡着的图」真的被看见）

1. **`/import` 的「打标」页签挂了计数**（`打标（7）`），与「待确认（N）」同一个做法：
   进页面拉一次汇总，取不到就不显示数字、不弹错误。**只数 `needs_manual`，不数 `pending`**
   ——pending 是正常中间态，天天挂个数只会变成噪声；needs_manual 是终局失败、不会自己好，
   这一格就是本任务开头说的那个「没人知道有 7 张卡着」。
2. **`embed_failed` 单独解释了一句**：「其中 N 张已经打标成功，只是没算出向量……
   这类不占「需人工」的张数」。§6.6.1 明确说 `sum(failures) ≠ counts.needsManual` 是对的，
   但界面把十来个失败列在「需人工 7 张」旁边，不解释这个差额就是在制造困惑。

### 没做与阻塞

- **`scope=all` 的管理员面板、设置页视觉分段的统计**：任务「明确不做」，接口已经在了，
  接界面是几行的事。
- **逐图失败详情**：`failures` 只给聚合分布，按任务归 §6.4 那批一起做。
- **跟真接口的联合验收没做**（阻塞点）：接口在，本地库里没有 `pending` / `needs_manual`
  的图。建议联合验收时用测试库造一张 `needs_manual`（或让那张图连一个不存在的模型地址），
  把「汇总的 `needsManual` = 列表条数」在真实链路上走一遍——**这是替身验不了的那一条**。
- SPEC §6.6 仍是 `proposed`：两端实现都完成了，等总管把状态转 `accepted`。
