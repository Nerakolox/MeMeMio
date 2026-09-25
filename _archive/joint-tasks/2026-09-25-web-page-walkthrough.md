# 四页走查：把界面讨论从注释挪到屏幕上

**状态**：`done`（2026-09-25；关单与归档由总管做，见文末「web 端验收」）
**性质**：**web 单端**——不动 `api/`，不动 SPEC，不改任何接口与数据语义。
产出是**证据与观察**，不是界面改动。

## 为什么要做

2026-09-25 提出的问题是「是否应该重新考虑，捋清楚前端页面的布局与交互」。

这个问题有它自己的来历：**09-21 到 09-24 这四天，web 是一页一条任务迁过来的**——
`web-sidebar-nav`、`web-sticky-header`、`web-home-shadcn`、`web-card-shadcn`、
`web-browse-shadcn`、`web-settings-redesign`、`web-image-viewer`、`web-import-shadcn`、
`web-interaction-fixes`、`web-toast-feedback`、`web-viewer-copy-shortcut`。

每个决定本身都是对的，但它们**全部写在各自那一页的代码注释里**：

- `src/App.tsx` 的 `AppLayout` 用四十行讲顶栏为什么是 `z-20`、为什么不能高过 Radix 那一层；
- `src/routes/browse.tsx` 用六十行讲布局三稿（`sticky` 为什么做不到、`ResizablePanel` 上那两个 `!` 是干嘛的）；
- `src/routes/home.tsx` 讲 `max-w-6xl` 为什么不是装饰。

而**全仓没有一处回答「全站有哪几页、每页承担什么、同一个动作在哪些地方出现」**。
最接近的是 `web/agents/rules/state-navigation.md §4` 那张路由表——六行，只有路由名和一句话。

逐页迁移的产物就是「每页都对、合起来没人负责」。所以在讨论「要不要重新捋」之前，
得先有一次**以用户身份把四页走完的实看**；不然所有讨论都是在注释上讨论。

## 一次旧证据，以及它为什么不够

`2026-09-21-web-tailwind-v4-radix-luma.md` 里记着一次四页渲染（2026-09-21，`page.route()`
打桩 + 系统 Chrome，浅色深色各一遍）。**那次不作数，三个原因**：

1. **时点**：它在 09-21，而 home / browse / card / import / settings 各自的 shadcn 迁移都在它
   之后（09-21 ~ 09-22）。它证的是迁移**前**的样子。
2. **名单变了**：当时说的是 browse / home / tagging / discover，而 tagging 与 discover 现在都
   不是路由了——tagging 并进导入页（`features/tagging/TagStatusView`，挂在 `routes/import.tsx`），
   discover 并进首页（`features/discover/DiscoverWall`）。
3. **性质**：它自己写明了「这是渲染证据，不是接口联调……仍然不构成关单依据」。

另外，那张卡现在挂在 `in_progress`、板子上写的阻塞理由是「仓库里没有开发凭据，执行者无法自证」。
**这条理由不成立**：`web/scripts/mock-api.mjs` 的 `/auth/me` 恒返 admin（默认 `role: 'admin'`，
`faults.member` 那一档切成员），`verify-home-look.mjs` 已经用「替身 + vite + CDP 驱动系统 Chrome」
把首页那几个状态截出来了，全程不需要凭据。真正缺的**不是凭据，是一套把四页都摆出来的脚本**。

## 走查时要盯的几处

下面五条是**读代码读出来的**，不是结论。带着它们去看，实看确认或推翻都算产出：

1. **「发送」有三套呈现**：结果卡片下方的常驻按钮（`features/search/SearchResults.tsx` 的 `ResultItem`）、
   卡片上的「⋯」菜单（`features/manage/MemeActions.tsx`）、全屏阅览的控制栏加 `Ctrl+C`
   （`components/LightboxViewer.tsx`）。三套是不是都成立？有没有一条能说清「为什么这里这样、那里那样」。
2. **管理动作只在浏览页可达**：`MemeActions` 的唯一调用点是 `features/browse/BrowseResults.tsx`，
   `MemeEditPanel` 的唯一调用点是 `routes/browse.tsx`。全屏阅览里**没有编辑、没有删除、也没有收藏**。
   搜到一张标错的图，得切到浏览页重新筛出来。
