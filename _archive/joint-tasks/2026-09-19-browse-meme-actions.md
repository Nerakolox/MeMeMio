# 浏览页图片操作：复制 / 编辑 / 删除

**状态：`done`**（2026-09-24 总管裁定：两端实现与验收都完成，四条报上来的问题逐条结清，见文末「总管裁定」）· 创建 2026-09-19 · 跨端任务（api 首次实现 `PATCH` / `DELETE`，web 新增操作入口与编辑侧边栏）

**涉及的 SPEC：** [§6.4](../../spec/06-endpoints.md) 的 `PATCH /memes/{id}` 与 `DELETE /memes/{id}`（本节随本任务细化，已转 `accepted`）、§6.4.1、§6.4.2、§4.5（词表校验与错误码）、§3.3（权限矩阵）、§3.4（两条硬边界）、§5.2.3（`search_text` 重算）、§5.2.6（对外表示）、[§9.19](../../spec/09-decisions.md)（编辑不重算向量）。

**相关规则：** [clipboard-share.md](../../web/agents/rules/clipboard-share.md)（**本端最重要的一份**，复制分流全在这里）、[state-navigation.md §8](../../web/agents/rules/state-navigation.md)（编辑与删除不做乐观更新）、[code-style.md](../../web/agents/rules/code-style.md)、[api database.md](../../api/agents/rules/database.md)、[api testing.md](../../api/agents/rules/testing.md)。

## 为什么

`PATCH /memes/{id}` 和 `DELETE /memes/{id}` **写在契约里已经很久了，但一行实现都没有**。任务板上它们一直挂在「还没有任务、但已知缺口」那一行。缺口的代价是具体的，不是「功能少了一个」：

