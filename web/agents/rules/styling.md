# 样式

## 方案

**样式载体：Tailwind，组件库：shadcn/ui**（2026-09-19 定稿，取代早先「不引入组件库」的决定）。

- 组件从 shadcn 拉进仓库，落在 `src/components/ui/`，底层原语是 Radix。新组件用
  `npx shadcn add` 拿，再按项目约定改，不把它当黑盒依赖。
- 主题是**自调的 shadcn preset `b1VlIttI`**（2026-09-21 换掉 new-york + zinc 默认值），
  颜色/圆角/阴影全部走 `src/index.css` 里的 CSS 变量 token（`--primary` 等 **oklch** 值），
  **组件与页面只引用语义 token，不写死 HEX**。
- **样式载体是 Tailwind v4**（2026-09-21 从 v3.4 迁上来，见[该次任务](../../../_archive/joint-tasks/2026-09-21-web-tailwind-v4-radix-luma.md)）。
  没有 `tailwind.config.js`、没有 `postcss.config.js`：主题整块在 `src/index.css` 的
  `@theme inline` 里，构建走 `@tailwindcss/vite`。加 token 就在那两处加，别去找配置文件。
- **token 存完整色值**（`--primary: oklch(0.205 0 0)`），`@theme inline` 用
  `--color-primary: var(--primary)` 映射成工具类。不要写 v3 那套「裸分量 + `<alpha-value>`
  占位符」——那是为了在 v3 里凑出透明度修饰符，v4 原生支持，写成裸分量反而解析不出颜色。
- ⚠️ **`@theme inline` 不输出 CSS 变量**——`inline` 的含义就是「工具类直接用值，不留变量引用」。
  工具类没事（`.rounded-xl{border-radius:calc(var(--radius)*1.4)}` 是内联进去的），
  但**组件自己写 `var(--radius-xl)` 会解析成空**。所以 `:root` 里另有一份七行圆角刻度的
  运行时副本，**不是重复**：`sidebar.tsx` 的 `SidebarHeader` / `SidebarContent` 用
  `[--radius:var(--radius-xl)]` 把整个侧边栏子树的半径抬高一档，少了那份副本，
  侧边栏里每个圆角都变成 0 且不报任何错。**加 token 时先问一句：有没有组件会写 `var(--它)`，
  有就两处都加。** 判据可以量：侧边栏菜单项的 `border-radius` 是 19.6px
  （`0.625rem × 1.4 × 1.4`），是 0 就说明这份副本丢了。
- **颜色 token 只抄被引用的**。`--chart-*` 至今零引用，没抄；`--sidebar-*` 在换成侧边导航
  （2026-09-21）时补了 **6 个**（`sidebar` / `sidebar-foreground` / `sidebar-accent` /
  `sidebar-accent-foreground` / `sidebar-border` / `sidebar-ring`），
  `--sidebar-primary` / `--sidebar-primary-foreground` 仍零引用，也没抄。
  **漏一个不报错**——Tailwind v4 对未知的颜色工具类不生成任何东西，`bg-sidebar` 静默失效，
  侧边栏渲染成全透明。值取自 `https://ui.shadcn.com/r/colors/neutral.json` 的 `cssVars`，
  不自己推。将来谁要用新的一组，先确认它真的在用。
- **组件层是 `radix-luma`**（`components.json` 的 `style`）。它和旧的 `new-york` 不是一套
  东西：圆角是乘法刻度（`rounded-4xl` = `--radius × 2.6`）、按钮是药丸形、destructive 是
  浅底红字，组件代码里用 `data-open:` / `data-checked:` 这类变体。**这些变体来自
  `shadcn/tailwind.css`**，所以 `index.css` 里对它的 `@import` 删不得——删了不报错，
  表现是弹层没动画、勾选态不显示。
- **深色不写 `@custom-variant dark`**：v4 的 `dark:` 默认就是 `prefers-color-scheme`，
  正合本项目约定（见下「深色模式」）。preset 产出的是 `.dark` class 版，抄的时候别抄那行。
- **本端还跑 React 18，radix-luma 是按 React 19 写的——自己写的组件要当 `asChild` 子节点时
  必须 `forwardRef`。** React 19 里 `ref` 是普通 prop，注册表组件一律不写 `forwardRef`，
  靠 `{...props}` 透传；React 18 里 `ref` 不进 props，这么写的组件**会把 ref 静默丢掉**
  （生产构建不报警；dev 模式报 `Function components cannot be given refs`）。丢在最要命的地方：
  `PopoverTrigger` / `DropdownMenuTrigger` / `TooltipTrigger` 用 `asChild` 包我们的 `Button` 时，
  popper 拿不到触发器 ref 就没有锚点，`useFloating` 静默早退，**弹层永远停在未定位的
  `translate(0, -200%)`（跑到视口外）**，顺带被 Radix 内联 `animation: none` 压掉进场动画。
  本次已给 `button.tsx` / `badge.tsx` 加 `forwardRef`；**新拉的组件或新写的可组合组件同样要加**。
  升 React 19 可根治，但那要能回归业务页，目前不具备条件。
  > 2026-09-21 首页补了第三例：**`input.tsx`**。它中招的地方和弹层不一样——不是没锚点，
  > 而是 `inputRef.current?.focus()` 里拿到 `null`，**自动聚焦静默不生效**
  > （dev 报一行 `Function components cannot be given refs`，生产构建里连那行都没有）。
  > **凡是要拿 DOM 节点的调用点，先确认那个组件包了 `forwardRef`**，别照注册表原样抄。