3. **一张图没有自己的地址**：全仓没有一处 `pushState` / `replaceState`。深链只有 query string，
   分享粒度是「一次搜索」而不是「一张图」，全屏阅览的开关不进 URL。
4. **顶栏几乎是空的**：只有折叠按钮与导入进度；登出埋在侧栏底部；管理员与成员共用同一个
   「设置」入口，管理员多三段（`routes/settings.tsx` 的 `SECTIONS`）。
5. **设置页一页装了两件事**：配置（视觉 / Embedding / 运行参数 / 用户 / 邀请码）与运维动作面板
   （`ReindexPanel` / `RetagPanel` 两个都没有 `id`、不进锚点表，而重建索引要跑几分钟）混在一页长滚动里。

**看的时候按「用户在做什么」走，不要按代码怎么分走。** 至少这几条得真走一遍：
导入一千张的过程中切走再切回来能不能找回进度；一次搜索的链接发给别人打开是不是同一屏；
手机上筛选抽屉盖住内容时，还看不看得出自己在哪一页；键盘从头到尾用一遍。
—— **复制 / 分享路径要按 `web/AGENTS.md §6` 分别看桌面与手机**，那条路径是产品的价值所在。

## 做完的标准

1. **一条命令跑完四页走查**：自己起替身与 vite，CDP 驱动系统 Chrome，**不装任何新依赖**。
2. 替身的媒体改喂**真图**。现在替身发的是 1×1 透明 PNG，图墙与瀑布流的密度、比例、动图角标全看不出来
   ——拿它评布局等于评一张灰纸。静态与动图都要有，动图那张要能在截图里认出动图标识。

   > ✏️ **2026-09-25 更正**：这里原来写「`docs/fixtures/images/` 有 26 jpg / 11 png / 10 gif / 2 webp，
   > 都进仓库」——**数字是错的**，那份统计把 `docs/fixtures/eval/images/` 一起数进去了。进仓库的
   > `images/` 只有 18 个文件，另 30 个在 `eval/images/` 且被 `.gitignore` 挡着。执行者照实报了这个出入，
   > 没有假装修好。**连带一个没做全的**：`images/` 里全是方图，真比例只在不进仓库的 eval 集里，
   > 所以「比例」这一维本次没评到，见文末验收。
3. 每页截**关键状态**，能摆的都摆：有数据 / 空库 / 请求失败 / 加载中。设置页要**管理员与成员两个视角**；
   造不出 `pending` / `needs_manual` 时用 CDP `Fetch` 拦 `/memes/tag-status` 摆出来。
4. **两个视口**：390×844（手机）与桌面（至少 1440×900）；**浅色与深色**（系统 `prefers-color-scheme`）各一遍。
5. 交回**一份观察清单**，不是「好不好看」：每页实际是什么样、与代码注释里的说法有没有出入、
   上面那五条各自实测到的是什么。截图落临时目录，路径写进本文件。
6. **顺带回答那张 in_progress 的卡**：四页渲染到底有没有回归。没有回归就回填
   `2026-09-21-web-tailwind-v4-radix-luma.md` 的剩余阻塞，该关单就关单。

## web 端要改什么

1. **`web/scripts/mock-api.mjs`**：媒体分发从那个 1×1 `PNG` 常量换成 `docs/fixtures/images/` 的真图，
   按 slug 轮换（动图给 `animated/` 里的 GIF）。

   > ⚠️ **别把媒体地址改回同域路径。** 真实实现里媒体是**绝对 URL**、指向 R2 而不是同域路径，
   > 替身是照那个形状发的。改成 `/media/…` 的话请求会落到 vite 上、走 SPA 兜底**返回一份 HTML**，
   > `fetch` 拿到 200 与一段 HTML，报错位置离原因很远（`mock-api.mjs` 头部记着这条）。

2. **新增 `web/scripts/verify-page-walkthrough.mjs`**，沿用 `verify-home-look.mjs` 那套骨架
   （零依赖、自己 spawn 替身与 vite、CDP 驱动系统 Chrome）。
   **仓库里没有 Playwright，不要临时装包。**
3. 要摆分支的地方走 CDP 的 `Fetch` 拦。替身的 `/auth/me` 恒返 admin，所以四页**不登录也能渲染**。
4. **本次不改任何 UI。** 发现的问题写成观察清单交回来，改不改、怎么改由下一步裁定。

