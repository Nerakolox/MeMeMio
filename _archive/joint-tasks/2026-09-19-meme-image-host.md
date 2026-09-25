# 图片承载组件 MemeImage

状态：`done`（web 单端）
开始：2026-09-19

## 为什么要做

浏览页刚改成瀑布流（[browse-masonry](2026-09-19-browse-masonry.md)），`MemeCard` 里的图片至今
只是一颗裸 `<img>`，`styling.md` 对图片网格 / 动图 / 深色模式写下的承诺大部分没兑现：

| styling.md 要求 | 现状（本任务前） |
|---|---|
| 加载中骨架占位（尺寸从 width/height 算，不留白跳动） | 只有浏览页首屏的网格级骨架（`.meme-card--skeleton`），单张图加载中无骨架 |
| 加载失败显示文件名 + 占位符，不显示破图标 | 无 `onError`，破图标直出 |
| 深色模式下图片容器浅色底 | 无背景，白底图糊进背景 |
| 动图不自动播放，首帧 + 角标，hover/点击再播 | 有「GIF」角标，但播放交互为零 |

把 `<img>` 连同它的完整生命周期抽成 `MemeImage` 组件，`MemeCard` 复用。`MemeCard` 被浏览 / 搜索 /
首页图墙 / 打标列表 4 处共用，抽出来这 4 处一起受益——与 `styling.md`「网格必须处理三件事」是全局要求一致。

## 关键事实（跨端，非显而易见）

`thumbUrl` 是**静态首帧 WebP**：`api/src/image/decode.ts` 的 `toThumbnail` 用
`sharp(bytes).resize(...).webp({quality:80})`，**没传 `animated: true`**；而送 AI 的抽帧路径
（`decode.ts:105`）显式传 `animated: true, page, pages: 1` 才读指定帧。所以「动图不自动播放、显示首帧」
**天然满足**，无需任何代码；「再播」= 交互时把 `src` 从 `thumbUrl` 换成原图 `url`。这是纯 web 本端任务，
不动 api / SPEC。

## 做完的标准

- [x] 新增 `src/components/MemeImage.tsx`：`<img>` 的完整生命周期——按比例占位、加载骨架、失败兜底、深色底、动图播放
- [x] `MemeCard` 的裸 `<img>` 换成 `<MemeImage>`，`variant` 语义不变（`square` 裁方 / `natural` 整张）
- [x] 加载失败显示 `originalFilename`（SPEC §5.2.3 就为这个存的），不显示破图标
- [x] 动图：静态首帧 + hover（桌面）/ 点按（触屏）换成原图播放，`isAnimated` 语义照旧（SPEC §5.2.2）
- [x] 深色模式：图片容器固定浅色底（`bg-white`，非主题 token，不随 `prefers-color-scheme` 翻转）
- [x] 搜索页 / 图墙 / 打标列表方形网格不变（`variant` 默认 `square`）
- [x] `npm run typecheck` / `npm run build` 通过

## web 端

### 改什么

| 文件 | 改动 |
|---|---|
| `src/components/MemeImage.tsx` | **新增**，图片承载组件 |
| `src/components/MemeCard.tsx` | 裸 `<img>` 换 `<MemeImage>`，删 `naturalRatio` 逻辑（迁进 MemeImage） |
| `src/styles.css` | 删死类 `.meme-card__img` / `.meme-card__img--natural`；`.meme-card--skeleton` 保留 |

新组件样式走 Tailwind utility（`styling.md`：新增代码一律 Tailwind），颜色只引用 token / 固定浅色，
不写死 HEX。动图 hover 与点按的分界用 `matchMedia('(hover: hover)')` 能力探测（模块级缓存一次，同
`lib/clipboard.ts` 的 `shareProbe` 思路），不判 UA。

### 明确不做

- 不改 api / SPEC / `lib/clipboard.ts`；`isAnimated`、`thumbUrl` 语义照旧
- 不做 shimmer / 加载过渡动画（`styling.md`「不做花活」）
- 触屏点按播放只做最小 toggle，不额外加播放按钮 / 进度条
- 不迁移其余 BEM 样式到 Tailwind——那是单独任务

## web 端验收

（2026-09-19 回填）

### 实现

- `MemeImage` 状态机 `loading / loaded / error` + 动图 `playing`；占位用内联 `aspect-ratio`
  （数据驱动，没法走 Tailwind），`<img>` 保留 `width`/`height` 属性防 CLS + `loading="lazy"`。
- 失败兜底：`onError` → 显示 `originalFilename`；播放途中原图失败则回退 `playing=false`
  （缩略图本来好好的，不把整卡打成失败态）。
- `MemeCard` 只剩角标 / 收藏 / 操作插槽，图片完全交给 `MemeImage`。

### 实测

验证方式：系统 Chrome headless（`channel: 'chrome'` 等价，直接 `chrome.exe --headless`）对**真 api**；
在 `/ui` 参照页临时挂 4 个 `MemeImage`（真 R2 图 × 2、坏地址 × 1、动图 × 1），DOM dump 断言，跑完即删。

| 检查项 | 结果 |
|---|---|
| 自然比例占位 `aspect-ratio` 内联（如 `1024 / 762`） | ✅ 4 个包装 div 全部正确 |
| 裁方 `aspect-ratio: 1 / 1` + `object-cover` | ✅（square 变体） |
| 自然变体 `object-contain` 整张不裁 | ✅（natural 变体） |
| 坏地址 → 显示文件名兜底、无破图标 | ✅ 输出 `这张图加载失败.png`，且该卡无 `<img>` |
| 编译产物含全部 Tailwind utility（object-contain/cover、bg-white、bg-zinc-200 等） | ✅ |
| 闸门 `npm run typecheck` / `npm run build` | ✅ 通过 |

### 备注

- 未在真机点按动图（本任务不碰复制 / 分享路径，`web/AGENTS.md §6` 不强制；headless 无法模拟 hover / 点按）。
  动图播放的 hover/点按交互留待下次上真机顺手点一下。
- 单张图的**瞬态骨架**（`loading` → 图片到达前）在 DOM dump 里抓不到（图片已加载完），走的是代码路径；
  逻辑即 `status==='loading'` 叠一层 `bg-zinc-200`，容器已按比例占位、无跳动。
