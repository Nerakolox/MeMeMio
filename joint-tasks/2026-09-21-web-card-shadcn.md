# web 图片承载组件 + ⋯菜单 + 编辑侧边栏（shadcn 化）

**状态**：`done`
**性质**：**web 单端**——不动 `api/`，不动 SPEC，不改任何接口与数据语义。

## 为什么要做

用户 2026-09-21 的要求：「现在来做图片承载组件。编辑菜单到侧边栏全部。要符合现在的 shadcnUI」。
已确认三项范围：**三件一起做**、**卡片四处共用**、**删除二次确认换 `AlertDialog`**。

触发它的是两件已经摆在桌面上的事：

1. **组件库进来了，业务页一个都没用。** 2026-09-21 的 Tailwind v4 + `radix-luma` 迁移把 25 个
   shadcn 组件拉进了仓库，但同一轮顺手把实验性的 `MemeCard` / `MemeImage` 删掉了
   （提交 `f7f6661`，「做错的一版删掉重来」）。四个页面因此退化成裸 `<img>` + 一排绝对定位的角标。
   上次任务「不做」的最后一行的原话是「把视觉重新长回业务页是后续任务」——这就是那一次。

2. **两块骨架期的手写 BEM 覆盖层在解决 Radix 已经做对的问题。**
   `MemeActions` 自己实现弹层（点外关闭、Escape、焦点进出），`MemeEditPanel` 自己实现
   `aside` + 隐形 scrim 且**没有焦点陷阱**，焦点恢复靠调用方在 `routes/browse.tsx` 里
   `document.querySelector` 找回来。它们的几何 / 圆角 / 配色都是 `radix-luma` 之前写的，
   和现在的主题不是一套。

预期结果是四页共用一套卡片，菜单与侧边栏由原语构成，`styles.css` 少掉三块死规则。

## 本任务取代 / 修正了哪些已有记录

- **[图片承载组件](2026-09-19-meme-image-host.md)**（`done`）那个 `MemeImage` 已经被
  `f7f6661` 删掉了。本任务**取代**它，不是重做：那次是按 `new-york` 配色写的 `bg-white` 方框，
  这次按 `radix-luma` 的乘法圆角与 token 重来。
- **[浏览页图片操作](2026-09-19-browse-meme-actions.md)**（跨端，`in_progress`）里的弹层与侧边栏
  是手写版，本任务只换它们的皮，三个接口一个没动。但该任务验收表里
  **「Tab 能依次走完并走得出去」那条断言由本任务的设计变更取代**：`role="menu"` 的键盘契约里
  Tab 被 Radix 直接 `preventDefault`（WAI-ARIA 对菜单的规定），方向键才是选择方式。
  **这不是回归，不要来「修」。**

## 一、这个组件的要害：关闭后约 100ms 才发生的焦点恢复

`react-menu` 把关闭后的焦点恢复挂在菜单 FocusScope 的 `onUnmountAutoFocus` 上，而
`react-focus-scope` 是在 `setTimeout(…, 0)` 里才发那个事件的；内容又是在退场动画跑完后才卸载。
所以「打开菜单 → 点删除 → 确认框拿到焦点」之后**约 100ms**，菜单才卸载并把焦点还回「⋯」。

实测把因果查清了，**结论和一开始的猜测不一样，写进代码注释免得下一个人重查**：

- 模态框的焦点陷阱**会**把焦点拽回去（`handleFocusIn` 对容器外的 `focusin` 直接
  `focus(lastFocusedElement)`）。所以**打开确认框这条路最终状态本来就是对的**——
  把 `MemeActions` 里那句 `preventDefault()` 删掉重跑，
  「点删除 → 300ms 后焦点在取消上」**照样通过**。那条断言不判别这句代码。
- `preventDefault()` 真正兜住的是**点外部关闭**：那里没有任何模态陷阱，用户点的是别处，
  Radix 却会在约 100ms 后把焦点拉回这张卡的「⋯」上。删掉它，这条必挂（加回即过）。

**所以：`onCloseAutoFocus` 里的 `preventDefault()` 不能删，但别拿确认框那条测试判断它有没有用。**

## 二、`Sheet` 没有 Trigger，Radix 不会把焦点还给「⋯」

`DialogContentModal` 的关闭逻辑是 `context.triggerRef.current?.focus()`，而侧边栏是受控打开、
没有 `SheetTrigger` → `triggerRef` 是 null → **什么都不做**。
`routes/browse.tsx` 里那段 rAF 重聚焦因此必须留着（这是手写版唯一做到、Radix 不会代劳的事），
只把选择器改准（`data-actions-trigger`）。它可靠的前提是**侧边栏是模态的**：
打开期间页面滚不动，masonic 不会把那个格子回收掉。

