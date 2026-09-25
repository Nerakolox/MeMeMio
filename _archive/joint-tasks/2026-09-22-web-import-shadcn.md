# web 导入页（`/import`）迁到 shadcn / Tailwind

**状态**：`done`（2026-09-22，typecheck + build 过，浏览器 35/35 断言过，两档各一遍；
`styles.css` 里 `.import__*` / `.tagging__*` / `.review-card*` 在构建产物中为 0 条）
**性质**：**web 单端**——不动 `api/`，不动 SPEC，不改任何接口与数据语义。

## 为什么要做

用户 2026-09-22 要求：「优化导入页面样式，按照现在的 shadcn UI 样式和他的组件」。

`/import` 是 `styling.md` 里点名剩下的两页之一（另一页是打标页签，同在这一页上）。
这一页的**三个页签**目前全部来自 `styles.css` 的手写 BEM（`.import__*` 第 105–434 行、
`.review-card*` 第 361–434 行、`.tagging__*` 第 436–553 行，**无层** CSS），
与已迁完的外壳 / 设置页 / 首页 / 浏览页「一套界面两种来源」。

用户选择的范围是**整页三个页签**（导入 / 待确认 / 打标），理由是同一页不该有两种来源。

## 本端要改什么

| 文件 | 改什么 |
|---|---|
| `routes/import.tsx` | 外壳 `max-w-6xl` 对齐设置页；三个页签换成 `Tabs`（值仍来自 `?tab=`），计数从「（N）」改成 `Badge` |
| `features/import/FilePicker.tsx` | 拖拽区（虚线框 + 图标）、待上传列表（`ScrollArea` 限高 + 分隔行）、清空 / 开始导入按钮 |
| `features/import/ImportProgress.tsx` | `Progress` 两条（上传 / 处理）+ 分阶段数字 + 状态 `Badge` + `Alert`（配额 / 批次错误）+ 摘要卡 + 失败明细 |
| `features/import/ReviewQueue.tsx` | 加载换成 `Skeleton`、错误换 `Alert`、空态与头部文案排版 |
| `features/import/ReviewCard.tsx` | 一张 `Card`，左右两格用**容器查询**在窄处堆叠（不用 `sm:`：外壳有侧边导航，视口宽度 ≠ 内容宽度） |
| `features/tagging/TagStatusView.tsx` | 子筛选换成 `Tabs`（值仍来自 `?tagStatus=`），汇总错误换 `Alert` |
| `features/tagging/TaggingSummary.tsx` | 计数块 + 「没配模型」提示换 `Alert`（**不是错误色**，契约见 `styling.md`） |
| `features/tagging/TaggingList.tsx` | 网格换 `auto-fill`（**实施时改了做法**，理由见下）、错误换 `Alert`、加载更多换 `Button` |
| `features/tagging/FailureBreakdown.tsx` | 失败分布换带边框的列表块 |
| `src/styles.css` | **删掉** `.import__*` / `.review-card*` / `.tagging__*` 三块（无层，留着会静默盖掉工具类） |
| `agents/rules/styling.md` | 迁移进度那一行更新 |

## 行为变化（有意的，逐条记）

1. **触摸目标按指针分档**（`lib/touch.ts` 的 `TOUCH`）：这一页原来是无条件的
   `min-height: 44px`。鼠标那一档收回到各控件自己的尺寸，手指那一档一个字没变。
2. **待上传列表限高**：上千个文件原来会把页面拉成几万像素；现在 `ScrollArea` 限高、
   内部滚。条目本身仍然全渲染（虚拟化不在这次范围内）。
3. **导入进度列表同样限高**，理由同上。
4. **单文件状态带上颜色区分**（`Badge`）：原来 `.import__item-state--<state>` 这些类在
   CSS 里根本不存在，六个状态长得一模一样。现在 `failed` 是 destructive、其余是中性色
   ——`needs_review` **仍然不用错误色**（`styling.md`「状态的视觉表达」）。
5. **页签计数从「待确认（3）」变成「待确认 + 数字徽标」**，数字为 0 时仍然不显示。
6. **`ReviewCard` 的左右两格按容器宽度堆叠**，不再是 `@media (max-width: 640px)`。
7. **失败明细、待上传列表、进度列表的空 / 加载 / 错误三态用统一的 shadcn 组件**，
   断网文案沿用 `toStateError` 的「连不上服务端，确认 api 是否已启动」。

## 实施时偏离计划的一处

**`TaggingList` 的网格改用 `grid-cols-[repeat(auto-fill,minmax(160px,1fr))]`，没照
`DiscoverWall` 的 `WALL_GRID` 写三档 `@max-[…]:` 容器查询。**

计划里写的是「照 `WALL_GRID`」，但那两处要的不是同一件事：`WALL_GRID` 是三档写死的列数，
因为首页图墙的「一屏 10 张」把列数和张数捆在一起；打标列表是个清点用的列表，
一行 4 张还是 5 张都行，要的只是「列数跟着容器宽度走」。`auto-fill` 让浏览器直接算，
少一层 `@container` 类——也就没有「那个类被删掉、下面几档一起静默失效」的坑。
`minmax(160px,1fr)` 这条底线与首页 / 浏览页一致，没有放松。

## 不改的

- 不动 `use-import-queue.ts`（SSE、断线补齐、并发上限、配额处理全在里面，属行为）。
- 不动三个页签与子筛选**放在 URL** 这件事（`?tab=` / `?tagStatus=` 仍可被直接链接）。
- 不动 `MemeCard` / `MemeImage` / `ImageViewer`。
- 不引新依赖（不 `npx shadcn add`：那会动 lockfile；需要的组件仓库里都有）。
- 不改任何文案的内容——文案是契约（`settings-ux.md` 那条的精神同样适用于
  「已入库的图会进公共库」这句）。

