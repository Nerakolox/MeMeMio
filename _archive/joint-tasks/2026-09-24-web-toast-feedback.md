# web 全站操作反馈：动作按钮补 toast（Sonner）

**状态**：`done`（web 单端，无跨端部分，验收见 §4）｜ **性质**：web 单端 ｜ 开于 2026-09-24

契约不变：**一个接口都没有动**，`spec/` 未改。反馈的**呈现**是 web 本端的事，
而「哪些文案是契约」的那几条（设置页警告、降级不是错误）逐条照旧，没有弱化。

## 1. 为什么要做

用户 2026-09-24 的要求是「所有按钮点击都需要提示框反馈，用 toast，放右上角」。
逐条核对下来，问题分两类，**第二类比第一类严重**：

**点了什么都不发生：**

- `components/AppSidebar.tsx` **登出**——`postLogout()` 没有 try/catch。网络一失败就是一条
  未处理的拒绝：不跳转、不报错、**按钮看起来完全是死的**。这是本次唯一的真 bug。
- `features/manage/MemeActions.tsx` 无权限时点「删除」——`preventDefault()` 后直接 return，
  点击零变化（原因写在菜单项里，只有看菜单和读屏的人拿得到）。
- 收藏失败（五处乐观更新）**静默回滚**：心形翻过去又翻回来，看起来像「这一下没点中」。

**发生了但用户看不见：**

- `features/manage/MemeEditPanel.tsx` **保存**——成功时把「已保存」写进 `use-browse-actions`
  的页级 state，而那行文字渲染在 `BrowseResults` 里，**正好被这个模态侧边栏盖住**。
- `features/settings/UsersSettings.tsx` **保存**——失败有行内 `role="alert"`，
  **成功没有任何提示**；同页另外三张卡都有行内「已保存」。
- `features/settings/InviteSettings.tsx` **生成邀请码**——唯一的反馈是表格顶部多了一行，
  而新行按时间倒序插在**最上面**，管理员此刻正看着表单。

另有一处待办顺手结清：`styling.md` 记着一笔「复制反馈那句 `copyNote.text` 在首页与浏览页
各是一行裸文字，是两页共用的一份呈现，整批留在下一步」。本次就是那一步。

## 2. 做完的标准

规则写在 [feedback.md](../../web/agents/rules/feedback.md)（新文件，四条判据），
样式与层级写在 [styling.md](../../web/agents/rules/styling.md) 的「全站提示（toast）」。

| # | 判据 |
|---|---|
| 1 | 成功态已经看得见的**不弹**（收藏的心形、骨架屏、筛选后重取） |
| 2 | 失败一律弹，**不自动消失**，带 `requestId`（`http.md §3`），有关闭按钮 |
| 3 | 成功态看不见的**弹**（剪贴板、删除、生成邀请码、放弃修改） |
| 4 | 导航类**不弹**（侧边栏导航项、登录注册提交、`/admin` 重定向） |

**两处例外是产品负责人当天的裁定**，不要按判据 3 去「纠正」它们：

- **设置页整体保持行内**（`http.md §5`），包括各卡的「已保存」与失败侧的行内 `role="alert"`。
  设置页里唯一走 toast 的是**生成邀请码**（见 §1 最后一条）。
- **表单 / 模态内的保存确认走行内**（`MemeEditPanel`、`UsersSettings`）。三条理由在
  `feedback.md §3`，其中一条是硬的：Radix 模态给 `#root` 挂 `aria-hidden`，
  模态开着时弹的 toast **对读屏是隐藏的**——用 toast 修「反馈看不见」等于没修。

## 3. web 端

**地基**

| 文件 | 改动 |
|---|---|
| `package.json` | `sonner` 2.0.8。装完核对 `hono` 仍是 `4.13.7`（RPC 类型链靠 web / api 同版本） |
| `components/ui/sonner.tsx`（新） | `<Toaster>`：`position="top-right"`、`theme="system"`、`closeButton`。**覆写走 sonner 自己的 CSS 变量且内联**（它的样式是无层注入 head 的，普通工具类压不过）；`z-index` 收到 **60**（高于 Radix 的 50、低于全屏阅览的 9999）；offset 减掉 `--app-header-h`（右上角是「导入 N/M」入口）；`pointerEvents: 'auto'`（Radix 模态给 `body` 挂 `pointer-events: none`，不写回的话模态开着时 toast 点不动） |
| `lib/toast.tsx`（新） | 文案与判据的**唯一落点**：`notifySuccess` / `notifyFailure`（常驻 + requestId）/ `notifySend`（降级那条中性样式 + 可点 `<a>`）。业务组件**不直接** `import { toast } from 'sonner'` |
| `App.tsx` | `<Toaster />` 挂在 `Routes` **之外**——登录 / 注册页没有外壳 |

**发送路径：两页那行裸文字一起收掉**