- ⚠️ **Radix 的折叠高度是「展开那一刻量一次」的快照，展开后再长的内容会被静默裁掉。**
  `--radix-collapsible-content-height` 由 `useLayoutEffect` 在 `[open, present]` 变化时量一次，
  **没有 ResizeObserver**；而 `AccordionContent` 的内层 div 是 `h-(--radix-accordion-content-height)`，
  外面套 `overflow-hidden`。实测（2026-09-21）：展开后往里塞一块 200px 的 div，
  内层 `scrollHeight` 108 → 292，而 `height` 仍是写死的 `108px`，塞进去的内容只露出 16px
  ——**不跟高度，也不报错**。所以 `Accordion` / `Collapsible` 里**只能装渲染完就不再变的内容**；
  结果、进度、异步回来的列表这类会长大的东西，用 `Button aria-expanded` + 条件渲染，
  或者把滚动交给内容自己（限高 + `overflow-auto`）。
  设置页的「高级选项」就是被这条否掉的：里面装的正是点了按钮才出现的测试结果。
- 不混用：现有页面的 BEM 全局样式（`src/styles.css`）逐步迁到 Tailwind，迁移完成前
  允许并存，但**新增代码一律写 Tailwind utility + shadcn 组件**，不再往 `styles.css`
  追加新的手写装饰。迁移是单独任务，不在引入 shadcn 这一次里做。
  **迁移已经完成**（2026-09-23 登录 / 注册页是最后一处）：外壳、设置页、首页（2026-09-21）、
  浏览页、导入页含三个页签（2026-09-22）、登录 / 注册页（2026-09-23）。
  那份样式表现在只剩 `:root` / `body` 两条基础声明，**不要再往它里面加东西**——
  它是无层的，加进去会静默盖掉 Tailwind 的 `@layer utilities`。

## 移动端不是适配，是主场

**手机端是这个产品体验最好的一端**——`navigator.share({files})` 能直接把动图分享进微信，桌面端做不到。见 [SPEC §9.2](../../../spec/09-decisions.md)。

所以：**移动优先写样式**，桌面是加宽版本，不是反过来。

触摸目标至少 44×44px。搜索结果卡片在手机上是单手点击的主要目标。

**shadcn 的控件默认全部低于 44**：`Button` / `Input` / `Select` 默认
`h-9`（36px），`size="sm"` 只有 **32px**，`SelectItem`（下拉里那个选项本身）**36px**。
「小号」在触摸目标这件事上不存在——设置页一度打算给表格开例外（行数是个位数），
**实测推翻了**：邀请码的「复制」和用户行的角色选择器正是手机上要用手指点的。
落点是一个常量 **`src/lib/touch.ts` 的 `TOUCH`**
（`min-height` 盖过 `height`，不用改 `size` 变体）。
`SelectItem` 要**单独**带上：它不在触发器那类的覆盖范围里，漏了的表现是
「触发器 44，展开后每行又变回 36」。将来迁其余页面时，这条按页面照搬。

### 44 是给**手指**的：按指针分档（2026-09-22 定案）

上面那条原来是无条件的，于是 1600px 的桌面上每个控件都白扛 12px 的触摸垫。
产品负责人看完成品的一句话定了案：「**所有的标签、按钮都太大了，浏览页的筛选板块是
最佳实例**」——那一栏 163 个 chip、每行复选框、每个下拉全是 44 高，比 shadcn 自己的
`size="sm"` 高出 12px，整栏因此长三成。

闸门是**指针**，不是断点：

| 指针 | `TOUCH` 那半句 | 落到的实际尺寸 |
|---|---|---|
| `pointer: coarse`（手指） | `min-h-11` | **44**，一个字没变 |
| `pointer: fine`（鼠标） | `pointer-fine:min-h-8` | 各控件**自己的** `size` 变体：chip 与 `SelectTrigger size="sm"` 32、`SidebarMenuButton` 与 `SelectItem` 36 |

`min-height` 只抬不压，所以细指针那一档是**把额外加的那 12px 收回去**，不是把控件压成 32。

- **为什么不写 `md:`**：断点按宽度猜指针，两种都猜错——700px 的桌面窗口被当成手机
  （白扛 44），宽屏平板被当成桌面（手指按 32）。`pointer-fine:` 这个变体仓库里早就在用
  （`MemeCard` 的浮层显形就叠在它上面）。
- **用 `pointer-*` 不是 `any-pointer-*`**：后者问「这台机器有没有粗指针」，触屏笔记本
  答「有」，于是每台带触摸屏的桌面都退回 44。主指针才是「你现在拿什么在点」。
- **手写 `min-h-11` 等于绕过闸门**。「可点的一行」现在一律写 `TOUCH`——浏览页筛选栏里
  不受控件管的那四行也是（`BrowseFilters.tsx` 的 `ROW`）。
- **浮层按钮照 `pointer-coarse` 抄**（卡片上的「⋯」与收藏：`size-8 pointer-coarse:size-11`），
  **不要用 `TOUCH`**：`min-h-11` 用在那里会把桌面卡片顶大。
- **栅格里的方形图标按钮照 `size-8 pointer-coarse:size-11` 抄，不能套 `TOUCH`。**
  导入页待上传列表的「移除」就是一条：`min-h-11` 只抬高度，会把 32×32 的方按钮拉成
  32×44 的长方形（`.import__picked-remove` 那条旧 BEM 没有这个问题，因为它压根没写尺寸）。
