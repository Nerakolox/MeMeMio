# 图片左键全屏阅览（`MemeImage` + yet-another-react-lightbox）

**状态**：`done`
**性质**：**web 单端**——不动 `api/`，不动 SPEC，不改任何接口、字段与排序语义。

## 为什么要做

用户 2026-09-21 的要求：「安装一个图片阅览库，修改优化图片承载组件，左键能全屏阅览」。
已确认三项范围：

| 问题 | 选定的 |
|---|---|
| 阅览范围 | **单张**。点哪张看哪张，不做 ←/→ 翻上下一张 |
| 触摸端点按 | **也开全屏**。就地播放 GIF 的行为随之取消——同一个手势不做两件事 |
| 库 | **`yet-another-react-lightbox` 3.32.2**（TS 原生、peer 覆盖 React 18、自带 portal / 焦点陷阱 / Esc、零运行时依赖） |

触发它的是：四个页面（浏览 / 搜索 / 图墙 / 打标列表）里的图最大只有 160–200px，
手机上一格 140px。`styling.md`「图片网格」那条「不裁剪，因为信息常在边缘」恰恰说明
用户需要看清边缘，而当前点上去什么都不会发生——**没有任何放大手段**。

## 做完的标准（验收口径）

- 桌面左键点图 → 覆盖层出现，且 `img.src` 是**原图**（不是缩略图）
- Esc / 点背景 / 下拉 → 都能关
- **首页键盘路径不串台**：阅览器开着时 `Enter` **不产生复制 / 下载**、`↑↓` 不移动搜索结果；
  `Esc` 关掉之后搜索结果的选中态**还在**
- 焦点在关闭后回到那张图的按钮（不是 `body`）
- **四个页面版式零漂移**——帧从 `<div>` 变 `<button>` 是本轮最大的静默风险
- 失败态不可点：打桩 404 的图，帧上是文件名、**没有 `<button>`**
- 触摸 390×844：点按开全屏、阅览器内按钮实测 ≥ 44px
- 类型闸门 `cd web && npm run typecheck`（连带编译 `api/src/`）+ `npm run build`

## 改动清单

| 文件 | 改动 |
|---|---|
| `web/package.json` / `package-lock.json` | 加依赖，**单独一个 `chore` 提交**（`git-and-delivery.md:3`：不混入依赖变更） |
| `web/src/components/ImageViewer.tsx`（新） | `ImageViewerProvider` + `useImageViewer()` + 全应用唯一的 `<Lightbox>` 宿主 |
| `web/src/components/MemeImage.tsx` | 帧元素改 `<button>`、`Enter` 拦截、接 `useImageViewer()`、**删点按播放**、失败态不包按钮、补 `cursor-pointer` |
| `web/src/App.tsx` | `AppLayout` 里挂 provider，包住 `div.flex-1.p-6` |
| `web/agents/rules/styling.md` | 新增「全屏阅览」一节；「动图」一节的「hover / 点击时再播」按新行为改写 |
| `web/agents/rules/project-structure.md` | `components/ImageViewer.tsx` 落地说明（外壳例外的第二条） |

## 四处「写错了不报错」

### 一、阅览器必须挂在**页面子树之外**，否则首页键盘路径被悄悄劫持

`use-search.ts:158-201` 的 `handleKeyDown` 是挂在首页根 `<section>` 上的**一个 React
`onKeyDown`**：`Esc` → 取消选中、`↑↓` → 移动选中、`Enter` → 复制 / 下载。
而 **React 的 portal 事件沿 React 树冒泡，不沿 DOM 树**——阅览器若挂在 `MemeImage` 里，
它 portal 到 `document.body` 之后键盘事件照样冒到那个 `<section>` 上：`Esc` 关不干净、
`↑↓` 一边看图一边移动搜索结果、`Enter` 在阅览器里**发起一次复制 / 下载**。

所以 `ImageViewerProvider` 挂在 `AppLayout` 里、摆在那条 `Outlet` 链的**祖先**上。
不选「在阅览器上补 `stopPropagation`」：synthetic 的 `stopPropagation` 会连带调
`nativeEvent.stopPropagation()`，而 YARL 自己那条 `Esc` 是**原生**监听，很可能被一起掐掉
——那是更隐蔽的坏法。

### 二、图片框从 `<div>` 变 `<button>`，`frameClass()` 必须补 `block`

`<button>` 的 UA 默认是 `inline-block`，而帧自带 `overflow-hidden`，基线取下外边距边缘
（CSS 2.1 §10.8.1），父元素被撑出一段 strut 的下伸部 + 半行距 ≈ **7px**。
后果全是静默的版式漂移，四处一起：浏览页瀑布流整列重排（masonic 量的是真实高度）、
其余三处网格每行长 7px；收藏按钮（`bottom-1.5`）与 hover 遮罩（`inset-0`）相对图片错位。