> 这两个脚本都在根 `.gitignore` 里（`web/scripts/mock-api.mjs`、`web/scripts/verify-*.mjs`），
> 不是产品代码也不是回归套件，**照原样不进仓库**；留着是为了下次联调能翻出来看。

## 现在不做

- 不改界面、不动 SPEC、不改接口与数据语义。
- 不建截图回归基线——那是另一件事，排在[测试设施与 CI](../../joint-tasks/2026-09-24-test-infra-ci.md)之后。
- **不在这次给出「该怎么改」的方案。** 先把现状看清楚；方案是下一份文件的产物，
  而且要按 [AGENTS.md §3](../../AGENTS.md) 路由：纯布局与交互归 web 单端，
  一旦动到 URL 形态、分享粒度或管理员入口分层，那是跨端契约，得回 SPEC 走契约先行。

## web 端验收

**跑了什么**：`node scripts/verify-page-walkthrough.mjs`（新增，零依赖；自己起替身 + vite + 系统 Chrome，
CDP 驱动）。**32 条断言全过、89 张截图**，落
`C:/Users/admin/AppData/Local/Temp/mememio-walkthrough/`（另附 `walkthrough.json`：逐条断言、16 条观察的原文）。
四档视口 × 主题各走一遍：**1440×900 / 390×844 × 浅色 / 深色**。

只改了两个文件，都在根 `.gitignore` 里、**不进仓库**：`web/scripts/verify-page-walkthrough.mjs`（新）
与 `web/scripts/mock-api.mjs`（媒体改喂真图，顺带修两处会带走替身进程的 bug，见下）。
`web/src/` 一个字节没动，SPEC 没动。

**替身的两处修复**（都不是产品缺陷，是替身自身的）：

- `/r2/` 的 PUT 里那个 `for await` 在**客户端中途刷新**时抛 `Error: aborted`，未处理 → **替身进程整个退出**，
  后面每个 `fetch` 只报 ECONNREFUSED。就地接住 + 一条 `unhandledRejection` 兜底。
- 替身的输出现在写 `stub.log`，不再 `stdio: 'ignore'`：上面那次崩溃原先只表现为「离原因很远的一条报错」。

### 五条待确认，各自实测到什么

| # | 读代码时的判断 | 实看结果 |
|---|---|---|
| 1 | 「发送」有三套呈现 | **两套可见 + 一套不可见**。搜索卡片的常驻按钮与浏览页「⋯」那一项都在（同一个 `sendMeme`）；**全屏阅览整屏没有任何发送入口**，工具栏只有 `放大/缩小/关闭`，唯一路径是 `Ctrl+C`，界面上一个字都没提（`hasShortcutHint: false`） |
| 2 | 管理动作只在浏览页可达 | **成立**。`MemeActions` 只长在浏览页；搜索结果卡片没有动作槽，全屏阅览里没有编辑/删除/收藏。代价是「搜到一张标错的图」要**换一种筛法再找一遍**（浏览页按标签筛，搜索按向量/文本） |
| 3 | 一张图没有自己的地址 | **成立**。开/关阅览器、在阅览器里翻页，`location.href` 与 `history.length` 都不变；把同一串地址重开，阅览器是关着的。「发一屏给别人」只有搜索走通了（顺序可复现），随机图墙刻意不进 URL |
| 4 | 顶栏几乎是空的 | **成立**。顶栏 56px，常驻内容只有折叠按钮（导入时多一个「导入 n/m」）；登出在侧栏底部（距视口顶 856px / 视口高 900px）；管理员与成员共用同一个「设置」入口——成员看到的是**只有一段、且不解释为什么别人的更长**的设置页 |
| 5 | 设置页一页装了两件事 | **成立**。锚点目录 5 条全是配置分段；`重建索引` / `重新打标` 两张卡 `id` 为 null、不进目录，却和配置在同一条滚动轴上，整页 **3262px（3.6 屏）** |

### 另外几条（没在五条里，但走查中撞上的）

- **导入的进度只活在内存里。** 同一份文档里切走再回来是同一批（顶栏「导入 0/8」在浏览页上也看得见）；
  但**刷新一次就归零**，页面回到「点击选择图片」，顶栏入口也没了。一号场景是「导入一千张」。
  （切走必须走客户端路由去量；`Page.navigate` 等于刷新，量的是另一回事——脚本里两种都摆了。）