- **`styles.css` 里已经一条 `min-height: 44px` 都不剩了**（登录页那套 `.auth-form__*` 是
  最后一份，2026-09-23 随该页迁移按这条改掉）。也就是说「按指针分档」这条规则现在**全覆盖**，
  没有例外页——新写一个可点控件时不要以为还有别处也这么写死着。
- 连手机也想再小，改 `lib/touch.ts` 那一行的 `min-h-8` 一个数，别去各调用点散着改。

首页（2026-09-21 迁移）的四处落点，和设置页一样是**各调用点的 `TOUCH`**，
`styles.css` 里那四条 `.search__submit` / `.search__card-action` / `.discover__*` 的
`min-height: 44px` 随迁移一起删了：

| 位置 | 写法 |
|---|---|
| 搜索框、提交按钮（`features/search/SearchBar.tsx`） | `Input` / `Button` 上各带 `TOUCH`；提交按钮另带 `min-w-18`（72px，接旧 `min-width`） |
| 卡片下的发送按钮、错误态的「重试」（`features/search/SearchResults.tsx`） | `cn(TOUCH, …)`，重试那枚另带 `mt-2` |
| 「换一批」、图墙错误态的「重试」、空库态的「去导入几张」（`features/discover/DiscoverWall.tsx`） | `Button` 上带 `TOUCH`；`variant="link"` 那枚也一样 |

> ⚠️ `size="sm"` **在手指那一档不豁免**：重试与「换一批」都是 `size="sm"`（32px），
> 靠 `TOUCH` 的 `min-height` 顶回 44（2026-09-22 之后鼠标那一档就是它自己的 32，
> 见下面那节）。别再给自己找「这个按钮小一号没关系」的理由。

> 2026-09-21 这个常量从 `features/settings/settings-ui.ts` 搬到了 `lib/`：
> 卡片、菜单项、编辑面板、词表 chip 同时要用它，**再抄一份就是第二个落点**，
> 而这份规则的教训正是「散着写会漏」。`settings-ui.ts` 现在只 re-export，
> 设置页那十几处调用一行没动。
>
> 同一轮补上的还有一处**一直在的违规**：编辑面板里的词表 chip 是 `padding: 4px 10px`
> （≈24px），而那条窄屏触摸块只覆盖了菜单项和面板关闭按钮——手机上这一屏标签全都低于 44。
> chip 现在带 `TOUCH`，代价是三个分区变长（面板本来就能滚）。
>
> ⚠️ **浮在图上的按钮按「鼠标 32 / 手指 44」走**（卡片上的「⋯」与收藏，
> `size-8 pointer-coarse:size-11`）。这不是例外松绑，是两个使用场景不同：鼠标那一枚压在
> 160px 宽的瀑布流格子上，44 会把图压掉一块。**新加浮层按钮照这个抄，不要照 `TOUCH` 抄**
> ——`min-h-11` 用在这里会把桌面卡片顶大，而 `max-sm` 那种按宽度分的写法两种都判错
> （700px 的桌面窗口白扛一个 44 的方块，700px 宽的手机反而落不进去）。

**浮层操作器的显形：能 hover 的设备上默认藏起来，鼠标进卡片才显形**（2026-09-21 加，
GPT 图片墙那种）。落点是 `components/MemeCard.tsx` 的 `REVEAL_ON_HOVER`。

要害是**基线必须是「看得见」**，隐藏叠在 `(pointer: fine)` 上：

```ts
'transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover/card:opacity-100'
```

反过来写（基线 `opacity-0` + `hover:opacity-100`）**在触摸设备上就是入口直接消失**——
内建的 `hover` 变体自带 `@media (hover: hover)` 外壳，手机上永远不成立。手机是这个产品的
主场，不能为了一种视觉效果把「⋯」和收藏弄没。判据用 `(pointer: fine)` 而不用动图那句
`(hover: hover)`：判错了的后果不同（「得点一下」vs「入口不见了」），粗指针一律按看得见处理。

三个配套，少一个都出事：

| 配套 | 少了会怎样 |
|---|---|
| `group-focus-within/card:opacity-100` | 键盘焦点落在看不见的按钮上 |
| `has-[[aria-expanded=true]]:opacity-100` | 菜单是 portal 出去的，打开后焦点离开卡片 → 「⋯」淡出、菜单悬空（Radix 打开期间给触发器挂 `aria-expanded`） |
| **角标不跟着藏** | 角标是状态不是操作器，而且是打标列表的全部信息量；它让位的那 48px 也照留，跟着显隐一起变会让角标在鼠标进出时重排 |

`group` 要**具名**（`group/card`）：`ui/sidebar.tsx` 在更高层也挂了 `group`，不具名会被外面那层顺带点亮。

**卡片的浅阴影与 hover 遮罩**（2026-09-21 加）：

- 浅阴影 `shadow-sm`（`0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a`）挂在 `MemeImage`
  的图片框上，**和圆角写在同一个元素上**。挂到外面那层矩形（`MemeCard` 的根，没有圆角）上，
  影子的四角是方的——图是圆的、影是方的。量级跟 `ui/sidebar.tsx` 的浮动侧边栏一致。
  深色模式下这个影子看不出来，属正常（深色底上的黑影子），没做 `dark:` 分支。
- hover 遮罩 `bg-black/20` 压在图上，**基线是「看不见」**，与上面那两枚操作器**相反**。
  判据是同一条——**藏错了会丢什么**：遮罩只是个视觉提示，没有入口可丢，所以可以放心默认不可见；
  操作器藏错了就是入口消失，所以必须默认可见。`group-hover/card` 自带 `@media (hover: hover)`，
  手机上这一层永远不会亮；基线写死可见的话，手机每张图永久蒙着一层灰。
