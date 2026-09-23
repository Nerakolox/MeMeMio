# 复制、下载与分享

> **这是产品的价值所在，也是 Web 形态约束最强的地方。本端最重要的一份规则。**

背景与完整论证见 [SPEC §9.2](../../../spec/09-decisions.md)。

## 1. 能力边界

浏览器的 `ClipboardItem` 规范**只保证** `text/plain`、`text/html`、`image/png` 三种类型。

| 场景 | 能力 | 体验 |
|---|---|---|
| 桌面 · 静态图（PNG/JPG/WebP） | 写入剪贴板 | ✅ 点击即复制，切回微信 Ctrl+V |
| 桌面 · 动图（GIF/APNG） | **写不进剪贴板** | ⚠️ 退化为下载后拖入，或直接拖进聊天窗口 |
| 手机 · 任意格式 | `navigator.share({files})` | ✅ 直接分享到微信，动图也可以 |

**手机端是体验最好的一端**，不是需要适配的次要端。见 [styling.md](styling.md)。

## 2. 分流唯一依据是 `isAnimated`

```tsx
// 动图写不进剪贴板，只能走下载。见 SPEC §9.2
if (meme.isAnimated) return downloadFlow(meme)
```

**不能从 `mime` 推断。** WebP 和 APNG 都可能是动图也可能是静图，`image/webp` 说明不了任何事。服务端已经真的解析过容器了，用它给的答案。

见 [SPEC §5.2.2](../../../spec/05-data-models.md)。

## 3. UI 必须诚实

> ⚠️ **不能让用户点了 GIF 之后发现没反应。**

这是本文存在的全部理由。要求：

- 动图卡片有**明显角标**，在点击之前就能看出来
- 动图的主操作按钮文案是「下载」或「拖到聊天窗口」，**不是「复制」**
- 静图和动图的按钮长得不一样，不是同一个按钮点了之后行为不同

**一个按钮两种行为是最糟糕的设计**——用户会形成「点这个能复制」的预期，然后在某些图上落空，而且不知道为什么。

## 4. 三条路径

### 4.1 桌面静图 → 剪贴板

```
fetch 原图 → 转成 PNG Blob → ClipboardItem → navigator.clipboard.write
```

JPG / WebP 静图**必须先转 PNG**（canvas 转一道），因为规范只保证 `image/png`。

**必须在用户手势的同步调用栈里发起。** Safari 对剪贴板写入的用户激活要求最严格，`await fetch` 之后再 `write` 会失败。用 `ClipboardItem` 接受 Promise 的形式：

```ts
new ClipboardItem({ 'image/png': fetchAsPng(url) })  // 传 Promise，不 await
```

成功后给明确反馈（「已复制」）。**没有反馈的复制等于没复制**——剪贴板是不可见的。

反馈**怎么显示**归 [feedback.md](feedback.md)：2026-09-24 起是右上角 toast（`lib/toast.tsx`
的 `notifySend`），页面里不再有那一行裸文字。文案仍由 `lib/clipboard.ts` 的 `sendNote`
定，两页对同一个动作说同一句话。

⚠️ 那句话**只说「已复制」**。此前是「已复制，去微信 Ctrl+V」，2026-09-24 按产品负责人
的裁定砍掉了后半句：这个产品要发的不只有微信（还有 Telegram / Discord / 钉钉……），
指名一个应用会让用别的人以为没成；而「复制之后粘到哪」是用户本来就知道的事。

### 4.2 桌面动图 → 下载 / 拖拽

主路径是下载到本地再拖进聊天窗口。

拖拽路径（Chrome 的 `DownloadURL` 机制，从网页直接拖进微信）**尚未验证**，见 [SPEC §9.12](../../../spec/09-decisions.md)。验证可行之前不要在 UI 上承诺它。

### 4.3 手机 → 系统分享

```ts
if (navigator.canShare?.({ files: [file] })) {
  await navigator.share({ files: [file] })
}
```

**先 `canShare` 再 `share`。** 不是所有移动浏览器都支持文件分享，不检查会抛异常。

不支持时降级到下载，**不要显示一个点了报错的分享按钮**。

## 5. 能力探测，不做 UA 判断

```ts
// ✗ UA 判断永远追不上现实
if (/iPhone|Android/.test(navigator.userAgent)) { ... }

// ✓ 分享要先过一道「这是触屏优先设备吗」
if (touchPrimary() && navigator.canShare?.({ files: [f] })) { ... }
else if (navigator.clipboard?.write) { ... }
else { downloadFlow() }
```

**这和 [api 端不按 baseUrl 猜供应商](../../../api/agents/rules/ai-providers.md)是同一条原则**：能力靠探测，不靠猜。