1. **打标失败的图没有任何出路。** [`needs_manual` 的图现在能看不能改](../../spec/06-endpoints.md#662-待处理列表)——[§6.6.2](../../spec/06-endpoints.md) 自己写了这句话，并把补标动作指给 §6.4。那批图现在停在列表里，看得见、点不动。
2. **标错了没有任何纠正路径。** 共享库里标签是公共品，[§9.1](../../spec/09-decisions.md) 特意把编辑开放给全员，就是为了「谁发现标错了顺手改掉」。而这条决策至今没有落地的按钮——**权限矩阵里最重要的一条不对称，界面上不存在**。
3. **传错了的图只能留在库里。** 删除接口没实现，唯一的「撤销」是把图再传一遍别的。

浏览页是这三件事唯一自然的落点：它是「翻」的地方，也是用户看着一张图产生「这张标错了」的念头的地方。

**入口不做右键菜单。** 最初的想法是「右键图片弹出复制/编辑/删除」，**已否掉**：右键是桌面专属交互，手机上等于没有入口，而 [styling.md](../../web/agents/rules/styling.md) 明写「移动端不是适配，是主场」。改用**卡片右上角的「⋯」按钮**——两端都能用，位置固定、可键盘聚焦，也不和浏览器的原生右键菜单抢。

## 做完的标准

### api 端

- [x] `PATCH /api/v1/memes/{id}` 按 [§6.4.1](../../spec/06-endpoints.md) 实现：请求体只认 `description` / `emotions` / `scenes` / `tags`
- [x] **权限是「所有人」**（`assertCanMutate(meme, actor, 'edit')`）。非上传者编辑 `member` 的图**必须成功**——这是有意的不对称，最容易被「顺手补一个归属检查」改坏，[api/testing.md §4](../../api/agents/rules/testing.md) 点名要求这条有测试
- [x] 区分「不传」/ `null` / `[]` 三种传法（§6.4.1 的表）：不传不动、`null` 清空描述、`[]` 清空该维度
- [x] 未知字段（尤其 `ocrText`）出现在请求体里 → `VALIDATION_FAILED`
- [x] 三个数组的元素含 alias 归一化后在词表内，否则 **`VALIDATION_FAILED`（400）**，**不是 `AI_INVALID_OUTPUT`**——这两者混用的表现是前端去等一个永远不会来的 AI 降级
- [x] `edited_by` / `edited_at` 与内容字段**在同一条 UPDATE 里写**
- [x] **`search_text` 也在那一条里重算**。拆成两条语句中间崩掉会留下文本与标签对不上的记录，不报错
- [x] **不重算 embedding、不入队**（[§9.19](../../spec/09-decisions.md)）。这不是漏做，是写下的取舍——代码注释里要写明理由，否则下一个人会「顺手补上」
- [x] 响应是**更新后的完整 Meme**（与 `GET /memes/{id}` 同形，复用 `serializeMeme`），不是 204
- [x] 软删记录 `PATCH` → `NOT_FOUND`（不是 `FORBIDDEN`、不静默成功）
- [x] `DELETE /api/v1/memes/{id}` 按 [§6.4.2](../../spec/06-endpoints.md) 实现：上传者或 admin → 204 软删
- [x] 非上传者非 admin → `FORBIDDEN`；软删记录 → `NOT_FOUND`（**不幂等**，重复删除是 404 不是 204）
- [x] `data/memes.ts` 的 `softDeleteMeme` 已经写好了这套逻辑（含 `assertCanMutate`），**接路由即可，不要重写一遍**
- [x] 两个 handler 都**不自己拼条件、不自己写 SQL**：`memes` 的读写只经过 `data/memes.ts`（[api database.md](../../api/agents/rules/database.md)）
- [x] 测试（`api/tests/`）：非上传者编辑成功、非上传者删除被拒、上传者删除成功且**三路读都查不到**、软删后 `PATCH` → 404、词表外标签 → 400 `VALIDATION_FAILED`、`ocrText` 进请求体 → 400、`search_text` 与标签同语句更新

### web 端

- [x] 浏览页卡片右上角有「⋯」按钮，点开**弹出层**：复制 / 编辑 / 删除
- [x] **复制按 [clipboard-share.md](../../web/agents/rules/clipboard-share.md) 的三条路径分流**，唯一依据是 `isAnimated`，不是 `mime`：
  - [x] 桌面静图 → `fetch` 原图 → 转 PNG → `ClipboardItem` 写剪贴板，**传 Promise 不 await**（Safari 的用户激活要求）
  - [x] 桌面动图 → **菜单项文案是「下载」**，不是「复制」
  - [ ] 手机 → 先 `navigator.canShare?.({files})` 再 `navigator.share({files})`，不支持则降级下载 —— **代码已写，但真机没测**（手上没有可测的设备）。`navigator.share` 这条路径在桌面无头 Chrome 里根本走不到，见「web 端验收」里如实写明的那一条。**这一格不勾**，别当成验证过
- [x] 复制失败**自动降级到下载**并说明原因（§6），不是只弹一句「复制失败」
- [x] 复制成功有明确反馈（「已复制，去微信 Ctrl+V」）——**没有反馈的复制等于没复制**
- [x] 新建 `src/lib/clipboard.ts`（[project-structure.md](../../web/agents/rules/project-structure.md) 里已经给它留了位置），**首页与搜索页现有的临时复制一起改走它**（见下「为什么顺手换掉首页那段」）
- [x] **编辑侧边栏**展示 [§5.2.6](../../spec/05-data-models.md) 列出的全部对外字段：预览图、`originalFilename`、`mime`、宽高、`sizeBytes`、`isAnimated`、上传者、`createdAt`、`editedBy`/`editedAt`、`tagStatus`、`visionModel`、`ocrText`、`description`、三个标签数组、`favorited`
- [x] **侧边栏不显示也不请求 §5.2.6 里「不返回」的那批字段**（`contentHash` / `phash` / `embedding` / `searchText` / `embedModel` / `deletedAt` / `storageKey`）——它们没有用户可读的含义
- [x] `ocrText` **只读展示**，不给输入框（[§6.4.1](../../spec/06-endpoints.md)：改它会让文本和图不再对应，而没有任何地方会报错）
- [x] 可编辑的三个数组**从 `shared/vocab/vocab.json` 选**（`lib/vocab.ts` 已有），**不能自由输入**（[§4.5](../../spec/04-vocabulary.md)）
- [x] 保存成功后就地更新列表里那一条（响应就是新对象，不再拉一次），**不维护影子副本**（[state-navigation.md §2](../../web/agents/rules/state-navigation.md)）
- [x] **编辑与删除都不做乐观更新**（[§8](../../web/agents/rules/state-navigation.md)）：等服务端确认再改本地
- [x] 删除有二次确认（不可逆），成功后**从当前列表移除**；**404 也当成功处理**（那张图本来就要消失，§6.4.2）
- [x] 菜单里对**不是自己上传的图**：「删除」**保留但禁用**并给出原因，不隐藏——藏起来会让用户以为没有这个功能，而「编辑全员、删除限本人」正是共享库最重要的一条规则（[§9.1](../../spec/09-decisions.md)）
- [x] 服务端仍是唯一权威：前端禁用只是体验（[state-navigation.md §4](../../web/agents/rules/state-navigation.md) 的同一条原则），403 要能正确显示
- [x] 窄屏下侧边栏可完整使用（抽屉或全屏），触摸目标 ≥44×44px —— 量过，但**是 390×844 视口模拟，不是真机**
- [x] **只写结构性 CSS**：flex / grid / 尺寸 / 间距 / 定位 / 断点，**没有颜色、背景、边框、阴影、圆角、动效**（[web/AGENTS.md §5](../../web/AGENTS.md)）
- [x] 新组件放 `src/features/manage/`（[project-structure.md](../../web/agents/rules/project-structure.md) 已经写明这个目录留给 §6.4 的编辑与删除），跨 feature 复用的才进 `src/components/`

### 部署（总管已改）

- [ ] [deployment.md §8.3](../../docs/deployment.md) 的 CORS 已加 `GET`（复制要走 `fetch` 公开地址）。**漏配的表现是静默退化成下载**，没有任何日志——已写进 §8.3 和落地检查清单

### 交付时必须说明

- 复制路径**在哪些浏览器 / 设备上实测了什么**。桌面 + 真机各一轮，[clipboard-share.md §8](../../web/agents/rules/clipboard-share.md) 与 [web/AGENTS.md §6](../../web/AGENTS.md) 都要求，「本地看起来没问题」不算测过
- 两端的 `npm run typecheck`；闸门是 `cd web && npm run typecheck`（它会连 `api/src/` 一起编译）

## 明确不做

| 不做 | 归哪 |
|---|---|
| 右键菜单 / 长按手势 | **本次否掉**。右键是桌面专属；长按会被移动浏览器的系统「保存图片」菜单抢占，`preventDefault` 不可靠 |
| `POST /memes/{id}/restore`（恢复软删） | 仍是缺口。没有「已删除」视图，恢复没有入口可挂 |
| `POST /memes/retag`（重跑视觉模型） | 仍是缺口。**这与本任务的「编辑」不是一回事**：编辑是人工改标签（不花钱），retag 是重跑模型（花调用者自己的 AI 预算）。不要合成一个「重试」按钮 |
| `GET /memes/duplicates`（主动查重） | 仍是缺口，另开任务 |
| **编辑后重算向量** | [§9.19](../../spec/09-decisions.md) 写明了不做的理由：embedding 走部署方的 key 而编辑对全员开放，自动重算是一条公开的烧钱路径。触发条件写在同一条里 |
| 编辑历史表 / 撤销 | [§3.3](../../spec/03-auth-permission.md)：首期只记 `edited_by` / `edited_at`，不做完整修改历史 |
| 搜索页与首页图墙加「⋯」入口 | 本任务只做浏览页。首页卡片上那片位置留给「复制 / 发送」，见[首页图墙的遗留项](../../joint-tasks/README.md#首页随机图墙转出的遗留项) |
| `ocrText` 可编辑 | §6.4.1 定死了不可编辑。想改 OCR 的正确路径是 retag，不是手改 |
| 编辑别人的图时的冲突检测 / ETag | §6.4.1：最后写入者赢，共享库里并发编辑是常态不是边缘情况 |
| 弹层用三方库（Radix / Headless UI 等） | [styling.md](../../web/agents/rules/styling.md)：不引入组件库。这次要注意的是 **`Esc` 关闭、点外部关闭、焦点能出来**——一个不响应键盘的弹层在这个项目里是硬伤（搜索页的键盘路径是核心体验） |

## 两端各自做什么

**先改契约（已完成）：** [SPEC §6.4.1 / §6.4.2](../../spec/06-endpoints.md) 已按 [§8.1](../../spec/08-collaboration.md) 写好并标 `accepted`，[§4.5](../../spec/04-vocabulary.md) 补了错误码口径，[§5.2.6](../../spec/05-data-models.md) 补了「展示字段的上限」，[§9.19](../../spec/09-decisions.md) 记了「编辑不重算向量」的决策，[§6.6.2](../../spec/06-endpoints.md) 改掉了「能看不能改」那句。**两端实现时如果发现哪条做不到或有矛盾，回报总管改 SPEC——不要绕着写。**

### api 端

1. **`api/src/data/memes.ts`** —— 新增 `updateMemeContent(id, actor, patch, db)`：
   - `findMemeById` → null 抛 `NOT_FOUND` → `assertCanMutate(meme, actor, 'edit')`
   - `search_text` 用 `lib/vision-output.ts` 的 `buildSearchText` 重算，和 `applyTagResult` 同一份实现
   - **一条 UPDATE** 写内容字段 + `searchText` + `editedBy` + `editedAt`，WHERE 带 `deleted_at is null`
   - 若 patch 里一个字段都没有，直接返回当前行（不写库、不动 `edited_at`）——空 PATCH 不该留下「有人编辑过」的痕迹
   - **不碰 `embedding` / `embed_model`**，加注释指向 [§9.19](../../spec/09-decisions.md)
   - `softDeleteMeme` **已经实现好了**，本任务只用接路由
2. **`api/src/routes/memes.ts`** —— 新增 `.patch('/:id')` 与 `.delete('/:id')`：
   - 两者都要登录：这个 Hono 实例只挂 `optionalAuth`，**收藏那两个端点的写法就是模板**（handler 里判 `currentUser === null` 抛 `UNAUTHENTICATED`）。⚠️ 不要给整条路由换 `requireAuth`——两种中间件对 `currentUser` 的类型要求相反，混挂会让整条路由的 Variables 退化，文件顶部注释已经解释过
   - 请求体校验（未知字段 → `VALIDATION_FAILED`）在 handler 做；词表校验走 `api/src/vocab.ts` 的 `vocabAdapter`（`alias()` 归一化 → `isKnownLabel()` 判定），**和打标写回同一套**。那个文件顶部写着「全进程只有这一份」——另写一份的表现是模型输出过得去、人工编辑过不去（或反过来）
   - `PATCH` 返回 `serializeMeme(updated)`；`DELETE` 返回 `c.body(null, 204)`
   - ⚠️ **路由注册顺序**：这两条是 `/:id` 的具体动词，Hono 按注册顺序匹配，和 `tag-status` 那个坑不同类，但按文件里既有的顺序写
3. **测试** —— 新增 `api/tests/meme-edit-delete.test.ts`。**必测的是「非上传者编辑成功」**（[api/testing.md §4](../../api/agents/rules/testing.md) 点名的那条），以及软删后三路读都查不到（这是 `deleted_at is null` 的回归）

### web 端

1. **`src/lib/clipboard.ts`**（新）—— 三条路径的分流，能力探测（`canShare` / `clipboard.write`）在**渲染时就决定菜单项**，不是点击后才发现。这个文件同时被 `features/manage/`、`routes/home.tsx`、搜索页消费
2. **`src/lib/api.ts`** —— `patchMeme(id, patch)` 与 `deleteMeme(id)`。类型从 Hono RPC 推导，**api 端合入前这两个方法不存在**（见「两端先后」）
3. **`src/features/manage/`**（新）—— `MemeActions.tsx`（「⋯」按钮 + 弹出层）、`MemeEditPanel.tsx`（侧边栏）、`use-meme-edit.ts`
4. **`src/components/VocabPicker.tsx`** —— 三个数组的选择控件。放 `components/` 而不是 `manage/`，因为打标待处理列表将来也要用它
5. **`src/routes/browse.tsx`** —— 卡片包一层，接上操作与列表就地更新
6. **`src/routes/home.tsx`** —— 把 `handleActivate` 里那段临时实现（`writeText(meme.url)`）换成 `lib/clipboard.ts`
7. **`src/styles.css`** —— 弹出层与侧边栏的布局、断点

### 两端先后

**api 先合入对 web 更省事**：`web` 的类型链直接把 `api/src/app.ts` 编译进来（`api/package.json` 的 `exports`），路由不存在时 `api.api.v1.memes[':id'].$patch` 不是合法类型，`lib/api.ts` 那一步就写不下去。

但**不必等**：web 可以先做 `lib/clipboard.ts`（完全不依赖新接口）、再做侧边栏与弹层的版式，最后接 `patchMeme` / `deleteMeme`。参考[首页图墙那次](2026-09-19-home-random-grid.md)的做法——对着既有形状搭版式，接口到位后接线。

### 交接语

**api 端：**

> Mememio 项目，你是 **api 执行者**，工作目录在 `api/`。开工先读 `api/AGENTS.md`。
>
> 当前跨端任务：`_archive/joint-tasks/2026-09-19-browse-meme-actions.md`，你的任务在「api 端」小节。
>
> 相关 SPEC：§6.4.1、§6.4.2（本次新增，已 `accepted`）、§4.5、§3.3、§3.4、§5.2.3、§5.2.6、§9.19。另读 `api/agents/rules/database.md`（`memes` 读写只能走 `data/memes.ts`）与 `api/agents/rules/testing.md §4`。
>
> 三件事最容易写错：① **编辑权限是所有人**，非上传者改 `member` 的图必须成功，不要「顺手补一个归属检查」；② 词表外的标签返回 **`VALIDATION_FAILED`**，不是 `AI_INVALID_OUTPUT`；③ `search_text` 必须和内容字段**在同一条 UPDATE** 里重算，而 **`embedding` 一个字都不要碰**（§9.19，代码注释里写明理由）。
>
> `softDeleteMeme` 和 `assertCanMutate` 都已经写好，本任务主要是接路由。做完在「api 端验收」小节回填实测情况，不要代填 web 端。

**web 端：**

> Mememio 项目，你是 **web 执行者**，工作目录在 `web/`。开工先读 `web/AGENTS.md`。
>
> 当前跨端任务：`_archive/joint-tasks/2026-09-19-browse-meme-actions.md`，你的任务在「web 端」小节。
>
> 相关 SPEC：§6.4.1、§6.4.2、§5.2.6、§4.5。但本任务**最该先读的是 `web/agents/rules/clipboard-share.md`**——复制那三条路径全在里面，交付时要求在桌面和真机各说明测了什么。
>
> 入口是卡片**右上角的「⋯」按钮**，不是右键（原因见任务文件「为什么」）。编辑侧边栏的字段清单以 §5.2.6 为**上限**，`contentHash` / `phash` / `embedding` 那批不在响应里、也不该显示。
>
> **阻塞点：** `PATCH /memes/{id}` 与 `DELETE /memes/{id}` 的实现取决于 api 端合入——那两个路由不存在时 `lib/api.ts` 里的 `api.api.v1.memes[':id'].$patch` 不是合法类型，接线那一步写不下去。`lib/clipboard.ts`、侧边栏与弹层的版式**不依赖接口，可以先做**。
>
> 做完在「web 端验收」小节回填实测情况，不要代填 api 端。

## 为什么顺手换掉首页那段临时实现

[首页图墙的遗留项](../../joint-tasks/README.md#首页随机图墙转出的遗留项)里写着「复制现在是一段临时实现，真流程落地那次，两处一起接」。这次就是那一次。

现在 `routes/home.tsx` 的 `handleActivate` 复制的是**图片地址**，注释里如实写着「按钮文案如实写『复制地址』」。问题是：那个入口就在搜索结果卡片上，用户点它的**意图是发图**，拿到的却是一段 URL。而 `lib/clipboard.ts` 一旦存在、复制路径一旦按 `isAnimated` 分流，首页再留一份自己的实现，就是**同一个动作两套行为**——[clipboard-share.md §3](../../web/agents/rules/clipboard-share.md) 把这件事列为本端最不能犯的错。

**范围因此比「浏览页加个入口」大。** 这是有意的：真流程本来就该一次性铺到所有入口，分两次做等于在两次之间留一段「同一个按钮在不同页面行为不同」的时间。

## 已知代价与后续

| 项 | 说明 |
|---|---|
| **编辑过的图向量陈旧** | [§9.19](../../spec/09-decisions.md) 的取舍。`stale` 看不见它，补的办法是管理员手动 `POST /admin/reindex` |
| **`needs_manual` 的图能补标签，但不能重跑模型** | retag 仍是缺口。用户会期望待处理列表里有一个「重试」，现在没有——[§6.6.2](../../spec/06-endpoints.md) 已把这条边界写进契约 |
| **CORS 的 `GET` 是复制的部署前置条件** | 漏配时静默退化成下载。已写进 [deployment.md §8.3](../../docs/deployment.md) |
| **`/browse` 之外的入口还没有「⋯」** | 搜索页与首页图墙的卡片上仍没有编辑入口 |

## api 端验收

**状态：完成**（2026-09-19，api 执行者）。实测在真 Postgres 上跑（`api/agents/rules/testing.md §1`，无 mock），命令 `npx vitest run`。

### 实测结果

| 闸门 | 结果 |
|---|---|
| `cd api && npm run typecheck` | 通过 |
| `cd web && npm run typecheck`（闸门，连 `api/src/` 一起编译） | 通过 |
| `npx vitest run`（api 全量） | **32 个文件 / 340 个用例全绿**，新增的 25 条在 `tests/meme-edit-delete.test.ts` |

### 三件最容易写错的事，逐条实测

1. **编辑权限是「所有人」。** 用例「非上传者编辑别人的图**成功**」：bob 改 alice 的图返回 200，落库 `edited_by = bob.id`（记的是**改的人**，不是上传者）。归属判定只出现在 `assertCanMutate` 一处——两个新 handler 里没有手写的归属检查，`updateMemeContent` 里也没有。
2. **词表外标签是 `VALIDATION_FAILED`（400）**，三个数组各测一遍，另有「`ocrText` 进请求体 → 400」和「其余未知字段 → 400」。补了一条 alias 用例：提交 `猫咪` 落库是 `猫`——证明走的是 `vocab.ts` 的 `vocabAdapter`，不是另写的一份。
3. **`search_text` 同语句重算、`embedding` 一个字不动。** 编辑后断言 `search_text` **精确等于** `'图上的字 新描述 无语 狗'`（精确值而不是「包含」：漏掉某个来源字段、或用旧值拼，都会露出来），且被移除的标签不在其中；另一条用例把 `embedding` / `embed_model` 在编辑前后逐字比对，确认没被重算。

### 超出清单的一处实现决定：读-改-写加了行锁

`updateMemeContent` 是**读-改-写**（没传的字段要保留原值、`search_text` 又要按五个字段重算），所以它跑在一个事务里、以 `select ... for update` 开头。

不加锁会怎样，是实测出来的，不是推演：把 `.for('update')` 去掉后跑「两个人同时改同一张图」那条用例，**6 次全失败**，而且是整个字段丢失（`expected [ '猫' ] to deeply equal [ '狗' ]`）——两个请求各自读到同一行旧数据，后提交的那个把前一个的改动整片写回去。锁上之后同一用例跑 5 次全绿，且两种先后顺序的终值相同（所以这条断言是确定性的，不是碰运气的竞态检测）。

「最后写入者赢」照样成立（§6.4.1 说不做冲突检测），只是不再有**整片丢改动**和**半新半旧的 `search_text`**。后者正是 §5.2.3「文本与标签对不上」那个不报错的形态；撞上后台打标写回（`applyTagResult`）是同一种交错，锁一并挡住。

### 其余契约点的实测

- 响应 = 更新后的完整 Meme，与 `GET /memes/:id` 的响应体**逐字段相等**（用例直接 `toEqual` 两个响应体），且 `storageKey` / `contentHash` / `phash` / `embedding` / `searchText` 都不在里面。
- 不传 / `null` / `[]` 三种传法各有用例：不传不动、`description: null` 清空描述而其余维度不受影响、`tags: []` 落库是空数组而不是 null。
- 空 PATCH（`{}`）返回当前状态，`edited_by` / `edited_at` 仍为 null——不留「有人编辑过」的痕迹。
- 软删后 `PATCH` → 404 `NOT_FOUND`（不是 `FORBIDDEN`、不静默成功）；`DELETE` 非上传者非 admin → 403 `FORBIDDEN`；admin 删别人的图 → 204；**重复删除 404，不幂等**；未登录两条都是 401 `UNAUTHENTICATED`。
- 删除那条**先断言三路都召回得到、再断言都召回不到**——否则那三条「查不到」是白过的。

### 交付说明

- **改了什么**：`src/data/memes.ts` 新增 `updateMemeContent`（含上面那条行锁决定）与私有的 `findMemeByIdForUpdate`，并把「行 + uploaderName + favorited」抽成 `MemeView`，浏览 / 详情 / 编辑三处共用同一个形状；`src/routes/memes.ts` 新增 `PATCH /:id`、`DELETE /:id` 与请求体校验；新增 `tests/meme-edit-delete.test.ts`（25 条）。`softDeleteMeme` 与 `assertCanMutate` 一行没改，只是接上了路由。
- **动没动 SPEC**：没有。实现与 §6.4.1 / §6.4.2 逐条对得上，过程中未发现矛盾。
- **评测集：没跑。** 本次没有改打标提示词、词表和检索参数（`buildSearchText` 是复用既有实现，未改），按 `api/AGENTS.md §5` 不需要跑。如实说明，不用「看着没问题」代替。
- **没动 `web/`**：`web/src/lib/api.ts` 里那个手写的 `MemePatch` 类型现在可以从 `$patch` 推导了（那里的注释写着「api 合入后请换掉」），**web 端的阻塞点已解除**。`MemeDetail` 用的是 `$get` 的推导，与 PATCH 响应同形，不用改。

### 两个留给总管的问题（没有自行决定，先按契约实现）

1. **编辑不改变 `tag_status`，所以 `needs_manual` 的图人工补完标签后仍留在待处理列表里。** §6.4.1 的请求体与写入清单里都没有 `tag_status`，§6.6.2 也只写了「人工补用 `PATCH`」、没写补完之后状态怎么走。于是补完标签，`GET /memes?tagStatus=needs_manual` 里那张图还在、`counts.needsManual` 也不减——对用户来说像是没保存成功。要不要在 §6.4.1 补一句（改成 `ok`？还是另加取值？）由总管定，本端没有自行加这个写入。
2. **非 UUID 的路径参数返回 500 而不是 404**（例如 `/memes/not-a-uuid`）。这是**既有行为**，不是本次引入：`GET /memes/:id` 与收藏两条端点一样如此（Postgres 在 `where id = $1` 处报 invalid input syntax，被错误中间件兜成 `INTERNAL`）。本次两个端点与既有三处口径一致，没有单独修——单独修会让同一批端点行为不一致。要不要统一挡一层，另开任务。

## web 端验收

**状态：完成**（2026-09-19，web 执行者），**但有一条没测**——见下面「真机那一条：没测」。「手机 → 分享」那格因此没有勾。

### 实测结果

| 闸门 | 结果 |
|---|---|
| `cd web && npm run typecheck`（闸门，连 `api/src/` 一起编译） | 通过 |
| `cd web && npm run build` | 通过（254 kB / gzip 82 kB） |
| 浏览器实测三份脚本 | **52 条全过**：`verify.mjs` 35、`verify-errors.mjs` 8、`verify-fallback.mjs` 9 |

### 实测怎么做的（先说清楚方法，不然上面的数字没有意义）

**没有连真 api。** 浏览器这一轮跑在一个替身服务上，走的是 [vite.config.ts](../../web/vite.config.ts) 里 `MEMEMIO_API_PROXY` 这条正式通道（文件注释写明它就是给 in_progress 接口联调用的）。替身发的图是真 PNG 字节（手写 chunk + CRC32），刻意贴了一个 **`Content-Type: image/jpeg`** 的标签，用来把「非 PNG → canvas 转一道」那条分支真的走到。

**浏览器是桌面 Chrome（`channel: 'chrome'`，无头）**，1280×900 为主，另有一段 390×844。项目记忆里那条「Playwright 自带的 chromium 构建号对不上，用系统 Chrome」照做了。

**服务端的正确性不靠这一轮**：api 端那 25 条 vitest 在真 Postgres 上跑过了。这一轮验的是**前端拿到各种响应之后干了什么**，以及前端自己那三条路径的分流。

### 逐条对着「做完的标准」验了什么

**入口与菜单。** 浏览页每张卡都有「⋯」，几何量过在右上角（距上 <12px、距右 <12px）。弹层里 Tab 能依次走到每一项并**走得出去**（不是焦点陷阱），`Esc` 关闭后焦点回到那张卡的「⋯」——包括从编辑侧边栏关闭时。点弹层外部关闭。

**复制那条路径（本任务最要紧的一条）。**

- 桌面静图：点「复制」后**真的去读了一次剪贴板**——`navigator.clipboard.read()` 拿回来的是 `image/png`，PNG magic 头对得上，内容非空。这一步是「复制成功了没有」唯一的硬证据，光看界面提示不算。
- 非 PNG 的图：同一张 `image/jpeg` 的图复制后剪贴板里仍然是 `image/png`——证明 canvas 那道转码真的被走到了。
- 桌面动图：菜单第一项文案是**「下载」**不是「复制」，点了**真的触发下载事件**（拿到文件名 `shake.gif`），提示里说明「动图写不进剪贴板」。
- 复制失败降级：**注入**失败来验（不是等浏览器自然失败——无头 Chrome 里不申请权限也能写剪贴板，想让它自然拒绝反而做不到）。写剪贴板被拒 → 真的触发下载 + 提示「复制失败：浏览器拒绝了剪贴板权限，已开始下载」。
- 取原图失败（模拟 CORS 没配）→ 提示里**指向 CORS**，并改为在新标签页打开原图，不是只报一句失败。

**这里改了一处实现，理由值得记一笔。** 原先取图失败和写剪贴板被拒在 `ClipboardItem` 的 Promise 上长得一模一样，于是 CORS 漏配会被报成「浏览器拒绝了剪贴板权限」——而 deployment.md §8.3 说这条漏配是**静默**退化的，现在它至少会说话，且说的是对的。做法：取图那条链自己记一笔失败，报错时优先用它；另外 `fetch` 的网络层失败只给一句英文 `Failed to fetch`，不再原样往界面上抛。

**编辑侧边栏。** §5.2.6 的对外字段逐个点名查过（文件名 / 格式 / 尺寸 / 大小 / 动图 / 上传者 / 上传时间 / 打标状态 / 视觉模型 / 收藏 / 图片 ID / 上传者 ID / 最近编辑）；`contentHash` / `phash` / `embedding` / `searchText` / `embedModel` / `deletedAt` / `storageKey` **一个都没出现**。面板里只有描述一个 `textarea`，OCR 是只读段落、没有输入框。三个数组从词表选，点选生效。没改动时「保存」是禁用的；保存成功后**列表里那一条就地变成服务端返回的对象**（拿卡片的 `alt` 对过），没有再拉一次列表。失败时展示服务端 message 与 requestId（用 400 拦出来验的）。

**删除。** 有二次确认，确认框默认聚焦「取消」；成功后从当前列表移除。**404 当成功**（拦成 404，卡片照样消失且不显示错误）。**403 如实显示**服务端那句话与 requestId，且**卡片留在列表里**——没有做乐观更新。别人的图（`role: member` 且不是上传者）「删除」保留但禁用，并给出原因。

**首页 / 搜索页。** 同一个按钮：静图写「复制」、动图写「下载」，走的是 `lib/clipboard.ts`，提示语与浏览页逐字相同。**顺手清掉的那笔旧账已清**：首页不再把图片地址写进剪贴板（实测断言过提示里不含「地址」）。

**窄屏。** 390×844 下「⋯」和菜单项都 ≥44×44（量出来的像素），侧边栏是全宽抽屉。

**没有多余请求。** 替身服务记下了收到的每个请求，清单里没有意外的一次列表重拉。

### 真机那一条：**没测**

[clipboard-share.md §8](../../web/agents/rules/clipboard-share.md) 与 [web/AGENTS.md §6](../../web/AGENTS.md) 都要求「桌面 + 真机各一轮」。**这一轮只有桌面 Chrome。** 手上没有可测的手机，`navigator.share({ files })` 这条路径因此**一次都没有真的跑过**——它在桌面无头 Chrome 里走不到（`pointer: coarse` 不匹配），模拟触屏也只是把媒体查询骗过去，验不了系统分享面板真的弹出来、真的能把图发进微信。

所以「手机 → 分享」那一格**没有勾**。要补的是：一台 iPhone Safari + 一台 Android Chrome，各点一次动图与静图。`lib/clipboard.ts` 里那条路径的写法（先 `canShare` 再 `share`、`AbortError` 当用户取消不当失败、失败降级下载）是照规则写的，但**照规则写不等于验过**。

### 一处与规则对不上的地方，按规则第 7 条回报总管

[clipboard-share.md §5](../../web/agents/rules/clipboard-share.md) 给的探测顺序是：

```ts
if (navigator.canShare?.({ files: [f] })) { ... }
else if (navigator.clipboard?.write) { ... }
else { downloadFlow() }
```

**照这个顺序写，桌面 Windows Chrome 会走分享。** 它上面 `navigator.canShare({files})` 返回 true（系统分享面板是有的），而 §3 又要求桌面静图的按钮写「复制」、SPEC §9.2 说桌面主路径是「点一下切回微信 Ctrl+V」。两者只能选一个，本端选了**加一个触摸条件**（`matchMedia('(pointer: coarse)')`）作为分享的前置：只有触屏优先设备才走分享。这不是 UA 判断——是和 `prefers-color-scheme` 同类的平台能力查询，符合 §5 的原则。

代码里写了理由（`clipboard.ts` 的 `touchPrimary()`）。**要不要把这条补进 §5 的示例**由总管定：现在的示例照抄会得到错误行为，而这份规则是本端最容易照着写的地方。

### 另外三件交给总管的事

1. **`PATCH` 的请求体没有类型同步。** api 端在验收里说「`MemePatch` 现在可以从 `$patch` 推导了」，**这条不成立**：那条路由的 handler 直接 `c.req.json()`、没挂校验器，Hono 给出的输入类型里**根本没有 `json` 这一段**（`$patch` 只推出 `{ param: { id: string } }`）。我把这一点实测过（改了名不报错、只在运行时收到 400），`lib/api.ts` 的注释改成如实描述这个缺口。补法是 api 端给这条路由挂一个校验器让 RPC 能推导——**请总管决定要不要单开一条 api 单端任务**。在此之前那个手写的 `MemePatch` 保留。
2. **deployment.md §8.3 那句「表现和浏览器不支持剪贴板写入完全一样」现在只对了一半**：这次改了降级提示之后，取图失败会明说「取不到原图（可能是 R2 的 CORS 没放行 GET）」，和权限被拒区分得开。§8.3 的排查顺序仍然成立，但结论那半句该改。
3. **侧边栏里列了「图片 ID」和「上传者 ID」两个 uuid。** §5.2.6 没把它们列进对外字段清单，`Meme` 里有（`id` / `uploaderId`），我按「§5.2.6 是上限」的理解**保留了**——报问题时这两个 ID 是对日志最有用的东西。如果总管认为不该露，删掉是两个 `<dt>/<dd>` 的事。

### 交付说明

- **改了什么**：新增 `src/lib/clipboard.ts`（分流 + 能力探测 + 三条路径 + 文件名处理）、`src/features/manage/`（`MemeActions.tsx` 弹层、`MemeEditPanel.tsx` 侧边栏、`use-meme-edit.ts` 草稿与 PATCH 构造）、`src/components/VocabPicker.tsx`；`src/lib/api.ts` 加 `patchMeme` / `deleteMeme` 与从 RPC 推导的 `MemeDetail`；`MemeCard.tsx` 加 `actions` 插槽；`browse.tsx` 接操作、就地更新与提示；`home.tsx` 的临时复制换成 `lib/clipboard.ts`；`styles.css` 加弹层 / 侧边栏 / 词表控件的**结构性**布局（无颜色、边框、阴影、圆角、动效，web/AGENTS.md §5）。
- **没有做乐观更新**（编辑与删除都是等服务端确认再改本地），也不维护影子副本：保存后直接拿响应替换列表里那一条。
- **编辑不发空 PATCH**：没有字段变化时请求根本不发出去，避免在服务端留下「有人编辑过」的 `edited_by` / `edited_at` 痕迹（与 api 端空 PATCH 的取舍一致）。
- **动没动 SPEC**：没有。**动了一处 web 端规则的建议**（`clipboard-share.md §5` 的探测顺序），见上面「一处与规则对不上的地方」——这条**没有自行改规则**，按 §7 回报。
- **只写了布局样式**：弹层与侧边栏目前**没有视觉分隔**（没背景色、没边框、没阴影），骨架阶段这是刻意的。等视觉风格定稿那次补——**在那之前它们看起来是「浮在图上的一片文字」，可用但不体面**。
- **没动 `api/`**：一行没改。

## 总管裁定（2026-09-24，随任务板整顿一并处理）

**真实状态：两端实现与验收都完成，本任务该做的都做完了。** 它挂在 `in_progress` 上是因为三件事**都不是它的欠账**——本轮逐条结掉：

| 报上来的 | 裁定 |
|---|---|
| ① 编辑不改 `tag_status`，`needs_manual` 的图人工补完仍留在待处理列表里 | **是 SPEC 自己的矛盾，不是实现缺陷。** §6.4.1 的写入清单里没有 `tag_status`，而 §6.6.2 说「人工用 `PATCH` 补」是两条出路之一——走完这条「不花钱」的路，图并没有离开列表，`counts.needsManual` 一个不减。**你当时没有自行加这个写入是对的**（写入清单里没有的字段不该由实现补上）。已单开一条跨端任务：[人工补完标签之后，怎么离开待处理列表](../../joint-tasks/2026-09-24-needs-manual-exit.md)，**带一个待产品负责人裁定的选型**（推荐 A：`PATCH` 成功即把 `needs_manual` 置回 `ok`）。 |
| ② `PATCH` 的请求体没有类型同步（那条路由的 handler 直接 `c.req.json()`、没挂校验器，`$patch` 推不出 `json` 这一段） | **你的实测结论成立，api 端验收里那句「`MemePatch` 现在可以从 `$patch` 推导了」不成立。** 你保留手写 `MemePatch` 是对的，别删。补法是给路由挂校验器——已登记到任务板的「已知缺口」，**不单开任务**（它和 §3.3 的入参形状校验同源，[会话与访问收口](../../joint-tasks/2026-09-24-auth-access-hardening.md) §3 第 6 条正在做同一件事，收口时一起看）。 |
| ③ 侧边栏露「图片 ID」与「上传者 ID」 | **保留。** §5.2.6 是**上限**不是白名单，而这两个 ID 在报问题时是唯一能把界面和日志对上的东西。判断依据是「它对用户有没有害」而不是「清单里有没有」——uuid 既不泄露上传者身份（那要另一次请求），也不落在 §3.5 的密钥类字段里。 |
| ④ `clipboard-share.md §5` 的探测顺序照抄会得到错误行为（桌面 Windows Chrome 的 `canShare({files})` 返回 true，于是桌面静图会走分享而不是「复制」） | **你加 `matchMedia('(pointer: coarse)')` 前置是对的，规则照你的写法改。** 理由：`§3` 要求桌面静图的按钮写「复制」，`§9.2` 说桌面主路径是「点一下切回微信 Ctrl+V」——**探测顺序不能推翻这两条**。这不是 UA 判断，是和 `prefers-color-scheme` 同类的平台能力查询，符合 §5 自己的原则。规则里的示例已按此更正（`web/agents/rules/clipboard-share.md §5`）。 |
| ⑤ `deployment.md §8.3`「表现和浏览器不支持剪贴板写入完全一样」现在只对了一半 | **成立，照你的说法改。** 取图失败会明说指向 R2 的 CORS，和权限被拒区分得开——**这正是 §8.3 该有的样子**：它是一份排查手册，把两种失败压成一句就等于把手册最有用的那一步删了。已改。 |

**两处没测的处置**：真机分享（`navigator.share({files})`）并入任务板的「待测清单：真机与部署」，与 [web 交互缺陷批修](2026-09-24-web-interaction-fixes.md) 第 3、4 条、[首页随机图墙](2026-09-19-home-random-grid.md) 的自动聚焦一批上机。**`lib/clipboard.ts` 里那条路径写对了不等于验过了**——这句话留在板子上。

**样式那条已知不足照旧**：弹层与侧边栏没有视觉分隔（浮在图上的一片文字）。它随视觉风格定稿那次补，**不在本任务里**，也**不是本任务没做完**。

→ **转 `done`，待归档。**