## 三、操作器改成 hover 才显形（2026-09-21 追加，用户要求「优化成 GPT 这种」）

同一轮用户提的第二个要求。**「不展示的阴影」那半问过之后确认是「保持现状」**——
卡片本来就没有阴影和外框（实测 `box-shadow: none`、`border-width: 0`），不需要改。

显隐规则落在 `MemeCard` 的 `REVEAL_ON_HOVER`：能 hover 的设备上「⋯」和收藏默认 `opacity: 0`，
鼠标进卡片显形。**写法上唯一要紧的一件事是基线不能反**：

- 写的是「基线看得见 + 在 `(pointer: fine)` 上叠一层 `opacity-0`」。
- 反过来写（基线 `opacity-0`、`hover:opacity-100`）**在手机上就是入口直接消失**——
  Tailwind 内建的 `hover` 变体自带 `@media (hover: hover)` 外壳（v4 源码里
  `p.nodes=[H("&:hover",[B("@media","(hover: hover)",p.nodes)])]`），手机上永远不成立。
  浏览页的「⋯」是那页唯一的删除 / 编辑 / 发送入口，弄没就是功能没了。
- 判据用 `(pointer: fine)` 而不是 `MemeImage` 播放动图那句 `(hover: hover)`：
  后果不同（「得点一下」vs「入口不见了」），所以问的问题不同。这条差异是**有意**的。

三个配套（每个都验过，见下表）：`group-focus-within/card`（键盘）、
`has-[[aria-expanded=true]]`（菜单 portal 出去后焦点离开卡片，「⋯」会淡出、菜单悬空）、
角标不跟着藏。`group` 用具名 `group/card`，否则会被 `ui/sidebar.tsx` 更高层那个 `group` 顺带点亮。

`OVERLAY_BTN` 的过渡属性从 `transition-colors` 改成一个 `transition-[color,background-color,opacity]`：
tailwind-merge 把 `transition-colors` 和 `transition-opacity` 看作同一组，两个一起给只会留下后一个，
另一个静默失效；一个类覆盖三种属性就没有这个二选一。

## 四、浅阴影 + hover 深色遮罩（2026-09-21 再追加）

用户：「图片承载组件最外层要有浅阴影，hover 要有一层淡淡的深色遮罩」。
这**推翻了同一轮早些时候那个「保持无阴影」的确认**，按新要求做。

- **浅阴影 `shadow-sm`** 挂 `MemeImage` 的图片框（`0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a`，
  量级与 `ui/sidebar.tsx` 的浮动侧边栏一致）。**必须挂在这个有圆角的元素上**：挂到
  `MemeCard` 的根（矩形、无圆角）上，影子的四角就是方的。实测两层都量了：
  框 `border-radius: 18px` + 有影，根 `box-shadow: none`。深色下这影子看不见，属正常，没做 `dark:` 分支。
- **hover 遮罩 `bg-black/20`**（Chrome 算成 `oklab(0 0 0 / 0.2)`）压在图上，`opacity 0 → 100`。
  **基线与操作器相反**：这里默认不可见。判据是同一条——藏错了会丢什么。遮罩没有入口可丢，
  而操作器藏错了就是入口消失（见「三」）。`group-hover/card` 自带 `@media (hover: hover)`，
  所以手机上它永远不亮；基线写死可见的话，手机每张图永久蒙一层灰。
- **遮罩必须 `pointer-events-none`**：它盖住的正是图片，吃掉指针事件就把动图的 hover 播放
  和点按播放一起废了。这条用「hover 遮罩时动图 `src` 有没有从缩略图换成原图」验过（S12）。
- 遮罩的圆角 import 图片框导出的 `IMAGE_RADIUS`，**不自己写第二份**：它是图片框的兄弟节点，
  不在那个 `overflow-hidden` 里，圆角写岔了方角会从圆角外面露出来。这也是本次唯一新增的导出。

## 改了什么

