# 任务板

需要 `api` 和 `web` 同时动的事情放这里。判断标准不是工作量，是**「一端先合入会不会让另一端坏掉」**。什么时候必须开、什么时候不必，见 [SPEC §8.2](../spec/08-collaboration.md)。

**单端任务也登记在这块板上**，标注「api 单端」或「web 单端」，文件里只写那一端的小节。理由：执行者的开工读取只指向这里（见 `api/AGENTS.md §1`、`web/AGENTS.md`），本端任务写在别处等于没人会读到它。单端任务没有联合验收，本端验收通过即可归档。

命名 `YYYY-MM-DD-主题.md`。完成后移到 [`_archive/joint-tasks/`](../_archive/joint-tasks/README.md)，**不要删除**——它记录了这个决定是怎么来的。

## 状态

只有三个主状态，阻塞单列：

| 状态 | 含义 |
|---|---|
| `planning` | 契约还在讨论，**不写实现代码** |
| `in_progress` | 契约已转 `accepted`，两端在实现 |
| `done` | 联合验收通过（单端任务：本端验收通过），准备归档 |

各端只回填**本端**的任务和**有依据的**验证结果。没跑的测试不要写成跑过了。

## 当前任务

**核心功能优先，优化任务边用边迭代。** 词表、评测集、供应商探测不阻塞核心功能开发，先用 `proposed` 版本落代码，结果随使用积累后持续改进。

| 任务 | 状态 | 性质 |
|---|---|---|
| [首页随机图墙](2026-09-19-home-random-grid.md) | `done` | **跨端**——首页现在是纯搜索框，没有「翻」的入口；`GET /memes` 加 `random=true` 在全库抽样（SPEC §6.3.2，已转 `accepted`） |
| [打标状态界面](2026-09-19-tagging-status.md) | `planning` | **跨端**——打标跑起来了但界面上看不见，兑现 §5.2.3 / `styling.md` / `settings-ux.md §9` 三处已写下的承诺；新增 `GET /memes/tag-status`（SPEC §6.6，`proposed`） |
| [三个管理页并入设置页](2026-09-18-settings-merge.md) | `in_progress` | **web 单端**——`/admin/*` 三页都是设置项；带出两处 SPEC 措辞偏差待总管裁定 |
| [R2 公开 URL 丢了键前缀](2026-09-18-r2-public-url-prefix.md) | `in_progress` | **api 单端，挡着用**——首次接真实 R2 就全站裂图；派生 URL 有两份实现，都没加 `R2_KEY_PREFIX` |
| [评测集](2026-09-13-eval-set.md) | `in_progress` | 持续优化——边用边跑；**已转入一项工具改造**：`eval.ts` 现在跑的是探测期提示词，不是上线那份 |
| [词表 v1](2026-09-13-vocab-v1.md) | `in_progress` | 持续优化——`proposed` 版本直接落代码，跑出数据后迭代 |
| [供应商探测](2026-09-13-provider-spikes.md) | `in_progress` | 持续优化——先选一个能用的，探测结果随用随补 |
| [梗名别名层](2026-09-13-meme-lexicon.md) | `planning` | 检索实现定稿前做完；词表是闭集，梗名是开集，见 [SPEC §9.18](../spec/09-decisions.md) |

**已归档**：骨架、认证、Admin 邀请码与用户管理、浏览页、搜索页、导入、打标队列消费者（含收藏端点）、api 收尾三件、模型配置与测试连接，见 [`_archive/joint-tasks/`](../_archive/joint-tasks/)。

**还没有任务、但已知缺口**：SPEC §6.4 的编辑/软删/restore/retag/查重接口（**`needs_manual` 的图要能补标，等的就是这一批**）、`queue.md §6` 的五个定时清理任务、设置页与管理页的统计面板（`settings-ux.md §9`，接口随[打标状态界面](2026-09-19-tagging-status.md)一起做，界面没做）、部署、**`web/` 的常驻 e2e**。

> ~~web 侧 `tagStatus` 徽标直出英文枚举~~ —— 已并入[打标状态界面](2026-09-19-tagging-status.md)（2026-09-19）。

