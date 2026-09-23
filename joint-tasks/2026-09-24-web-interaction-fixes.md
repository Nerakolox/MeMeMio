# web 交互缺陷批修

**状态**：`in_progress`（2026-09-24 web 端已回填：12 条全部落地，真 Chrome 两档 **65/65 断言过**，
`typecheck` + `build` 过。**未标 `done`**：第 3、4 条的 iOS 真机那部分记「未测」，是否可就此关闭由总管裁定，
理由见 §4 末）｜ **性质**：web 单端 ｜ 开于 2026-09-24

契约不变。第 2 条用的是 SPEC §1.4 早就写明的做法：「客户端不能把 SSE 当作唯一的结果来源」，要用 `GET /imports/{batchId}` 补齐。所以**不需要 api 配合**。

来源是 2026-09-24 的只读审查。标 ✔ 的条目总管已核实；其余先复核，查无此事的记「不成立」。401 统一跳转、`/auth/me` 网络失败、`/ui` 进生产包这三条在[会话与访问收口](2026-09-24-auth-access-hardening.md)的 web 端，本任务不重复。

## 1. 为什么要做

前两条是用户每天都会撞上的：

- **首页按 Enter 会发出另一张图** ✔。`features/search/use-search.ts:181-186`：只要焦点不在输入框、`selectedIndex >= 0`，任何 Enter 都会被 `preventDefault` 并发送 `items[selectedIndex]`。只有图片帧挡了冒泡（`MemeImage.tsx:345`），收藏按钮、「搜索」按钮、其它卡片的「复制」都没挡。Tab 到第 5 张的收藏按钮按 Enter，结果没收藏，却把第 1 张复制或下载了。**键盘用户根本收藏不了。**
- **导入完成后，界面可能永远停在「处理中」。** `features/import/use-import-queue.ts:154, 356-361` 在 commit 之前先 `new EventSource`，但没等连接真正建立。服务端连上之后才订阅，而且只补发一条 `progress` 快照，不补发 `done` 和 `item`。一张精确重复的图几毫秒就处理完，这时 SSE 还没连上，`phase` 就永远停在 `processing`：顶栏「导入 x/y」常驻，文件行卡在「上传中」。中途断线错过 `done`，也是同样结果。

## 2. 做完的标准

每条都在真 Chrome 里有对应断言，1264 与 390 两档都要跑（沿用现有做法：零依赖 CDP 驱动系统 Chrome，不临时装 Playwright）。第 3、4 条（iOS 分享）**必须上真机**（`web/AGENTS.md §6`）；上不了就记「未测」，不要写成已测。

## 3. web 端

| # | 问题 | 位置 | 方向 |
|---|---|---|---|
| 1 ✔ | Enter 被整页监听劫持 | `features/search/use-search.ts:181-186` | 只在结果项本身聚焦时响应（判 `e.target` 是不是那张卡的 option 元素），别再靠「谁挡了冒泡」 |
| 2 | 导入完成判定只靠 SSE | `features/import/use-import-queue.ts:132-193, 303-306, 356-361` | `onopen` 与每次重连后，拉一次 `GET /imports/{batchId}`；快照里 `pending = 0` 且已 commit 即收尾。R2 上传成功后行状态立刻前进，不等 `item` 事件 |
| 3 | iOS 分享：先 `await fetchOriginal` 再调 `navigator.share`，大 GIF 取完图时用户激活多半已失效 → `NotAllowedError` → 降级成下载并提示「分享失败」。手机正是主路径 | `lib/clipboard.ts:218-222` | 在渲染或 hover 时预取 blob，点击时同步调 `share`。**真机验证** |
| 4 | 下载失败后在 `await` 之后才 `window.open`，会被弹窗拦截，文案却说「已在新标签页打开」 | `lib/clipboard.ts:235-242` | 在手势内先开空窗再赋 URL，或者改文案并给一个可点的链接 |
| 5 | `clipboard.writeText` 没接 `catch`，非安全上下文或权限被拒时没有任何反馈 | `features/settings/TestResultPanel.tsx:77-81`、`InviteSettings.tsx:89-93` | 接住并提示 |
| 6 | 轮询失败一次就永久停止 | `features/settings/ReindexPanel.tsx:57-64`、`RetagPanel.tsx:134-140` | 失败后退避重排，并显示「暂时连不上」 |
| 7 | 浏览页第 N 页失败后点重试，拉的是第 1 页并整表替换，已翻过的内容和滚动位置都丢了 | `features/browse/use-browse-list.ts:333-335` | 重试失败的那一页 |
| 8 | SSE 监听器里 `JSON.parse` 没有保护 | `features/import/use-import-queue.ts:160, 165, 181, 193` | 解析失败记一次、忽略这条事件 |
| 9 | 导入行对未知的 `item.reason` 没有兜底文案。[导入加固](2026-09-24-import-hardening.md)会开始发 `reason: QUOTA_EXCEEDED` | `features/import/` | 未知 reason 显示原 code，`QUOTA_EXCEEDED` 给中文 |
| 10 | API Key 输入框 `type="password"` 配 `autoComplete="off"`，Chrome 会忽略；点「更换 Key」后，可能被自动填入登录密码 | `features/settings/ConfigFields.tsx:76` | 改 `autoComplete="new-password"` |
| 11 | `role="listbox"` / `option` 里嵌了可交互的按钮，违反 ARIA | `features/search/SearchResults.tsx:114, 160-187` | 换成 `grid` 或去掉 listbox 语义。和第 1 条一起改 |
| 12 | 只打出一个 655 kB 的 JS 包，没有代码分割 | `App.tsx:13-20` | 设置、导入页和 YARL 阅览器用 `React.lazy` 按路由拆 |