**`touchPrimary()` 那一道是 2026-09-24 补上的，不能省。** 桌面 Windows Chrome 的 `navigator.canShare({ files })` 返回 `true`（系统分享面板确实存在），所以只按 `canShare` 分流的话，**桌面静图会走分享路径**——而 §3 要求它的按钮写「复制」、[SPEC §9.2](../../../spec/09-decisions.md) 说桌面主路径是「点一下切回微信 `Ctrl+V`」。**探测顺序不能推翻这两条**，`touchPrimary()` 就是那道闸：

```ts
matchMedia('(pointer: coarse)').matches
```

**它不是 UA 判断**，是和 `prefers-color-scheme` 同类的平台能力查询，符合本节的原则。`lib/clipboard.ts` 里叫 `touchPrimary()`，代码里写了理由。

探测结果决定按钮长什么样，**在渲染时就决定，不是点击后才发现**。

## 6. 失败要有出路

剪贴板写入失败（权限被拒、非安全上下文、Safari 的用户激活判定）时，**自动降级到下载**，并告诉用户发生了什么。

不要只弹一个「复制失败」。用户的目标是把图发出去，复制只是手段——手段失败了就给另一个手段。

## 7. 键盘路径

`↑` `↓` 选择、`Enter` 复制、`Esc` 关闭。

使用场景是「聊天到一半切过来找图」，**快是核心体验**。鼠标操作已经比桌面端慢了，键盘路径不能再丢。

`Enter` 在动图上触发的是下载，不是复制——和点击行为保持一致。

### 全屏阅览里：`Ctrl+C` / `Cmd+C` 复制**当前这一张**

2026-09-24 加（产品负责人提的：阅览器里按下去没反应）。落在
`LightboxViewer.tsx`，**调的是和卡片「⋯」菜单里那一项完全同一个函数**（`sendMeme` →
`sendNote` → `notifySend`）：分流不看「用户按的是不是 Ctrl+C」，看的是 `isAnimated` 与能力
探测，所以动图在它上面同样落到下载、同样说「动图写不进剪贴板」。三条平台也一样——
触屏设备上它走的是系统分享。

四条不能少：`ctrlKey || metaKey`（macOS 是 `Cmd`）、挡掉 `Shift` / `Alt` 组合
（`Ctrl+Shift+C` 是开发者工具）、挡掉 `e.repeat`（按住不放会连着下载好几个文件）、
`preventDefault()`（浏览器默认动作是复制选区，而 `.yarl__container` 是 `user-select: none`，
没东西可复制，不挡的话它会抢在异步写入之前落一次空内容）。

⚠️ **由此把 toast 抬到了 `10000`**（高于阅览器的 `9999`）。这不是顺手的层级调整：
`.yarl__container` 是不透明黑底、铺满视口，toast 在它下面屏幕上什么都没有，
而「已复制」只从 toast 出来——没有反馈的复制等于没复制（§4.1）。见
[styling.md](styling.md)「层级 10000」。

⚠️ **但「看得见」和「点得到」是两件事，这次只解决了前者。** 验收里读像素实测：toast 确实
画在黑底之上（底 `255,255,255`，它下面 40px `10,10,10`），可它的**指针事件仍然收不到**——
YARL 进阅览器时给 `#root` 挂了 `inert`，Toaster 就在里面，于是「关闭提示」按钮、
降级提示里那条「在新标签页打开原图」的链接在阅览器开着时都是死的（`aria-hidden` 那一半
就是一直记着的「读屏听不见」）。换个层级解决不了，移出 `#root` 也只解决一半，推导与后续
写在这里不要重复：[styling.md](styling.md)「已知缺口」。**「已复制」那条本身没有可点的
东西**（只剩一个关闭按钮，4 秒后自己会走），所以这条路径的反馈是够用的——但别顺口说成
「toast 在阅览器上面都是可用的」。

⚠️ 还有一条踩过的坑：**别拿 `elementFromPoint` 判「画没画在上面」。** 上面那个 `inert`
会让命中测试整个跳过 toast，而它照画不误——那条路会得出反的结论。

⚠️ 这条路径靠 `[data-index]` 找结果项，**而 toast 的 `<li>` 也带这个属性**（见
`styling.md`「toast 的 `<li>` 也带 `data-index`」）。选择器必须从结果区那棵子树里查，
裸的 `document.querySelector` 会在有提示时把焦点交给一条 toast。

## 8. 改了这里必须两端实测

桌面和手机行为完全不同，且都无法靠单测覆盖。

交付时说明**在哪些浏览器 / 设备上测了什么**。「本地看起来没问题」不算测过——本地通常是 Chrome 桌面，那恰好是三条路径里限制最少的一条。
