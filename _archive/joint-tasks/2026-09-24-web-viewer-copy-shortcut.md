# 全屏阅览里 `Ctrl+C` / `Cmd+C` 复制当前这一张

**状态**：`done`（web 单端；实现、两档浏览器验收与提交都完成，验收见 §4）｜ **性质**：web 单端 ｜ 开于 2026-09-24

契约不变：**一个接口、一行 `spec/` 都没动**。复制 / 分享那三条路径的分流与每一句文案仍由 `lib/clipboard.ts` 一处决定（[SPEC §9.2](../../spec/09-decisions.md) / [clipboard-share.md](../../web/agents/rules/clipboard-share.md)），这次只是给已经存在的那条路径补一个入口。

## 1. 为什么要做

2026-09-24 产品负责人的要求，原文：

> 阅览图片页面 ctrl+c（macos 同理 command+c）要能够复制（调用外面复制按钮同函数就行）

全屏阅览是「聊天到一半切过来找图」这条主路径的终点：图已经放大到眼前了，手却还要移回右上角去点那个复制按钮。卡片上有 `⋯` 菜单、首页有 `↑↓` + `Enter`，唯独这个页面此前一个键盘入口都没有。

「调用外面复制按钮同函数就行」这句是**要求**，不是提示：同一张图在三个地方发出去，不能因为入口不同而分流不同、文案不同。

## 2. 做完的标准

| # | 判据 | 怎么证 |
|---|---|---|
| 1 | 发的是**当前这一张**，不是打开时那张 | 翻到第 2 张（动图）再按，取的原图是 `anim.gif`；翻回第 1 张再按，取的又是 `ok.png` |
| 2 | 与卡片「⋯」菜单**同一个函数**（`sendMeme` → `sendNote` → `notifySend`） | 动图那条落成下载并说「动图写不进剪贴板」，与菜单里那一项同一句话 |
| 3 | `Ctrl+C` 与 `Cmd+C` 都认，且不误触 | `Cmd+C`（CDP `modifiers=4`）单独验一条；`Ctrl+Shift+C`、裸 `c`、`e.repeat` 都不发送 |
| 4 | 反馈**看得见** | 读像素：toast 正中 `255,255,255`，它下面 40px `10,10,10` |
| 5 | 关掉阅览器之后这条路消失 | 宿主是常驻的（`everOpened` 之后不卸载），Esc 之后再按，取图与剪贴板计数都不动 |
| 6 | 触屏那一档走系统分享，不写剪贴板 | 390×844 粗指针档 `navigator.share` 命中，`clipboard.write` 0 次 |

第 2 条与第 6 条是「同函数」这个要求的实际含义：**分流看的是 `isAnimated` 与能力探测，不是看用户按了什么键**。

## 3. web 端

| 文件 | 改了什么 |
|---|---|
| `src/components/LightboxViewer.tsx` | 主改动：`document` 上的 `keydown`、模块级 `sendImage`、`usePrefetchShare(current)`，以及三处注释（层级、为什么挂 `document`、四条 guard 各挡什么） |
| `src/lib/use-prefetch-share.ts` | 签名放开成 `SendTarget \| undefined`：hook 不能条件调用，阅览器关着时它就得自己认下这一档 |
| `src/components/ui/sonner.tsx` | 层级 `60` → `10000`（+ 那段推导与已知缺口） |
| `agents/rules/clipboard-share.md` | §7 补「全屏阅览里 `Ctrl+C`」一小节 |
| `agents/rules/styling.md` | 「层级 10000」、已知缺口两处 |
| `agents/rules/code-style.md` | 无障碍那一行补这个快捷键 |
| `scripts/verify-viewer-copy-shortcut.mjs` | **新增**验收脚本（gitignored，与 `verify-*.mjs` 同批） |
| `scripts/verify-toast-feedback.mjs` | 两处层级断言 `60` → `10000` |

四处取舍，都不是随手写的：

- **监听挂 `document`，不是挂某个元素。** 焦点此刻在 YARL 的容器 / 底部轨道 / 工具栏上，逐个挂会漏；更要紧的是**焦点根本不在页面那棵树里**——阅览器 portal 到 `body`，而页面那侧（`#root`）此刻被 YARL 标了 `inert`（§5 第一条），挂在页面组件上的 `onKeyDown` 收不到任何东西。
- **`preventDefault()` 必须有。** `.yarl__container` 是 `user-select: none`，浏览器默认的「复制选区」没有内容可复制，但会紧接着落一次空内容，和上面那次**异步**写入抢同一个剪贴板。
- **`usePrefetchShare(current)` 不能省。** 触屏那一档要在**渲染时**把原图取好，按键时才来得及同步调 `navigator.share`（理由见 `lib/clipboard.ts` 的 `SharePrefetch`）；卡片菜单那份预取在 `MemeActions` 里，全屏这条路它管不到。
- **toast 抬到 `10000`。** `.yarl__container` 是不透明黑底、铺满视口，`60` 的 toast 在它下面等于**没有反馈**——而没有反馈的复制等于没复制（`clipboard-share.md` §4.1）。这一档只买到「看得见」，没买到「点得到」，见 §5。

