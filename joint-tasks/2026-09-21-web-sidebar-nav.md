# web 顶部导航换成 shadcn 侧边导航

**状态**：`done`
**性质**：**web 单端**——不动 `api/`，不动 SPEC，不改任何接口与数据语义。

## 为什么要做

用户 2026-09-21 要求把页面顶部的导航条换成 shadcn 的侧边导航。这是一次**结构性替换**，
不是换个皮肤，触发它的是三件具体的事：

1. **组件库进来了，但一个 shadcn 组件都没长在业务界面上。** 上一轮把 `radix-luma` 组件层
   落了地，可整个 `src/` 里 import `@/components/ui/*` 的只有 `routes/ui.tsx` 一个文件——
   也就是「组件库」目前只是一个参照页。外壳换掉之后，Sidebar 是第一个真正跑在业务里的
   shadcn 组件，顺带把这条链路真的走通一遍（token、变体、React 18 的 ref、44px 触摸目标）。

2. **`.app__nav a { min-height: 44px }` 是触摸目标契约在代码里的唯一落点。**
   `styles.css` 里那条规则（注释写明是 390×844 实测出来的）随着顶部导航一起消失。
   触摸目标的要求不会因为导航换了形状而消失——**新侧边栏的导航项必须接住它**，
   否则 `styling.md`「至少 44×44px」那条就从有落点变成一句无人执行的话。

3. **首页图墙的断点绑在视口上，侧边栏吃掉 256px 后不再成立。**
   `.discover__grid` 是固定列数 + `@media (max-width:900px)`：768–1150px 视口下内容列只剩
   720–850px 却依然排 5 列，每格 120–140px，低于这条规则自己写的 160px 底线。
   媒体查询看的是视口，而变窄的是内容列——**这是容器查询要解决的问题，不是调阈值能解决的**。

## 已定决策（用户已选）

| 问题 | 选择 | 理由 |
|---|---|---|
| 登录 / 注册页 | **不套**侧边栏 | 它们各自是一个专注任务页，旁边挂一条几乎全是「登录后才有效」的入口只是噪音 |
| 桌面折叠形态 | `collapsible="icon"` | 收起后留一条 3rem 图标窄栏，图标带 tooltip，比整体收成抽屉少一次点击 |
| 内容区顶栏 | **只放折叠按钮** | 各页自己已经有标题，顶栏再放一遍就是两处标题 |

## 三个「漏了不报错」的坑（都踩过一遍才写在这里）

### 1. `--sidebar-*` token 一个都没有

Tailwind v4 对未知的颜色工具类**不生成任何东西**：`bg-sidebar` / `text-sidebar-foreground` /
`border-sidebar-border` / `ring-sidebar-ring` 会静默失效，侧边栏渲染成全透明、无边框，
构建不报错、控制台不报错。

补了 6 个（`sidebar.tsx` 里真被引用的那 6 个；`--sidebar-primary` / `--sidebar-primary-foreground`
零引用，没抄），值取自注册表的 neutral 条目（`https://ui.shadcn.com/r/colors/neutral.json`
的 `cssVars`），与 `index.css` 里其余 18 个 token 逐字对得上——**不是推出来的**。

### 2. `@theme inline` 不输出 CSS 变量，组件里写 `var(--radius-xl)` 会解析成空

这是本次最隐蔽的一个。`inline` 的含义就是「工具类直接用值，不留变量引用」：
量最终产物 `dist/assets/index-*.css` 确认 `--radius-xl` / `--radius-sm` / `--color-background`
出现 **0 次**，只有 `--font-sans` 出现 2 次。工具类没事（`.rounded-xl{border-radius:calc(var(--radius)*1.4)}`
是内联进去的），但**组件自己写 `var(--radius-xl)` 就没得解析**。

而 `sidebar.tsx` 的 `SidebarHeader` / `SidebarContent` 正是这么用的
（`[--radius:var(--radius-xl)]`，把整个侧边栏子树的半径抬高一档）。少了这一份，
**侧边栏里每个圆角都变成 0，且不报任何错**。

