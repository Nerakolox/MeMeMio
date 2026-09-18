# 首页随机图墙

**状态：`done`** · 创建 2026-09-19 · 跨端任务（api 新增抽样参数，web 改首页版式）

**涉及的 SPEC：** [§6.3.2](../spec/06-endpoints.md) 的 `random=true`（本节随本任务新增，两端确认后已转 `accepted`）、§5.2.6（`Meme` 对外表示）、§3.4（软删过滤）、§3.3（`tagStatus` 权限）。

## 为什么

首页现在是一个**纯搜索框**：没输入搜索词时，页面下半部分只有一句「输入一句话，用自然语言找图」，除此之外什么都做不了。

这挡住了一半的用法。共享库的价值一半在**检索**（你已经知道要找什么），一半在**翻**（你不知道库里有什么）。没有后者，用户对库的规模没有感知，三个月前传的图除非被一句话精准描述出来，否则等于不存在——**而它就在那儿，一直能被搜到，只是没有任何入口指向它**。

所以首页要有一屏随机图 + 一个「换一批」。

**「随机」必须在服务端、在全库上发生，这是本任务唯一的架构决定。** 客户端也能做出「随机」的样子：拉最新 100 条然后 `Math.random()` 抽 10 个。但它只在新图里随机——库用上三个月之后，用户按一百次刷新也见不到那张三个月前的图，而「把老图重新翻出来」正是这个入口唯一的用途。那种实现看起来是随机的，实际是**伪随机**，而且失效方式是静默的：没有报错，只是首页永远只有最近那批图。

代价是要动契约（`GET /memes` 加一个参数）。这个代价与它的收益比是划算的：参数是**兼容性新增**（[§8.3](../spec/08-collaboration.md)），不传时行为逐字不变，已有测试全绿即是证据。

## 做完的标准

### api 端

- [x] `GET /api/v1/memes?random=true&limit=10` 按 [SPEC §6.3.2](../spec/06-endpoints.md) 返回 `items` 与 **`nextCursor: null`**
- [x] **抽样发生在所有筛选之后**：`emotions` / `scenes` / `tags` / `isAnimated` / `favorited` / `uploader` / `tagStatus` 同时传时，被抽出来的每一条都满足全部条件
- [x] **软删的图抽不出来**（要有专门用例）。这条是本任务最危险的一处：`order by random()` 里漏掉 `deleted_at is null` **不报错、不崩溃**，只是已删的图出现在首页。写这条查询时不要另起一套 WHERE——复用 `listMemes` 已有的 `conditions` 数组
- [x] `tagStatus` 的权限判定与 `random` 无关，仍走既有那条（非本人非 admin → `FORBIDDEN`，未登录 → `UNAUTHENTICATED`）
- [x] `random=true` + `cursor` 同时传 → `VALIDATION_FAILED`
- [x] `limit` 上限仍是 100，`random=true` 时不因为抽样而放宽
- [x] **不传 `random` 时行为逐字不变**，已有测试全绿
- [x] SQL 落在 `api/src/data/memes.ts`（`memes` 的 SQL 只许在这个文件里），handler 只解析参数
- [x] 代码注释里写明 `order by random()` 的代价与换方案的触发条件（见下）

**关于性能，实现时按这个口径处理：** `order by random()` 是**全表扫描 + 排序**，不是索引扫描。当前量级（几万行）在毫秒级，够用；百万行时它会变成秒级，届时换 `TABLESAMPLE` 或预生成随机序列。

**这一版就写 `order by random()`，不要现在去建索引或做缓存。** 首页每次加载都会命中这条查询，但它扫的是几万行不是几百万行——这与 `database.md` 里「几万行仍在毫秒级，现在就上是提前优化」是同一个判断。**触发条件写进注释**，别让下一个人在百万行的库上重新发现一遍。

### web 端

