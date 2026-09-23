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

### 已完成，待归档

按板子规则该移进 [`_archive/joint-tasks/`](../_archive/joint-tasks/README.md)，**这一步还没做**。

**2026-09-24 换了一次理由**，前一个已经作废：原来写的是「工作区里压着别端未提交的实现」，而那批实现（队列可靠性，`fdf1bfe`）已经提交，树是干净的。**现在挡住它的是另一件事**——`api/` 和 `web/` 里有 **13 个文件把 `joint-tasks/<任务>.md` 写进了注释**（`api/src/data/search.ts`、`api/src/image/probe.ts`、`api/src/shutdown.test.ts`、`api/tests/meme-edit-delete.test.ts`、`web/src/lib/api.ts`、`web/src/routes/settings.tsx`、`web/scripts/verify-*.mjs` 等，`grep -rl joint-tasks/2026 api web --include='*.ts' --include='*.tsx' --include='*.mjs'` 可重现）。移文件会让这些路径全部指空，而改它们是**改另一端的实现代码**，不在总管范围内，也会让那几条任务的「验收通过」不再成立。

**所以归档要拆成两步**：先由两端各自扫一遍自己代码里的任务路径（单端任务，纯注释、不动行为），再一次性移文件、改文档里的引用、跑 `node scripts/check-doc-links.mjs`。**在那之前不要移**——移了就会留下一批指向不存在文件的注释，而这正是这个板子存在的理由要防的事。

| 任务 | 端 | 一句话结论 |
|---|---|---|
| [队列可靠性：退出、僵死回收、未处理拒绝、重建漏行](2026-09-24-queue-reliability.md) | api 单端 | 九条全部落地（`fdf1bfe`，三个测试文件一起提的）。五项验收全部实测：`docker stop --time 10` → **390ms / exit 0**（对照组 10,273ms / exit 137）、造 `running` 行 ≤7 分钟被回收、交错入队一张不漏、unit 194 / integration 315 全过。**§5.5 的诚实项原样留着**：没跑真 SIGKILL、多副本回收靠代码论证、第 6 条只落了日志、`claimReindexJob` 领取时仍不看上限（建议另开一条） |
| [全屏阅览里 `Ctrl+C` / `Cmd+C` 复制当前这一张](2026-09-24-web-viewer-copy-shortcut.md) | web 单端 | 调的是卡片「⋯」菜单里那一项**同一个函数**（分流看 `isAnimated` + 能力探测，不看按了什么键），所以动图同样落到下载、触屏同样走系统分享。顺带把 toast `60` → `10000`——阅览器的黑底会把反馈整个盖住，**没有反馈的复制等于没复制**。两档浏览器 24/24、另两套回归 65/65 与 37/37，`typecheck` / `build` 干净，接口与 `spec/` 一行未动。**一条已知缺口本次没修**：阅览器里 toast 可见但点不到（YARL 给 `#root` 挂了 `inert`，与层级无关），修法见任务文件 §5 |
| [全站操作反馈：动作按钮补 toast](2026-09-24-web-toast-feedback.md) | web 单端 | Sonner 右上角，新套 37/37、旧套重跑 65/65，`typecheck` / `build` 干净，接口与 `spec/` 一行未动。登出那个真 bug（未处理拒绝 → 死按钮）修掉；两页那行裸文字收进 toast，文案缩成「已复制」。**顺带修掉一处 toast 引出来的回归**：sonner 的 `<li>` 也带 `data-index`，把搜索页按 ↓ 的焦点抢走了（1264 档 Esc 断言红了才查出来）。设置页与表单保存按裁定保持行内 |
| [文档与任务板整顿](2026-09-24-docs-board-cleanup.md) | 总管 | 七条标准逐条对照在 §3：板子 9191 → 386 字符、6 条状态更正、§9.27 / §9.28 两条新记录、893 条链接失效 0、署名规则归位。**归档那一步没做**，原因见 §3.2 |
| [三个管理页并入设置页](2026-09-18-settings-merge.md) | web 单端 | 页面已并完（`/admin` 三条子路径各重定向到 `/settings` 的锚点）。两处 SPEC 措辞偏差 2026-09-24 裁定为「改描述、不动约束」：§9.6 / §9.9 里「普通用户的设置页里没有这一组」「分成两个页面」改成权限口径与「两类分段」，全站一份 / 仅管理员等实质约束逐条照旧 |
| [浏览页图片操作：复制 / 编辑 / 删除](2026-09-19-browse-meme-actions.md) | 跨端 | 两端实现与验收都完成（浏览器 52 条断言）。四条报上来的问题逐条结清：`needs_manual` 的出口单开了新任务、`MemePatch` 类型同步归入已知缺口、两个 uuid 判定保留、`clipboard-share.md §5` 照实测更正。真机分享并入「真机待测」 |
| [检索召回与动图抽帧性能](2026-09-24-search-media-perf.md) | api 单端 | 四条全落地，`522 passed`。真库 15 条查询改前改后对照（改前文档在改动落地前的工作树上跑）：默认计划下逐位不变——1,809 行上规划器根本不用索引，修的是几千行之后的临界点；强制走索引时向量路 40 → 50 条、前 20 名 13 条发生位移。240 帧样本抽帧 12.5 s → 1.3 s 且逐帧字节一致，导入期整套抽帧 → 解一帧（51 ms）。**未跑评测**（评测集跑不了）。两处诚实项：`animated.webp` +6 ms 的回归、OCR 那条「拆开别用 OR」按效果交付而非字面 |
| [导入与存储加固](2026-09-24-import-hardening.md) | api 单端 | 七条全部成立，`436 passed`；`tempKey` 只认库里那份、配额按**实际字节**拦、超限对象在读进内存之前就拒 |
| [web 交互缺陷批修](2026-09-24-web-interaction-fixes.md) | web 单端 | 12 条全部落地，真 Chrome 两档 65/65。第 3、4 条的 **iOS 真机部分记「未测」**，总管裁定：归入下面那批「真机待测」，不单独挂在本任务上 |
| [R2 公开 URL 丢了键前缀](2026-09-18-r2-public-url-prefix.md) | api 单端 | 主修 + 启动探活 + 文档三件全做完，对真实 R2 逐个 HEAD 验过（对照组 404 即修复前的裂图）。三次提交已合入 |
| [web 导入页迁到 shadcn / Tailwind](2026-09-22-web-import-shadcn.md) | web 单端 | 浏览器 35/35；顺带修掉「六个状态类在 CSS 里根本不存在」 |
| [web 浏览页迁到 shadcn + 左栏固定](2026-09-22-web-browse-shadcn.md) | web 单端 | 六批验收累计上百条断言；顺带修掉顶栏层级、换筛选拿旧游标、masonic 滚动源 |
| [图片左键全屏阅览](2026-09-21-web-image-viewer.md) | web 单端 | 浏览器 49 条断言；要害是阅览器必须挂在页面子树之外 |
| [首页迁到 shadcn + 拆 `features/search/`](2026-09-21-web-home-shadcn.md) | web 单端 | 浏览器 49 条断言 |
| [卡片 / ⋯菜单 / 编辑侧边栏 shadcn 化](2026-09-21-web-card-shadcn.md) | web 单端 | 取代已归档的图片承载组件任务 |
| [外壳顶栏吸顶](2026-09-21-web-sticky-header.md) | web 单端 | 三处偏移量收成 `--app-header-h` 一个值 |
| [设置页改用 shadcn 重做](2026-09-21-web-settings-redesign.md) | web 单端 | 三条契约（两段逐字文案、不截断原始返回、不测不让保存）逐条证明活下来了 |
| [顶部导航换成侧边导航](2026-09-21-web-sidebar-nav.md) | web 单端 | 触摸目标契约换了个落点、断点从视口改容器查询 |
| [浏览页改瀑布流](2026-09-19-browse-masonry.md) | web 单端 | 按自然宽高比整张展示，不动 api / SPEC |
| [图片承载组件](2026-09-19-meme-image-host.md) | web 单端 | 已被 `MemeCard` + `MemeImage` 取代（`f7f6661`） |
| [首页随机图墙](2026-09-19-home-random-grid.md) | 跨端 | `GET /memes` 加 `random=true`（SPEC §6.3.2） |