## 验收

闸门：`cd web && npm run typecheck`、`cd web && npm run build`。

浏览器：零依赖 CDP 驱动系统 Chrome + 打桩 `/api/v1/*`（本仓无常驻 e2e）。

## web 端验收

日期：2026-09-22。全部在 `web/dist`（构建产物）+ 打桩 `/api/v1/*` 上实测，
零依赖 CDP（`headless=new`）驱动系统 Chrome，桩与页面都走 `127.0.0.1`。
打桩覆盖：`/auth/me`、`/memes`（含两段游标）、`/memes/tag-status`、
`/imports`（预签名）、`/imports/{id}/events`（真 SSE：progress / item ×4 / done）、
`/imports/reviews` + 决策 POST。

**档位**：1600×900（细指针）与 390×844（粗指针，靠 `Emulation` 模拟触摸 +
`pointer: coarse`）各一遍。**35 项断言全过**。

### 闸门

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（`noUnusedLocals` 开着，无输出） |
| `npm run build` | 通过，3.51s |
| 构建产物里 `.import__*` / `.tagging__*` / `.review-card*` 选择器 | **0 条**（`grep -c` 于 `dist/assets/*.css`）——无层覆盖确认删干净 |

### 桌面 1600×900（细指针）

| 验的什么 | 实测 |
|---|---|
| 三个页签 + 选中态 + 角标 | `["导入","待确认2","打标2"]`，第一个 `aria-selected=true` |
| 页签高度 | 32（细指针落到自己的尺寸，不扛 44） |
| 落区 | 虚线框、`cursor: pointer`、高 160、圆角 26 |
| 待上传列表 | 4 条，移除按钮 32×32，限高容器 286px（`h-72` 减内边距） |
| 开始导入 | 40×120（`size="lg"` 自己的高度；`min-h` 只抬不压，不会掉到 32） |
| 四格统计 | 已入库1 跳过重复1 待你确认1 失败1，**只有「失败」是错误色** |
| 进度条 | 2 条（上传 / 处理分开） |
| 摘要句 | 逐字对上「已入库 1 张，跳过 1 张完全相同的文件，1 张待你确认，1 张失败。」 |
| 条目状态徽标 | 已入库 secondary / 跳过重复 outline / **待确认 secondary（不是错误色）** / 失败 destructive |
| 失败明细 | `<details>` 标题「失败明细（1）」，1 条 |
| 结论区三个动作 | 查看待确认（1）/ 查看打标状态 / 继续导入 |
| 连接没断 | 不出重连提示 |
| 待确认卡片 | 2 张，左右 **2 列**，Hamming 距离与 `@kim 上传` 都在 |
| 待确认三个按钮 | 36 高、不透明（浮层显隐规则不影响这里） |
| 「仍然导入」 | 真发出 `POST /imports/reviews/b1/cat.png`，列表剩 1 张 |
| 「稍后再说」→「重新展开」 | 出现「这次先不看」，展开后回到 1 张 |
| 汇总五格 | 已完成=32 待打标=7 需人工=2 已拒绝=0 正在打标=1 |
| 「没配模型」提示 | `role="status"`、**无 `text-destructive`**、链接指向 `/settings` |
| 子筛选 | `待打标7` / `需人工2`，默认选待打标，高 32 |
| 打标网格 | 3 张卡、角标「待打标」、1600px 下 6 列 |
| 「加载更多」 | 翻到 5 张，游标用完后按钮消失 |
| 切「需人工」 | URL 变 `?tab=tag&tagStatus=needs_manual`；「1 张连不上模型服务」「2 张打标成功但没算出向量」+ 解释句都在；2 张卡 |
| 配额不足 | 破坏性 `Alert`：「剩余可用空间：1.0 MB」+ `requestId：q-42` |

### 移动 390×844（粗指针）

| 验的什么 | 实测 |
|---|---|
| 指针探针 | `(pointer: coarse)=true`、`(pointer: fine)=false`、`maxTouchPoints=5` |
| 页签 | 三个都 44；**列表容器 52**（`h-auto!` 压住了注册表的 `h-9`，没把触发器裁掉） |
| 子筛选 | 两个都 44 |
| 打标网格 | 2 列、卡片 165px、页面无横向溢出（`scrollWidth 390 = clientWidth 390`） |
| 待确认卡片 | 容器 342px → **1 列**（`@max-[560px]:` 生效），无横向溢出 |
| 待确认三个按钮 | 44 / 44 / 44 |
| 待上传列表的移除按钮 | **44×44**（方的，不是 32×44——`size-8 pointer-coarse:size-11`） |
| 开始导入 | 44×120 |
| 端到端导入到 done | 四格统计出得来，进度区无横向溢出 |
| 页签角标 | 390px 下也在 |

### 已知的、这次没做的

- **`styles.css` 里还剩登录页**（`.auth-page` / `.auth-form__*`，两个路由 `login.tsx` /
  `register.tsx` 共用）——全站最后一处 BEM，迁移是单独任务。
  另有一条 `.error`（第 15 行）**全仓零引用**，是死规则，留给那一页一起清。
- 两个列表都没做虚拟化（`ScrollArea` 限高 + 全渲染），上千张时条目 DOM 仍全在。
- 打标列表的网格换了做法（见上），不是照 `WALL_GRID` 抄的。