- [x] 首页版式：顶部搜索框（**保持不变**），下方是随机图墙
- [x] **搜索词为空时显示图墙，有搜索词时显示搜索结果**——搜索是替换，不是并存（两个列表叠在一页上没人知道该看哪个）
- [x] 图墙 **10 张**（`limit=10`），桌面 **5 列 × 2 行**；窄屏降列数，卡片仍是 ≥44×44px 的触摸目标（[styling.md](../web/agents/rules/styling.md)）
- [x] 「**换一批**」按钮重新抽样；请求进行中不可重复触发
- [x] 卡片复用 `MemeCard`，行为与搜索结果一致：收藏走乐观更新（失败回滚，[state-navigation.md §8](../web/agents/rules/state-navigation.md)）、复制地址与结果卡片同一条路径
- [x] 三态齐全：加载中 10 个骨架、失败给 `requestId` + 重试、**空库**给一句「库里还没有图」并指向 `/import`
- [x] 图墙组件放 `src/features/discover/`，不堆进 `routes/home.tsx`（`project-structure.md`：路由只做布局与数据编排，且该文件已经 307 行）
- [x] 只写结构性 CSS：flex / grid / gap / 尺寸 / 断点，**没有颜色、边框、阴影、圆角**（[web/AGENTS.md §5](../web/AGENTS.md)）

## 明确不做

| 不做 | 归哪 |
|---|---|
| 随机结果翻页 / 无限滚动 | 随机序没有「下一页」（SPEC §6.3.2 定死 `nextCursor: null`）。翻页是 `/browse` 的事 |
| 把「抽到的这 10 张」放进 URL | 随机结果不是可分享的东西——分享一个随机链接给对方，看到的是另一批图。[state-navigation.md §1](../web/agents/rules/state-navigation.md) 管的是「能放 URL 的」，这是纯 UI state |
| 首页做筛选 UI（按标签随机） | 接口支持（筛选在抽样之前），但首页不做筛选器，那是 `/browse` 的职责。混在一起会让首页变成第二个浏览页 |
| 「不感兴趣 / 别再给我看这张」 | 需要一张屏蔽表和一个新的写路径，另开任务 |
| 加权随机（按收藏数、新鲜度、上传者加权） | 契约写的是**均匀抽样**。加权要先回答「权重从哪来、谁调」，那是另一个决策，不该顺手塞进这里 |
| 自动轮播 / 定时换一批 | 会打断正在看图的人 |

## 两端各自做什么

**先改契约：** [SPEC §6.3.2](../spec/06-endpoints.md) 已按 [§8.1](../spec/08-collaboration.md) 写好，两端确认后已转 `accepted`（2026-09-19）。

### api 端

1. **`api/src/data/memes.ts`** —— `ListMemesParams` 加 `random?: boolean`；`listMemes` 里加一条分支：`random` 为真时 `orderBy(sql\`random()\`)` 且**不吃游标**（游标条件本来就不该进这条路径）。
   ⚠️ **WHERE 条件必须复用上面已经拼好的 `conditions` 数组**，不要为随机路径另写一份。软删过滤、多值 AND、`uploader`、`tagStatus` 全都在那个数组里，另写一份等于把它们各抄错一次的机会。
2. **`api/src/routes/memes.ts`** —— 解析 `random`；`random=true` 且 `cursor` 存在 → `VALIDATION_FAILED`。响应形状不变（`nextCursor` 自然为 `null`）。
3. **测试** —— 新增 `api/tests/random-sample.test.ts`（或并入现有 `memes` 相关文件）：软删的图抽不出来、筛选条件下抽样仍然守约、`random` + `cursor` → 422、不传 `random` 时与既有行为一致。

### web 端

1. **`src/lib/api.ts`** —— `FetchMemesParams` 加 `random?: boolean`，序列化成 `random=true`。
2. **`src/features/discover/DiscoverWall.tsx`**（新）—— 图墙本体：拉 `{ random: true, limit: 10 }`、三态、换一批。
3. **`src/routes/home.tsx`** —— `state.kind === 'idle'` 那一支从「一句话提示」换成 `<DiscoverWall />`；搜索的那一支完全不动（含键盘路径）。
4. **`src/styles.css`** —— 图墙的 grid 与断点。
5. **`web/agents/rules/project-structure.md`** —— 目录树加一行 `discover/`。

### 交接语

**api 端：** SPEC §6.3.2 定死了三件事——抽样在筛选之后、`nextCursor` 恒为 `null`、与 `cursor` 互斥。实现时唯一需要小心的是**不要为随机路径另写一份 WHERE**，复用 `listMemes` 里已有的 `conditions`。做完在「api 端验收」回填，不要代填 web 端。

**web 端：** 依赖 `GET /memes?random=true`，api 端合入前可以先对着自己的替身搭版式（`fetchMemes` 的形状没变，只是多一个参数）。搜索那一支**一行都不用改**，本任务只动 `q` 为空时的那一半。做完在「web 端验收」回填。