| 文件 | 改动 |
|---|---|
| `components/MemeImage.tsx` | **新**。图片承载层：`square` / `natural` 两种形状、加载骨架、失败兜底文件名、动图 hover·点按播放。框底**写死 `bg-white`**（深色下 `bg-muted` 会让白底表情包和背景糊在一起）。**导出 `IMAGE_RADIUS`**（圆角的唯一落点，卡片那层遮罩要 import 它），框架带 `shadow-sm` 浅阴影 |
| `components/MemeCard.tsx` | **新**。图片 + 角标行 + `actions` 槽 + 收藏。四处共用，**不给 `className` / `role` 透传**——搜索页的 `role="option"` 与选中描边留在那一页的外层 wrapper 上。浮层操作器在能 hover 的设备上默认藏起来（见「三」） |
| `lib/touch.ts` | **新**。`TOUCH` 从 `features/settings/settings-ui.ts` 搬来（re-export 保住设置页十几处调用），卡片 / 菜单 / 面板 / chip 都要用它 |
| `features/manage/MemeActions.tsx` | 重写。手写弹层 → `DropdownMenu` + `AlertDialog`；props 去掉 `busy`、`onDelete` 改成返回 Promise |
| `features/manage/MemeEditPanel.tsx` | 重写外壳。手写 `aside` + 隐形 scrim → `Sheet`；`use-meme-edit.ts` 的逻辑一行没动 |
| `components/VocabPicker.tsx` | 只换样式。chip → `Button`，**选择语义逐字未动**（集合 toggle、按 `options` 序重排、词表外的旧值留在尾部——`use-meme-edit.ts` 的 `sameSet` 依赖那个顺序约定） |
| `routes/browse.tsx` | 换 `MemeCard`；删 `deletingId`；`closeEditor` 的选择器改 `[data-actions-trigger]` |
| `routes/home.tsx` | 搜索结果换 `MemeCard` + `recallBadges`；外层 `role="option"` wrapper 与发送按钮不动 |
| `features/discover/DiscoverWall.tsx` | 换 `MemeCard`（无 `actions`） |
| `features/tagging/TaggingList.tsx` | 换 `MemeCard` |
| `src/styles.css` | 删 `.manage-popover*` / `.manage-panel*` / `.vocab-picker*` / `@media (max-width:640px)` 里那三条 / `.search__result`，1056 → 823 行 |
| `agents/rules/styling.md`、`project-structure.md` | `TOUCH` 换了落点；补 chip 的 44px 违规与「浮层按钮仍走 32/44」的区分 |

## 验收

闸门：`npm run typecheck`（连带编译 `api/src/`）+ `npm run build` 全绿。

浏览器：`vite preview` + **系统 Chrome**（`channel: 'chrome'`）跑一次性脚本，`page.route()` 打桩
`/auth/me` 与 `/memes**`（这验的是几何、焦点与样式，**不是接口联调**），脚本跑完即删、不提交。

三轮：**首轮 40/40**（卡片 / 菜单 / 侧边栏全量）；**追加 hover 显形之后 29/29**，
其中 8 条是新的（下表 H 开头），其余是重跑会被这次改动碰到的那批（菜单几何、触摸目标、
角标让位、焦点三条、搜索页 wrapper）；**再追加阴影与遮罩之后 23/23**（下表 S 开头 18 条
+ 5 条回归：菜单几何、触摸目标、角标让位、搜索页两条）。