- 遮罩**必须 `pointer-events-none`**：它盖住的正是图片本身，吃掉指针事件等于把动图的
  hover 播放与点按播放一起废掉（角标行是同一条理由）。
- 遮罩的圆角 import 图片框导出的 `IMAGE_RADIUS`，**不自己写**：它是图片框的兄弟节点，
  不在那个 `overflow-hidden` 里，圆角写岔了方角会从圆角外面露出来。

**全站导航的落点**：侧边栏导航项在 `components/AppSidebar.tsx` 的 `NAV_ITEM_SIZE`
（`cn(TOUCH, 'group-data-[collapsible=icon]:min-h-8')`），不在 `styles.css` 里——那套 `.app__nav`
规则随顶部导航一起删了（2026-09-21）。两处容易踩：

- `SidebarMenuButton` 默认 `h-9`（36px），每个新加的菜单项都要自己带上
  `NAV_ITEM_SIZE`，registry 不会替你加。手指那一档由此仍是 44，鼠标那一档是它自己的 36。
- 图标窄栏模式（`data-collapsible=icon`）那半句**不能并进 `TOUCH`**：registry 用 `size-8!`
  把按钮压成 32×32 的方块，而 `min-height` 会盖过 `height`（不同属性，`!important` 管不着），
  少了它按钮变成 32 宽 × 44 高的长条。这个形态在**粗指针下也会出现**（平板横屏 ≥768px
  收成图标栏），那时 `TOUCH` 给的正是 44，所以必须无条件写死。
  手机端拿到的是抽屉里的**展开版**，由 `TOUCH` 保住 44。

**顶栏是吸顶的，它占住的 3.5rem 是一个跨文件的尺寸**（2026-09-21 加）。值只有一个落点：
`src/index.css` 的 `:root` 里 `--app-header-h: 3.5rem`，**不写进 `@theme inline`**
（`inline` 不输出变量，`var()` 会解析成空，同圆角刻度的坑）。现在有这些引用它：

| 引用点 | 写法 |
|---|---|
| 顶栏自己（`App.tsx`） | `h-(--app-header-h)`，另带 `sticky top-0 z-20 bg-background` |
| 浏览页（`routes/browse.tsx`） | md 以上**页面不滚动**：容器 `md:h-[calc(100svh_-_var(--app-header-h))]`，配 `md:-my-6`（抵消外壳 `p-6`）与 `md:py-6`（加回来）；两列各自 `overflow-y-auto`（2026-09-22 第二稿，此前是筛选列 `sticky top-…` + `max-h-[…]`——那条只在结果列比视口高时才钉得住，见该文件头部推导） |
| 三处抽屉（导航抽屉 `ui/sidebar.tsx`、编辑侧边栏 `MemeEditPanel.tsx`、筛选抽屉 `BrowseFilterSheet.tsx`） | **不在这张表里**——它们在 Radix 那层（`z-50`）、压得住顶栏，按注册表原样全高（`inset-y-0`）。2026-09-22 当天曾各写一段 `data-[side=*]:top-(--app-header-h) bottom-0 h-auto`，随顶栏收回 `z-20` 一起删掉了 |
| `SettingsCard`（锚点落点） | `scroll-mt-[calc(var(--app-header-h)_+_1rem)]` |
| `SettingsCard`（锚点落点） | `scroll-mt-[calc(var(--app-header-h)_+_1rem)]` |

**新写任何「贴视口顶边」的 sticky / 锚点 / `scroll-mt`，先减掉这个值。** 漏了不报错：
top 写 0 的元素会滑到顶栏底下（顶栏有实色底，压得住它，只是看不见了），
锚点则会落进顶栏里而 `scrollIntoView()` 照样返回成功。另注：Tailwind 工具类里的
`calc()` 空格要写成 `_`——`calc(var(--x)_+_1rem)`，写成 `+1rem` 会被浏览器整条丢弃。

**顶栏 `z-20`——比卡片浮层高、比 Radix 那层低**（2026-09-22 定：当天先从 `z-10`
抬到 `9999`、又落到 `60`，最后收到 `20`）。
抬起来是因为卡片浮层的角标 /「⋯」/ 收藏也是 `z-10` 且 DOM 更靠后，`SidebarInset` 不构成
层叠上下文，滚动时**卡片浮层会画到顶栏上面**——那是真的会画错，不是观感问题。`20 > 10`，
这条修好了。

**20 只和两个邻居有关**，不是「越大越保险」：卡片浮层与侧边栏是 `z-10` / 轨道 `z-20`
（那条细线与顶栏不相交），Radix 那层是 `z-50`。

⚠️ **上限不是「9999 以下」而是「50 以下」。** 顶栏一旦高过 `z-50`，三处全高抽屉就被它切成
「顶栏 + 抽屉」两条同时在屏幕上——手机端开导航抽屉时还留着一条 56px 的顶栏和一个 ☰，
2026-09-22 产品负责人报的就是这个（「和侧边栏展开有冲突，会一起显示」）。而且那条顶栏
**是假的**：Radix 的模态会给 **`body` 挂 `pointer-events: none`**，在它上面按下命中的是
`SheetOverlay`，效果是**把抽屉关掉**，不是「顶栏还活着、点 ☰ 能开合导航」（绘制与交互
不是一回事）。`60` 那一版为此给三处抽屉各写了 `top-(--app-header-h) bottom-0 h-auto`，
`20` 之后那三段连同它们的推导一起删了。

