# web 设置页改用 shadcn 组件重做

**状态**：`done`
**性质**：**web 单端**——不动 `api/`，不动 SPEC，不改接口、字段与数据语义。

## 为什么要做

用户 2026-09-21 要求设置页用 shadcn 组件**完全重做**。触发它的是一件已经摆在眼前的事：
外壳（侧边导航）已经换成 shadcn 了，而 `/settings` 里每一块还是 BEM 的手写样式——
一套界面里两种来源的样式，改一处要猜另一处。

但**换皮不是重点，重点是这个页面扛着三条不能松的契约**，重做时最大的风险是它们在
「看起来更现代」的过程中被悄悄削弱：

1. **`VISION_NOTICE` / `EMBED_NOTICE` 是逐字契约**（`settings-ux.md §4`、SPEC §9.9）。
   「你的打标结果会进入公共库」那一句是共享库代价在界面上的唯一体现。**缩字号、改行距、
   重排成 `<p>` 都算弱化**——重排尤其阴，它会让下一次比对时对不上却看不出哪里变了。
2. **`rawResponse` / `rawError` 不截断、不包装**（`settings-ux.md §5`）。用户面对的是中转服务，
   只有原始返回能分清「模型能力不行」和「配置填错了」。做成折叠面板是可以的，
   但**折叠不能变成截断**。
3. **不测不让保存**（`settings-ux.md §6`）。改任何一个字段都要重置测试状态。

顺带一个结构性的理由：**触摸目标 44px 在这页原本有五个落点**，散在 `styles.css` 里
（`.config-fields__row input`、`.settings-table button`、`.settings-invite-form input` 等
各写一遍 `min-height: 44px`）。五份手写就是五种漂法，这次收成一个常量。

## 做完的标准

1. `npm run typecheck` 与 `npm run build` 全绿。
2. 分段数、顺序、`id` 锚点、管理员分段的可见性**一个不变**（`/admin/*` 的跳转靠它们）。
3. 两段契约文案**逐字**仍在，字号不缩，仍是等宽 `<pre>`。
4. 测试结果的四项探针（含三态「未探测」）逐项列出；原始输出可折叠但**全文在 DOM 里**。
5. 测试通过前保存禁用；改任一字段后重新禁用且清掉上一次结果。
6. 所有可聚焦控件 ≥44×44（**含表格内与下拉选项**）。
7. `styles.css` 里设置页那段 BEM 删干净。

## web 端要改什么

新增两个文件：

- **`features/settings/settings-ui.ts`**——两条跨文件常量。`TOUCH = 'min-h-11'` 是 44px 的
  新落点，`NOTICE` 是契约文案面板的样式。
- **`features/settings/SettingsCard.tsx`**——每段的壳（Card + 标题 + 描述 + 右上角 action）。

改写 8 个：`ConfigFields` / `TestResultPanel` / `VisionSettings` / `EmbedSettings` /
`ReindexPanel` / `InviteSettings` / `UsersSettings` / `routes/settings.tsx`，
外加 `App.tsx` 的一句过期注释、`styles.css` 删掉设置页那两块（1311 → 1050 行）。

## 三个「错了不报错」的地方

### 1. shadcn 的控件默认全部低于 44px，而且**没有例外**

| 控件 | 默认高 |
|---|---|
| `Button` / `Input` / `Select` 默认 | 36px（`h-9`） |
| `Button size="sm"` / `SelectTrigger size="sm"` | 32px |
| `SelectItem`（下拉里的选项本身） | 36px |

最小值要一个个量才知道，`size="sm"` 尤其反直觉——**「小号」在触摸目标这件事上不存在**。
本次一度打算给表格开例外（管理员表行数是个位数，44 会让行变高），
**实测推翻了这个想法**：邀请码的「复制」和用户行的角色选择器正是手机上要用手指点的东西。
所以现在**没有例外**，`settings-ui.ts` 的注释里写明了这一点和推翻的过程。

`SelectItem` 要单独带 `TOUCH`：它不在触发器那一类的覆盖范围里，漏了的表现是
「触发器 44，展开后每行又变回 36」。

