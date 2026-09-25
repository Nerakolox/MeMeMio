# web 迁 Tailwind v4 + radix-luma 组件层

**状态**：`done`（2026-09-25；关单与归档由总管做）
**性质**：**web 单端**——不动 `api/`，不动 SPEC，不改任何接口与数据语义。

**剩余阻塞（已解除）**：`做完的标准` 第 4 条（业务四页不回归）**已实测**，见
[四页走查](2026-09-25-web-page-walkthrough.md) 的「web 端验收」。

原来的阻塞理由「仓库里没有开发凭据」是错的：替身的 `/auth/me` 恒返 admin，四页不登录也能渲染
（`verify-home-look.mjs` 早就这么用过）。真正缺的是一套把四页都摆出来的脚本，2026-09-25 补上了。

**四页名单已修正**：老卡里写的 browse / home / tagging / discover 是**迁移当时**的路由，
现在 tagging 并进了导入页（`features/tagging/TagStatusView` 挂在 `routes/import.tsx`）、
discover 并进了首页（`features/discover/DiscoverWall`）。走查走的是**现在的四页**：首页 / 浏览 / 导入 / 设置。

## 为什么要做

2026-09-21 换主题那次只换对了**颜色**。用户对着
<https://ui.shadcn.com/create?preset=b1VlIttI> 调的那份 preset，实际内容远不止一组色值。

把 preset 在沙箱里完整生成一份（`npx shadcn@latest init --preset b1VlIttI --base radix --template vite`）
之后，它生成的东西是：

```json
// components.json
"style": "radix-luma",                                   // 我们是 new-york
"tailwind": { "config": "", "baseColor": "neutral" }      // 我们是 tailwind.config.js / zinc
// package.json
"tailwindcss": "^4", "@tailwindcss/vite": "^4", "tw-animate-css",
"radix-ui", "cn", "shadcn", "@fontsource-variable/inter"
```

对比后确认，颜色 token 我们抄对了（`--primary: 0.205 0 0`、`--radius: 0.625rem`、
`--border: oklch(0.922 0 0)` 逐一相同），差的另外三层：

| 层 | preset | 我们（迁移前） |
|---|---|---|
| 字体 | `@fontsource-variable/inter`，`--font-sans: 'Inter Variable'`，`html { font-sans }` | **完全没有**，走 `styles.css` 的 `system-ui,...` |
| 组件样式家族 | `radix-luma`（Tailwind v4 时代，`rounded-4xl` / `ring-3` / `size-9` / `data-slot`） | `new-york`，而且是 registry 里的 **v3 旧版内容** |
| 圆角换算 | 乘法：`sm=r×0.6, md=r×0.8, lg=r, xl=r×1.4, 2xl=r×1.8, 3xl=r×2.2, 4xl=r×2.6` | 加减：`sm=r−4px, md=r−2px` |

同一个 `--radius: 0.625rem`，两种公式下每个组件的角都不一样；同一个按钮，preset 是
`rounded-4xl`（≈26px）、我们是 `rounded-md`（8px）。所以「配色像、整体不像」。

**为什么不能只补字体和圆角**：那样配色和字对了，组件几何仍是 new-york——按钮更方、
destructive 仍是实心红底、outline 仍带阴影。目标是「和官网调的那份看起来一样」，
半程等于再返工一次。

## 硬依赖（迁移前不知道、漏了会静默坏）

**`shadcn/tailwind.css` 是必需品，不是可选项。** radix-luma 的 25 个组件里有 18 个用了它定义的
自定义变体，Tailwind v4 本体不提供：

| 变体 | 用在 |
|---|---|
| `data-open:` / `data-closed:` | accordion、dialog、alert-dialog、popover、dropdown-menu、select、tooltip |
| `data-checked:` / `data-unchecked:` | checkbox、radio-group、switch |
| `data-disabled:` | dropdown-menu、select、slider、switch |
| `data-horizontal:` / `data-vertical:` | scroll-area、separator、slider、tabs |
| `data-active:` | tabs |
| `no-scrollbar` | scroll-area 等 |

漏掉不会报错，表现是**弹层动画没了、勾选态不显示、滑块方向错**——所以要么
`@import "shadcn/tailwind.css"`（进 `dependencies`，preset 就是这么放的），要么把这几个变体抄进
`index.css`。本任务选前者：抄一份就有第二份要跟上游同步。

**Tailwind v4 改了工具类名字**，现有代码里的 v3 名字在 v4 下要么消失要么变语义：

| v3 | v4 | 影响 |
|---|---|---|
| `shadow-sm` | `shadow-xs` | 阴影变大一号 |
| `shadow` | `shadow-sm` | 同上 |
| `rounded-sm` | `rounded-xs` | 圆角变大 |
| `rounded` | `rounded-sm` | 同上 |
| `outline-none` | `outline-hidden` | `outline-none` 在 v4 是「无轮廓」，不再保留可访问性轮廓 |
| `ring` | `ring-3` | v4 默认 ring 宽度从 3px 变 1px |

