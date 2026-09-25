# 任务板

需要 `api` 和 `web` 同时动的事情放这里。判断标准不是工作量，是**「一端先合入会不会让另一端坏掉」**。什么时候必须开、什么时候不必，见 [SPEC §8.2](../spec/08-collaboration.md)。

**单端任务也登记在这块板上**，标注「api 单端」或「web 单端」，文件里只写那一端的小节。理由：执行者的开工读取只指向这里（见 `api/AGENTS.md §1`、`web/AGENTS.md`），本端任务写在别处等于没人会读到它。单端任务没有联合验收，本端验收通过即可归档。

命名 `YYYY-MM-DD-主题.md`。完成后移到 [`_archive/joint-tasks/`](../_archive/joint-tasks/README.md)，**不要删除**——它记录了这个决定是怎么来的。

## 状态

只有三个主状态，阻塞单列：

| 状态 | 含义 |
|---|---|
| `planning` | 未开工：契约还在讨论，**或契约已定但没人动手**。两种都不写实现代码 |
| `in_progress` | 已开工：有本端未提交或未验收的改动。**不是「已登记」的意思** |
| `done` | 联合验收通过（单端任务：本端验收通过），准备归档 |

**这块板是索引，不是记录。** 每一格只写「现在卡在哪」，过程与推导留在任务文件里；同一个结论不要在这里、任务文件和 SPEC §9 各写一遍。任务文件头部的状态与这里必须一致，不一致时以任务文件为准，顺手把板子改掉。

各端只回填**本端**的任务和**有依据的**验证结果。没跑的测试不要写成跑过了。

## 当前任务

**核心功能优先，优化任务边用边迭代。** 词表、评测集、供应商探测不阻塞核心功能开发，先用 `proposed` 版本落代码，结果随使用积累后持续改进（2026-09-24 由 [SPEC §9.27](../spec/09-decisions.md) 裁定，取代 §9.12 原来的「先跑评测」）。

### 实施中

| 任务 | 状态 | 端 | 现在卡在哪 |
|---|---|---|---|
| [运行参数：并发上限进管理页](2026-09-23-runtime-config.md) | `in_progress` | 跨端 | 两端实现与各自验收都完成，但 web 的断言全部对着**按 api 实现逐字校准的替身**，两端从未真对话；**真实提速也一次没量过**——不要读成「速度问题已解决」 |
| [会话与访问收口：读路径登录、限流、注册竞态、401 跳转](2026-09-24-auth-access-hardening.md) | `in_progress` | 跨端 | **只差 §8 那两条联合验收**（401 → 跳登录 → 回原页；429 → 倒计时）：api 已合入（`4f6a97f`）、web 四条已落、两端验收都已回填，但 web 那轮对着替身走的——重跑要盯的三处见任务文件 §9。§4 另有 2 项待产品负责人裁定 |

### 卡在外部条件或待裁定

| 任务 | 状态 | 端 | 现在卡在哪 |
|---|---|---|---|
| [批量重打标 `POST /memes/retag`](2026-09-22-retag-endpoint.md) | `in_progress` | 跨端 | 两端实现与验收都完成，**只差真库全量重打**——它是「`ratings` 从全空变成有值」的唯一验证方式，要花 admin 自己的额度、约 9–20 分钟，**跑之前问一句** |
| [内容分级独立成第七维 `ratings`（词表 v0.3.0）](2026-09-22-r18-ratings-dimension.md) | `in_progress` | 跨端 | 两端实现完成（迁移 0007 对真库跑通、`npx vitest run` 375/375）。三处诚实项：这一维的打标主力是人工、多问的那一问对无害的图也问（无实测）、评测集没跑 |
| [语义维度拆成五个 + 检索五处修正](2026-09-22-语义维度拆分.md) | `in_progress` | 跨端 | 两端实现完成。两处欠账：评测集没跑（词表 / 提示词 / 检索三样都动了）、web 没在浏览器里开过 |
| [打标状态界面](2026-09-19-tagging-status.md) | `in_progress` | 跨端 | 两端实现完成，**卡在联合验收**：本地库没有 `pending` / `needs_manual` 的图，而「汇总 `needsManual` = 列表条数」正是替身验不了的那条，要在真链路造一张。SPEC §6.6 已按此在 2026-09-24 转 `accepted`，验收仍挂在这一条上 |
| [web 迁 Tailwind v4 + radix-luma 组件层](2026-09-21-web-tailwind-v4-radix-luma.md) | `in_progress` | web 单端 | 代码侧完成、`/ui` 实测通过；**剩业务四页要登录后过一眼**，仓库里没有开发凭据，执行者无法自证 |

### 持续优化（不阻塞核心功能）

