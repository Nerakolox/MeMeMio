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
| [评测集](2026-09-13-eval-set.md) | `in_progress` | 持续优化——边用边跑；**已转入一项工具改造**：`eval.ts` 现在跑的是探测期提示词，不是上线那份 |
| [词表 v1](2026-09-13-vocab-v1.md) | `in_progress` | 持续优化——`proposed` 版本直接落代码，跑出数据后迭代 |
| [供应商探测](2026-09-13-provider-spikes.md) | `in_progress` | 持续优化——先选一个能用的，探测结果随用随补 |
| [梗名别名层](2026-09-13-meme-lexicon.md) | `planning` | 检索实现定稿前做完；词表是闭集，梗名是开集，见 [SPEC §9.18](../spec/09-decisions.md) |

**已归档**：骨架、认证、Admin 邀请码与用户管理、浏览页、搜索页、导入、打标队列消费者（含收藏端点）、api 收尾三件，见 [`_archive/joint-tasks/`](../_archive/joint-tasks/)。

**还没有任务、但已知缺口**：SPEC §6.4 的编辑/软删/restore/retag/查重接口、§6.5 的用户视觉配置与 Embedding 配置（含测试连接与重建索引）、`queue.md §6` 的五个定时清理任务、web 侧 `tagStatus` 徽标直出英文枚举、部署。

> ✅ **两端 typecheck 口径已对齐**（2026-09-16，见[api 收尾三件](../_archive/joint-tasks/2026-09-16-api-housekeeping.md)）。`api/tsconfig.json` 现在也开着 `noUnusedLocals` + `noUnusedParameters`，所以本端自查和提交前闸门看到的是同一批错误。
>
> 这条留在这里是因为**那次的漏法还会再来**：`web` 的类型链会把 `api/src/` 一起编译（`api/package.json` 的 `exports` 指向 `./src/app.ts`），任何一端往 `tsconfig.json` 加严格开关而另一端不加，就又会出现「api 自查全绿、闸门红、报错全在 api 代码里」。闸门始终是 `cd web && npm run typecheck`，见[骨架任务](../_archive/joint-tasks/2026-09-13-skeleton.md)第 10 条。

## 打标队列任务转出的遗留项

出处见[打标队列任务归档](../_archive/joint-tasks/2026-09-16-tag-queue.md)的总管裁定：

| 遗留项 | 归属 |
|---|---|
| 评测集未跑；**`eval.ts` 内嵌探测期提示词，不 import `src/ai/vision.ts`**，原样跑出的数字会被误读成「新提示词已验证」 | [评测集](2026-09-13-eval-set.md)，已进其「做完的标准」 |
| `tag_status = 'refused'` 目前不可达（只有主通道，终局失败全落 `needs_manual`） | 等 SPEC §9.5 转 `accepted` + 副通道接入；**不是缺陷**，不要为了让状态可达提前实现 §9.5 |
| 降帧梯子 `[10, 4, 1]` 生产里走不到：`resolveVisionConfig()` 固定 `multiImage: null` | SPEC §6.5 配置任务——探测结果存下来后自然变成真实流量路径 |
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
| HyDE 走部署方 `env.defaultVision`，未按搜索者自己的视觉通道解析——**与 SPEC §6.3.1 的已知偏差**，不改契约 | 待 `user_ai_configs` 读写与解密上线；接入点唯一，`api/src/services/search.ts` 的 `startVectorPath()` |
| `resolveEmbedConfig()` 只读环境变量，`embed_config` 表无读写路径 | 管理页 Embedding 配置任务 |
| `rrf.ts` 依赖「`data/` 每路返回的 id 不重复」，上游 join 出重复行会静默翻倍 | 改 `api/src/data/search.ts` 的 join 时回看 |


## 写任务的要求

每个任务文件至少要有：**为什么要做**、**做完的标准是什么**、**两端各自要改什么**。

不要写成一个待办清单。三个月后回来看时，「当时为什么决定这么做」比「做了哪几步」重要得多。

决策结论写完后要搬进 [SPEC §9](../spec/09-decisions.md)——**任务是过程，SPEC 是结论**。
