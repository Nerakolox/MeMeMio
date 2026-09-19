# 浏览页改瀑布流

状态：`done`（web 单端）
开始：2026-09-19

## 为什么要做

浏览页现在是**均匀方形网格**：`.browse__grid` 用 `repeat(auto-fill, minmax(160px, 1fr))`，
每张卡片 `.meme-card__img { aspect-ratio: 1; object-fit: cover }` 把所有图**裁成正方形**。

对一个表情包库，裁方是错的——梗图的意义在画面和文字，裁掉一半经常把字裁没了。
浏览页是用户「翻库找图」的主入口，应该是**瀑布流按自然比例整张展示**，不是方格子。

关键：**这件事不需要动 api，数据已经齐了**——

- `width` / `height` 就在 `Meme` 响应里（SPEC §5.2.6），`serialize/meme.ts` 原样透出，
  瀑布流按自然比例排需要的就是它。
- 卡片渲染的是 `thumbUrl`（长边 400 的 WebP），缩略图用 `fit: 'inside'` 生成
  （`api/src/image/decode.ts:200`），**保持原图比例**，所以按 `width/height` 预占位不会变形。

分页形态**已定**（2026-09-19 与用户确认）：**保留无限滚动**，游标分页原样复用；
不改成「加载更多」按钮，也不做数字页码。所以这是纯 web 本端任务。

## 做完的标准

- [x] 浏览页 `.browse__grid` 由方形网格改为瀑布流，图片按自然宽高比整张展示，**不再裁方**
- [x] 无限滚动照旧：滚到底自动加载下一页，游标 `nextCursor` 追加逻辑不变
- [x] 筛选侧边栏、卡片「⋯」操作（复制/编辑/删除）、收藏、编辑侧边栏全部不动
- [x] **没有布局跳动**：图片加载前就按 `width/height` 占好位（`aspect-ratio`），
      不因图片后到而重排；`width`/`height` 为 `null` 时兜底成正方形，同样不跳
- [x] 搜索页（`/`）与首页图墙的方形网格**保持不变**——本次只改浏览页
- [x] `npm run typecheck` / `npm run build` 通过
- [x] 浏览器实测：桌面 + 390×844，含「滚动到底加载第二页」这一条

## web 端

### 改什么

| 文件 | 改动 |
|---|---|
| `package.json` | 加 masonry 库（见下方「选库」） |
| `src/routes/browse.tsx` | `.browse__grid` 的渲染换成 masonry；哨兵、游标、筛选、操作逻辑都不动 |
| `src/components/MemeCard.tsx` | 图片的 `aspect-ratio:1; object-fit:cover` 改为可传入的比例 / 由调用方决定，或加一个变体；不裁切 |
| `src/styles.css` 或 Tailwind | 卡片图片占位比例的样式，与「裁方」解耦 |

### 必须注意的三件事

1. **`.meme-card__img` 是三个页面共用的**（浏览 / 搜索 / 首页图墙）。裁方行为写在
   这个共享类里。本次**只改浏览页**，所以要么给 MemeCard 加变体/比例 prop，要么在
   浏览页的调用处套一层覆盖样式——**不要让搜索页和首页图墙跟着变成瀑布流**。

2. **占位防跳动是瀑布流的第一要务**。图片晚于布局到达，不占位的话每张图都会在
   `onLoad` 时把下面整列推乱。`width`/`height` 已经能算出比例，`aspect-ratio: W/H`
   先占位；两个字段可能为 `null`（旧数据 / 探测失败），`null` 兜底 `1 / 1`。

3. **瀑布流天然丢「严格新到旧」的行读序**。列按高度均衡分布，最新一张不一定在左上角。
   这是瀑布流的固有属性，不是 bug——**不要为了保序又改回 grid**。追加下一页时已有条目
   可能轻微挪位，同样可接受。

### 选库

推荐 **`masonic`**（jaredlunde）：