| 验的是什么 | 实测值 |
|---|---|
| 菜单 → 确认框：等 300ms（跨过退场动画）后焦点 | 在「取消」上（鼠标路径与键盘路径都是） |
| 确认框打开 300ms 后 | `[data-radix-popper-content-wrapper]` 数 = 0 |
| 关闭后 `body` | `overflow: visible`、`pointerEvents: auto`，与打开前逐字相同（无残留锁） |
| 确认框 Esc 关闭 | 焦点回到那张卡的 `[data-actions-trigger]` |
| DELETE 打桩延迟 700ms | 确认框保持打开、按钮「删除中…」且 `disabled`；落定后关闭、卡片消失、页面可滚 |
| 别人的图（普通成员视角） | 删除项仍在、`aria-disabled="true"`、**没有** `disabled` 属性、原因文案在项内、方向键可达、Enter 不开确认框 |
| 自己的图 | `aria-disabled` 为 `null`（禁用是从数据来的，不是一刀切） |
| **点空白处关闭菜单** | 焦点**不**被抢回「⋯」——这条是 `preventDefault()` 的判别性断言，删掉必挂 |
| 菜单 → 侧边栏：等 300ms 后焦点 | 在面板 body 里（`[role="dialog"]` 内），不是「⋯」也不是 `body` |
| 侧边栏 Esc 关闭 | 120ms 与 620ms 两个时刻焦点都已在「⋯」上（Radix 不代劳，是本页 rAF 做的） |
| 面板 body 滚动 | `scrollHeight 2697 / clientHeight 746`；滚到底后页脚「保存」`bottom = 884 ≤ 900`（`min-h-0` 生效） |
| ARIA | `role="menu"` × 1、`role="menuitem"` × 3、触发器 `aria-expanded="true"` + `aria-haspopup="menu"` |
| 方向键 | 三项都到得了（鼠标打开时初始焦点在菜单内容层上，键盘打开时在第一项） |
| **Tab** | 不移动焦点、也不关菜单（Radix 吞掉，**有意的行为变更**） |
| 菜单几何 @1280 | 右沿与「⋯」差 **0px**、上沿低 **4px**、宽 **208px** |
| 视口底部那张卡的菜单 | `top 692 / bottom 836`（视口 900）→ 完整落在视口内，popper 的碰撞处理真的翻了向 |
| 菜单打开时「⋯」的样式 | `oklab(0 0 0 / 0.85)` 底 + `rgb(255,255,255)` 图标（`ghost` 变体的 `aria-expanded:bg-muted` 被盖住了） |
| 触摸目标 @1280 | 菜单项 `[44,44,44]`；「⋯」32；收藏 32 |
| 触摸目标 @390×844 | 菜单项 `[44,44,44]`；「⋯」44；收藏 44；菜单仍完整落在视口内 |
| 卡片框（浏览页） | `aspect-ratio: 400 / 300`、`object-fit: contain`、框底 `rgb(255,255,255)` |
| 卡片框（深色模式） | 框底仍是 `rgb(255,255,255)` |
| 卡片框（搜索页） | `1 / 1` + `cover` |
| 搜索页选中描边 | 仍在 wrapper 上（`solid 2px`） |
| 角标行让位 | 有「⋯」时带 `right-12`；搜索页没有「⋯」→ **不带**（旧版白留了 48px） |
| 发送按钮文案 | 静图「复制」、动图「下载」（按 `isAnimated` 分流） |
| 面板 chip | 163 个，最小高 **44px**；`aria-pressed` 会翻；未改动时「保存」禁用、改动后可用 |
| `reducedMotion: 'reduce'` 重跑「菜单→确认框」 | 仍通过（退场动画被跳过时卸载时序没变） |
| **H：桌面 1280 未 hover** | 「⋯」`opacity 0`、收藏 `opacity 0`；同卡角标仍是 `1` |
| 「⋯」显形判据（旁观证据） | 桌面 `(pointer: fine)` = true |
| 桌面 hover 卡片 | 两枚都变 `1`；鼠标移开又回到 `0` |
| 菜单打开、鼠标移出卡片后 | 「⋯」保持 `opacity 1`、`role="menu"` 仍在（`has-[[aria-expanded=true]]` 生效） |
| Esc 关菜单后 | 焦点回「⋯」且它可见（`focus-within`） |
| 键盘聚焦「⋯」 | 显形（`focus-within` = true）；Tab 到同卡的收藏仍显形；焦点离开整卡后回 `0` |
| **手机 390×844（`hasTouch`）** | `(pointer: fine)` = **false**、`(hover: hover)` = false，而两枚**都是 `opacity 1`**（无 hover）——这条是这次改动的回归红线 |
| 手机上的尺寸 | 「⋯」44、收藏 44（未受显隐改动影响） |
| 搜索页 | 收藏默认 `0`、hover 后 `1`；无「⋯」→ 照旧不带 `right-12` |
| 卡片外框/阴影（用户问的那半） | `box-shadow: none`、`border-width: 0px`、框底 `rgb(255,255,255)`——**当时是现状即目标，后被「四」推翻** |
| **S：阴影落在哪** | 图片框 `border-radius: 18px` 且带 `0 1px 3px 0 / 0 1px 2px -1px`；**外层根 `box-shadow: none`**（影子不出方角） |
| 遮罩默认态 | `opacity: 0`、`background: oklab(0 0 0 / 0.2)`、`pointer-events: none`、圆角 18px 与图片框一致 |
| hover 卡片 | 遮罩 → `1`；同卡两枚操作器也 → `1` |
| 遮罩的层叠 | 命中测试在「⋯」/收藏的中心拿到的是按钮不是遮罩；遮罩亮着时菜单照常打开 |
| 遮罩不吃指针事件 | hover 时动图的 `src` **确实**从缩略图换成了原图（事件穿透了遮罩） |
| 鼠标移开 | 遮罩回 `0` |
| 具名组 | hover m2 时 m2 遮罩 `1`、m1 遮罩与操作器都还是 `0`（没被外层 `group` 顺带点亮） |
| 手机 390×844 | 遮罩 `0`、操作器 `1`、阴影仍在；**点按之后遮罩仍是 `0`**（点按不等于 hover） |
| 搜索页 | 也有阴影；遮罩默认 `0`、hover → `1`；`1/1` + `cover` 未变 |
| 截图对照（deviceScaleFactor 2） | 静止：白色留边、无操作器、卡片外圈浅影；hover：整张压暗（留边 `#fff → #ccc` 一档）、两枚操作器浮出 |