全屏阅览（`ImageViewer.tsx`）不受影响：`.yarl__portal` 自带 `9999`，**比顶栏大得多**。
（它自己不是最大的那一个了——toast 在 `10000`，见下面「层级」。）

## 响应式：按容器分档，不按视口

**视口宽度不等于内容宽度。** 加了侧边导航之后它差了 256px（桌面折叠成图标窄栏时还要再算），
而首页的图墙、结果网格都在内容列里。旧 CSS 的断点绑在视口上，768–1150px 视口下每格只剩
120–140px，**低于这条规则自己写的 160px 底线，而媒体查询在那个区间不触发**（侧边导航那次
发现，首页迁移时把最后两处也换掉了）。

写法（Tailwind v4，本仓**零先例**，2026-09-21 起）：

```
容器那一层：  className="@container …"          → container-type: inline-size
档位：        @max-[900px]:grid-cols-3          → @container (width < 900px)
```

`DiscoverWall.tsx` 的 `WALL_GRID` 是范本。两个坑：

- **`@max-[900px]:` 生成的是 `<`，不是 `≤`**——与 CSS 的 `max-width: 900px` **只在恰好等于
  900.00 那一刻不同**。布局宽度几乎取不到整数值，不做小数补偿，但改这两档时要知道有这笔账。
- **`@container` 那个类删了不报错，下面所有档位查询一起静默失效**（图墙永远 5 列，
  手机上一格 70px）。它必须落在**既是容器、又真的包住网格**的那一层，别挂在无关的父节点上。

多档之间的先后顺序由**值本身**决定（900 那条一定排在 640 之前，与写的先后无关），
已核对产物 CSS。改完的判据是**实测列数**，不是读代码：首页图墙在容器 1152 / 976px 时 5 列、
796 / 696px 时 3 列、596 / 496px 时 2 列。

**窄屏只降列数、不降张数**：少给几张等于让「换一批」在更小的池子里换，和这个按钮的用途正好相反。

## 自动聚焦：只在精确指针设备上做

**`autoFocus` 属性不要用在手机上。** 首页的搜索框一直带 `autoFocus`（为了「打开就能打字」），
在随机图墙出现之后它变成：**一进首页就弹键盘，把下半屏整个盖住**——而图墙正是「不知道要找什么」
时唯一的入口，手机又是这个产品的主场。

判据按**输入方式**分流，不按屏幕宽度：

```ts
useEffect(() => {
  if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus()
}, [])
```

桌面保留「打开就能打字」（这是搜索页存在的理由），触摸设备不抢焦点——要搜的时候手指本来就在屏幕上。
与卡片浮层用的是同一条判据（`pointer: fine`），问的都是「有没有一个精确指针」。
**用 effect 而不是 `autoFocus` 属性**：属性没法带条件。（也因此 `Input` 必须包 `forwardRef`，见上。）

> 2026-09-23 起这不是搜索页一处的写法了：登录 / 注册页的**用户名框**同样按这条来
> （`features/auth/LoginForm.tsx`）。它的收益和搜索页无关——手机上抢焦点会弹起软键盘，
> 把提交按钮一起盖住。

## 图片网格

列表用缩略图，**不加载原图**。一屏几十张原图会把流量打爆。

网格必须处理三件事：

| 情况 | 做法 |
|---|---|
| 图片尺寸各异 | 固定宽高比容器 + `object-fit: contain`，不裁剪 |
| 加载中 | 骨架占位，**尺寸从 `width`/`height` 算**，不留白跳动 |
| 加载失败 | 显示文件名和一个占位符，不显示破图标 |

**不裁剪是有原因的**：表情包的信息经常在边缘（一行小字、一个角标），`cover` 裁掉之后用户认不出这是哪张。

## 动图

列表里的动图**默认不自动播放**，显示首帧 + 一个角标。一屏几十个 GIF 同时播放会让手机发烫、滚动掉帧。

**在能 hover 的设备上 hover 播放，点按一律开全屏**（2026-09-21 改，见下）。
角标是必须的——用户要能一眼看出哪些是动图，因为[它们的发送路径不同](clipboard-share.md)。

触摸设备上**没有「就地播放」这一档**：同一个手势不做两件事，而手机上一格只有 140px，播了也看不清。
播放靠把 `src` 从缩略图换成原图（缩略图是服务端转的静态首帧 WebP），全屏那张用的本来就是原图。

## 全屏阅览

点图片开全屏覆盖层（2026-09-21 加，`components/ImageViewer.tsx`）。**全应用只有一份**，
挂在 `App.tsx` 的 `AppLayout` 里，四页共用。

### 宿主的位置是功能的一部分，不是目录偏好

**不能挂在卡片里。** React 的 portal 事件沿 **React 树**冒泡、不沿 DOM 树，所以阅览器就算
portal 到 `document.body`，只要它的 React 父链经过首页，键盘事件照样冒到首页根 `<section>` 的
`onKeyDown` 上：`Esc` 关不干净（背后的选中态被清掉）、`↑↓` 一边看图一边移动搜索结果、
`Enter` 在阅览器里**发起一次复制 / 下载**。三件都不报错。

挂在 `AppLayout` 里、摆在那条 `Outlet` 链的**祖先**上，`<Lightbox>` 的 React 祖先链就只有外壳。

> 第二重保险是库自己给的：portal 会给 root 的**所有兄弟**挂 `inert` + `aria-hidden`。
> root 是 `document.body` 时那就是 `#root`——整个应用在阅览器开着期间都是 inert。
> **但这条依赖它真的拿到了焦点**，所以进不去就当没有，仍然靠上面那条结构上的隔离。

