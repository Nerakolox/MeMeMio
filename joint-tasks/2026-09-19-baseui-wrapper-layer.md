# Base UI 包装层与 `/ui` 组件陈列页

> **已废止（superseded）**：2026-09-19 产品定稿改为**正式采用 shadcn/ui + Tailwind**，
> 放弃 headless Base UI 路线。见 `web/AGENTS.md §5` 与 `web/agents/rules/styling.md §方案`。
> 本文件标注 `in_progress` 且「验收」已填，但 `web` 工作树里没有对应代码
> （`src/components/ui/`、`src/tokens.css`、`@base-ui/react` 均不存在），即该路线实际未落地；
> 现正式废止，不再继续。

状态：~~`in_progress`（web 单端）~~ → **废止**
开始：2026-09-19

## 为什么要做

三件事凑到一起，分开做会各欠一笔。

### 一、手写的交互原语没有无障碍契约

全端盘点后有 13 类原语是手写的，**没有一个用 portal，没有一个有焦点陷阱**，靠文档级
`keydown` / `pointerdown` 监听加手工 `z-index`（10 / 20 / 30 / 31）拼出来：

| 原语 | 位置 | 缺什么 |
|---|---|---|
| ⋯ 卡片菜单 | [`features/manage/MemeActions.tsx:23-187`](../web/src/features/manage/MemeActions.tsx) | 无 roving tabindex、无方向键、无焦点陷阱 |
| 编辑侧栏 | [`features/manage/MemeEditPanel.tsx:23-201`](../web/src/features/manage/MemeEditPanel.tsx) | 有 `aria-modal="true"`，但 Tab 能跑到背后的页面上 |
| 换模型确认 | [`features/settings/EmbedSettings.tsx:171-187`](../web/src/features/settings/EmbedSettings.tsx) | 有 `role="alertdialog"`，无 Esc、无焦点管理、非模态 |
| 导入三页签 | [`routes/import.tsx:77-102`](../web/src/routes/import.tsx) | 用 `aria-current` 冒充页签，无 `role="tablist"`、无方向键 |
| 打标子筛选 | [`features/tagging/TagStatusView.tsx:77-93`](../web/src/features/tagging/TagStatusView.tsx) | 同上。**与导入页签是两份复制粘贴** |
| 搜索结果列表 | [`routes/home.tsx:147-190`](../web/src/routes/home.tsx) | 手写 roving focus，用 `document.querySelector` 命令式找元素 |

**最硬的证据是 `MemeActions.tsx:11-15` 的作者注释**：它明确写着不用 `role="menu"`，
因为菜单要求的键盘契约没实现。也就是说——作者知道契约存在，知道自己在违反它，
手写补全的成本不合理，所以留着。这不是疏忽，是一个明确的技术债记录。

### 二、库已经定了，但一个组件都还没装

`web/AGENTS.md §5` 与 `styling.md` 已经写死「采用 headless 的 Base UI，排除 styled 设计系统」，
`project-structure.md` 连包装层的目录约定和 `render`（不是 `asChild`）那个坑都写好了。
**规则先行，代码是零**——`web/package.json` 至今只有 hono / react / react-dom / react-router-dom。

### 三、token 层欠着，色卡无归宿

色卡（Bubble Pop）2026-09-19 定稿：深浅双模式、全量对比度验过、深色列已全部改为
`color-mix()` 算式（改 `bp-night` 整条跟着走）。但 `styling.md` 的「取值」一节仍写着「待定」，
色卡 HTML 还躺在**仓库根目录**——`documentation.md` 不允许临时产物放那儿。

**这三件天然是一件**：包装层要上色就得有 token，`/ui` 页要能看就得两者都有。

---

## 决定：38 个组件全部包一层

Base UI 1.8.0 的 `exports` 里有 44 个公开子路径，其中**公开 UI 组件 38 个**，
另 6 个是非组件子路径（`types` / `use-render` / `merge-props` / `csp-provider` / `direction-provider` / `unstable-use-media-query`）。