| 任务 | 状态 | 端 | 现在卡在哪 |
|---|---|---|---|
| [评测集](2026-09-13-eval-set.md) | `in_progress` | 持续 | 边用边跑。两项前置：`eval.ts` 里内嵌的是探测期提示词、不是上线那份；标注还是词表 v0.1 的两维口径（30 条里 23 条不合法） |
| [词表 v1](2026-09-13-vocab-v1.md) | `in_progress` | 持续 | 先用 `proposed` 版本落代码，跑出数据后迭代 |
| [供应商探测](2026-09-13-provider-spikes.md) | `in_progress` | 持续 | 先选一个能用的。真供应商的超时、限流、流式截断、各家 `error` 体型一条都没验过 |

### 未开工

| 任务 | 状态 | 端 | 现在卡在哪 |
|---|---|---|---|
| [人工补完标签之后，怎么离开待处理列表](2026-09-24-needs-manual-exit.md) | `planning` | 跨端 | **要先裁定才能动手**：§6.4.1 的写入清单里没有 `tag_status`，而 §6.6.2 说「人工用 `PATCH` 补」是 `needs_manual` 的两条出路之一——两节矛盾，补完仍留在列表里。三个走法见任务文件、推荐 A；验收动作与[打标状态界面](2026-09-19-tagging-status.md)共用（都要真库造一张 `needs_manual`，造一次验两条） |
| [回收站、查重与定时清理](2026-09-24-trash-and-cleanup.md) | `planning` | 跨端 | restore / duplicates 未实现、五个定时任务为零、「重传删过的图」语义未定义 |
| [首次部署与积压的联合验收](2026-09-24-first-deploy.md) | `planning` | 总管 + 运维 | 部署手册缺首启序列、反代样例、首个 admin。它是解开「联调等部署」死锁的那把钥匙 |
| [测试设施与 CI](2026-09-24-test-infra-ci.md) | `planning` | 跨端 | 无 CI、web 无常驻测试。**排在 §6.4 与部署之后** |
| [梗名别名层](2026-09-13-meme-lexicon.md) | `planning` | 总管 | 检索实现定稿前做完；词表是闭集，梗名是开集，见 [SPEC §9.18](../spec/09-decisions.md) |

**2026-09-25 已全部归档**：上一版这里压着 21 张 `done` 的任务文件，挡住它们的是代码注释里写死的 `joint-tasks/` 路径。两端各开一张单端任务把注释改成只写任务名（写法见 [documentation.md](../agents/rules/documentation.md)），随后 23 张一起移进 [`_archive/joint-tasks/`](../_archive/joint-tasks/README.md)，一句话结论搬到那边的索引表里。

**还没有任务、但已知缺口**：设置页与管理页的统计面板（`settings-ux.md §9`，接口随[打标状态界面](2026-09-19-tagging-status.md)一起做、界面没做）、浏览页缺「只看我上传的」筛选（api 已支持 `uploader=me`）、全量重新打标前没有费用预估、`PATCH /memes/{id}` 没挂校验器所以 RPC 推不出请求体类型、web 的 `uploadToR2` 兜底把 CORS / TLS / DNS 失败和 HTTP 失败压成同一句「上传失败」（[R2 那条任务](../_archive/joint-tasks/2026-09-18-r2-public-url-prefix.md) §6 记了为什么它值得单独修）。

## 待测清单：真机与部署

一批任务都卡在同一个前置条件上——**真 api × 真浏览器 / 真机 / 部署后有数据**。它们共用一个排期，不需要各写一遍：

| 待测项 | 出处 |
|---|---|
| 手机 → 分享（`navigator.share({files})`）：iPhone Safari + Android Chrome 各点一次动图与静图 | [浏览页图片操作](../_archive/joint-tasks/2026-09-19-browse-meme-actions.md)、`web/agents/rules/clipboard-share.md §8` |
| iOS 上「点击前先取原图」保住用户激活这条是否真的成立 | [web 交互缺陷批修](../_archive/joint-tasks/2026-09-24-web-interaction-fixes.md) 第 3、4 条 |
| 手机端首页不再自动聚焦、不弹键盘盖住随机图墙 | [首页随机图墙](../_archive/joint-tasks/2026-09-19-home-random-grid.md)（代码已修于 `a5ee19b`，真机未看） |
| 真 api × 真浏览器联调：`existing` 为 null 的降级、`sizeBytes` 字符串、SSE 断线→快照→重连 | [导入任务归档](../_archive/joint-tasks/2026-09-15-import.md) |
| `QUOTA_EXCEEDED` 的 `remaining` 展示、`INTERNAL` 的 `requestId` 展示 | 同上，需真实配额环境 |
| 导入路径在移动端 / 触屏、Safari、Firefox | 同上 |
| 图墙的空库态与请求失败态 | [首页随机图墙](../_archive/joint-tasks/2026-09-19-home-random-grid.md) |
| 汇总的 `needsManual` = 列表条数（要造一张 `needs_manual`） | [打标状态界面](2026-09-19-tagging-status.md) |
| 会话过期 401 → 跳登录 → 回原页；连错密码 429 → 倒计时 | [会话与访问收口](2026-09-24-auth-access-hardening.md) §8 |