### 库自带的 CSS 是无层的

`yet-another-react-lightbox/styles.css` **无层**且颜色写死。无层声明压过 Tailwind 的
`@layer utilities`，**在 `.yarl__*` 上写 Tailwind 类是静默失效**。要覆写走它自己的
`--yarl__*` 变量或 `styles` 属性（内联样式赢过无层表），**不往 `styles.css` 追加**。

- `import "yet-another-react-lightbox/styles.css"` 一行就够。**`plugins/zoom.css` 不存在**
  （3.32.2 的 `exports` 只有 `styles` 与 captions / counter / thumbnails 四个），补一行会让构建失败。
- 触摸目标**不用自己调**：关闭按钮 `padding: 8px` + `--yarl__icon_size: 32px` = 48px ≥ 44。
  改它的时候别把图标缩到 28px 以下。
- z-index 不用管：`--yarl__portal_zindex` 默认 `9999`，**比顶栏（`z-20`）大**——
  压过顶栏靠的是差值（两者同值那天靠的是 portal 在 `#root` 之后的 DOM 顺序）。
  本仓没有 z-index 总表，这条只记在 `LightboxViewer.tsx` 的注释里。
  ⚠️ 唯一压在它上面的是 toast（`10000`），那是给阅览器里 `Ctrl+C` 的反馈让的路，见下面「层级」。

### 文案必须本地化，**插件的文案是插件自己那份**

库默认全是英文，`labels` 逐个换掉。单张阅览用不到 `Previous` / `Next`（见下），
但 `{index}` / `{total}` 是模板占位符，**不能翻译掉**。

⚠️ **`Zoom` 插件的两个按钮读的是插件自己的 `labels`，不在顶层那一组里。**
实测踩过：只改顶层的时候，读屏念的是「Zoom in」。**换插件时记得同一条。**

⚠️ **单张阅览必须把这两个按钮拿掉**（2026-09-23 起是 `RENDER_SINGLE` 那一份 `render`）。
库对这两个按钮**无条件渲染**，只有一张图时它们既不是 `disabled` 也没被藏起来——表现是
全屏里左右各挂一个 64×80 的箭头，按下去什么都不发生；而且它们盖住的正好是**唯一能点到的背景**
（左右两条整条占掉，「点背景关闭」几乎点不着）。

⚠️ **反过来，多张时这两个按钮正是要的**（可读名、禁用态、`←→` 联动都是现成的）。
所以 `render` 分成了 `RENDER` / `RENDER_SINGLE` 两份、按 `slides.length > 1` 二选一——
**不是**在 `RENDER` 里放两个恒为 `null` 的键。（`render` 是**浅合并**到库默认值上的，
所以单张那档的写法是「没给这个键」而不是「给个返回 `null` 的」：给了 `() => null`
是把它**藏起来**，不给才是留库的默认实现。）

### 宽屏是左图右栏，窄屏还是底部一条

`lg`（64rem）以上：左边是图，右边一条 22rem 的 `ViewerAside`（标签 + 描述 + 上传者），
底部一条 5.5rem 的缩略图轨道 `ThumbRail`（一格一张，点哪张跳哪张）。以下：图铺满，
信息回到底部那条 `SlideFooter` 浮层。**两套都渲染，靠断点各自显隐**，内容同出
`labelValues`——各写一份的话，将来漏掉的那一维只会在一个版式里消失。

尺寸走 `index.css` 的 `:root` 两个变量 `--viewer-aside-w` / `--viewer-rail-h`（窄屏是 0，
`min-width: 64rem` 那一档才有值）。**必须是变量**：JS 那边要给 YARL 算舞台的宽高，
CSS 那边要用 `w-(--viewer-aside-w)` 给两块浮层量自己的宽高，两边套的得是同一个数。

**让位靠容器的 `width/height`，不是 `padding`。** 这条踩过一次，症状是右栏最右侧一道
竖着的色带：

- `.yarl__container` 的 `overflow: hidden` 裁的是 **padding 盒**，给容器加 padding 等于
  **什么都没裁**——容器还是整屏那么大。而轮播里相邻那几张幻灯片本来就摆在容器外面等着
  滑进来，于是「下一张」的图**穿过**让出来的那条带子（库默认幻灯间隔 30%，1088 宽的舞台上
  下一张从 x=1430 起步，视口到 1440，正好露 10px）。
- 改成 `width/height` 之后容器**就是**舞台：裁剪边界、`containerRect`、图片的 `slideRect`、
  滑动距离全是同一个数，一处不用另配。连带默认的 `toolbar` / 翻页按钮 / `navigationNext`
  位置也都不用挪了（右侧那个让开右栏是靠 `render`，不是靠让位）。
- 代价：**纯黑底是 `.yarl__container` 自己的**（`.yarl__portal` 没有背景），容器一缩小，
  两条带子底下就什么都没有了。所以 `ViewerAside` / `ThumbRail` 要 `fixed`（`absolute`
  会按容器的盒子定位，那就叠到图上去了；`fixed` 的包含块是视口，也**不被祖先的
  `overflow: hidden` 裁**）且**背景不透明**。原先右栏是 `bg-white/[0.04]`（压在纯黑上
  = `#0a0a0a`）——只有 4% 白、96% 透明，上面那道色带正是**透过它**被看见的。
  **加 z-index 治不了这个病**：那道带子本来就在右栏*下面*（`elementFromPoint` 量过）。

### 光标：`cursor-pointer` 得自己写