### 2. Radix 的折叠高度是**展开那一刻量一次的快照**

`--radix-collapsible-content-height` 由 `useLayoutEffect` 在 `[open, present]` 变化时量一次，
**没有 ResizeObserver**；而 `AccordionContent` 的内层 div 是 `h-(--radix-accordion-content-height)`，
外面套 `overflow-hidden`。**展开之后再往里塞内容，多出来的部分被裁掉，且不报任何错。**

这不是从源码推的，是实测的（在 4173 上展开后往内容里塞一块 200px 的 div）：

```
内层 scrollHeight   108 → 292
内层 height         108px → 108px   （写死的，不跟）
外层 overflow       hidden
那块内容的可见高度   16px            （就是它自己的 padding）
```

**这条直接否掉了一个设计**：「高级选项」原本打算用 `Accordion` 做，但里面装的是
**测试结果**——用户正好是在它展开着的时候点「测试连接」，结果面板一出现就会被裁掉。
改成 `Button aria-expanded` + 条件渲染，实测 `overflow: visible`、不裁。

而 `RawOutput`（原始输出）**可以用 `Accordion`**：它装的是已经拿到的字符串，渲染完不再变。
`TestResultPanel.tsx` 里那段注释把这个边界写清楚了，免得下次有人把动态内容搬进去。

### 3. `Accordion` 的 `defaultValue` 只在挂载时生效

同一处折叠的第二个坑：两次测试之间组件是**复用**的（同一个 `form.phase.kind === 'done'` 分支），
所以「先失败（自动展开）→ 改配置 → 再测通过」会留着上一次展开的原始返回。
旧实现是 `<details open={!ok}>`，React 每次渲染都会去改那个属性，行为跟着变——**换组件时把这个行为丢了**。
处置：`key={`err-${ok}`}` / `key={`res-${ok}`}`，ok 一变就重挂载。用户自己点开的那次不受影响。

## 几处刻意的选择

- **`id` 挂在 `Card` 上，不挂里面的内容**。加载态和错误态渲染在卡片**里面**而不是替换整块——
  从 `/admin/invites` 跳过来时标题要立刻在，不能等表格拉回来才出现。
- **探针清单不在 `Alert` 里**。`variant="destructive"` 会把整块染红，而「测试没过」时
  清单里通常仍有几项是 ✓，一色红会把它们一起说成故障。结论那一行用 Alert
  （它自带 `role="alert"`，测完立刻被念出来），清单在外面用普通 `<ul>`。
- **✓ 用前景色，不用绿色**。主题里没有 success token，硬套一个 Tailwind 调色板就等于绕过
  token 体系（`styling.md`），而「通过」本来也不需要被染成什么颜色。✗ 用 `text-destructive`
  ——那是有语义 token 的。
- **邀请码的三个状态都不是红色**。「未使用」实心、「已使用」灰、「已过期」描边：
  已过期没坏，只是不再生效（`styling.md`「正常状态不用错误色」）。
- **Embedding 的二次确认改成 `AlertDialog`**，但**重建进度仍是并列的一块**，不做模态阻塞
  （`settings-ux.md §8`：它要跑几分钟，管理员应该能去干别的）。
- **`<CardTitle><h2>…</h2></CardTitle>`**。Tailwind preflight 把标题的字号字重清零，
  直接写 `<h2 className="…">` 会和 `CardTitle` 打架；包一层既有标题语义又不重复。
  实测每张卡一个 `<h2>`、页面一个 `<h1>`。
- **行内错误用一行小字不用 `Alert`**（用户表保存失败）。`Alert` 是 `px-4 py-3` 的整块，
  塞进单元格会把行撑成一张卡；`role="alert"` 保留，失败必须被读屏念出来。

## web 端验收

**做法**：`npm run build` → `vite preview`（4173），系统 Chrome（Playwright `channel: 'chrome'`），
量计算样式与几何，不靠肉眼看截图。

> **登录态是 route 打桩的**（仓库里没有开发凭据，用 `page.route()` 拦 `/auth/me`、
> `/config/vision*`、`/admin/*`）。**这验的是渲染与几何，不是接口联调**——
> 下面的数字都成立，但真 api 没接过。