处置：把七行圆角刻度**同时**写进上面 `:root` 的运行时副本，两处逐条对应、改一处要改另一处。
实测判据是菜单项的 `border-radius` = **19.6px**——`0.625rem × 1.4 × 1.4`，
两个因子分别证明「`--radius-xl` 解析得出」和「侧边栏子树的覆盖生效」。

### 3. `TooltipProvider` 缺失会白屏，不是降级

Radix 的 `createTooltipContext(PROVIDER_NAME)` 没有默认值，`useTooltipProviderContext` 在
**渲染期直接抛错**。而 registry 的 `SidebarProvider` 里**不含** `TooltipProvider`。
图标窄栏模式的菜单名全靠 tooltip 显示，所以这个 Provider 是必需件：漏了就是整个应用白屏，
没有 error boundary 兜。

处置：`App.tsx` 的 `AppLayout` 里用 `<TooltipProvider>` 包住 `<SidebarProvider>`。

## React 18 的 ref：这次不用再包 `forwardRef`

`styling.md` 那条「自己写的组件当 `asChild` 子节点必须 `forwardRef`」这次**不适用**，
逐个可能的丢 ref 点核过：

| 点 | 结论 |
|---|---|
| `SidebarMenuButton`（非 forwardRef，React 19 写法） | 被 `<TooltipTrigger asChild>` 包着。非 asChild 分支渲染真实 `<button>`（DOM 元素收 ref 没问题）；asChild 分支渲染 `Slot.Root`，而 `@radix-ui/react-slot` 是 `React.forwardRef`，克隆子节点时同时读 `props.ref` 与 `element.ref`（React 18/19 两种写法都认） |
| 传给 `asChild` 的子节点 | 本次是 react-router v6 的 `<Link>`，自带 forwardRef |
| `SidebarTrigger` | 渲染的是我们的 `Button`，已在上一轮包过 forwardRef |

**结论：只有传给 `asChild` 的那个子节点需要 forwardRef**——这对 `styling.md` 现有表述是个收窄，
不是扩大。实测也印证了：折叠态 hover 图标弹出 tooltip，说明 popper 拿到了锚点。

## 触摸目标 44px 的新落点

原 `.app__nav a { min-height: 44px }` 那条规则的解释性注释**搬进了**
`components/AppSidebar.tsx` 的 `NAV_ITEM_SIZE`，没有随 BEM 一起删掉。

`SidebarMenuButton` 默认 `h-9`（36px），低于 44，所以统一加 `min-h-11`。
**图标窄栏是唯一的例外**：registry 用 `group-data-[collapsible=icon]:size-8!` 把按钮压成
32×32 的方块，而 `min-height` 会盖过 `height`（不同属性，`!important` 管不着），
不加 `group-data-[collapsible=icon]:min-h-8` 按钮会变成 32 宽 × 44 高的长条。
32 是窄栏的物理宽度，且那个形态只在 md 以上出现——手机端拿到的是 Sheet 里的**展开版**，
仍是 44。

## 做完的标准

1. `npm run typecheck` 与 `npm run build` 全绿。
2. 桌面：侧边栏 256px、导航项 ≥44px、当前路由项高亮、可折叠成 48px 图标栏且图标能弹 tooltip。
3. 手机：<768px 侧边栏不可见、触发器 ≥44×44、点开是抽屉且导航项 ≥44px、**点导航后抽屉要收起**。
4. 深色下侧边栏是实色底（token 生效的唯一判据）。
5. 登录 / 注册页无外壳；`/ui` 与业务页在外壳里正常渲染；`/admin*` 重定向仍从布局内发生。
6. 首页图墙在 1024px 视口下为 3 列（改前 5 列），且回落的是**容器宽度**不是视口宽度。
7. `styles.css` 里的 `.app__*` 规则删干净（无分层 CSS 会压过 Tailwind 工具类）。

