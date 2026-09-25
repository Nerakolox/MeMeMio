# Mememio · web 执行者入口

本目录默认角色为 **web 执行者**：SPA、搜索与发送体验、导入与设置 UI。不修改 `api/` 的实现代码；需要改接口时回到 [总管入口](../AGENTS.md)，按 [SPEC §8](../spec/08-collaboration.md) 走契约先行。

## 1. 开工读取

| 顺序 | 读什么 |
|---|---|
| 1 | [共用规则索引](../agents/rules/INDEX.md) |
| 2 | [本端规则索引](agents/rules/INDEX.md)，按任务类型取正文 |
| 3 | [SPEC 索引](../spec/INDEX.md) 的「按任务读取」表，取相关章节 |
| 4 | [当前任务](../joint-tasks/README.md) |

**不要一次加载全部规则。** 按索引取需要的那几份。

## 2. 本端职责边界

| 归 web | 不归 web |
|---|---|
| 组件、路由、本地状态、样式 | 接口与字段（属 [SPEC](../spec/INDEX.md)） |
| 复制 / 下载 / 分享的分流实现 | `isAnimated` 怎么算出来的（属 api） |
| 导入进度与待确认队列的呈现 | 什么算重复、阈值多少（属 api） |
| 设置页的交互 | 提示文案的内容（属 [SPEC §9.9](../spec/09-decisions.md)，是契约） |

**结果排序不归 web。** 服务端 RRF 融合后的顺序就是最终顺序，客户端不重排、不按 `matchedBy` 加权。

**红线：SPEC 里没有的字段、接口、错误码，一个都不许引进来。** 确实需要，停下来回总管提出，等 SPEC 改好、api 导出类型之后再写；本地实现和 SPEC 对不上，也停下来对齐，不边写边改。

**谁说了算**：`spec/` → [总管入口](../AGENTS.md)与 `../agents/rules/` → 本文件 → `agents/rules/` → 代码。代码与 SPEC 冲突改代码。

## 3. 本端特有的三件事

**能力边界必须诚实。** 浏览器剪贴板只保证 `image/png`，动图写不进去。UI 必须按 `isAnimated` 分流，**不能让用户点了 GIF 之后发现没反应**。见 [clipboard-share.md](agents/rules/clipboard-share.md)。

**导入不弹中途确认框。** 上千张图时每张都弹窗体验会崩掉。近似重复攒进待确认队列，队列只有 1 条时呈现成即时弹窗——**同一个接口，不同的呈现形式**，不为单张上传另做一套。见 [import-ux.md](agents/rules/import-ux.md)。

**设置页的警告文案是契约。** 「你的打标结果会进入公共库」这类文案不能删、不能弱化——它是共享库代价在界面上的唯一体现。见 [settings-ux.md](agents/rules/settings-ux.md)。

## 4. 类型从 api 来

Hono RPC 直接消费 `api` 导出的类型，**没有代码生成步骤，不手写接口类型**。

但**类型只保证形状，SPEC 保证含义**。`tagStatus: string` 编译得过，它必须是 [SPEC §5.2.3](../spec/05-data-models.md) 那四个值之一；`degraded`、`matchedBy`、软删语义都不在类型里。类型检查通过不等于契约遵守。

## 5. 样式

**组件库 shadcn/ui（组件层 `radix-luma`），样式载体 Tailwind v4**，BEM 已全部迁完。新组件从 shadcn 拉、落在 `src/components/ui/`；颜色、圆角、阴影只引用 `src/index.css` 的语义 token，不写死 HEX。选型经过、token 的坑、移动优先、44×44 触摸目标、图片不裁剪、动图不自动播放、深色走 `prefers-color-scheme`，都在 [styling.md](agents/rules/styling.md)（写样式之前读）；后面这几条**不因换组件库而放松**，`src/styles.css` 只剩两条基础声明，不要再往里加。

## 6. 交付

改完说明：本次改了什么、在哪些浏览器 / 设备上实测过、有没有动 SPEC、有没有阻塞。

**动了复制 / 分享路径，必须说明在桌面和手机上各测了什么。** 这条路径是产品的价值所在，且两端行为完全不同，「本地看起来没问题」不算测过。

提交信息里不加 `Co-Authored-By` 或任何 AI / 工具署名行，见 [git-and-delivery.md](../agents/rules/git-and-delivery.md)。