**别处归档**：骨架、认证、Admin 邀请码与用户管理、浏览页、搜索页、导入、打标队列消费者、api 收尾三件、模型配置与测试连接，见 [`_archive/joint-tasks/`](../_archive/joint-tasks/)。

**还没有任务、但已知缺口**：设置页与管理页的统计面板（`settings-ux.md §9`，接口随[打标状态界面](2026-09-19-tagging-status.md)一起做、界面没做）、浏览页缺「只看我上传的」筛选（api 已支持 `uploader=me`）、全量重新打标前没有费用预估、`PATCH /memes/{id}` 没挂校验器所以 RPC 推不出请求体类型、web 的 `uploadToR2` 兜底把 CORS / TLS / DNS 失败和 HTTP 失败压成同一句「上传失败」（[R2 那条任务](2026-09-18-r2-public-url-prefix.md) §6 记了为什么它值得单独修）。

## 待测清单：真机与部署

一批任务都卡在同一个前置条件上——**真 api × 真浏览器 / 真机 / 部署后有数据**。它们共用一个排期，不需要各写一遍：

| 待测项 | 出处 |
|---|---|
| 手机 → 分享（`navigator.share({files})`）：iPhone Safari + Android Chrome 各点一次动图与静图 | [浏览页图片操作](2026-09-19-browse-meme-actions.md)、`web/agents/rules/clipboard-share.md §8` |
| iOS 上「点击前先取原图」保住用户激活这条是否真的成立 | [web 交互缺陷批修](2026-09-24-web-interaction-fixes.md) 第 3、4 条 |
| 手机端首页不再自动聚焦、不弹键盘盖住随机图墙 | [首页随机图墙](2026-09-19-home-random-grid.md)（代码已修于 `a5ee19b`，真机未看） |
| 真 api × 真浏览器联调：`existing` 为 null 的降级、`sizeBytes` 字符串、SSE 断线→快照→重连 | [导入任务归档](../_archive/joint-tasks/2026-09-15-import.md) |
| `QUOTA_EXCEEDED` 的 `remaining` 展示、`INTERNAL` 的 `requestId` 展示 | 同上，需真实配额环境 |
| 导入路径在移动端 / 触屏、Safari、Firefox | 同上 |
| 图墙的空库态与请求失败态 | [首页随机图墙](2026-09-19-home-random-grid.md) |
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
- ~~首页「复制地址」是临时实现~~ —— 已换成 `lib/clipboard.ts` 的真流程（[浏览页图片操作](2026-09-19-browse-meme-actions.md)）。
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
