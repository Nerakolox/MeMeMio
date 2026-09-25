# 首页迁到 shadcn 组件（拆 `features/search/`）

**状态**：`done`
**性质**：**web 单端**——不动 `api/`，不动 SPEC，不改任何接口、字段与排序语义。

## 为什么要做

用户 2026-09-21 的要求：「优化首页，使用 shadcnUI 组件」。已确认五项范围：**换皮 + 拆文件**（交互与版式不动）、
**加页宽上限 `max-w-6xl`**、**手机端 autoFocus 顺手修**、**`.search__*` / `.discover__*` 全部迁走并删除**、
**搜索失败的「重试」按钮顺手改真**。

触发它的是三件已经摆在桌面上的事：

1. **首页是最后一个完全手写 BEM 的业务页。** 侧边导航、设置页、卡片层都在 2026-09-21
   换成了 shadcn（`radix-luma` + Tailwind v4），只有这一页还是 `<input class="search__input">` +
   `<button class="search__submit">` + `styles.css` 里 180 行 `.search__*` / `.discover__*`。
   结果是同一个产品里两套界面来源：这里的控件**不是 44px 触摸目标**
   （[styling.md](../../web/agents/rules/styling.md) 那条「shadcn 控件默认全部低于 44，没有例外」
   在首页没人接住），也不随主题 token 走。
2. **[卡片 shadcn 化](2026-09-21-web-card-shadcn.md) 的「不做」里明确留了两笔账给这次**：
   `.discover__grid` / `.search__grid`（网格布局）和 `.search__card-action`（页面级控件，留 BEM）。
3. **[迁 Tailwind v4](2026-09-21-web-tailwind-v4-radix-luma.md) 停在 `in_progress`**，
   等的就是「业务四页要登录后过一眼」——首页是其中一页。

顺带两处早就记在任务板上的账：首页的 `autoFocus` 是[随机图墙](2026-09-19-home-random-grid.md)
转出的遗留项（手机弹键盘盖住图墙，当时以「只有真机能回答」为由没改），以及「重试」按钮
**写着重试却不重试**。

## 三处行为改动（其余是纯换皮）

| 改动 | 之前 | 之后 |
|---|---|---|
| 手机自动聚焦 | `autoFocus` 属性，手机上弹键盘盖住图墙 | 只在 `(pointer: fine)` 的设备上聚焦。按**输入方式**分流而不是按屏幕宽度：桌面保留「打开就能打字」，触摸设备不抢焦点 |
| 「重试」 | 调 `commit('')`，把搜索词清空、把用户丢回图墙 | `retry()` 只 +1 一个 `attempt` 计数，`q` 不动，effect 照常重跑。**不清词、不多一条历史记录、不离开当前页** |
| 页宽 | 无上限，2560px 视口下结果网格铺满整屏 | `max-w-6xl`，与 `/settings` 对齐 |

## 做完的标准（验收口径）

- 首页零 BEM：`styles.css` 里搜不到 `.search__*` / `.discover__*`，且**类删除与新类落地在同一个提交里**
  （这份样式表是**无层**的，无层声明压过 Tailwind 的 `@layer utilities`——分两步走的那段时间里，
  旧选择器会在它们命中新元素时静默盖掉工具类，比如 `.discover__grid` 的 `grid-template-columns`
  会压住新写的 `@max-[900px]:grid-cols-3`，图墙永远 5 列）
- 首页四处触摸目标全部 ≥ 44px（提交按钮、发送按钮、两处「重试」、「换一批」）
- 图墙列数**按容器宽度**分档、降列数不降张数（`styling.md` 的手机可点性红线）
- 键盘路径一行不动：输入 → ↓ 进结果区 → ↑↓ 移动 → Enter 发送 → Esc 取消
- 类型闸门 `cd web && npm run typecheck`（连带编译 `api/src/`）+ `npm run build`

## 改了什么