### 三、搜索页：焦点落在图上的 `Enter` 会**同时**开阅览器和复制

`<button>` 在 Enter 上会派发 `click`，而这个 keydown 同时冒到 section 的 handler
→ `handleActivate(items[selectedIndex])`，**是另一张卡**（`selectedIndex` 默认 0）。
表现是一条复制 / 下载被静默发起。

改法：帧按钮上 `onKeyDown` 拦 `Enter` 并 `stopPropagation`（**不能 `preventDefault`**
——那会连按钮自己的 click 一起掐掉，阅览器就不开了）。

> 同一个隐患**已经存在于收藏按钮**（`MemeCard.tsx:169-183`），只是没人从那里按过 Enter。
> 本轮**不顺手改**（改的是别的任务的验收面），见「不做 / 遗留」。

### 四、Tailwind v4 不再给 `<button>` 加 `cursor: pointer`

v3 加、v4 去掉了（改成跟浏览器默认一致），preflight 里也没有这条。于是帧虽然是个按钮，
鼠标划过去仍是**箭头**——「这里能点」只剩读屏和提示文案在说。要自己写 `cursor-pointer`。

**失败态的帧故意不给**：它不可点，光标是「点了会有事发生」的承诺，空承诺比没承诺更坏。

## 实测回填（web 端验收）

闸门：`npm run typecheck` 干净；`npm run build` 通过（`index-BWahxOXs.css` 113.30 kB，
gzip 18.70 kB；JS 592.59 kB，chunk 体积警告是既有的）。

浏览器：本轮**没有 Playwright**，也**故意不现装**——本仓没有常驻 e2e，而临时装包会让 lockfile
重新解析、漂 `hono` 版本并打断 web↔api 的类型链（那次事故的步骤与正确装法已补进
[git-and-delivery.md](../../agents/rules/git-and-delivery.md) 的「依赖变更」）。改用**零依赖的一次性驱动**：
Node 起一个服务同时供 `web/dist` 与 `/api/v1/*` 打桩，再用 Node 22 内置的 `WebSocket`
通过 CDP 驱动**系统 Chrome**——**不装任何东西，因此不碰 lockfile**。脚本跑完即删。

**49 条断言全部通过，连跑三次。**

| 验什么 | 实测 |
|---|---|
| 左键开覆盖层 | `.yarl__slide_current` 位恰好 1 张图 |
| 用的是**原图** | `img.src` = `/img/m2.svg`（缩略图是 `/img/m2-thumb.svg`） |
| 点背景关闭 | 落点现问 `elementFromPoint`，实测关掉 |
| Esc / 下拉 | Esc 关掉，portal 无残留 |
| **键盘隔离** | 阅览器开着按 `Enter`：对原图的 `fetch` 计数 **0**、无复制反馈；`↑↓` 后搜索结果选中仍是 index 1（改前会被移走） |
| **`Esc` 之后选中态还在** | 选中 index 仍是 1（改前会被首页 handler 清成 -1） |
| 焦点归还 | `document.activeElement` 的可读名是「全屏阅览：描述 2」，**不是 BODY** |
| 背景 inert | `#root` 带 `inert`（`Enter` 那条的第二重保险） |
| z-index | `.yarl__portal` = 9999 |
| `labels` | `["放大","缩小","关闭"]`，**全部含汉字** |
| **版式零漂移** | 四页各量 4 帧：`display` 全是 `block`；父元素高度 − 帧高度**最大 0.02px**、宽度最大 0px |
| 光标 | 四页帧的 `getComputedStyle().cursor` 全是 `pointer` |
| 失败态（打桩 404） | 帧是 `<DIV>`、内含文件名「坏掉的图.png」、**不是 `<button>`**；整页全屏按钮 7 个（8 − 1） |
| 触摸 390×844 | `(pointer: coarse)` 真 / `(hover: hover)` 假；点按开全屏；阅览器内按钮 **48×48**（≥ 44） |
| console | 除**故意打的 404**（失败态那条要靠它）外无错误 / 警告 |

量到的页面各自报地址：`/`、`/?q=cat`、`/browse`、`/import?tab=tag`——**四处都量过**。

> 驱动自身踩的两个坑，记下来免得下次重写：
> ① **YARL 的 carousel 同时渲染 current 与前后两张克隆**（内部 `--yarl__carousel_slides_count: 3`），
> 任何「图在哪 / 背景在哪」的查询都必须锚在 `.yarl__slide_current` 上；直接取第一个
> `.yarl__slide_wrapper` 拿到的是被 `translateX` 移出视口的克隆（实测 `rect.x = -1627`），
> 点它会点在空处、**测出来的是「点背景关不掉」这种假失败**。
> ② 断言函数改成 `async` 之后调用点忘了 `await`，`check()` 在后面的分组名下降落，
> 输出看起来像「几何量错了页」。现在每组都自己报 `location.pathname`。