## web 端要改什么

1. **`components.json`**：`aliases.hooks` 由 `"@/hooks"` 改成 `"@/lib"`——`project-structure.md`
   明文禁止按类型切的全局 `hooks/` 目录。CLI 自己就把 `use-mobile.ts` 写到了 `src/lib/`。
2. **拉组件**：`npx shadcn add sidebar --overwrite`（新增 `ui/sidebar.tsx`、`ui/sheet.tsx`、
   `lib/use-mobile.ts`）。**唯一风险是它会覆盖 `ui/button.tsx`**，跑完立刻
   `git checkout -- src/components/ui/button.tsx` 还原那层 `forwardRef`。依赖只多一个 `cn`
   （已在 `package.json`）——**不触发 `npm install`，`hono` 无漂移风险**。
   两处 sr-only 文案汉化，按 button/badge 的先例注明。
3. **`src/index.css`**：补 `--sidebar-*` 6 组（浅色 / 深色）+ `@theme inline` 6 行映射，
   并把圆角刻度复制进 `:root`（见上）。
4. **`src/components/AppSidebar.tsx`**（新）：`Sidebar collapsible="icon"` +
   Header（品牌）/ Content（`SidebarMenu`，图标 Lucide）/ Footer（角色徽标 + 登出）。
   导航项 `isActive` 用**精确相等**——`/` 是每条路由的前缀，`startsWith` 会让「首页」在每一页都亮着。
5. **`src/App.tsx`**：`RequireAuth` 改成布局路由（`useLocation` + `<Outlet/>`）；
   新增 `AppLayout` = `TooltipProvider` + `SidebarProvider` + `AppSidebar` + `SidebarInset`。
   `/login`、`/register` 在布局**外**；`/`、`/browse`、`/import`、`/settings`（各自仍包 `RequireAuth`）、
   `/ui`、四个 `/admin*` 重定向、`*` 都在布局**内**（重定向放外面会先卸掉整条外壳再挂回来，闪一下）。
6. **`src/styles.css`**：删 `.app__header`（注意**有两段**）、`.app__header a`、`.app__main`、
   `.app__nav`、`.app__nav a`、`.app__nav a, .app__nav button`、`.app__nav-progress`；
   `.discover` 加 `container-type: inline-size`，两条 `@media` 改 `@container`。
7. **`src/features/settings/use-hash-scroll.ts`**：加 `pointerdown` 兜底（见下）。

## web 端验收

**做法**：`npm run build` 起 `vite preview`（4173），系统 Chrome（Playwright `channel: 'chrome'`，
见 memory）实测计算样式与几何，不靠肉眼看截图。

> **登录态是 route 打桩的。** 仓库里没有开发凭据，所以用 Playwright 的 `page.route()` 拦
> `/api/v1/auth/me` 与 `/api/v1/memes**` 回假数据。**这验的是渲染与几何，不是接口联调**——
> 上表的数字都成立，但「真 api × 真浏览器」仍然没跑过（见 README 的遗留项表）。

| 项 | 实测 |
|---|---|
| 侧边栏宽（展开） | 256px；侧边栏占位 `sidebar-gap` = 256px |
| 侧边栏宽（折叠） | 48px；图标按钮 32×32 方块（不是 32×44 长条） |
| 导航项高 | 44px（展开态、手机抽屉里都是 44） |
| 菜单项 `border-radius` | **19.6px** = `0.625rem × 1.4 × 1.4` —— `--radius-xl` 与子树的覆盖都生效 |
| `data-active` | `/ui` 上「组件」= `true`，「首页」= `false`（精确相等，没误亮） |
| 折叠后 hover 图标 | tooltip 出现，文案「浏览」——顺带证明 React 18 下 popper 拿到了锚点 |
| `sidebar-inner` 背景（浅 / 深） | `oklch(0.985 0 0)` / `oklch(0.205 0 0)`——**实色，不是透明**，token 确实补上了 |
| `<main>` 地标数 | 1（各页都验过，`SidebarInset` 自己就是 `<main>`，没套第二层） |
| 手机 390×844 | 桌面侧边栏**根本不渲染**（`Sidebar` 的 `isMobile` 分支只出 Sheet）；触发器 44×44；抽屉里导航项 44px；点「浏览」→ URL 变 `/browse` **且抽屉收起** |
| 未登录 | `/login` 上 sidebar / `header` / `.app__nav` 数均为 0；访问 `/` 落 `/login` |
| 首页图墙 @1024 | 内容列 720px → **3 列**（改前 5 列）；`container-type` = `inline-size` |
| 首页图墙 @1280 | 内容列 976px → 5 列（宽屏行为不变） |