### 契约与结构

| 项 | 实测 |
|---|---|
| 分段 | 5 张卡，锚点 `#vision` / `#embedding` / `#invites` / `#users`，顺序与改前一致 |
| 标题语义 | 页面 1 个 `<h1>`；每张卡恰好 1 个 `<h2>` |
| 契约文案 | `VISION_NOTICE` / `EMBED_NOTICE` 逐字比对通过，**字号 14px 未缩**，`white-space: pre-wrap` 保住原文缩进 |
| 卡片圆角 | 26px（`radix-luma` 的乘法刻度，证明 token 生效） |
| 原始输出 | 折叠态全文仍在 DOM 里；`<pre>` 限高 320px 自带滚动，**不是截断** |
| 锚点落点 | `#vision` / `#invites` / `#embedding` 精确落在 `top: 16px`（`scroll-margin-top: 16px`）；`#users` 落 638px 是因为它是最后一张卡、文档滚不动了——**改前如此，不是回归** |
| 未登录 / member | member 只看到「视觉打标模型」一张卡，目录里只有 `#vision` 一条 |
| 控制台 | 无报错 |

### 交互

| 项 | 实测 |
|---|---|
| 保存门禁 | 初态禁用 → 测试通过后启用 → **改任一字段后重新禁用且结果面板清空** |
| 测试探针 | 4 项逐项列出，含三态「多图输入：未探测」（`null` 不是 `false`） |
| 高级选项 | 默认收起；展开后 `overflow: visible`、**不裁内容** |
| 二次确认 | `AlertDialog` 真的是模态；标题与描述正确；两个按钮都 44px；Esc 可关 |
| 角色下拉 | 展开有 admin / member 两项可选 |
| 邀请码复制 | 点击后剪贴板内容与码一致 |
| 空进度条 | `translateX(-100%)`，**无 NaN**（`total: 0` 的除法守卫） |

### 触摸目标 44×44

| 控件 | 实测 |
|---|---|
| 输入框 / 保存按钮 / 测试按钮 / 目录锚点 | 44 |
| `SelectItem`（下拉选项本身） | **144 × 44** |
| 手机端 `SelectTrigger` / 「生成邀请码」/ 侧边栏触发器 | 44 / 44 / 44×44 |

### 手机 390×844 与深色

| 项 | 实测 |
|---|---|
| 页面横向溢出 | 无：`document.scrollWidth` = 390，根容器与卡片 = 342 |
| 表格 | 在自己的容器里横向滚（484/294、698/294），不撑破页面 |
| 深色 | 卡片 `oklch(0.205 0 0)`、页面 `oklch(0.145 0 0)`——**实色，不是透明** |

## 已知遗留（记录不修）

- **真 api × 真浏览器联调仍未跑**。上面的断言全部对着打桩数据，真后端接上后
  「保存 → 重建索引 → 进度」这条链要看一眼。与 README 里那批「部署后联合回归」同批。
- **`#users` 深链落在 638px 而不是 16px**——它是最后一张卡，文档滚不动了。改前也一样，
  不是本次引入的。要治得给页面留底部空白，那是另一件事。
- **`styles.css` 里其余页面的 BEM 还没迁**（1134 行），`web/AGENTS.md §5` 已写明是单独任务。
  本次只删了设置页那两块（约 230 行）。
- **本次没上真机**，手机端结论来自 390×844 视口。本任务不涉及复制 / 分享路径
  （邀请码的复制走的是 `navigator.clipboard.writeText` 而不是图片路径），所以够用；
  动图片复制 / 分享时仍必须上真机（`web/AGENTS.md §6`）。

## 不做

- 改分段的可见性与权限归属——合并的是呈现，权限一个字没改（`settings-ux.md §2`）。
- 改任何接口、字段或错误码。
- 管理员分段的统计面板（`settings-ux.md §9`，界面还没做，另见[打标状态界面](../../joint-tasks/2026-09-19-tagging-status.md)）。
- 给 API Key 加显示明文的眼睛图标——`settings-ux.md §7` 明令不加。