> 最后一条有明确排期：**排在 §6.4 和部署之后**（测试设施不阻塞核心功能）。`web/package.json` 至今只有 `dev` / `build` / `preview` / `typecheck`，没有任何测试框架——已经是第四个用一次性脚本跑几十条断言、跑完即删的任务了，代价是每轮重写驱动、归档里的数字全不可复现。
>
> 沉淀时**不要整包搬**：硬边界（key 不出响应）、错误码路径、403、重建端到端值得留；布局类断言不值得——视觉风格没定稿（`web/AGENTS.md §5`），留下来只会因为装饰改动变红。最该先重建的是那个**六模式的模型上游替身**（`good`/`weak`/`small`/`badkey`/`offvocab`/`refuse`），768 维、上游 401、词表越界这些路径拿真供应商凑不出来。设计记在[模型配置任务](../_archive/joint-tasks/2026-09-16-ai-config.md)的 web 验收里。

> ✅ **两端 typecheck 口径已对齐**（2026-09-16，见[api 收尾三件](../_archive/joint-tasks/2026-09-16-api-housekeeping.md)）。`api/tsconfig.json` 现在也开着 `noUnusedLocals` + `noUnusedParameters`，所以本端自查和提交前闸门看到的是同一批错误。
>
> 这条留在这里是因为**那次的漏法还会再来**：`web` 的类型链会把 `api/src/` 一起编译（`api/package.json` 的 `exports` 指向 `./src/app.ts`），任何一端往 `tsconfig.json` 加严格开关而另一端不加，就又会出现「api 自查全绿、闸门红、报错全在 api 代码里」。闸门始终是 `cd web && npm run typecheck`，见[骨架任务](../_archive/joint-tasks/2026-09-13-skeleton.md)第 10 条。

## 模型配置任务转出的遗留项

出处见[该任务归档](../_archive/joint-tasks/2026-09-16-ai-config.md)的第四轮联合验收：

| 遗留项 | 归属 |
|---|---|
| 「全站重建索引已排队 N 条」那句话**没有人在浏览器里见过**——代码路径跑过，但 `${n}` 前后的空格、窄屏会不会挤断行只有渲染出来才知道 | web 本端，下次为别的事起浏览器时顺手看一眼 |
| `POST /admin/reindex` 的 `enqueuedCount` **没有任何界面消费它**（`startReindex()` 按契约只看 `res.ok`，理由正当），只被测试和日志消费 | 不是缺陷，记着就行：它的回归只有测试会发现 |
| 模型上游全程是替身。真供应商的超时、限流、流式截断、各家 `error` 体型一条都没验过 | [供应商探测](2026-09-13-provider-spikes.md) |
| 设置页与管理页只在 Playwright 的 390×844 视口测过，**不是真机**。本任务两页不涉及复制 / 分享路径所以够用 | 动复制 / 分享路径时必须上真机（`web/AGENTS.md §6`） |

## 打标队列任务转出的遗留项

出处见[打标队列任务归档](../_archive/joint-tasks/2026-09-16-tag-queue.md)的总管裁定：

| 遗留项 | 归属 |
|---|---|
| 评测集未跑；**`eval.ts` 内嵌探测期提示词，不 import `src/ai/vision.ts`**，原样跑出的数字会被误读成「新提示词已验证」 | [评测集](2026-09-13-eval-set.md)，已进其「做完的标准」 |
| `tag_status = 'refused'` 目前不可达（只有主通道，终局失败全落 `needs_manual`） | 等 SPEC §9.5 转 `accepted` + 副通道接入；**不是缺陷**，不要为了让状态可达提前实现 §9.5 |
| 设置页会在 `VISION_NOTICE` 底下多一行「副通道的配置入口尚未开放」——因为契约文案让用户去配副通道，而界面上没有那个输入框（2026-09-18 总管裁定，见[模型配置与测试连接](../_archive/joint-tasks/2026-09-16-ai-config.md)的联合验收） | **同样绑 §9.5**：副通道入口一开放，这行字必须删。它是对界面现状的说明，不是契约的一部分，所以写在 `<pre>` 契约块之外——契约文案仍然逐字可比对 |
| 降帧梯子 `[10, 4, 1]` 生产里走不到：`resolveVisionConfig()` 固定 `multiImage: null` | ✅ api 端已修（2026-09-18，`81e1aeb`）：能力位跟着配置来源走，用户测出 `multiImage: true` 后梯子才是真实流量路径。部署方默认通道仍固定 null，那是有意的 |
| `finish_reason: 'length'` 归 `AI_INVALID_OUTPUT` 的判断只活在任务文件里 | ✅ 已完成，进了 `api/agents/rules/ai-providers.md §3`（见[api 收尾三件](../_archive/joint-tasks/2026-09-16-api-housekeeping.md)） |

## api 收尾三件转出的遗留项

出处见[该任务归档](../_archive/joint-tasks/2026-09-16-api-housekeeping.md)的总管裁定：