| 文件 | 改动 |
|---|---|
| `lib/clipboard.ts` | `sendNote` 文案 `'已复制，去微信 Ctrl+V'` → **`'已复制'`**（产品负责人裁定砍掉后半句：要发的不只有微信） |
| `features/search/use-search.ts` | 删 `copyNote` state，`handleActivate` 改调 `notifySend`；收藏失败补 `notifyFailure`。**另修一处 toast 引出来的回归**：`focusResult` / `scrollIntoView` 原本是裸的 `document.querySelector('[data-index="…"]')`，而 sonner 的 toast `<li>` **也带 `data-index`** 且 `tabIndex: 0`，`<Toaster />` 又挂在 `Routes` 之前——有提示在屏幕上时按 ↓ 会把焦点交给一条提示。改成从 `e.currentTarget` 那棵子树里查（详见下）|
| `features/search/SearchResults.tsx` | 删 `copyNote` prop 与那一段渲染 |
| `routes/home.tsx` | 删 `copyNote` 透传 |
| `features/browse/use-browse-actions.ts` | 删 `Note` state：`send`→`notifySend`、`remove`→`notifySuccess('已删除')` / `notifyFailure(…, requestId)`、`handleSaved` 只留 `applyUpdate` |
| `features/browse/BrowseResults.tsx` | 删 `Note` 导入与那一段渲染 |
| `routes/browse.tsx` | 删 `note` 透传 |

`sendNote` 对 `shared` / `cancelled` 返回 `null` 的行为**不变**——系统分享面板自己就是反馈。

**补新反馈**

| 文件 | 改动 |
|---|---|
| `components/AppSidebar.tsx` | 登出加 try/catch，失败 `notifyFailure`。**失败不清本地会话**：服务端会话还在，清掉只会让界面显示成已登出而下一次请求又能通 |
| `features/manage/MemeEditPanel.tsx` | 保存成功改在**面板内行内**说「已保存」（`use-meme-edit.ts` 新增 `saved`，改动草稿即收掉）；「放弃修改」→ `notifySuccess` |
| `features/manage/MemeActions.tsx` | 无权限删除的静默 no-op → `notifyFailure(已有原因文案)`，菜单仍不关 |
| `features/settings/UsersSettings.tsx` | 每行保存成功补行内「已保存」（`role="status"`），改动该行任一格即收掉 |
| `features/settings/InviteSettings.tsx` | 生成成功 → `notifySuccess('已生成邀请码')` |
| `DiscoverWall.tsx`、`TaggingList.tsx`、`use-search.ts`、`use-browse-list.ts` | 收藏失败 → `notifyFailure('收藏失败，请重试')`。成功不弹。**没有顺手重构这四处的重复**，只加 catch（`MemeCard.tsx` 自己不调接口，收藏回调由页面注入，无需改） |

**不动的地方**：`use-copy-text.ts`（邀请码 / 原始返回的复制，1.5s 按钮文字反馈，设置页既有形态）、
全部「重试 / 换一批 / 加载更多」（骨架屏已经是反馈）、筛选器与词表 chip、登录注册提交、
`components/ui/**` 里除新增 `sonner.tsx` 之外的一切。

**文档**：[clipboard-share.md](../../web/agents/rules/clipboard-share.md) §4.1 那句逐字引用的文案跟着改、
[styling.md](../../web/agents/rules/styling.md) 销掉 `copyNote.text` 那笔待办并补 toast 一节、
[feedback.md](../../web/agents/rules/feedback.md) 新增 + [INDEX.md](../../web/agents/rules/INDEX.md) 一行。

**引入 toast 带出来的一处回归（本次一并修掉）**

toast 的 `<li>` 是 `<li data-index="N" tabIndex="0">`，而 `<Toaster />` 挂在 `Routes` **之前**。
搜索页的键盘路径原本用 `document.querySelector('[data-index="N"]')` 找结果项——**只要屏幕上有
任何一条提示，命中的就是那条提示**，`focusResult` 把焦点交给它、`scrollIntoView` 滚到它
（`position: fixed`，看不出来）。表现是「有提示时按 ↓ 从输入框进结果区，哪一格都选不中」，
不报错。改成从 `handleKeyDown` 的 `e.currentTarget`（整页那个 `<section>`）里查；
`browse` 的 `[data-actions-for]` 不是这套属性，未受影响。

**它是由一条看起来不相关的断言暴露的**：`verify-web-interaction-fixes.mjs` 的「1264 档 Esc
取消选中」红了，而「没弹过提示」的 390 档是绿的——两档唯一差别就是前面弹没弹过 toast
（1264 那档在它之前按过 Enter，弹出一句降级提示）。现在 `verify-toast-feedback.mjs` 里钉了
两条回归闸门，专测这件事。规矩写进了 `styling.md`「⚠️ toast 的 `<li>` 也带 `data-index`」
与 `clipboard-share.md §7`。

## 4. web 端验收

**结论**：通过。`scripts/verify-toast-feedback.mjs` **37/37**（桌面 1264×900 细指针 + 手机
390×844 粗指针两档），`scripts/verify-web-interaction-fixes.mjs` **65/65**（重跑，确认改呈现
没打坏原有路径），`npm run typecheck` 与 `npm run build` 均干净。**一个接口、一行 `spec/` 都没动。**