本仓库实际命中很少（业务页在上一轮已简化成裸图，只有 `routes/ui.tsx` 和
`features/manage/MemeActions.tsx` 各一处在用），已逐一处理。

**radix-luma 是按 React 19 写的，本端跑 React 18——ref 会静默丢。** 这是迁移后第二轮才发现的第二个
「漏了不报错」的坑，比上面那个更隐蔽：

React 19 里 `ref` 是普通 prop，所以注册表组件一律写成

```tsx
function Button({ className, ...props }) { return <Comp {...props} /> }   // 没有 forwardRef
```

`ref` 顺着 `{...props}` 就落到 DOM 上了。React 18 里 `ref` 不进 props，只有 `forwardRef` 组件收得到，
上面这种写法 **ref 直接被丢掉，且生产构建不发警告**（dev 模式才会报
`Function components cannot be given refs. Check the render method of Primitive.button.Slot.`）。

丢在哪一环：`DropdownMenuTrigger asChild` → Radix `Slot` 把触发器 ref 交给我们的 `Button` → 丢。
而 popper 系弹层的**锚点就是这个 ref**，于是 `context.anchor` 为 null，`useFloating` 静默早退
（`if (!referenceRef.current || !floatingRef.current) return`），表现是：

- Tooltip / Popover / DropdownMenu / Select **全部弹层不定位**——不是「位置偏了」，是永远停在
  Radix 未定位的占位 `translate(0, -200%)`，也就是**跑到视口外，用户看不到**；
- 顺带导致「进场动画没了」——Radix 在未定位期间会内联压 `animation: none`
  （`@radix-ui/react-popper/dist/index.mjs` 的 `animation: !isPositioned ? "none" : …`），
  它压过 `data-open:animate-in`。所以一开始看到的「不动画」只是这个根因的表象，
  不是 tw-animate-css 或 `shadcn/tailwind.css` 没生效。

处置：给**会被当 `asChild` 子节点用的**本端组件包 `forwardRef`（本次是 `button.tsx`、`badge.tsx`，
各加一层并注明原因）。不升 React 19——业务四页在登录后面，升大版本而无法回归验证的代价更大；
`forwardRef` 在 React 19 下同样有效，将来升级不用回退。规则已写进
[styling.md](../../web/agents/rules/styling.md)。

## 深色模式：契约不变

preset 生成的是 `.dark` class 变体（`@custom-variant dark (&:is(.dark *))`）。
**本项目深色走 `prefers-color-scheme`、不做手动开关**（[styling.md](../../web/agents/rules/styling.md)），
所以**不加** `@custom-variant dark` —— Tailwind v4 的 `dark:` 默认就是
`@media (prefers-color-scheme: dark)`，恰好就是我们要的；深色 token 也从 `.dark {}` 搬进
`@media (prefers-color-scheme: dark) { :root { … } }`。组件里所有 `dark:` 前缀不用改。

## 做完的标准

1. `npm run typecheck` 与 `npm run build` 全绿。
2. `components.json` 为 `radix-luma`，25 个组件内容与 `https://ui.shadcn.com/r/styles/radix-luma/<name>.json` 逐行等价。
3. `/ui` 在浅色与深色下渲染正常：弹层能开合、勾选框/开关/滑块有状态样式（验证 `shadcn/tailwind.css` 真的生效）。
4. 业务四页（browse / home / tagging / discover）渲染不回归。
5. `hono` 版本与 `api/` 保持一致（`^4.6.16`）——见 [web 规则](../../web/agents/rules/INDEX.md) 里的锁步约束。

## web 端要改什么

1. **依赖**：`tailwindcss@^4` + `@tailwindcss/vite` + `tw-animate-css` + `@fontsource-variable/inter`
   + `radix-ui` + `cn` + `shadcn`；卸 `tailwindcss@3`、`postcss`、`autoprefixer`、
   `tailwindcss-animate`、18 个 `@radix-ui/react-*`（业务代码零直接引用，已 grep 确认）、
   `clsx`、`tailwind-merge`。
2. **构建**：`vite.config.ts` 挂 `@tailwindcss/vite`；删 `tailwind.config.js`、`postcss.config.js`。
3. **`src/index.css`**：改 v4 形态（`@theme inline` + `:root` 全量色值），深色走 media。
4. **`src/lib/utils.ts`**：`export { cn } from "cn"`。
5. **重拉 25 个组件**（`--overwrite`），落在 `src/components/ui/`。
6. **`src/styles.css`**：`font-family` 换成 Inter 栈。
7. **`src/routes/ui.tsx`**、**`src/features/manage/MemeActions.tsx`**：v3→v4 类名。
8. **`web/agents/rules/styling.md`** 与 **`web/AGENTS.md §5`**：主题一节改成 Tailwind v4 口径
   （token 不再是「裸分量 + `<alpha-value>`」那一套，那是 v3 的形状）。