### 两条实测出来的库行为（都不是设计，是踩到的）

**一、单张时库会渲染两个「按了没反应」的箭头。** `Navigation` 组件对
`buttonPrev` / `buttonNext` 是**无条件渲染**的，没有 `count > 1` 之类的判断；
只有一张图时它们既不是 `disabled` 也没被藏起来（实测 `visibility: visible`、`opacity: 1`、
`64×80`）。更糟的是它们盖住的正好是**唯一能点到的背景**——左右两条整条占掉，
「点背景关闭」在单张时几乎点不着（实测左边缘 6px 是箭头图标、40px 是箭头按钮本身）。
所以 `render={{ buttonPrev: () => null, buttonNext: () => null }}` 是**功能的一部分**，
不是样式偏好。

**二、`Zoom` 插件的文案在插件自己那份 `labels` 里。** 只改顶层那一组时，
放大 / 缩小两个按钮的可读名仍是英文「Zoom in」/「Zoom out」——**这是实测撞出来的**，
不是读文档读到的。已补。

### 顺带确认的一条（原本只是推测）

点开后指针被覆盖层挡住，浏览器自然给网格里的 `<img>` 发 `pointerleave`，
于是**同一张动图不会在网格和全屏里同时解码**。实测：hover 时网格 `src` 是原图，
点开全屏后网格那份自己退回缩略图。**没有为此写任何代码。**

## 不做 / 遗留

| 事项 | 处置 |
|---|---|
| ←/→ 翻上下一张 | 用户选了单张。四页数据形态差异大（浏览页是虚拟化 + 游标追加，只有搜索页是完整有序数组），要做得先开页面级 provider 的任务 |
| Fullscreen API（浏览器真全屏） | iOS Safari 对非视频元素不支持 `requestFullscreen`，而手机是主场。覆盖层已盖满视口 |
| 阅览器里的复制 / 下载 / 分享 | 入口另有落点（搜索结果卡片下、浏览页「⋯」）。塞进去得先定「在阅览器里发出去算谁的」，是产品决定 |
| 说明文字 / 标签 / 张数角标 | YARL 的 Captions / Counter 插件。本轮只做「看清」 |
| **收藏按钮的同款 Enter 隐患** | `MemeCard.tsx:169-183`。焦点在收藏按钮上按 `Enter`，同样会冒到首页那个 handler 上触发一次复制 / 下载。本轮**没有改**——它属于「浏览页图片操作」的验收面，且改法与帧那条不同（那里 `preventDefault` 和 `stopPropagation` 的取舍要重新想一遍）。**记在这里，那件事动到 `MemeCard` 时一起修** |
| 结果项 tab 停靠点 2 → 3 | `ResultItem` 里多了一个真的 `<button>`。方向是对的（图本来就该键盘可达），**不是回归**，记一笔 |
| **shadcn 其余按钮也没有 `cursor: pointer`** | 同一个 Tailwind v4 变更的波及面：`components/ui/button.tsx` 及所有用它拼的按钮，光标都是默认箭头。本轮**只修了图片帧**（用户点到的那处）；全站统一是另一件事，需要一次全局决定（改 `ui/button.tsx` 的基线，还是每处自己写） |
| /ui 加 demo | `/ui` 是 shadcn 组件画廊，`MemeCard` 不是 shadcn 组件；登录门槛用 route 打桩绕过了，不必为它加 |
| `MemeEditPanel` 那个预览 `<img>` | 已归档任务里明确记过「不换成 `MemeImage`」 |
| 真机 | 390×844 是**模拟触屏**，只给几何结论。`closeOnPullDown` 是手机上的主要关闭手势，**真机惯性下拉没验过**。本轮没动 `lib/clipboard.ts`，所以不触 `web/AGENTS.md §6` 那条红线 |

## 沉淀到规则里的两条

- [styling.md](../../web/agents/rules/styling.md)：新增「全屏阅览」一节——宿主的**位置是功能的一部分**
  （React 树 vs DOM 树的 portal 冒泡）、库自带 CSS **无层**且怎么覆写、
  **插件的 `labels` 是插件自己那份**、单张必须 `render` 掉翻页按钮、
  `cursor-pointer` 要自己写（Tailwind v4 去掉了按钮的默认指针）。「动图」一节按新行为改写。
- [project-structure.md](../../web/agents/rules/project-structure.md)：`components/ImageViewer.tsx`
  落地，作为「应用外壳」例外的第二条——理由不是复用次数，是**全应用只能有一份**。