**Tailwind v4 起不再给 `<button>` 加 `cursor: pointer`**（v3 加、v4 去掉了，preflight 里也没有）。
图片帧现在是个按钮，不写的话鼠标划过去仍是箭头。可点的元素才给 pointer——**失败态的帧不可点，就不给**，
光标是「点了会有事发生」的承诺。

## 状态的视觉表达

| 状态 | 怎么显示 |
|---|---|
| `tagStatus: pending` | 卡片角标「待打标」，不是错误色 |
| `tagStatus: needs_manual` | 角标「需人工」，可点进去补 |
| 搜索 `degraded: true` | 结果区顶部一条提示，**不遮挡结果** |
| 动图 | 角标 |
| 已收藏 | 角标 |

**`pending` 和 `needs_manual` 不用红色。** 它们是正常的中间态，不是故障——[产品明确要求](../../../docs/product.md)没配模型也能导入。用错误色会让用户以为自己做错了什么。

### 文案要有承载物（2026-09-24）

**同一句话，裸铺在页面底色上就是「这一块漏渲染了」。** 首页搜索区这批文案
（`按回车搜索`、降级提示、`搜索理解为：…`、空结果）此前都是裸 `<p>`，现在一律带承载物：

| 文案 | 承载物 |
|---|---|
| 输入后未提交的 `按回车搜索`（`routes/home.tsx`） | 回车键帽 + 细边的 `rounded-full` 胶囊，`w-fit`、`text-xs` |
| 降级提示 / `搜索理解为：…`（`SearchResults.tsx` 的 `NOTICE`） | `rounded-2xl border bg-card px-3 py-2` 面板，`w-fit`，各带一枚图标 |
| 空结果 | 居中的空态块（图标 + 一句话），不是一行浮在空白里的字 |

三条不能随手改的：

- **不用 `Alert`。** 它自带 `role="alert"`，而这几条是状态说明、不是警报（[http.md](http.md) §5）。
  要这个形状就照 `NOTICE` 手写容器，只留与原实现一致的 `role="status"`。
- **底色是 `bg-card`，不是 `bg-muted`。** `text-muted-foreground` 落在 `--muted`
  （浅色 `oklch(0.97)`）上对比度约 **4.3**，低于 4.5；落在 `bg-card` 上就是页面底色：
  浅色 4.7、深色 6.9。这一档差得不多，**肉眼看不出来，只有量才知道**——换底色要重量。
- **提示胶囊不给交互态**（没有 hover、不进 tab 序、不加 `TOUCH`）：它是说明不是按钮，
  长成能点的样子，用户就会去点它。

> 同类的那一处**已经做完了**（2026-09-24）：复制反馈那句 `copyNote.text` 在首页与浏览页
> 各是一行裸文字（`SearchResults.tsx` / `BrowseResults.tsx`）。它现在是右上角 toast
> （`lib/toast.tsx`），两页那两条裸文字连同承载它们的 `copyNote` / `Note` state 一起删掉了。
> 判据见 [feedback.md](feedback.md)。

## 全站提示（toast）

**组件：Sonner**（2026-09-24 引入，`components/ui/sonner.tsx`）。调用一律走 `lib/toast.tsx`，
**不在业务组件里直接 `import { toast } from 'sonner'`**——谁该弹、弹什么、弹多久都收在那里。

位置固定在**右上角**，避开吸顶的 `--app-header-h`（56px）。右上角原本是「导入 N/M」
进度入口，offset 减掉顶栏高度才不压住它。

### 覆写必须走它自己的 CSS 变量，且内联

⚠️ **Sonner 把样式在运行时注入 `head`，而且是无层的**（没有 `@layer`）。无层声明压过
Tailwind 的 `@layer utilities`，所以在 `[data-sonner-toast]` 上写工具类是**静默失效**。
与上面「全屏阅览 / 库自带的 CSS 是无层的」那条一模一样。

颜色 / 圆角因此一律走它的 `--normal-*` / `--error-*` / `--border-radius`，**内联在元素上**：
内联样式无条件赢过无层表，而 `class` 写法则要看注入顺序（不稳）。值取本项目的语义 token，
**不写 HEX**：

| 变量 | 取自 |
|---|---|
| `--normal-bg` / `--normal-border` / `--normal-text` | `--popover` / `--border` / `--popover-foreground` |
| `--error-bg` / `--error-border` / `--error-text` | `--popover` / `--destructive` / `--destructive` |
| `--border-radius` | `--radius-2xl` |

失败态用 `bg-popover + text-destructive`，与 `ui/alert.tsx` 的 destructive 变体同配方，
不另调一套红。**说明行**（`requestId`、降级链接）另有一组坑：sonner 给
`[data-description]` 写死了两组灰色，压它同样要 `!`（`lib/toast.tsx` 记了）。

### 层级 10000：**全站最上面的一层**（2026-09-24 从 `60` 抬上来）

sonner 自带 `z-index: 999999999`，且写在元素自身的无层规则里，普通 class 压不住，
所以用内联 `style` 强制收下来。不收的话「编辑抽屉开着时 toast 在不在上面」没人说得清，
也违反本文件那条「层级只和几个邻居有关，不是越大越保险」。

**抬上去的唯一原因是全屏阅览器里的复制反馈**：此前 `60` 的邻居是 Radix（`50`）与阅览器
（`9999`），而 `.yarl__container` 是**不透明黑底、铺满视口**——阅览器一开，toast 就被整个
盖住，屏幕上什么也没有（降级那条「在新标签页打开原图」的链接同样在黑底下）。阅览器里加上
`Ctrl+C` 之后这一条不能再将就：**没有反馈的复制等于没复制**（[clipboard-share.md](clipboard-share.md) §4.1），
而那句话只从 toast 这一个落点出来（[feedback.md](feedback.md) §4）。

