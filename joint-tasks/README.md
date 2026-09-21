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
| [首页迁到 shadcn + 拆 `features/search/`](2026-09-21-web-home-shadcn.md) | `done` | **web 单端**——首页是最后一个完全手写 BEM 的业务页：shadcn 控件「默认全部低于 44 且没有例外」这条在这里没人接住，页面也不随主题 token 走。三处行为改动：手机不再自动聚焦（按 `(pointer: fine)` 分流，否则弹键盘盖住随机图墙——这条是[随机图墙](2026-09-19-home-random-grid.md)转出的遗留项）、**「重试」从「清空搜索词把用户丢回图墙」改成真的重跑同一个词**、加 `max-w-6xl`。两处「漏了不报错」的坑：`@max-[900px]:` 生成的是 `@container (width < 900px)`（**`<` 不是 `≤`**，本仓零先例，写错只是永远 5 列）、`Input` 不包 `forwardRef` 则 `inputRef.current` 是 null，**自动聚焦静默不生效**（生产构建连警告都没有）。浏览器 49 条断言全过：5/3/2 三档容器分档、键盘全路径、重试请求计数 +1 且搜索词不变、手机 390×844 不聚焦且没有一枚按钮写「复制」 |
| [卡片 / ⋯菜单 / 编辑侧边栏 shadcn 化](2026-09-21-web-card-shadcn.md) | `done` | **web 单端**——组件库进来了但业务页一个都没用（上一轮顺手删掉了做错的那版 `MemeImage`），四页还是裸 `<img>`；同时 `MemeActions` / `MemeEditPanel` 两块骨架期的手写弹层在解决 Radix 已经做对的焦点进出、点外关闭、层叠。本轮把卡片抽成 `MemeCard` + `MemeImage` 四页共用，菜单换 `DropdownMenu` + `AlertDialog`，侧边栏换 `Sheet`，`styles.css` 少掉三块死规则。**要害是关闭后约 100ms 才发生的那次焦点恢复**——`preventDefault()` 真正兜住的是**点外关闭**那条路（打开确认框那条有模态陷阱兜着，删掉它测试照样过，实测对照写在任务文件里）。**本任务取代已归档的[图片承载组件](2026-09-19-meme-image-host.md)**（那个 `MemeImage` 已被 `f7f6661` 删掉），并取代[浏览页图片操作](2026-09-19-browse-meme-actions.md)验收表里「Tab 能依次走完」那条断言（`role="menu"` 下 Tab 被 Radix 吞掉，是 WAI-ARIA 的规定，**不是回归**） |
| [外壳顶栏吸顶](2026-09-21-web-sticky-header.md) | `done` | **web 单端**——顶栏唯一的常驻内容是折叠按钮，而不吸顶时它只在页面顶部可见，长页面一滚就再也折不动侧边栏。取 `sticky` 不取 `fixed`（后者抽离文档流，还得多补一层 `padding-top`）；代价是三处「必须比它低」的偏移量，收成 `--app-header-h` 一个值：顶栏自己、`.browse__sidebar` 的 sticky `top`／`max-height`、`SettingsCard` 的 `scroll-mt`。三处漏改**都不报错**：筛选栏滑到顶栏底下、锚点落进顶栏里，全靠肉眼。实测对照：`/browse` 滚到 1200 时顶栏 `top` 由 **-1200** 变 **0**，筛选栏由 0 变 56 |
| [迁 Tailwind v4 + radix-luma 组件层](2026-09-21-web-tailwind-v4-radix-luma.md) | `in_progress` | **web 单端**——上一轮只换对了颜色：preset `b1VlIttI` 的 `style` 是 `radix-luma`（不是 `new-york`）、自带 Inter 字体、圆角换算也从加减改成乘法。三层都在，所以「配色像、整体不像」。迁 Tailwind v4 是它的前置；`shadcn/tailwind.css` 是硬依赖（18 个组件靠它定义的 `data-open:` / `data-checked:` 等变体）。代码侧已完成、`/ui` 实测通过，剩业务四页要登录后过一眼才能关单——**侧边导航那次用 route 打桩在浏览器里渲染了 home / browse / import / settings，四页在外壳里都正常**（见[该任务](2026-09-21-web-sidebar-nav.md)的验收表），但那是渲染证据，不是真接口联调 |
| [设置页改用 shadcn 重做](2026-09-21-web-settings-redesign.md) | `done` | **web 单端**——外壳换成 shadcn 之后，`/settings` 里每一块还是 BEM 手写，一套界面两种来源。换皮不是重点：**这页扛着三条不能松的契约**（两段逐字文案、「不截断原始返回」、「不测不让保存」），重做的最大风险是它们在「看起来更现代」的过程中被悄悄削弱，所以验收标准是证明它们活下来了。结构性收益是**触摸目标 44px 从五份手写收成一个常量**（散在 `styles.css` 里各写一遍）。三条实测出来的坑：shadcn 控件默认全部低于 44 且**没有例外**（`size="sm"` 只有 32、`SelectItem` 36）；**Radix 的折叠高度是展开那一刻量一次的快照**（塞 200px 进去，`scrollHeight` 108→292 而 `height` 仍是 108、`overflow: hidden`，只露 16px 且不报错）——这条直接否掉了「高级选项用 Accordion」的方案，因为里面装的正是测试结果；`Accordion` 的 `defaultValue` 只在挂载时生效，两次测试之间组件复用会留着上次展开的原始返回 |
| [顶部导航换成侧边导航](2026-09-21-web-sidebar-nav.md) | `done` | **web 单端**——把 `App.tsx` 那套手写 `header.app__header > nav.app__nav` 换成 shadcn 的 `Sidebar`（桌面折叠成图标窄栏、手机收成抽屉）。两处结构性理由：`.app__nav a { min-height: 44px }` 是触摸目标契约在代码里的**唯一落点**，随顶部导航一起消失，得有人接住；`.discover__grid` 的断点绑在视口上，侧边栏吃掉 256px 后 768–1150px 视口仍排 5 列、每格 120–140px，必须换成容器查询。踩到三个「漏了不报错」的坑（`--sidebar-*` token 缺失、`@theme inline` 不输出变量导致侧边栏圆角全 0、`TooltipProvider` 缺失直接白屏），并修掉一个 registry 缺陷（手机端点导航后抽屉不收起） |
| [浏览页图片操作](2026-09-19-browse-meme-actions.md) | `in_progress` | **跨端**——SPEC §6.4 的 `PATCH` / `DELETE` 写在契约里很久但一行没实现，打标失败的图至今没有出路；卡片「⋯」入口给复制 / 编辑 / 删除，编辑开侧边栏。顺带把首页那段临时的「复制地址」换成 `clipboard-share.md` 的真流程 |
| [浏览页改瀑布流](2026-09-19-browse-masonry.md) | `done` | **web 单端**——浏览页方形网格改瀑布流，按自然宽高比整张展示（不再裁方）；`width/height` 已在响应里、缩略图保比例，故不动 api/SPEC；分页形态已定：保留无限滚动，引 masonry 库（推荐 `masonic`） |
| [图片承载组件](2026-09-19-meme-image-host.md) | `done` | **web 单端**——`MemeCard` 的裸 `<img>` 抽成 `MemeImage`：按比例占位 / 加载骨架 / 失败兜底文件名 / 深色底 / 动图 hover·点按播放，四页共用；关键事实是缩略图本就是静态首帧，「不自动播放」天然满足 |
| [首页随机图墙](2026-09-19-home-random-grid.md) | `done` | **跨端**——首页现在是纯搜索框，没有「翻」的入口；`GET /memes` 加 `random=true` 在全库抽样（SPEC §6.3.2，已转 `accepted`） |
| [打标状态界面](2026-09-19-tagging-status.md) | `planning` | **跨端**——打标跑起来了但界面上看不见，兑现 §5.2.3 / `styling.md` / `settings-ux.md §9` 三处已写下的承诺；新增 `GET /memes/tag-status`（SPEC §6.6，`proposed`） |
| [三个管理页并入设置页](2026-09-18-settings-merge.md) | `in_progress` | **web 单端**——`/admin/*` 三页都是设置项；带出两处 SPEC 措辞偏差待总管裁定 |
| [R2 公开 URL 丢了键前缀](2026-09-18-r2-public-url-prefix.md) | `in_progress` | **api 单端，挡着用**——首次接真实 R2 就全站裂图；派生 URL 有两份实现，都没加 `R2_KEY_PREFIX` |
| [评测集](2026-09-13-eval-set.md) | `in_progress` | 持续优化——边用边跑；**已转入一项工具改造**：`eval.ts` 现在跑的是探测期提示词，不是上线那份 |
| [词表 v1](2026-09-13-vocab-v1.md) | `in_progress` | 持续优化——`proposed` 版本直接落代码，跑出数据后迭代 |
| [供应商探测](2026-09-13-provider-spikes.md) | `in_progress` | 持续优化——先选一个能用的，探测结果随用随补 |
| [梗名别名层](2026-09-13-meme-lexicon.md) | `planning` | 检索实现定稿前做完；词表是闭集，梗名是开集，见 [SPEC §9.18](../spec/09-decisions.md) |

**已归档**：骨架、认证、Admin 邀请码与用户管理、浏览页、搜索页、导入、打标队列消费者（含收藏端点）、api 收尾三件、模型配置与测试连接，见 [`_archive/joint-tasks/`](../_archive/joint-tasks/)。

**还没有任务、但已知缺口**：SPEC §6.4 余下的三个接口 **restore / retag / 查重**（编辑与软删已进[浏览页图片操作](2026-09-19-browse-meme-actions.md)——**但那次没有 retag**，所以 `needs_manual` 的图现在能人工补标签、不能重跑模型）、`queue.md §6` 的五个定时清理任务、设置页与管理页的统计面板（`settings-ux.md §9`，接口随[打标状态界面](2026-09-19-tagging-status.md)一起做，界面没做）、部署、**`web/` 的常驻 e2e**。

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