顺手修掉的两处字面问题：`sendImage` 里没有 `await` 之外的等待（剪贴板写入要落在用户手势的同步调用栈里）；`useEffect` 的依赖是**当前这一张**（`session.items[session.index]`），翻页只换索引、数组引用不动，所以这个引用是稳的，不会每次渲染重挂监听。

## 4. web 端验收

**结论**：通过。`scripts/verify-viewer-copy-shortcut.mjs` **24/24**（桌面 1264×900 细指针 + 手机 390×844 粗指针两档），另两套回归重跑 **65/65**（`verify-web-interaction-fixes.mjs`）、**37/37**（`verify-toast-feedback.mjs`，含改成 `10000` 的那两条），`npm run typecheck` 与 `npm run build` 均干净。

沿本端既有路径：零依赖 CDP 驱动**系统 Chrome**，替身与验收都走 `127.0.0.1`，没装 Playwright。替身没改，探针（`window.fetch` 包装、`clipboard.write`、`navigator.share`）由 `Page.addScriptToEvaluateOnNewDocument` 注入。

**实测到的关键值**（不是只读文本）

| 断言 | 实测 |
|---|---|
| 静图 `Ctrl+C` → 写剪贴板 | `clipboard.write` 1 次，类型 `["image/png"]` |
| 发的是当前这一张 | 取图序列 `ok.png` →（翻页后）`anim.gif` →（翻回后）`ok.png` |
| 反馈画在阅览器之上 | toast 底 `255,255,255`（亮度 255），其下 40px `10,10,10`（亮度 10） |
| 动图落到下载，不碰剪贴板 | toast「动图写不进剪贴板，已开始下载」，`clipboard.write` 仍是 1 次 |
| 误触不发送 | `Ctrl+Shift+C` 与裸 `c`：取图 2 → 2、剪贴板 1 → 1 |
| 关闭后失效 | Esc 之后再按：取图 3 → 3、剪贴板 2 → 2 |
| 触屏档走分享 | `navigator.share` 1 次（`ok.png`，调用时 `userActivation.isActive === true`），`clipboard.write` 0 次 |
| 全程序 | `Runtime.exceptionThrown` 0 条 |

**没测的（不要读成已测）**

- **真机**：iOS / Android 的分享面板、真实长按/外接键盘，一次都没上过真机；390 档是 Chrome 的触屏仿真。
- **macOS 的 `Cmd+C`**：验的是 CDP 的 `metaKey`（`modifiers=4`），不是在 macOS 上按的。
- **Safari / Firefox**：只在系统 Chrome 里跑过。
- **用户激活那一条**：Chrome 里 CDP 的合成按键会让 `navigator.share` 拿到 `isActive=true`；Safari 的判定更严（`clipboard-share.md` §4.1），真机没验。

## 5. 已知缺口（写下来，不要当成已解决）

- **阅览器里的 toast「看得见、点不到」。** YARL 进阅览器时给 `body` 的每个子节点（除自己的 portal）挂 `inert` **和** `aria-hidden="true"`，Toaster 挂在 `#root` 里——于是「关闭提示」按钮、降级提示里那条「在新标签页打开原图」的链接在阅览器开着时都是死的。**这次没修**：换层级解决不了（`inert` 与 `z-index` 无关），把它移出 `#root` 只解决一半（YARL 走的正是 body 的每一个子节点），彻底闭合要再补一个只清自己那层的观察器，而 Toaster 是全站唯一的反馈落点，动它值得单开任务。完整推导在 [styling.md](../../web/agents/rules/styling.md)「已知缺口」，验收里那条**哨兵断言**钉着现状（`toastInsideInert` 变 `false` 就是有人在修）。对这条路径的实际影响很小：「已复制」那条提示上没有可点的东西。
  ⚠️ 顺带纠正一处记错的账：这条一直写作「Radix 给 `#root` 挂 `aria-hidden`」——全屏阅览器那一份是 **YARL** 干的，而且它多挂了 `inert`。
- **快捷键不可发现**：界面上没有任何提示，也没有 `aria-keyshortcuts`，用户只能从别处知道这件事。要不要在工具栏加个提示，是产品决定，本次没做。
- **`aria-modal` 那一半仍在**：阅览器开着时 toast 对读屏是隐藏的（同上，YARL 的 `aria-hidden`）。