**反向对照**（证明上面的断言不是白过的）：把 `MemeActions` 里 `onCloseAutoFocus` 的
`preventDefault()` 注释掉重新构建再跑——「菜单→确认框焦点在取消上」**照样通过**（模态陷阱兜住了），
「点空白处关闭后焦点不被抢回」**失败**。加回即全绿。这条对照的结论已写进 `MemeActions.tsx` 的文件头。

### 测不了、要如实说的

- **真机一律没测。** 390×844 的 Playwright 是模拟触屏，只给几何，不给真机结论。没验过：
  iOS Safari 键盘顶起面板 body 之后页脚的位置、真实惯性滚动、真机点按播放动图
  （`(hover: hover)` 是平台能力查询，带触控笔的 Android 可能同时报 true）。
- 打桩的是路由不是接口。三个接口（`PATCH` / `DELETE` / `favorite`）的**联调仍归
  [浏览页图片操作](2026-09-19-browse-meme-actions.md)**。

### 顺带量到的一件事：浏览页卡片上的操作器，键盘几乎走不到

验「键盘聚焦时会不会显形」时发现：第一张卡的「⋯」在 Tab 顺序里排到 **第 220 位左右**
（两次跑分别量到 176 与 220，随瀑布流挂载的格子数浮动），前面全是侧边栏的筛选器。
换句话说在这一页靠按 Tab 去够到卡片操作器是不现实的。

**这不是本次改动造成的**——`opacity` 不影响 Tab 顺序，改之前它同样是第 220 位，
只是一直看得见所以没人注意。但也**不要因为这个把 `group-focus-within` 那层删掉**：
焦点仍然会落到那里（Shift+Tab 往回走、读屏软件跳转、浏览器地址栏补全后回车），
落到一个看不见的按钮上才是真事故。这条留在这里，谁要动浏览页的 Tab 顺序时知道有这么笔账。

## 与计划不一致的两处（计划写错了，按实测改）

1. 计划说 `styles.css` 的 `.search__result` 是死规则、直接删。**它不是死的**——搜索页的 wrapper
   还在用它做「卡片与发送按钮之间的 `gap`」。改法：wrapper 换成 Tailwind `flex flex-col gap-1`，
   然后才删掉那条规则。
2. 计划断言模态框的焦点陷阱「拉不回来」。**源码与实测都相反**，
   见上面「一」——真实机制写进了代码注释。

## 如实说的两个取舍

1. **`square` 变体仍走 `object-cover`（裁剪）**，与 `styling.md`「图片不裁剪」不一致。
   搜索页 / 图墙 / 打标列表三页现状如此，本轮**保持原行为**，不顺手改——改掉会让三页所有非方形图
   变成留边。要不要改由用户定。（浏览页是 `natural` + `contain`，不裁。）
2. **删除项从 `disabled` 改成 `aria-disabled`**：位置不变、仍然点不动，但**方向键能选中它并读出原因**
   （原实现是读不出理由的死链）。代价是点它会保持菜单打开（原实现点不动、原因也读不到）。

## 不做

- 网格布局（`.discover__grid` / `.tagging__grid` / `.search__grid` / `.browse__grid`）——纯布局，本轮不动。
  `.browse__grid` 还被首屏 12 格骨架用着，**不是死规则**。
- `use-meme-edit.ts` 的逻辑（草稿、稀疏 PATCH、不做乐观更新）——只换皮。
- `lib/clipboard.ts` 与发送行为——只消费 `SEND_LABELS` / `detectSendPath` / `SendTarget`。
- 搜索页卡片下面那个「复制 / 下载」按钮（`.search__card-action`）——页面级控件，留 BEM。
- 导入页 `ReviewCard`（并排两张图、`4/3` 容器、null src 文案兜底）——语义不同，不并进 `MemeCard`。
- 编辑面板里的预览图不换 `MemeImage`（要显示原图、无角标、要 `max-h-60` 限高）。
- `src/styles.css` 余下的 BEM 整体迁 Tailwind——`web/AGENTS.md §5` 已写明是单独任务。