## api 端验收

**状态：完成。** 2026-09-19 · 执行者：api

**契约确认：** §6.3.2 的三条定死项（抽样在筛选之后、`nextCursor` 恒为 `null`、与 `cursor` 互斥）都可实现且已按它实现，**未改动 SPEC 一个字节**（spec/ 的改动全部来自总管）。§6.3.2 的 `proposed → accepted` 由总管操作。

**实测：** `npm run typecheck` 干净；`npx vitest run` **31 个文件 / 315 条全绿**（本任务新增 `tests/random-sample.test.ts` 11 条）。

- 新增 11 条覆盖：条数与 `nextCursor: null`；库里的图少于 `limit`；**软删的图抽不出来**（造 1 张存活 + 20 张已删，`limit=100`，断言返回集合逐个相等——漏过滤就必然带出已删的图，不靠概率）；全库都软删时是空列表；`tags` 筛选在抽样之前（抽五轮，每轮断言返回的每一条都带该标签）；`uploader` 同理；**`favorited` 走 INNER JOIN 那条路径**且返回的 `favorited` 都是 `true`；`random` + `cursor` → 400 `VALIDATION_FAILED`；`random` 不绕开 `tagStatus` 权限（member 查他人 → 403 `FORBIDDEN`）。
- **「随机是全库的，不是最新那几条打乱」**（本任务的核心断言）：40 张里前 20 张最老，抽 10 轮 × 每轮 10 张，断言至少抽到过一张老图。十轮全是新图的概率约 2e-38，不是会偶发红的断言。
- **兼容性**：不传 `random` 时行为逐字不变——既有的 315 条里包含收藏、软删、搜索、打标队列等全部旧用例，它们全绿即是证据；另新增一条断言非随机路径的游标分页仍然两页不重叠。

**实现落点：**

| 文件 | 内容 |
|---|---|
| `api/src/data/memes.ts` | `ListMemesParams.random`；`listMemes` 里随机分支（`orderBy(sql\`random()\`)`，`nextCursor: null`） |
| `api/src/routes/memes.ts` | 解析 `random`；`random` + `cursor` → `VALIDATION_FAILED` |

**两处实现决策，请总管在联合验收时过目：**

1. **WHERE 只有一份。** 随机分支复用的是 `listMemes` 里逐条拼好的 `conditions` 数组，没有为它另写一套过滤——这是本任务最危险的地方（漏 `deleted_at is null` 不报错，只是已删的图出现在首页），代码里有两段注释点明。
2. **顺手合并了 `listMemes` 里原本重复的两段查询。** 原先「只看收藏」和「通用路径」各写了一遍 select/join/orderBy/limit，加随机就要变成四份。现在 join 的选择只在一处（`favoriteFilter ? innerJoin : leftJoin`），随机与分页两条路径共用它，只有 `orderBy` 与 `limit` 不同。**外部行为不变**，属于本端内部重构（[总管入口 §3](../AGENTS.md) 的路由表）。已有的 `favorites.test.ts` / `soft-delete.test.ts` 等全绿是这条的判断依据。

**性能口径（写进代码注释了）：** `order by random()` 是全表扫描 + 排序。几万行毫秒级够用；**百万行会是秒级**，届时换 `TABLESAMPLE` 或预生成随机序列。现在不做——扫的是几万行不是几百万行，与 `database.md §3` 的 pHash「现在就上专用索引是提前优化」是同一个判断。

**真库实测（29 张图的开发库）：** `random=true&limit=10` 连打五次，五次都是不同的一批；`random=true&cursor=x` 返回 400 且 `code` 是 `VALIDATION_FAILED`。

## web 端验收

**状态：完成。** 2026-09-19 · 执行者：web

**契约确认：** §6.3.2 的响应形状（`items` + `nextCursor`）可直接消费，`random` 只是 `GET /memes` 的一个新参数、`Meme` 类型一个字节都没变，**未改动 SPEC 一个字节**。

### 实测环境

**这次是真接口 × 真浏览器 × 真库，不是替身**（与上一轮打标状态任务不同，那次本地库没有对应的数据所以要造）：