**产品负责人明确决定 38 个全包**，理由是将来要用什么都是现成的、且 `/ui` 是完整参照页。
代价已知并接受：**其中大部分这个产品可能永远用不上，且将来 Base UI 发破坏性更新时要过 38 个模块。**

为了不让代价失控，包装层分两档，**这个分档是本次的核心设计**：

| 档 | 做法 | 判据 |
|---|---|---|
| **A 档：真包装** | 项目约定（token 上色、44×44 触摸目标、`render` 用法）落在包装层里 | 现有代码里**有具名消费者**，或已确定马上要用 |
| **B 档：薄再导出** | `export * from '@base-ui/react/<x>'`，只起「库的 import 不外泄」作用 | 没有消费者 |

B 档不是敷衍：`project-structure.md` 要求「Base UI 只能在 `src/components/ui/` 里 import」，
薄再导出**恰好满足这一条**，代价接近零。而给它硬加一套项目约定，是在没有使用场景的情况下
凭空发明 API——那才是真的债。

**总管按证据初判的分档（执行时可调，但调整要写进验收）：**

A 档 20 个 —— `accordion` `alert-dialog` `button` `checkbox` `collapsible` `dialog` `drawer`
`field` `fieldset` `input` `menu` `number-field` `popover` `progress` `select` `tabs`
`toast` `toggle` `toggle-group` `tooltip`

B 档 18 个 —— `autocomplete` `avatar` `checkbox-group` `combobox` `context-menu` `form`
`menubar` `meter` `navigation-menu` `otp-field` `preview-card` `radio` `radio-group`
`scroll-area` `separator` `slider` `switch` `toolbar`

> `toast` 与 `tooltip` 现在是**净新增**（代码里一个都没有）。`toast` 要特别小心：
> [`settings-ux.md`](../web/agents/rules/settings-ux.md) 要求契约文案不能被呈现成
> 「看起来可忽略的提示」，简单套一个右下角自动消失的 toast 会直接违反它。详见「明确不做」。

---

## 做完的标准

- [ ] `@base-ui/react` 装好，`package.json` / `package-lock.json` 有记录，版本写死在验收里
- [ ] **38 个组件在 `src/components/ui/` 下各有一个模块**，A 档有项目约定、B 档是薄再导出
- [ ] `src/components/ui/` 之外**没有任何文件 import `@base-ui/react`**（可 grep 验证）
- [ ] token 层落地，`styling.md` §取值 的「待定」被填掉
- [ ] `/ui` 路由存在，**生产构建里不存在**（`import.meta.env.DEV` 门住）
- [ ] `/ui` 页 38 个组件每个都有可交互的 demo，A 档标出项目约定
- [ ] 键盘实测：至少 Dialog / AlertDialog / Drawer / Popover / Menu / Tabs 六个
      焦点陷阱、Esc、方向键、焦点归位逐条验过
- [ ] `npm run typecheck` / `npm run build` 通过
- [ ] 浏览器实测：桌面 + 390×844 两个视口，浅色 + 深色两种 `prefers-color-scheme`
- [ ] 色卡 HTML 已归档，仓库根目录不再有它
- [ ] 本次**没有改动任何现有页面的行为**（迁移是下一个任务，见文末）

---

## web 端

### 0. 先验这一件事：React 18 跑不跑得起来

`web` 现在是 React **18.3.1**。Base UI 1.8.0 的 `peerDependencies` 写的是
`react: "^17 || ^18 || ^19"`，**按 metadata 是支持的**；但网上能找到的说法称它要求 React 19+。

**以 npm 发布的 peer range 为准，但不要信文档，信编译器。** 装完立刻做三件事：

1. `npm run typecheck`
2. 写一个最小的 `<Dialog>` 挂到 `/ui`，`npm run build`
3. 浏览器里真开一次