## web 端验收

**做法**：`npm run build` 起 `vite preview`（4173），用系统 Chrome（Playwright `channel: 'chrome'`）
实测计算样式与几何，不靠肉眼看截图。

1. **typecheck / build 全绿**。`tsc -p tsconfig.json --noEmit` 无输出；`vite build` 成功
   （产物 `index-*.css` 90.45 kB / gzip 15.03 kB，Inter 7 个 woff2 子集都在 dist 里）。
2. **`components.json`** 已是 `radix-luma` + `tailwind.config: ""` + `baseColor: neutral`；
   25 个组件与 `/r/styles/radix-luma/<name>.json` 逐行比对，差异只有 CLI 自身重写的那几处
   （沙箱工程对照确认）。**已知偏离**：`button.tsx`、`badge.tsx` 各加了一层 `forwardRef`（原因见上），
   其余 23 个与注册表一致；9/25 个文件带 `"use client"`（Vite 里是空操作，按注册表原样保留）。
3. **`/ui` 交互实测（浅色）**：

   | 项 | 实测 |
   |---|---|
   | DropdownMenu | 定位 `translate(564px, 522px)`，`animation-name: enter` |
   | Popover | 定位 `translate(581px, 522px)`，`animation-name: enter` |
   | Tooltip | 定位 `translate(638px, 444px)`，内容「悬停或聚焦时显示」 |
   | Select | item-aligned 模式，内容落在 `443,440`（正确）；`animation-name: none` 是组件自己写的 `data-[align-trigger=true]:animate-none`，非缺陷 |
   | AlertDialog | 打开正常，背景 `oklch(1 0 0)`，`animation-name: enter` |
   | Switch | 滑块 `translate` 由 `0px` → `calc(100% - 8px)` |
   | Tabs | 切到第二个，面板内容随之切换 |
   | Accordion | 展开高度 36px，`animation-name: accordion-up` |

4. **深色（`prefers-color-scheme: dark`，无手动开关）**：body 底 `oklch(0.145 0 0)`、
   弹层底 `oklch(0.205 0 0)`、前景 `oklch(0.985 0 0)`，菜单/确认框都定位且 `animation-name: enter`。
   圆角实测 22px（菜单 `rounded-3xl`）/ 26px（确认框 `rounded-4xl`），正是
   `--radius 0.625rem × 2.2 / 2.6` 的乘法档——乘法公式确实生效。
5. **hono 锁步**：web 与 api 都声明 `^4.6.16`、都实装 `4.13.7`（这轮动了 300+ 个包，未漂移）。

**没验到 / 有保留的**：

- ~~**业务四页（browse / home / tagging / discover）没做像素级回归**……这是推断不是实测。~~
  ✅ **2026-09-25 解除**：四页走查用真图把现在的四页（首页 / 浏览 / 导入 / 设置）在
  1440×900 / 390×844 × 浅色 / 深色四档下都渲染了一遍，32 条断言全过、89 张截图。
  组件层（卡片、弹层、确认框、页签、抽屉、toast）全部正常，没有样式缺失或布局塌掉。
  **仍是渲染证据，不是接口联调**（数据来自替身、写操作没落库），但「四页不回归」这条
  已由推断升级为实测。详见 [四页走查](2026-09-25-web-page-walkthrough.md)。

  > ✅ **2026-09-21 补了一半证据**（[顶部导航换侧边导航](2026-09-21-web-sidebar-nav.md)那次）：
  > 用 Playwright 的 `page.route()` 打桩 `/api/v1/auth/me` 与 `/api/v1/memes**`，
  > 在系统 Chrome 里**真的渲染了** home / browse / import / settings 四页，浅色深色都过了一遍，
  > 没看到布局塌掉或样式缺失。**这是渲染证据，不是接口联调**——数据是假的、写操作没走通，
  > 所以本条「业务四页不回归」从「推断」升级为「渲染实测通过，联调仍未做」，仍然不构成关单依据。
- **真机 / 真浏览器手势没测**。本次没有动复制、下载、分享路径，按 web 交付规则不需要两端实机结论。
- **dev server 与 build 两条路径都验过**，但用户本机 5173 那个进程是在依赖替换**中途**启的，
  一直供着旧 CSS，需重启才是当前代码。

## 现在不做

- `src/styles.css` 那 1334 行 BEM 迁 Tailwind —— 是另一件事（`web/AGENTS.md §5` 已写明单独任务）。
- 组件层换成 radix-luma 后，**业务页仍不使用 shadcn 组件**（上一轮简化成裸图去掉了
  `MemeCard`/`MemeImage`）。把视觉重新长回业务页是后续任务，不在本次。