- **键盘：浏览页从页面顶部按 Tab，第 23 步才落进第一张结果卡。** 前 22 步是 8 个外壳停靠点 +
  11 个筛选控件（上传者 / 标注状态 / 五组标签 / 内容分级 / …）+ `GIF`。进卡片之后**没有一步停在
  透明按钮上**（`group-focus-within/card` 确实兜住了），但每张卡的两个按钮都是停靠点，全排在翻页之前。
- **复制 / 分享，桌面与手机是两条路**（`web/AGENTS.md §6` 要求分开看）。打桩记录到的调用：
  桌面静图 → `clipboard.write(["image/png"])`；桌面动图 → **不写剪贴板**，按钮文案就是「下载」；
  手机静图 / 动图 → 都走 `navigator.share`（`image/png`、`image/gif`）。分流判据是 `isAnimated`。
- **手机端筛选抽屉盖住内容时，顶栏仍在**（抽屉 z=50、顶边 y=0、高 844px，顶栏 56px 可见），
  「自己在哪一页」读得出来。
- **比例这一维这次量不足**：`docs/fixtures/images/` 里的图**全是方的**，真比例只在那份**不进仓库**的
  `docs/fixtures/eval/images/`（30 张，非方的已被摊进池子前十二个槽位，但整体仍是方阵）。
  任务书里「26 jpg / 11 png / 10 gif / 2 webp，都进仓库」与实际不符：`images/` 共 18 个文件、
  `eval/images/` 30 个且被 ignore。**这条不假装修好了**，要么把几张非方图挪进仓库，要么下次单独量。
- 待确认队列的三个形态（0 / 1 / 3 条）都摆出来了。这一屏此前在界面上没出现过——替身的
  `/imports/reviews` 恒返空数组，是这次给替身加了 `POST /__reviews` 才摆得出来。1 条那档在手机上
  是即时弹窗、并自带一句「只有一条时它就以这种即时面板的形式出现」，与 `import-ux.md` 的说法一致。

### 四页渲染有没有回归（回答 in_progress 那张卡）

**没有回归，而且这次是实测不是推断**：四页（首页 / 浏览 / 导入 / 设置）在四档视口 × 主题下都用真图
渲染完整，迁移后 shadcn + Tailwind v4 的组件（卡片、弹层、确认框、页签、抽屉、toast）都正常出现，
没有样式缺失或布局塌掉。已回填 [2026-09-21-web-tailwind-v4-radix-luma.md](2026-09-21-web-tailwind-v4-radix-luma.md)。

⚠️ 那句「四页」里的 **tagging 与 discover 现在不是路由了**（tagging 并进导入页、discover 并进首页），
这次走的是**现在的四页**：首页 / 浏览 / 导入 / 设置。

### 实测范围与保留

- 走的是**替身**，不是真 api：数据是假的、写操作没有落库。这是渲染与交互走查，**不是接口联调**。
- 系统 Chrome headless（`--headless=new`）。**真机手势没测**；剪贴板 / 分享是打桩记录的**调用分流**，
  不是真写进剪贴板（那条路的完整断言在 `verify-viewer-copy-shortcut.mjs`）。
- 只看了浅色 / 深色两档，没做像素级基线（那是[测试设施与 CI](../../joint-tasks/2026-09-24-test-infra-ci.md)之后的事）。
- **本次不改任何 UI、不动 SPEC**，上面每条都只是观察，**没有给方案**。方案是下一份文件的产物，
  按 [AGENTS.md §3](../../AGENTS.md) 路由：纯布局与交互归 web 单端，动到 URL 形态 / 分享粒度 /
  管理员入口分层的，是跨端契约，得回 SPEC 先行。

### 顺带验过的

改替身之后重跑了全部旧脚本，都还是绿的：`verify-viewer-copy-shortcut` 24/24、
`verify-web-interaction-fixes` 65/65、`verify-toast-feedback` 37/37；`verify-home-look` 只截图不断言，跑通无异常。
（替身里 `searchItems()` 的 URL 与 `第 N 张验证图` 文案是这些脚本的断言对象，这次媒体改动只换了字节与
Content-Type，地址形状没动。）
