# 样式

## 方案

**样式载体：Tailwind，组件库：shadcn/ui**（2026-09-19 定稿，取代早先「不引入组件库」的决定）。

- 组件从 shadcn 拉进仓库，落在 `src/components/ui/`，底层原语是 Radix。新组件用
  `npx shadcn add` 拿，再按项目约定改，不把它当黑盒依赖。
- 主题是**自调的 shadcn preset `b1VlIttI`**（2026-09-21 换掉 new-york + zinc 默认值），
  颜色/圆角/阴影全部走 `src/index.css` 里的 CSS 变量 token（`--primary` 等 **oklch** 值），
  **组件与页面只引用语义 token，不写死 HEX**。
- **样式载体是 Tailwind v4**（2026-09-21 从 v3.4 迁上来，见[该次任务](../../../joint-tasks/2026-09-21-web-tailwind-v4-radix-luma.md)）。
  没有 `tailwind.config.js`、没有 `postcss.config.js`：主题整块在 `src/index.css` 的
  `@theme inline` 里，构建走 `@tailwindcss/vite`。加 token 就在那两处加，别去找配置文件。
- **token 存完整色值**（`--primary: oklch(0.205 0 0)`），`@theme inline` 用
  `--color-primary: var(--primary)` 映射成工具类。不要写 v3 那套「裸分量 + `<alpha-value>`
  占位符」——那是为了在 v3 里凑出透明度修饰符，v4 原生支持，写成裸分量反而解析不出颜色。
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
- 不混用：现有页面的 BEM 全局样式（`src/styles.css`）逐步迁到 Tailwind，迁移完成前
  允许并存，但**新增代码一律写 Tailwind utility + shadcn 组件**，不再往 `styles.css`
  追加新的手写装饰。迁移是单独任务，不在引入 shadcn 这一次里做。

## 移动端不是适配，是主场

**手机端是这个产品体验最好的一端**——`navigator.share({files})` 能直接把动图分享进微信，桌面端做不到。见 [SPEC §9.2](../../../spec/09-decisions.md)。

所以：**移动优先写样式**，桌面是加宽版本，不是反过来。

触摸目标至少 44×44px。搜索结果卡片在手机上是单手点击的主要目标。

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

hover / 点击时再播。角标是必须的——用户要能一眼看出哪些是动图，因为[它们的发送路径不同](clipboard-share.md)。

## 状态的视觉表达

| 状态 | 怎么显示 |
|---|---|
| `tagStatus: pending` | 卡片角标「待打标」，不是错误色 |
| `tagStatus: needs_manual` | 角标「需人工」，可点进去补 |
| 搜索 `degraded: true` | 结果区顶部一条提示，**不遮挡结果** |
| 动图 | 角标 |
| 已收藏 | 角标 |

**`pending` 和 `needs_manual` 不用红色。** 它们是正常的中间态，不是故障——[产品明确要求](../../../docs/product.md)没配模型也能导入。用错误色会让用户以为自己做错了什么。

## 深色模式

用 `prefers-color-scheme`，不做手动切换开关。

表情包多数是浅色背景，深色模式下要给图片容器一个浅色底，否则白底图会和背景糊在一起看不出边界。

## 不做的

- 不做页面切换过渡动画，这个工具要快