- api 在 3000 上跑着（`tsx watch`，改完自动重载），Vite dev server 在 5173
- 真 Chrome（系统装的 `chrome.exe`，Playwright 用 `channel: 'chrome'` 驱动），**桌面 1280×900 与手机 390×844 各一轮，合计 21 条断言全过**
- 登录态用一个临时造的会话（跑完已从库里删掉）；驱动脚本 `tmp-verify-home.mjs` 跑完已删，没有进仓库
- 顺带一提：本地 `ms-playwright` 里的 chromium 构建号与 `web/node_modules` 的 playwright（1.59.1）对不上，所以走的是系统 Chrome

### 与完成标准逐条对照

| 完成标准 | 实测 |
|---|---|
| 顶部搜索框、下方随机图墙 | 断言搜索框的 `y` 小于图墙的 `y`；两处都在 |
| 图墙 10 张，桌面 5 列 × 2 行 | 数到 10 张；计算列数为 5；**第 1–5 张同一行、第 6–10 张第二行**（比对五个元素的 `top`） |
| 窄屏降列数、卡片 ≥44px | 390×844 下是 **2 列、仍是 10 张**（降列数不降张数），卡片宽 165px |
| 「换一批」重新抽样、请求中不可重复触发 | 拦一次请求延迟 900ms：点击后 150ms 时按钮 `disabled`，请求回来自动恢复；换完内容确实不同，且仍是 10 张 |
| 卡片复用 `MemeCard`、收藏乐观更新 | 点 ♥ 立刻翻转 `aria-pressed`（不等服务端），再点一次回到原状态——测试没在库里留下改动 |
| 搜索是替换不是并存 | 提交搜索词后 `.discover` **整块不存在**；清空搜索词后图墙回来，仍是 10 张 5 列 |
| 三态 | 加载中是 10 个骨架；失败态给 `message` + `requestId` + 重试；空库给「去导入」链接（后两条走的是代码路径，本地库有 27 张图，**没造空库和失败态的真实场景**） |
| 组件在 `features/discover/`、不堆进路由 | `routes/home.tsx` 本任务净减 6 行（删掉本地 `toStateError`、空闲分支换成一行组件） |
| 只写结构性 CSS | 图墙容器的 `background` / `border-width` / `box-shadow` / `border-radius` 全是初始值；**「换一批」按钮的底色、阴影、圆角与页面上原有的搜索按钮逐项相等**（`rgb(240,240,240)` 是浏览器给 `<button>` 的默认底色，不是样式表写的） |

### 顺手改的两处（都是为了让同一份东西只存在一份）

1. **`toStateError` 提到 `lib/api.ts`。** 原先它只活在 `routes/home.tsx` 里，随机图墙要的是同一份「断网也要能读」的兜底（`http.md §4`），再抄一遍就是第二份。现在两处 import 同一个。
2. **`web/agents/rules/project-structure.md` 的目录树加了 `discover/`**，并写明它和同在一页的 `search/` 为什么不是一回事（一个「知道要找什么」、一个「不知道」）。

### 没做与阻塞

- **随机卡片上没有复制 / 发送入口**，只有收藏。这是**有意留的**：复制路径现在是一段临时实现（只复制图片地址，真流程见 `clipboard-share.md`），在第二处铺一份临时实现等于把待替换的代码铺开；而真流程要求**桌面 + 真机各测一遍**（`clipboard-share.md §8`），混在版式改动里做做不到。卡片上那片位置留给那一次。
- **空库与请求失败两个态没有真实场景验证**（本地库有 27 张图、api 正常）。走的是代码路径，不是实测。
- **真机没测。** 手机那一轮是 Chrome 的 390×844 视口，不是真手机。本任务**没有碰复制 / 分享路径**，所以按 `web/AGENTS.md §6` 不需要真机；但下面那条遗留项需要。

### 转出的遗留项

**手机端首页会自动聚焦搜索框 → 弹出键盘 → 盖住刚做好的图墙。** 这是 `routes/home.tsx` 上那个 `autoFocus`（本任务之前就有，为了「打开就能打字搜」）。图墙出现之前它没坏处，现在它对**手机**——也就是 `styling.md` 说的「这个产品体验最好的一端」——把新做的整块内容挡住了。

**本任务没动它**，因为改 `autoFocus` 会动到搜索路径的行为，而手机会不会真的弹键盘、弹了盖住多少，**只有真机能回答**，不能用桌面浏览器的表现替代。已登记到[任务板的遗留项](README.md#首页随机图墙转出的遗留项)。