**顺手项（不改行为，可以不做）**：收藏的乐观更新写了三份（`use-search.ts:118-140`、`DiscoverWall.tsx:76-98`、`use-browse-list.ts:341-349`）；`cn` 的导入路径有三种写法；`lib/api.ts:313-386` 手写的 `User` / `InviteCode` / `AdminUser` 和「不手写接口类型」的规则冲突。

**陷阱**：第 1 条改完，本来就能用的键盘路径（输入框 ↓ 进结果区、↑↓ 移动、Enter 发送）必须照样能走通。这几条是[首页迁移](2026-09-21-web-home-shadcn.md)验过的，改完原样重测一遍。

## 4. web 端验收

**结论**：12 条全部落地。真 Chrome（系统 Chrome，零依赖 CDP，未装 Playwright）跑
`node scripts/verify-web-interaction-fixes.mjs` **65/65 通过**，1264×900（细指针）与
390×844（粗指针）两档都跑。**第 3、4 条在 iOS 真机上的部分记「未测」**（见下）。

验收脚本与替身（两个文件都 gitignore 了，不进交付物）：
`web/scripts/mock-api.mjs`（替身 API，`127.0.0.1:3001`）、
`web/scripts/verify-web-interaction-fixes.mjs`（驱动 + 断言，`--only=<段>` 可单跑一段）。
截图落在 `%TEMP%/mememio-verify`。

| # | 断言（括号里是量到的数） |
|---|---|
| 1 | 焦点在收藏按钮上按 Enter → **收藏生效、没有顺手发送**；焦点在结果项本身时 Enter 照常发送（390 那一档分享被调到 0→1 次）；↓ 进结果区焦点落第 1 格、↑↓ 移动、Esc 取消选中 —— **陷阱那条原样重测，13/13 过** |
| 2 | `snapshot-only`：SSE 一条 `done`/`item` 都不发，靠 `GET /imports/{id}` 快照收尾（快照请求 4 次，不再停在「处理中」）；文件行不再是「上传中」而是「已上传」；重连那一路：断线提示出现过、events 连了 2 次（**两次间隔 407ms / 404ms**）、重连后由 `open` 那一次快照对齐收尾、提示自己收掉 |
| 3 | 桌面替代验证：按钮文案在渲染时就定成「分享」；原图在**点击之前**已取到（点前 `/media/ok.png` 取 1 次）；点击时 `navigator.share` 被调到且**调用时用户激活仍在**（`userActivation.isActive: true`）；用的是预取的那一份（点后再取 0 次）。**iOS 真机未测** |
| 4 | 取不到原图时不 `window.open` 然后说「已在新标签页打开」：页面给的是**可点的 `<a>`**（`target="_blank" rel="noopener noreferrer"`，href 指向原图），文案是「…请点下面的链接手动保存」，**不含**「已在新标签页打开」 |
| 5 | 复制成功 → 「已复制」；`writeText` 被拒 → 接住并给「复制失败，请手动选中后复制」，且带 `role="alert"`（不是静默） |
| 6 | 轮询失败 → 显示「暂时连不上（数据库连不上），**5 秒后自动重试**。」；放行之后**不碰界面**，退避到点自己又问了那一次（`reindexPolls` 2→3）并把状态补上，提示自己收掉 |
| 7 | 第二页失败 → 出错提示 + 重试按钮；**2 秒内又发了 0 次**（修之前是 120 次）；提示停在屏幕上；点重试发的是失败那一页的游标（`[null,null,"page-2"] → [null,null,"page-2","page-2"]`）；第一页没丢（8 张，追加不是替换）；成功后提示收掉 |
| 8 | 一条解析不出来的 `item` 事件：**没有未捕获异常**、控制台记了一笔「忽略一条解析不出来的 item 事件」、后面的正常事件照常处理（这一批仍然收尾） |
| 9 | `QUOTA_EXCEEDED` → 「存储空间不足，这个文件没能入库」；没见过的 `SOME_NEW_CODE` 原样显示（不吞、不白屏） |
| 10 | API Key 输入框：`{"id":"embed-api-key","autoComplete":"new-password","type":"password"}` |
| 11 | 结果区 `listbox: 0`、`option: 0`，换成三个**有名字**的 `role="group"`（「搜索结果」+「第 N 张：<名>」）；选中态改用描边，不再靠 option 语义 |
| 12 | 首屏**不请求**设置页与阅览器的 chunk（`settings=0，LightboxViewer=0`）；点卡片才取阅览器 chunk（1 次）且阅览器正常打开、Esc 关得掉；进 `/settings` 才取设置页 chunk（1 次） |