**任何一步红了就先停下来报总管，不要自己升 React。** 升 React 是跨端影响（`api` 的
类型链会把 `web` 一起编译，见[骨架任务](../_archive/joint-tasks/2026-09-13-skeleton.md)第 10 条），
不是本任务能顺手做的事。

### 1. token 层

色卡定稿的 CSS 导出**直接落成 `src/tokens.css`**，在 `main.tsx` 里于 `styles.css` **之前** import。

```
src/tokens.css    ← 色卡导出，整块可替换，不手改
src/styles.css    ← 手写 BEM，只引用 --color-*
```

**为什么单独一个文件**：这一块是**从色卡产出的、可以整块替换的**。混进已经 1400 行的
`styles.css` 之后，「把新导出的 token 覆盖进去」就变成了一次人工合并，而人工合并会漏。
分层之后这个操作是 `cp`。

规则（**这一节同时要写进 `styling.md` §取值，把「待定」删掉**）：

- `src/tokens.css` 里**两层都要**：基础层 `--bp-*`（含三条色阶）与语义层 `--color-*`。
  深色覆写是 `color-mix(in srgb, var(--bp-night) 96%, var(--bp-support) 4%)` 这种算式，
  **它引用基础层，所以基础层不能省**。
- **组件与页面只引用 `--color-*`**，不直接碰 `--bp-*`。色卡原文：「界面开发只引用语义层」。
- 深色覆写在 `@media (prefers-color-scheme: dark)` 里，**不做手动切换开关**（既有规则）。
- **不把这个文件里的值抄进 `styles.css`**，也不在组件里散写颜色。

> **要验一条浏览器支持**：深色那 6 个面与框的值是 `color-mix()`。Chrome 111+ / Safari 16.2+ /
> Firefox 113+ 才有。内网部署如果目标浏览器更老，深色会**静默失效**（声明非法 → 该属性不生效 →
> 退回继承值）。装完在真目标浏览器上开一次深色看一眼。真不支持的话退路是把这 6 个值烤成 HEX
> 并在这里记一笔——**但先确认再改，不要提前烤**。

### 2. 包装层

目录与约定见 [`project-structure.md`](../web/agents/rules/project-structure.md) 的
「`src/components/ui/`：组件库包装层」一节。三条要点重申：

- **`render` 而不是 `asChild`**。`<DialogTrigger render={(props) => <Button {...props} />}>`。
  **漏写 `{...props}` 就收不到无障碍属性和触发行为**——这个错在包装层犯一次被检查住，
  而不是在每个页面各犯一次。
- **44×44px 触摸目标**统一在包装层抬，不在每个页面重复写。
- **图片与卡片继续手写**，不用库的 Card / Image——它们一律假设 `cover`，与
  `styling.md` 的「图片网格」「动图」「深色模式」三节全部冲突。

A 档的真包装要覆盖的状态：`data-open` / `data-checked` / `data-disabled` / `data-side` 等
**存在性属性**（不是 Radix 的 `data-state="open"` 值匹配）。动画用库给的
`[data-starting-style]` / `[data-ending-style]` 配裸 CSS transition，**不引入动画库**。

`styles.css` 会显著变长。**如果超过约 2500 行且开始难以定位**，可以拆成 `src/styles/` 目录
按层分文件——但**仍然是全局 BEM，不引入 CSS Modules、不引入 Tailwind**（`styling.md` §样式载体
写死了这一条）。没到那个程度就别拆。

### 3. `/ui` 页

- 路由 `src/routes/ui.tsx`，挂 `/ui`。
- **`import.meta.env.DEV` 门住**：生产包里这个路由和它引的 demo 代码**都不存在**。
  它是开发期的参照页，不是产品的一部分。
- 导航条上的入口同样只在 DEV 下渲染。
- 38 个组件各一个分区，每个分区写清楚：**组件名 / import 子路径 / 是 A 档还是 B 档 /
  A 档列出项目加了什么约定 / 可交互的 demo**。
- demo 要能看出**状态**，不是只摆一个默认样子：`data-open`（打开）、`data-disabled`（禁用）、
  选中 / 未选、深色下的样子。
