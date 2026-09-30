# PWA：装到主屏、离线起外壳

本端做的是一个**手机 PWA**：装到主屏、独立窗口打开，顺带把静态外壳缓存起来。
Tauri 桌面壳是另一件事（`joint-tasks/2026-09-27-桌面壳与PWA.md`），那个任务一个字节都不碰。

**代码只有四处**，改动前先读对应那份的头注释：

| 文件 | 内容 |
|---|---|
| `public/sw.js` | 缓存策略本体（**策略表与四条硬要求都写在文件头**） |
| `public/manifest.webmanifest` | 装到主屏的清单：`standalone`、图标、`theme_color` |
| `src/lib/pwa.ts` | 注册，**全应用唯一碰 `navigator.serviceWorker` 的地方** |
| `scripts/generate-pwa-icons.mjs` | 图标的一次性光栅化（**脚本不进仓库**，产物进） |

## 三条不能破的

**1. `/api/*` 与 `/auth/*` 一个字节都不进缓存。** 这是安全边界不是性能取舍：缓存了就会
把别的会话的响应、或者过期数据交出去。`fetch` 里那一条 `return`（不 `respondWith`、
不碰 cache）就是它。**SSE 不被拦截、不被缓冲**靠的也是同一条。

**2. 只在生产注册**（`import.meta.env.PROD`）。开发态注册会把 Vite 的 HMR 挡在缓存后面，
症状是「改了代码页面不动」，排查起来很贵——从源头掐掉，别在本地「临时打开测一下」。

**3. 别缓存 HTML 当资源用。** 服务端的 SPA 回退**对任何未命中路径都回一份 200 的
`index.html`**，只看 `response.ok` 会把一份 HTML 当 `.js` 存下来。表现是「某个资源坏了，
而且一直坏」——`sw.js` 的 `isCacheable()` / `contentTypeMatches()` 是这条的机器化形式，
**导航那一档故意不调它们**（外壳本身就是 HTML）。

## 发版时记得的

`SW_VERSION` 是手改的常量，换了它 `activate` 才会清掉旧 cache。**不换的代价是缓存随每次
发版一直涨**（已知放宽：bump 之前旧资源不会被清，只占空间，不影响正确性）。
`index.html` 与那几个固定名字的图标会随发版被覆盖，它们靠这个版本号翻篇。

## 图标与 `theme-color`

底色只能写字面值（JSON / HTML 属性都读不到 token），来源写在
`generate-pwa-icons.mjs` 的文件头，**例外只覆盖「值从哪来」**：改之前先改
`src/index.css` 的 token。细节（为什么 `theme-color` 要两条、maskable 为什么按圆算、
为什么 `apple-touch-icon` 不能透明）见 [styling.md](styling.md)「PWA 的图标与 `theme-color`」。

## 发送那一半不要动

`lib/clipboard.ts` 的分流（触屏 → `navigator.share`、桌面 → 剪贴板 / 下载）**装成 PWA
之后逐字不变**：`touchPrimary()` 判的是 `(pointer: coarse)`，与「在不在独立窗口里」无关。
见 [clipboard-share.md](clipboard-share.md)。验收里有一条专门钉着它。