⚠️ **这一档只解决了「看不见」，没有解决「点不到」。** 实测（`verify-viewer-copy-shortcut.mjs`
读像素）：`10000` 之后 toast 确实画在黑底之上，但它的**指针事件仍然收不到**——原因是
YARL 给 `#root` 挂了 `inert`，与层级无关，见下面「已知缺口」。别把这两件事混成一件。

`10000` 是「比那唯一的邻居大一档」，不是随手加大：真正需要压过的只有 `.yarl__portal`
的 `9999`。**新加浮层时先想这一条**：任何要盖住全屏阅览的东西（本仓目前没有第二个）
都得再往上让一格，而 toast 永远在最上面。

### `pointer-events: auto` 不是多余的

Radix 的模态给 `body` 挂 `pointer-events: none`，而 toast 是 `body` 的后代——不显式写回
`auto`，**模态开着时弹的 toast 就点不动**（关闭按钮、降级链接全是死的），而它看着完全正常。
这条不报错。

### ⚠️ toast 的 `<li>` 也带 `data-index`，选择器一律要限定范围

**Sonner 的每条 toast 是一个 `<li data-index="N" tabIndex="0">`**，而 `<Toaster />` 挂在
`Routes` **之前**（`App.tsx`）——于是只要屏幕上有任何一条提示，
`document.querySelector('[data-index="0"]')` 命中的是**那条提示**，不是第一条结果，
而且它真的接得住焦点（`tabIndex: 0`）。

`use-search.ts` 的 `focusResult` 原来就是裸的 `document` 查询：**有提示在屏幕上时，
「按 ↓ 从输入框进结果区」把焦点交给了一条 toast**，键盘用户发现自己哪一格都选不中；
`scrollIntoView` 那行同理（滚到 `position: fixed` 的 toast 上，看不出来）。这一条不报错。

规矩：**凡是按 `[data-index]` 找回结果项的地方，都从一个锚点出发查**——产品代码传
`e.currentTarget`（整页那个 `<section>`），验收脚本用 `[aria-label="搜索结果"]` 打头。
`browse` 那边的 `[data-actions-for]` 不是这套属性，不受影响。

暴露它的是一条**看起来不相关**的断言：`verify-web-interaction-fixes.mjs` 的「1264 档
Esc 取消选中」红了，而没弹过提示的 390 档是绿的——两档的差别只有「前面弹没弹过 toast」。
`verify-toast-feedback.mjs` 现在钉着一条回归闸门，专测这件事故。

### 已知缺口

Radix 模态还给 `#root` 挂 `aria-hidden`，所以**对话框开着时弹的 toast 读屏听不见**。
正因如此表单 / 模态内的保存确认走行内，不走 toast（`feedback.md`）。

**2026-09-24 补：全屏阅览器那一份不是 Radix 干的，是 YARL 干的，而且它多挂一个属性。**

`yet-another-react-lightbox` 进阅览器时遍历 `body` 的子节点（`dist/index.js` 的
`handleEnter`），给除自己 portal 之外的每一个挂 `inert` **和** `aria-hidden="true"`——
`#root` 于是整棵变成 inert。两层后果：

| 属性 | 后果 |
|---|---|
| `aria-hidden="true"` | 读屏听不见（就是上面那句，只是凶手要改口） |
| `inert` | **指针事件也收不到**：toast 上的「关闭提示」按钮、降级提示里那条「在新标签页打开原图」的链接，阅览器开着时全是死的 |

`inert` 这件事特别难查：**它不出现在 `pointer-events` 的计算值里**（读出来还是 `auto`）、
不报错、屏幕上完全正常，而 `elementFromPoint` 会一路回落到 `.yarl__slide`——
**拿命中测试当可见性判据会得出「看不见」这个反的结论**，尽管它就在那儿画着。
验收里那条读像素的断言（`scripts/verify-viewer-copy-shortcut.mjs`）就是为此写的。

Toaster 挂在 `#root` 里（`App.tsx`），所以它的每一条提示都吃这个下场。
移出 `#root` 是唯一的出路，**但只解决一半**：YARL 走的正是「body 的每一个子节点」，
阅览器开着时若已经有一条 toast 在，连新挪出去的 toaster 一起标 inert；要彻底闭合
还得再补一个只清自己那层的观察器。Toaster 是全站唯一的反馈落点（`feedback.md`），
动它值得单开任务——现状由验收里那条**哨兵断言**钉着：`toastInsideInert` 一旦变 `false`
就是有人在修，那条会先红，回来把这里和 [clipboard-share.md](clipboard-share.md) §7 一起改。

**全屏阅览也一样**：`.yarl__portal` 带 `aria-modal`，读屏只读对话框里那棵树，所以阅览器里
按 `Ctrl+C` 弹的「已复制」**看得见、但读屏听不见**。这一档没有行内落点可用（阅览器里没有
表单，也没有别的地方能放一句「已复制」），所以照旧走 toast——同 `LightboxViewer` 里
`.yarl__*` 上写 Tailwind 会静默失效那条一样，属于「知道它这样，写下来别当没有」。

## 深色模式

用 `prefers-color-scheme`，不做手动切换开关。

表情包多数是浅色背景，深色模式下要给图片容器一个浅色底，否则白底图会和背景糊在一起看不出边界。

## 不做的

- 不做页面切换过渡动画，这个工具要快