**第 12 条的量法**：把 4 处 `lazy` 临时改回静态 import 再 `vite build` 量了一次「没切开」的
基线（量完已还原，两个文件的 sha256 对过）：

| | 没切开 | 切开后 |
|---|---|---|
| 首屏 JS | `index` **611.44 kB**（gzip 198.66） | `index` **498.54 kB**（gzip 162.57） |
| 按需 chunk | — | `progress` 4.04 + `import` 28.81 + `settings` 37.74 + `LightboxViewer` 45.27 = **115.86 kB**（另有 `LightboxViewer.css` 5.61 kB 跟着 YARL 一起切走） |

首屏少下 **112.90 kB**（gzip 36.09）。任务里记的「655 kB」与这次量到的 611.44 kB 对不上，
**以复现得到的 611.44 kB 为准**（可能来源那次量的是别的提交）。

**顺手项**：`cn` 的三种写法统一了（4 份 `from 'cn'` 改成走 `../../lib/utils`，`ImageViewer` 那份多余的 import 也去掉了）；
`components/ui/*` 仍是注册表原样的 `from "cn"`（那是 preset 的入口，不动）。
另两项**有意没做**：收藏乐观更新三份仍各写各的（无行为差异，抽公共件要连带改四处调用点）；
`lib/api.ts` 手写的 `User` / `InviteCode` / `AdminUser` 仍是手写 —— 三处**都能**从 RPC 推（`api.api.v1.auth.me`、
`api.api.v1.admin.*` 都已挂上），但换掉之后 `role: string` 这类放宽会立刻波及 auth context 与设置页的判分支，
该按 SPEC 判断哪一侧改，不该在收尾时顺手做。

**验收中另外发现并修掉的缺陷（不在原清单里）**：浏览页滚到底 + 服务端一直出错时，
`use-browse-list` 的观察器会在失败后立刻重观察，形成**每秒几十次的请求长龙**（实测 2 秒 120 次），
而且把出错提示推得看不见。改法是一行守卫：失败过的那一页不再自动补拉，
出路只留界面上那个「重试」（`use-browse-list.ts`，`failedCursorRef`）。

**量法本身修过的两处**（记下来是因为不修的话断言是假的）：第 3 条原先用
`element.click()` 触发，脚本调用**不产生用户激活**，`userActivation.isActive` 恒为 `false` ——
改成 CDP 发**受信任**的指针事件后才量得到 `true`；替身那边原来把直传地址写成相对路径
`/r2/…`，落在 vite 上（不是替身）返回 404，预检也没答，两条一起修掉之后导入那几条才量得实。

**未测**：第 3、4 条的 iOS 真机（`web/AGENTS.md §6`「动了复制 / 分享路径必须说明两端各测了什么」）——
手上没有真机，只有桌面 Chrome 的替代验证。真机要看的正是它俩的分歧点：Safari 的用户激活过期规则、
`canShare` 对 `image/gif` 的答复、以及分享面板取消时的返回值。**上线前必须补这两条。**
其余设备面：桌面 Chrome 已验证；Firefox / Safari 桌面未跑。

**自查**：`npm run typecheck` 通过，`npm run build` 通过。