| 遗留项 | 归属 |
|---|---|
| `routes/auth.ts` 的 `/me` 自己重复了一遍会话解析，与 `middleware/auth.ts` 的 `resolveUser` 同一套逻辑 | api 本端重构，非紧急；改时确认错误码仍是 `UNAUTHENTICATED`（SPEC §6.1：401 即跳登录页） |
| `finish_reason: 'length'` 的真实频次**没有实测支撑**——规则里已明写这一点，别把它当已验证的结论引用 | [供应商探测](2026-09-13-provider-spikes.md)，跑出来再补 |

## 导入任务转出的遗留项

出处见[导入任务归档](../_archive/joint-tasks/2026-09-15-import.md)的联合验收。前三项共用一个前置条件——**部署 + 库里有真数据**，不需要两端再写代码：

| 遗留项 | 归属 |
|---|---|
| 真 api × 真浏览器联调未跑（web 断言全部对着替身）；重点看 `existing` 为 null 的降级、`sizeBytes` 字符串、SSE 断线→快照→重连 | 部署后的联合回归 |
| `QUOTA_EXCEEDED` 的 `remaining` 展示与「停止后续上传」、`INTERNAL` 的 `requestId` 展示只走了代码路径 | 同上，需真实配额环境 |
| 导入路径在移动端 / 触屏、Safari、Firefox 未测 | 同上 |
| 剪贴板 `Ctrl+V` 入口、拖拽文件夹递归（`webkitGetAsEntry`）未实测 | web 本端，补测时机自定 |

## 搜索任务转出的遗留项

这些不阻塞任何新任务，各自独立跟踪（出处见[搜索任务归档](../_archive/joint-tasks/2026-09-15-search.md)的联合验收）：

| 遗留项 | 归属 |
|---|---|
| 未跑评测集（`recall@5`）；本次动了 RRF 参数、HyDE 提示词、切词 | [评测集](2026-09-13-eval-set.md) |
| HyDE 走部署方 `env.defaultVision`，未按搜索者自己的视觉通道解析——**与 SPEC §6.3.1 的已知偏差** | ✅ api 端已修（2026-09-18，`81e1aeb`）：`rewriteQuery` 收 `actorId`，登录用户走本人通道，匿名落部署方默认 |
| `resolveEmbedConfig()` 只读环境变量，`embed_config` 表无读写路径 | ✅ api 端已修（2026-09-18，`81e1aeb`）：配置表优先、环境变量兜底，只认 `verified_at` 非空的行 |
| `rrf.ts` 依赖「`data/` 每路返回的 id 不重复」，上游 join 出重复行会静默翻倍 | 改 `api/src/data/search.ts` 的 join 时回看 |


## 首页随机图墙转出的遗留项

出处见[该任务](2026-09-19-home-random-grid.md)的两端验收。

| 遗留项 | 归属 |
|---|---|
| **手机端首页会自动聚焦搜索框 → 弹键盘 → 盖住刚做好的随机图墙。** `routes/home.tsx` 的 `autoFocus` 是本任务之前就有的（为了「打开就能打字搜」），图墙出现之前它没坏处；现在它对手机——也就是 `styling.md` 说的「这个产品体验最好的一端」——把整块新内容挡住了。**改它要动搜索路径的行为，而弹不弹键盘、盖住多少只有真机能回答**，所以没在这次版式改动里顺手改 | web 本端，**需要真机**。下次上真机时先看一眼这个 |
| 图墙的空库态与请求失败态**没有真实场景验证**（本地库有图、api 正常），走的是代码路径 | 部署后联合回归，与「真 api × 真浏览器联调」那批一起 |
| 随机卡片上**没有复制 / 发送入口**，只有收藏。有意留的：复制现在是一段临时实现，真流程（`clipboard-share.md`）要求桌面 + 真机各测一遍 | `clipboard-share.md` 的三条路径落地那次，两处一起接 |
| `order by random()` 是全表扫描。几万行毫秒级，**百万行会是秒级**。触发条件已写进 `data/memes.ts` 的注释 | 到量了再换，不提前优化。改 `listMemes` 时回看 |


## 写任务的要求

每个任务文件至少要有：**为什么要做**、**做完的标准是什么**、**两端各自要改什么**。

不要写成一个待办清单。三个月后回来看时，「当时为什么决定这么做」比「做了哪几步」重要得多。

决策结论写完后要搬进 [SPEC §9](../spec/09-decisions.md)——**任务是过程，SPEC 是结论**。