| 文件 | 内容 |
|---|---|
| `src/features/search/use-search.ts`（新） | 从 `routes/home.tsx:37-191` **原样搬**的 state 机：`draft` / `committedRef` / fetch effect / `selectedIndex` / `copyNote` / `commit` / `focusResult` / `handleFavorite` / `handleActivate` / `handleKeyDown`。唯一新增是 `attempt` + `retry()` |
| `src/features/search/SearchBar.tsx`（新） | `role="search"` 的 form + shadcn `Input` + `Button type="submit"`，受控 |
| `src/features/search/SearchResults.tsx`（新） | 吃整个 `SearchState` 管五态：loading（`Skeleton` × 12）/ error（destructive `Alert` + requestId + 重试）/ ok 的降级提示与改写提示 / 空 / 结果网格 + 复制反馈。`ResultItem` 保留 `role="option"` / `data-index` / `aria-selected` / 选中描边 |
| `src/routes/home.tsx` | 326 → 66 行，只剩布局：`<section className="mx-auto flex w-full max-w-6xl flex-col gap-3" onKeyDown>` |
| `src/features/discover/DiscoverWall.tsx` | 换 shadcn 组件；`@container` + 两档容器查询；空库态的「去导入几张」改 `Button asChild` 包 `Link` |
| `src/components/ui/input.tsx` | **加 `forwardRef`**（见下） |
| `src/styles.css` | 删 `.search`～`.search__card-action`（含 640px 媒体查询）与 `.discover`～`.discover__request-id` 共约 180 行，换成一段说明这次迁移的注释。821 → 686 行 |

### 要害一：`input.tsx` 不 `forwardRef`，自动聚焦是假的

注册表版本的 `Input` 是按 React 19 写的——19 里 `ref` 是普通 prop，`{...props}` 展开即可透传；
本端仍跑 React 18，`ref` 不进 props，**只有 `forwardRef` 组件收得到**。不包的话
`inputRef.current?.focus()` 里是 `null`：dev 只报一行 `Function components cannot be given refs`，
生产构建里连那行都没有。已按 `button.tsx` / `badge.tsx` 的先例包上（`styling.md` 那条
「新写的可组合组件同样要加」的第三例）。

### 要害二：容器查询两档的 `<` 不是 `≤`

`@container` 产出 `container-type: inline-size`，`@max-[900px]:` 产出 `@container (width < 900px)`
——与旧 CSS 的 `@container (max-width: 900px)` **只在恰好等于 900.00 那一刻不同**。
本仓此前零先例，而它**写错了不报错**（`@max-[…]` 若不支持就是不生成任何东西，
表现是图墙永远 5 列、手机上一格 70px）。已核对产物：`@container not (min-width:900px)`
（lightningcss 把 `width < 900px` 规范化成了这个）排在 `@container not (min-width:640px)` **之前**，
且浏览器实测列数 5/3/2 正确。判据写在 `DiscoverWall.tsx` 的 `WALL_GRID` 注释里。

### 要害三：三处「必须照抄已有先例」的写法

- **降级提示用普通 `<p role="status">` 而不是 `Alert`**：`Alert` 硬编码 `role="alert"`
  （抢着打断读屏），而降级是状态说明不是警报。本端先例是 `EmbedSettings` / `ImportProgress`。
  计划里原本写的是「非 destructive 的 `Alert`」，实现时按仓库既有约定改了——`Alert` 只用于真警报。
- **错误块照抄 `MemeEditPanel.tsx:215-225`**：`Alert variant="destructive"` + `AlertTitle` + 内层
  `<p>{message}</p>` + `<p className="font-mono text-xs">requestId: …</p>`。
- **骨架复用结果网格的类**（`RESULT_GRID` 模块内私有）：这组类此前是同一份写两遍，
  两处一旦漂开，加载态和结果态的格子就对不上。

## 实测回填（web 端验收）

闸门：`npm run typecheck` 干净；`npm run build` 通过（`dist/assets/index-DZzetO24.css` 107.65 kB）。

浏览器：`vite preview` + **系统 Chrome**（Playwright 自带 chromium 构建号对不上，走 `channel: 'chrome'`），
`page.route()` 打桩 `/auth/me` / `/search**` / `/memes**` 与收藏端点——**验的是几何、键盘与样式，
不是接口联调**。一次性脚本跑完即删（本仓没有常驻 e2e，见任务板那条已知缺口）。

**49 条断言全部通过**（连跑三次，含一次定位到驱动自身的时序问题后复跑，见下）：