**本次改出来一个真缺陷（已修）**：registry **没有**「手机端导航后自动收起抽屉」这条——
点「浏览」路由变了，抽屉照旧盖在新页面上面，用户得再点一下遮罩才看得见自己刚点的页。
处置：`AppSidebar` 里 `useSidebar().setOpenMobile(false)`，挂在品牌、导航项与登出的 `onClick` 上。
桌面 `isMobile` 为 false，这个 setter 无害。

**已知的 registry 行为（不改）**：手机抽屉实测宽 **293px**，不是 `SIDEBAR_WIDTH_MOBILE` 的 288px。
`sheet.tsx` 给了 `data-[side=left]:w-3/4`，而 `sidebar.tsx` 传的是 `w-(--sidebar-width)`：
tailwind-merge 不会把带变体前缀的类和裸类合并，属性选择器特异性又更高，所以 `w-3/4` 赢——
390 × 0.75 = 292.5。也就是说 **`--sidebar-width: 18rem` 在手机端是失效的**，
抽屉宽度是「视口 75%」。在 320px 的机器上这比固定 288px（90%）更好用，按注册表行为保留。

## 已知交互与取舍（记录不修）

- **`use-hash-scroll.ts` 的 `pointerdown` 兜底**（本次新增，是**行为变化**）。它对 `.settings-page`
  挂了 `ResizeObserver`，任何尺寸变化都会重新 `scrollIntoView`（最多 3 秒）。折叠侧边栏会改内容列宽
  → 触发重对齐 → 而触发折叠的那一下正是点击，用户会被拽回锚点。加 `pointerdown` 是在
  「用户自己动手了」的判定里补上鼠标 / 触摸 / 笔一支，属于既有设计的补全，不是新机制。
- **`MemeEditPanel` 与手机抽屉的层叠**。`MemeEditPanel` 是手写模态（`z-index: 31` + scrim `30`），
  手机上的侧边栏走 Radix Sheet（`z-50`）会盖在它上面，且它的 Esc 处理不判断上层是否还有打开的层。
  **两个模态体系并存是既有事实**，合并是另一件事；这里只记录。
- **`/browse` 的筛选栏（220px）仍按视口断点收放**，没有一起改成容器查询。它有
  `min-width: 0` + masonic 自测容器宽度兜底，降列是平滑的。图墙那处是「不换就明显坏」，
  这处是「不换也不坏」——不同的问题，不一起动。
- **新增了一个全局快捷键** `Ctrl/Cmd+B`（registry 自带）。与浏览器的「显示书签栏」冲突，
  但只在应用内生效。
- **`sidebar_state` cookie 是只写的**：`SidebarProvider` 会写它，但**代码里没有任何地方读**，
  所以折叠状态刷新后回到展开。这是 registry 的现状，接它的读取是另一件事。

## 不做

- 业务页改用 shadcn 组件（把视觉重新长回 browse / home / tagging / discover）——后续任务。
- `src/styles.css` 那 1334 行 BEM 整体迁 Tailwind——`web/AGENTS.md §5` 已写明是单独任务。
- 侧边栏里加用户头像、存储配额、面包屑、多级菜单——本次只做导航等价替换。
- 升 React 19（`forwardRef` 那套在 19 下同样有效，不构成理由）。