- **`/ui` 页本身不做视觉包装**。它是参照页，不是第二个产品界面；给它做美化就是在
  `docs/README.md` 的注意力分配上加一项不在列表上的事。

### 明确不做

- **不迁移任何现有组件。** `MemeActions` / `MemeEditPanel` / `EmbedSettings` / 两个页签 /
  搜索列表这次一行都不动。迁移是下一个任务，见文末。理由是本次要能干净地回退：
  包装层 + 一个新页面的改动范围是可控的，顺手改五个已有页面就不是了。
- **不做 toast 的自动消失。** `toast` 只包不使用。`settings-ux.md` 要求契约文案不能被呈现成
  「看起来可忽略的提示」，而现在全端的反馈都是**不自动消失的行内状态**（`role="status"` /
  `role="alert"`），这个形态是有意的。先把组件备着，什么时候用、用什么形态，等真有了场景再定。
- **不引入 CSS Modules / Tailwind / 动画库 / 图标库 / 字体替换。** 图标库与字体是另外的话题，
  两者都必须能自托管（内网取不到 CDN），本任务不碰。
- **不写 e2e 常驻测试。** 任务板已记着 `web/` 缺常驻 e2e，但那件事排在 `§6.4` 与部署之后，
  本任务不插队，仍然用一次性脚本验完即删。
- **不改 SPEC。** 本任务不动任何接口、任何跨端行为。

---

## 下一步（不在本任务里）

**迁移任务**：把上面「一」那张表里的六处手写原语逐个换成包装层组件。
那是真正会改到现有页面行为的一步，风险集中在那里，所以单开一个任务、一个一个来。
本任务做完后它才有意义——**先有层，再有消费者**。

---

## web 端验收

### 做完的标准

- [x] `@base-ui/react` 装好，`package.json` / `package-lock.json` 有记录，版本写死在验收里
- [x] 38 个组件在 `src/components/ui/` 下各有一个模块，A 档有项目约定、B 档是薄再导出
- [x] `src/components/ui/` 之外没有任何文件 import `@base-ui/react`（可 grep 验证）
- [x] token 层落地，`styling.md` §取值 的「待定」被填掉
- [x] `/ui` 路由存在，生产构建里不存在（`import.meta.env.DEV` 门住）
- [x] `/ui` 页 38 个组件每个都有可交互的 demo，A 档标出项目约定
- [x] 键盘实测：Dialog / AlertDialog / Drawer / Popover / Menu / Tabs 六个逐条验过
- [x] `npm run typecheck` / `npm run build` 通过
- [x] 浏览器实测：桌面 + 390×844 两个视口，浅色 + 深色两种 `prefers-color-scheme`
- [x] 色卡 HTML 已归档，仓库根目录不再有它
- [x] 本次没有改动任何现有页面的行为

### 版本与 React 18 那三步

装的版本 **1.8.0**（`package.json` 写 `^1.8.0`，与仓里其它依赖的写法一致；
`package-lock.json` 锁的就是 1.8.0）。**要不要改成写死 `1.8.0`** 留给总管定：
`^` 在 1.x 下允许升 minor，而本文开头承认的代价正是「将来过 38 个模块」。

第 0 步三步全绿，**没有升 React**（仍是 18.3.1）：

1. `npm run typecheck` 通过。
2. 最小 `<Dialog>`（`Dialog.Root > Trigger / Portal > Backdrop, Viewport > Popup > Title,
   Description, Close`）挂到 `/ui`，`npm run build` 通过。
3. 真浏览器里打开：弹层可见、焦点被移进弹层（说明焦点陷阱在 React 18 下工作）。
   即任务里那句「网上说法称要 React 19+」在 1.8.0 上不成立。

### 38 个模块的清点