- hook 版（`useMasonry`），TS 原生带类型，React 18 兼容，无全局 CSS、可 tree-shake
- 按**实际渲染高度**均衡分列（真瀑布流），ResizeObserver 自适应列数
- 就是为「无限滚动、列表持续增长」这个场景设计的（`overscanBy`、key 化条目）
- 它测量的是渲染后高度，所以第 2 条的 aspect-ratio 占位仍然是必须的——不占位，
  图片加载会触发它重测重排

备选 `react-masonry-css`：更简单，但**按条数分列、不按高度均衡**，一列多塞几张长图
就会明显高低不齐，达不到「瀑布流」的均衡效果。最终选型由 web 执行者定，但要用
「真按高度均衡」的，不要用按数量分的。

### 明确不做

- 搜索页、首页图墙的方形网格
- 「加载更多」按钮、数字页码——无限滚动已定，不动分页形态
- 任何 api / SPEC 改动
- `width`/`height` 为 null 的历史数据回填——兜底比例即可，不去补数据

## web 端验收

（2026-09-19 回填）

### 实现

- 引入 `masonic@4.1.0`；浏览页 `.browse__grid` 换成 `<Masonry>`
  （`columnWidth=160`、`columnGutter=12`、`overscanBy=3`、`itemHeightEstimate=220`），
  按真实渲染高度均衡分列（真瀑布流，不是按条数分）。
- `MemeCard` 新增 `variant: 'square' | 'natural'`（默认 `square`，搜索页/首页图墙不受影响）。
  `natural` 时按 `width/height` 算 `aspect-ratio` 占位、`object-fit: contain` 整张展示；
  `width/height` 为 null 或 ≤0 兜底 `1 / 1`。
- **删除会缩短 `items`，masonic 按 index 缓存位置会错位甚至越界抛错**——删除成功后
  `masonryEpoch + 1` 换 `key` 强制重挂，位置器从零重建。筛选切换走「items → [] → 新 items」，
  中间空态已把 `<Masonry>` 卸载，不参与。
- `BrowseMasonryCell` 是模块级稳定引用：masonic 按 `render` 组件身份 memoize，若每帧现写
  内联箭头函数会把所有可见卡片重挂、打断交互状态。会变的回调放 `data`，key 是 `meme.id`。

### 实测

验证方式：Playwright（`channel: 'chrome'`，系统 Chrome）对替身 api，桌面视口 + 390×844 各跑一遍；
断言脚本一次性、跑完即删（同既往几轮的惯例）。

| 检查项 | 结果 |
|---|---|
| 桌面（宽视口）列数 | 5 列 |
| 390×844 列数 | 2 列 |
| 非方形图整张展示、不裁方 | 20 张里 18 张非方形图按自然比例，`object-fit: contain` |
| 占位 `aspect-ratio` 内联（如 `300 / 800`） | 图片加载前即占位，无跳动 |
| `width/height` 为 null 兜底 | 回落 `1 / 1` |
| 滚动到底加载第二页 | 触发 `cursor=cursor-2` 追加请求，`nextCursor` 逻辑未变 |
| 搜索页 `/` 与首页图墙方形网格 | 未变（`variant` 默认 `square`） |
| 筛选 / ⋯操作 / 收藏 / 编辑侧边栏 | 逻辑未动 |
| 删除后瀑布流不崩 | `masonryEpoch` 重挂生效 |

### 闸门

- `npm run typecheck` ✅ 通过
- `npm run build` ✅ 通过（520 kB chunk 的超限 warning 是既有告警，与本次无关）

### 备注

- 依赖漂移已修：早前 `npm install --no-save playwright` 把 `web/node_modules/hono` 从 4.13.7
  带到 4.13.8（与 api 的类型链冲突，`[GET_MATCH_RESULT]` 缺失导致 `api` 变 `unknown`），
  `npm install` 已把 13 个漂移包恢复成 lock 一致（hono 4.13.7 / rollup 4.63.2）。
- 本次没动复制/分享路径，故按 `web/AGENTS.md §6` 不需要补真机实测；瀑布流仅布局与滚动，
  Playwright 视口验收足够。