做法沿本端既有路径：零依赖 CDP 驱动系统 Chrome，替身与验收都走 `127.0.0.1`，没装 Playwright。
替身（`scripts/mock-api.mjs`）加了 `POST /__fault` 故障开关（默认全关，下面这些断言才造得出
失败侧），`verify-toast-feedback.mjs` 是新写的。

**实测到的几何 / 样式**（不是只读文本——这一节要证的三件事光看文本证不了）

| 断言 | 实测 |
|---|---|
| toast 在顶栏**下沿之下**，不盖右上角「导入 N/M」入口 | 顶栏 0..56（高 56），toast `top=68` |
| 贴右沿 1rem | 右边距 `16px` |
| 层级 60（高于 Radix 50、低于全屏阅览 9999），不是 sonner 默认的 `999999999` | `z-index = 60` |
| 颜色 / 圆角吃的是本项目 token（无层 CSS 没盖住） | 与探针 div 逐项相同：`oklch(1 0 0)` / `oklch(0.145 0 0)` / `18px` |
| 粗指针档走 `mobileOffset` | 视口 390，`top=68`（= 56 + 0.75rem），左 16 / 右 16 |

**两档的时长口径**：成功提示 4.6 秒后自己收掉；失败 / 降级那两条 4.6~5.2 秒后**仍在**
（`http.md §3` 要求 `requestId` 和降级链接能被用户抄下来 / 点一下）。

**逐条对判据**（§2 那四条，含两处裁定）

- 判据 1：收藏成功 `favorites 1 → 2`、**toast 0 条**；编辑面板保存成功**不弹 toast**、只在面板内行内说「已保存」。
- 判据 2：删除失败 / 登出失败都是常驻，`requestId：stub-11` / `stub-10` 可见，关闭按钮点得掉；删除失败那条量到文字色**等于** `--destructive`（这条一开始是红的——见 §5）。
- 判据 3：静图发送成功文案**正好是「已复制」**（后半句没了）；「放弃修改」→「已放弃修改」；「生成邀请码」→「已生成邀请码」。
- 判据 4 + 系统分享：粗指针档 `share 0 → 1` 且 **toast 0 条**；登出成功仍照常跳 `/login`。
- 裁定一（设置页保持行内）：用户卡保存**行内**「已保存」+ toast 0 条；生成邀请码的**失败侧仍是行内 Alert**，没被换成 toast。
- 裁定二（模态内走行内）：编辑面板保存行内可见、toast 0 条；无权限删除点下去**菜单仍开着**（原因不能被收走），并补一句 toast。
- 页级那两行裸文字：`main` 里 `p[role="status"]` **0 处**。
- 全程 `Runtime.exceptionThrown` **0 条**（登出那条未处理拒绝的同类）。

**这一轮实际改的是 web 端 15 个源文件 + 2 个验收脚本 + 4 份本端文档**，全部在 `web/` 下；
`api/` 与 `spec/` 一行未动。

## 5. 已知缺口（写下来，不要当成已解决）

- **模态开着时 toast 读屏听不见**（Radix 给 `#root` 挂 `aria-hidden`）。这是上面那条
  「保存走行内」的**原因**，不是遗漏。`components/ui/sonner.tsx` 头部记着。
- **`richColors` 是 `--error-*` 的开关**，不写它那三个变量一个都不生效，而 `toast.error()`
  与中性提示长得一模一样——不报错。本次是「删除失败那条是错误色」这条断言一开始就是红的
  才发现的，`components/ui/sonner.tsx` 里记了。
- 量 toast 位置前**必须等它落位**：sonner 是 `translateY(-100%)` → `translateY(0)` 的 400ms
  过渡，`data-mounted` 一出现动画才刚开始，这时量到的是半路的值（顶栏下沿 56，量出 53），
  会被误读成「toast 跑到顶栏上面去了」。脚本里 `settleToast()` 负责等它连续三帧不动。
- 真机分享仍归「真机待测」那批，本次**不声称测过**。

**2026-09-24 晚些时候补两条**（来自[全屏阅览里 `Ctrl+C` 复制当前这一张](2026-09-24-web-viewer-copy-shortcut.md)）：

- 上面第一条的**归因要改口**：`aria-hidden` 那一半对 Radix 模态成立，但**全屏阅览器那一份是 YARL 干的**，而且它多挂了一个 `inert`——于是阅览器开着时 toast 是「**看得见但点不到**」（关闭按钮、降级提示里那条链接全是死的）。`inert` 不出现在 `pointer-events` 的计算值里、不报错，`elementFromPoint` 还会整个跳过它：**拿命中测试当可见性判据会得出反的结论**。推导与修法见 [styling.md](../../web/agents/rules/styling.md)「已知缺口」，本次没修。
- **层级从 `60` 抬到了 `10000`**（否则 `.yarl__container` 那块不透明黑底会把反馈整个盖住）。上面 §4 那张表里的 `z-index = 60` 是**当时那次运行的实测值**，不是现状。