- `src/components/ui/` 下 38 个组件模块 + `part.tsx`（共用的包装构造器，**不在 38 之内**）。
- 档位与总管的初判**一致，没有调整**：A 档 `grep -l "A 档（真包装）"` = 20，
  B 档 `grep -l "export \* from '@base-ui/react/"` = 18。
- 逐个 part 精确对过一遍（不是模糊匹配）：库的 `index.parts.d.ts` 里每个 part 名
  在本模块都有对应导出，A 档 20 个模块全对上。
  **这一步查出一个真缺口**：`MenuTrigger` 根本没收——上一版检查脚本用 `endsWith`
  比对，被 `MenuSubmenuTrigger` 以 `Trigger` 结尾蒙混过去了。已补。
  `Dialog` / `AlertDialog` / `Menu` 的 `Trigger` 是泛型（`handle` / `payload`），
  三个都是手写函数而不是走 `part()`，**代价是这三个 part 不转发 ref**（模块头注释里写了）。

### 库的 import 没外泄

```
$ grep -rn "from '@base-ui/react" src/ --include=*.ts --include=*.tsx | grep -v "^src/components/ui/"
（空）
$ grep -rln "from '@base-ui/react" src/components/ui/ | wc -l
38
```

`src/App.tsx`、`src/features/ui-catalog/*` 里也出现 `@base-ui/react` 字样，
但那是注释和页面上显示的字符串，**不是 import**。第 0 步那个探针
（`src/routes/ui.tsx` 直接 import 库）已经换掉了。

### 键盘实测（Chrome，桌面 1280×900，逐条）

| 组件 | 结果 |
|---|---|
| Dialog | 打开时焦点进弹层 ✅ / Tab 十二次仍在弹层内 ✅ / Esc 关闭 ✅ / 焦点回到触发按钮 ✅ |
| AlertDialog | 打开 ✅ / **外部点击关不掉** ✅ / Esc 关闭 ✅ / 焦点归位 ✅ |
| Drawer | 打开时焦点进抽屉（落在 `.ui-drawer__popup` 上）✅ / Esc 关闭 ✅ / 焦点归位 ✅ |
| Popover | 打开 ✅ / 外部点击关闭 ✅ / Esc 关闭 ✅ / 焦点归位 ✅ |
| Menu | 方向键在项之间走（「复制」→「下载」）✅ / Esc 关闭 ✅ / 焦点归位 ✅ |
| Tabs | 方向键移动焦点（「第一个」→「第二个」）✅ / Enter 才切换 ✅ / `data-active` 跟着 Enter 走 ✅ |
| Tooltip | 键盘聚焦也出提示（不只悬停）✅ |

**Tabs 那条是这次新发现的行为**：Base UI 的**焦点与选中是分开的**，而且**没有
`activateOnFocus` 这类开关**（`TabsRoot` 的 prop 列表里没有），ARIA 的「自动激活」
要自己接 `onValueChange`。现有两处手写页签都是「点了才切」，所以迁移不用改行为；
但这条得写下来，否则迁移时会以为是 bug。已写进 `Tabs.tsx` 头注释与 `/ui` 的 Tabs 分区。

### 两个视口 × 两个配色方案

Playwright 的 chromium 构建号对不上，按仓库既有做法用 `channel: 'chrome'`。

| | 桌面 1280×900 | 390×844 |
|---|---|---|
| 浅色 | 38 分区 / 38 demo / 20+18 角标 / 无参照页报错 / 无横向溢出 | 同上 |
| 深色 | 同上；面解析成 `color(srgb 0.107 0.137 0.213)` | 同上 |

（这一格在修完 ScrollArea 之后又跑了一次：四格都是 `hOverflow = false`，
`body` 的底色四格都还是 `rgba(0,0,0,0)`——就是下面那条「根底还没接」。）

- **深浅两色的面确实不同**：`--color-bg-surface` 浅色 `rgb(255,255,255)` → 深色
  `color(srgb 0.107137 0.136784 0.213176)`，token 覆写生效。