| 验什么 | 实测 |
|---|---|
| 桌面 1280 摆位 | 搜索框 44px、提交按钮 44×72、发送按钮 44、两处「重试」44、「换一批」44 |
| 图墙骨架 / 搜索骨架 | 10 格 / 12 格，全部带 `motion-reduce:animate-none`（注册表只有 `animate-pulse`，不能省） |
| 结果网格 vs 骨架网格 | 两者 `gridTemplateColumns` 列数一致（5 vs 5） |
| 图墙分档（**按容器宽度**） | 容器 1152px / 976px → 5 列；796px / 696px → 3 列；596px / 496px → **2 列**。2560 / 1280 / 1100 / 1000 / 900 / 800 视口各测一次 |
| 键盘路径 | 输入框 ↓ 进第一条（聚焦 `data-index=0`）→ ↓ 到第二条（`aria-selected` 0→false、1→true）→ Esc 全部取消 → Enter 触发发送并出 `role="status"` 反馈 |
| 选中描边 | wrapper 上 `2px solid` + `outline-offset: 2px`，卡片本身 `outline-style: none` |
| 发送按钮文案 | 桌面静图 = **复制**、动图 = **下载**；手机三个全是**分享**，**没有一个是「复制」** |
| 错误态 | `role="alert"`、含 `requestId: req-abc-123`、标题「搜索失败」 |
| 「重试」真的重试 | 请求计数 2、两次的 `q` 参数**完全相同**、URL 一字不变、错误态仍在（没有被丢回图墙） |
| 降级态 | `role="status"`、页面无 `role="alert"`、结果照常渲染 2 条 |
| 深色 | `--muted` 由 `oklch(97% 0 0)` → `oklch(26.9% 0 0)`，走 `prefers-color-scheme` |
| 桌面自动聚焦 | `document.activeElement` 是搜索框（这条同时证明 `Input` 的 `forwardRef` 生效） |
| **手机 390×844 + `hasTouch`** | `(pointer: fine)` = false → **不聚焦**（`activeElement` 是 BODY，键盘不会盖住图墙）；输入框与按钮仍 44；图墙与结果网格各 2 列；字号 16px |
| console | 除两次**故意打的 500** 外，桌面与手机均无错误/警告 |

> 驱动自身的一处时序问题值得记一笔：`focusResult()` 是在 `requestAnimationFrame` 里落焦点的
> （要等 React 把新的一格提交到 DOM），第一版脚本按键后**立刻**读 `document.activeElement`，
> 于是跑一次过一个样。改成等焦点落定再断言（`waitForFunction`，2s 上限）后稳定复现。
> **这是测试的问题，不是实现的问题**——没有改产品代码。

## 不做 / 遗留

| 事项 | 处置 |
|---|---|
| 浏览页 / 导入页 / 打标页的 BEM 迁移 | 仍是各自的任务（`web/AGENTS.md §5`），本轮只动首页 |
| 搜索的接口、排序、`matchedBy` 权重、URL 参数名 | 不归 web |
| 图墙卡片上的复制 / 发送入口 | 仍等 `clipboard-share.md` 三条路径在真机落地那次，两处一起接 |
| 真机验收 | 390×844 是**模拟触屏**，只给几何结论。iOS 键盘行为、惯性滚动、真机分享面板仍未验过——**首页有复制路径，动它时必须上真机**（`web/AGENTS.md §6`），本轮没动 `lib/clipboard.ts` |
| **错误块现在全站重复 5 处** | 首页搜索、首页图墙，加 `browse.tsx:349`、`TaggingList.tsx:77`、`ReviewQueue.tsx:88`。抽 `components/ApiErrorNotice.tsx` 是**故意推迟的**：那要同时改三个不在本轮范围内的文件，且五处的文案/结构并非逐字相同（有的带重试按钮，有的没有）。记在这里，抽的时候一起看 |
| `App.tsx:44` 的 `ImportProgressLink` 没有 `TOUCH` | 顺手看到的一处 32px 触摸目标。不在本轮范围（顶栏组件，且只在导入进行中才出现），**没有改**——留在这里 |

## 沉淀到规则里的两条

- [styling.md](../../web/agents/rules/styling.md)：新增两条——**Tailwind v4 容器查询**的写法与两个坑
  （`@max-[…]` 是 `<` 不是 `≤`；`@container` 类删了不报错、两档查询全部静默失效），
  以及**自动聚焦只在 `(pointer: fine)` 上做**（按输入方式分流，不按屏幕宽度）。
  44px 那条的落点表补上首页四处；`forwardRef` 名单加 `input.tsx`。
- [project-structure.md](../../web/agents/rules/project-structure.md)：`features/search/` 落地，
  `routes/home.tsx` 退回纯布局。