**真机只在动复制 / 分享路径时才必须**（`web/AGENTS.md §6`）。设置页与管理页在 390×844 的**视口**下测过就够——视口不等于真机，但那两页不涉及复制 / 分享路径。

## 已销账的遗留项

改完就删行，但**结论留在这里**——它们曾是「漏了不报错」的典型，下次改同一块代码时要能一眼看到：

- ~~手机端首页自动聚焦~~ —— 已修（`a5ee19b`，按 `(pointer: fine)` 分流），真机没看，见上表。
- ~~`POST /admin/reindex` 的 `enqueuedCount` 没有界面消费~~ —— 已消费（`ReindexPanel`），并补了编译期断言：字段改名会让 `typecheck` 炸。
- ~~降帧梯子 `[10, 4, 1]` 生产里走不到~~ —— 已修（`81e1aeb`，能力位跟着配置来源走）。
- ~~`finish_reason: 'length'` 归 `AI_INVALID_OUTPUT` 只活在任务文件里~~ —— 已进 `api/agents/rules/ai-providers.md §3`。
- ~~HyDE 走部署方 `env.defaultVision`，未按搜索者本人通道解析~~ —— 已修（`81e1aeb`，登录用户走本人通道，匿名落部署方默认）。这条是与 SPEC §6.3.1 的**已知契约偏差**，接入点唯一在 `services/search.ts`。
- ~~`resolveEmbedConfig()` 只读环境变量~~ —— 已修（`81e1aeb`，配置表优先，只认 `verified_at` 非空的行）。
- ~~web 侧 `tagStatus` 徽标直出英文枚举~~ —— 并入[打标状态界面](2026-09-19-tagging-status.md)。
- ~~首页「复制地址」是临时实现~~ —— 已换成 `lib/clipboard.ts` 的真流程（[浏览页图片操作](../_archive/joint-tasks/2026-09-19-browse-meme-actions.md)）。
- ~~「全站重建索引已排队 N 条」那句话没人在浏览器里见过~~ —— 同卡另一句已验（1264 / 390 两档）；`EmbedSettings` 那句走的 `PUT /config/embed` 回执仍没在浏览器里见过。
- ~~两端 typecheck 口径不一致~~ —— 已对齐（2026-09-16）：`api/tsconfig.json` 也开着 `noUnusedLocals` + `noUnusedParameters`。**闸门始终是 `cd web && npm run typecheck`**，因为 `web` 的类型链会把 `api/src/` 一起编译；任何一端单方面加严格开关，又会回到「api 自查全绿、闸门红」。

## 仍然开着的遗留项

### 来自模型配置与打标队列

| 遗留项 | 归属 |
|---|---|
| 模型上游全程是替身。真供应商的超时、限流、流式截断、各家 `error` 体型一条都没验过 | [供应商探测](2026-09-13-provider-spikes.md) |
| `finish_reason: 'length'` 的真实频次**没有实测支撑**——规则里已明写，别当成已验证的结论引用 | 同上 |
| `tag_status = 'refused'` 目前不可达（只有主通道，终局失败全落 `needs_manual`） | 等 SPEC §9.5 转 `accepted` + 副通道接入。**不是缺陷**，不要为了让状态可达提前实现 §9.5 |
| 设置页在 `VISION_NOTICE` 底下多一行「副通道的配置入口尚未开放」——契约文案让用户去配副通道，界面上没有那个输入框 | **同样绑 §9.5**：入口一开放，这行字必须删。它是对界面现状的说明、写在 `<pre>` 契约块之外，契约文案仍逐字可比对 |

### 来自 api 收尾、导入与搜索

| 遗留项 | 归属 |
|---|---|
| `routes/auth.ts` 的 `/me` 自己重复了一遍会话解析，与 `middleware/auth.ts` 的 `resolveUser` 同一套逻辑 | api 本端重构，非紧急；改时确认错误码仍是 `UNAUTHENTICATED` |
| 剪贴板 `Ctrl+V` 入口、拖拽文件夹递归（`webkitGetAsEntry`）未实测 | web 本端，补测时机自定 |
| `rrf.ts` 依赖「`data/` 每路返回的 id 不重复」，上游 join 出重复行会静默翻倍 | 改 `api/src/data/search.ts` 的 join 时回看 |
| `order by random()` 是全表扫描。几万行毫秒级，**百万行会是秒级**；触发条件已写进 `data/memes.ts` 的注释 | 到量了再换，不提前优化。改 `listMemes` 时回看 |

## 写任务的要求

每个任务文件至少要有：**为什么要做**、**做完的标准是什么**、**两端各自要改什么**。

不要写成一个待办清单。三个月后回来看时，「当时为什么决定这么做」比「做了哪几步」重要得多。

决策结论写完后要搬进 [SPEC §9](../spec/09-decisions.md)——**任务是过程，SPEC 是结论**。