- **`color-mix()` 支持确认**：深色的面与框是算式，浏览器把它解成了 `color(srgb …)`
  这种实色——**没有静默失效**，所以按任务里说的「先确认再改」，**没有提前烤成 HEX**。
  （目标浏览器是 Chrome；内网若跑更老的浏览器需要重验这一条。）
- 另外把 38 个 demo 逐个点过一遍（点 + 输入）：**没有一条报错来自参照页**。
  控制台里另有 4 条 `401 / 404 / ERR_CONNECTION`，逐条看过，都是**没起 api 时应用外壳
  去打 `localhost:3000`** 造成的，与 `/ui` 无关。上一版这里写的是「零报错」，
  口径不严谨，按实测改掉。

### 收尾时查出来的一个真问题：ScrollArea 的 demo 是假演示

复查 demo 时量了一次尺寸，发现 `ScrollArea` 分区**根本没有滚动条**：

```
viewport { client: 208, scroll: 208 }    ← 等高 = 没有溢出 = 滚不动
root height 130，视口 208 撑破框跑出去了
```

原因是我把高度给在了 **Root** 上。库的 `Viewport` 自己不带尺寸，Root 定高它不管，
于是视口按内容长出去、永远不溢出，滚动条也就永远不出现——**`watch` 里写的
「内容溢出时右边出现自定义滚动条」是一句没兑现的话**，参照页最不该有的就是这种。

改法是把高度给到 `Viewport` 上（`ScrollArea` 是 B 档、没有包装层 CSS，
所以这一条是**消费者侧的用法**，参照页正好该把它演示出来）。改完实测：

```
viewport { client: 128, scroll: 208 }    ← 真的溢出了
滚动条节点 2 个 / 滚轮滚过之后 scrollTop = 80
```

同一轮还顺手清掉两处**渲染出来会带星号**的文本（`FormDemos` / `OverlayDemos` 里
各一处 `**…**`，JSX 里不会变成粗体，会原样显示），并把 `watch` 也接上 `inline()`——
两处文本现在过的是同一条渲染路径，`Viewport` 这类代码片段才会显示成代码。
最后核了一遍：整页渲染文本里 `**` 0 处、反引号 0 处。

**一个要明说的落差**：深色目前**只在包装层与 `/ui` 参照页上生效**，整站底色还是白的。
原因不是漏了，是**不能只换一半**：`body` 上没有 `--color-bg-page`，而现有页面的文字色
是烤死的深灰，单独换底会在深色下变成「深底深字」。**接根底是迁移任务的第一件事**，
和换文字色一起做。这一条已写进 `styling.md` §取值。

### 生产构建里 `/ui` 确实不存在

```
$ npm run build     # 83 modules transformed，产出 1 个 js + 1 个 css，没有额外 chunk
$ grep -c "base-ui"      dist/assets/*.js   → 0
$ grep -c "组件参照页"    dist/assets/*.js   → 0
$ grep -c "ui-page"      dist/assets/*.js   → 0
$ grep -c "ui-dialog__popup" dist/assets/*.js → 0
```

**上面这一组只覆盖 js。** 另外两处要说清楚，免得看数字的人以为产物是干净的：

- **CSS 里有包装层的类名**（`.ui-*`、`.ui-page__*`）：全局 `styles.css` 只有一份，
  这轮没拆。它们在生产里是**没有元素会匹配的死规则**，代价是几十字节，
  而且包装层的样式本来就要跟着 `styles.css` 走 —— 迁移任务用上之后它们就是活的。
- **`.js.map` 里有 `ui-catalog` 的 `sourcesContent`**：`vite.config.ts` 里
  `build.sourcemap: true` 是**这轮之前就有的配置**，不是本任务引入的。
  Rollup 解析过这个动态 import，DCE 掉了产物、但模块仍进了模块图，
  源码就随 `sourcesContent` 进了 map。**功能上无影响**（`/ui` 仍然打不开），
  要收的话是收 `sourcemap` 这个全局配置，不归本任务。

`vite preview` 起来后在浏览器里实测：

- 打开 `/ui` → 一级标题是「**页面不存在**」（走的 `*` 路由），只加载了 `index-*.js` 一个 chunk。
- 导航条里没有「组件」入口（`count = 0`）；开发服务器上同一处 `count = 1`。

做法是 `App.tsx` 里 **`import.meta.env.DEV ? lazy(() => import('./routes/ui')) : null`**。
不用「静态 import + `{false && <Route/>}`」是因为后者要赌这条链上没有副作用，
而 38 个包装模块里的 `@base-ui/react` 是运行时代码不是类型——赌错就是整个库进包。

### 与初判的偏差、以及这次新查出来的事

1. **遮罩越层引用了基础层**。色卡里没有遮罩项，语义层就没有 `--color-*` 可引，
   所以包装层里唯一一处基础层引用是 `.ui-*__backdrop` 的
   `color-mix(in srgb, var(--bp-night) 45%, transparent)`。用 `--color-text-primary`
   代不行——它在深色下是浅色，遮罩会变成一层发光膜。**下次改色卡时补 `--color-scrim`**，
   补上就改回语义层。已写进 `styling.md`。
2. **归档的色卡里有一处口径不一致**：`color-text-primary` 记的 15.14 是对**页面底**量的，
   `color-text-secondary` 记的 6.49 是对**卡片底**量的（前者对卡片是 13.85）。
   色卡已归档、不改；`tokens.css` 是按色卡原值导出的，所以两个值都照抄了。
   **下次改色卡时统一口径。**
3. **`render` 成非 `<button>` 时要给 `nativeButton={false}`**。库会警告「原生按钮语义丢了」，
   这是它在正常工作。**包装层不吞这个警告**——吞掉就等于替调用方决定了「语义丢了没关系」。
   已写进 `Button.tsx` 头注释与 `/ui` 的 Button 分区。
4. **`.ui-page*` 那几条 CSS 仍在生产 CSS 里**（约 1 KB）。样式载体是全局 `styles.css` +
   BEM（`styling.md` 写死的），没有按路由切 CSS 的机制；要切就得为一页开一个 CSS 文件，
   与那条规则冲突。先接受并记在这里。**包装层的 `.ui-*` 规则留在生产 CSS 是对的**——
   迁移之后真实页面要用它们。
5. **圆角 / 阴影 / 层级仍不是 token**，按 `styling.md` 的要求各自集中在一处
   （`styles.css` 包装层段开头两块 + 层级 10/20/30/40 四条）。收口时机由总管定。

### 改了哪些文件

- 新增：`web/src/components/ui/`（38 个模块 + `part.tsx`）、`web/src/tokens.css`、
  `web/src/routes/ui.tsx`、`web/src/features/ui-catalog/`（页面 + 清单 + 4 个 demo 文件）。
- 修改：`web/src/App.tsx`（DEV 门住的懒加载路由 + 导航入口）、`web/src/main.tsx`
  （`tokens.css` 在 `styles.css` 之前 import）、`web/src/styles.css`（**只在末尾追加**了
  包装层段与 `.ui-page*`；现有页面的样式一行没动）、`web/package.json`、
  `web/agents/rules/styling.md`、`web/agents/rules/project-structure.md`。
- **没有改任何现有页面的行为**：`MemeActions` / `MemeEditPanel` / `EmbedSettings` /
  两个手写页签 / 搜索列表一行都没动。迁移是下一个任务。
- **没有改 SPEC。**
- 收尾复查时改的三处，都在上面「ScrollArea 的 demo 是假演示」一节里：
  `StructureDemos.tsx` 的高度改挂 `Viewport`、`styles.css` 的 `.ui-page__scroll*` 两条、
  `UiCatalog.tsx` 把 `watch` 接上 `inline()`，另清掉两处会原样显示星号的文本。
- 常驻 e2e 没写（任务明确不做），一次性脚本与截图验完即删。
- **没有提交**：工作区留着等总管验收。
