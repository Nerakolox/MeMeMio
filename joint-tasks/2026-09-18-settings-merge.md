# 三个管理页并入设置页

状态：`in_progress`（web 单端）
开始：2026-09-18

## 为什么要做

`/admin/invites`、`/admin/embedding`、`/admin/users` 三个页面**本质上都是设置项**，
却因为「谁能看」这一个维度被拆成了独立页面。代价有三处：

1. 导航条上「设置」「管理」「Embedding」三个入口并排，用户要先猜哪个里面有自己要找的东西。
   而「管理」这个词没有说明它装的是邀请码。
2. `/admin/users` **根本没有导航入口**，只能手敲 URL——它是三个页面里唯一没被挂上去的那个，
   这个漏洞在拆成三页的结构下没人会发现。
3. 三个页面各自一个 `<h1>`、一套加载态、一份 `.admin-*` 样式，而内容都是「一块配置 + 一个表格」。

合并的是**呈现**，不是权限。

## 做完的标准

- [x] `/settings` 一页承载四个分段：视觉模型（所有人）、邀请码 / Embedding / 用户（仅管理员）
- [x] 顶部锚点目录，只列当前用户看得到的分段
- [x] 旧地址 `/admin`、`/admin/invites`、`/admin/embedding`、`/admin/users` 重定向到
      `/settings` 的对应锚点，不是 404
- [x] 管理员分段对普通用户**不渲染**（不是 CSS 隐藏）
- [x] SPEC §9.9 的两段契约文案逐字保留
- [x] `npm run typecheck` / `npm run build` 通过
- [x] 浏览器实测：桌面 + 390×844，管理员与普通成员两种角色

## web 端

### 改了什么

| 文件 | 改动 |
|---|---|
| `src/routes/settings.tsx` | 重写成四段 + 锚点目录 + hash 滚动 |
| `src/features/settings/InviteSettings.tsx` | 新增，来自 `routes/admin-invites.tsx` |
| `src/features/settings/UsersSettings.tsx` | 新增，来自 `routes/admin-users.tsx` |
| `src/features/settings/use-hash-scroll.ts` | 新增，锚点滚动（见下方验收里那条实测发现） |
| `src/routes/admin-invites.tsx` / `admin-users.tsx` / `admin-embedding.tsx` | 删除 |
| `src/App.tsx` | 三条 admin 路由改为重定向；删掉只剩空壳的 `RequireAdmin`；导航去掉「管理」「Embedding」 |
| `src/styles.css` | `.admin-*` → `.settings-*`；新增目录与分段的布局；页宽 800 → 1100 |

两个新组件的**加载态和错误态挪进了 `<section>` 内部**。原来整页 `return <p>加载中…</p>`，
并页之后那样会让锚点元素在数据回来之前不存在，从 `/admin/invites` 跳过来滚不到位置。

`RequireAdmin` 删掉了：合并后没有任何路由用它，而它留着会被 `noUnusedLocals` 判红。
前端守卫本来就只是体验，真正的权限在服务端（`state-navigation.md §4`）——这次是把
「藏入口」从路由层挪到了渲染层，防护强度没有变化。

### 顺手修的

`admin-invites.tsx` 的表头第三列写「创建时间」，渲染的却是 `inv.createdBy`（`InviteCode.createdAt`
是可选字段，接口不一定给）。按**实际渲染的东西**把表头改成「创建者」，没有去动接口。

### 明确不做

- 统计面板（`settings-ux.md §9`）——它要另外的端点，仍然欠着
- 页内页签 / 折叠分段——单页滚动 + 锚点已经够用，页签要把状态放进 URL 还会打断重建进度轮询
- 表格的窄屏横向滚动——原来在 1100px 的管理页上就溢出，这次没有改善也没有恶化

## 与 SPEC 的偏差（需总管裁定）

**这次改的是页面结构，不是 Embedding 的归属。** 但有两处正文是按「两个页面」写的：

| 位置 | 原文 | 现状 |
|---|---|---|
| [SPEC §9.6](../spec/09-decisions.md) | 「所以 Embedding 模型全站一份，由管理员配置，**普通用户的设置页里没有这一组**」 | 普通用户的设置页里仍然没有这一组（不渲染）。但它现在位于 `/settings` 这个 URL 下 |
| [SPEC §9.9](../spec/09-decisions.md) | 「共享库之后这一节**分成两个页面**：视觉模型在用户设置页，Embedding 在管理页」 | 一个页面、两类分段 |
| [`web/agents/rules/settings-ux.md` §2](../web/agents/rules/settings-ux.md) | 「两个页面，不是一个」 | 已随本任务改写 |

§9.6 的**实质约束一条没动**：Embedding 全站一份、仅管理员可改、换模型触发全站重算、
维度归一化到 1024。变的只是它挂在哪个 URL 下。

`settings-ux.md` 是本端规则，随实现一起改了。**SPEC §9.6 / §9.9 的措辞归总管**，
本任务不自行改写——按 `AGENTS.md §4`，不把 SPEC 改成已有代码的样子。

## web 端验收

`npm run typecheck` ✅　`npm run build` ✅

浏览器实测：Vite dev（:5199）+ Playwright 打桩 `/api/v1/**`（一次性脚本，跑完已删）。
角色 `admin` / `member` × 视口 1280×900 / 390×844，共 4 组，**32/32 断言通过**。

| 断言 | 结果 |
|---|---|
| 管理员目录四项（视觉模型 / 邀请码 / Embedding / 用户） | ✅ 两个视口 |
| 五个 `<h2>` 齐（含「重建索引」） | ✅ 两个视口 |
| 「⚠️ 你的打标结果会进入公共库，所有人都会搜到」逐字在页面上 | ✅ 两个视口 |
| 「⚠️ 这是全站唯一一份 Embedding 配置，对所有用户生效」逐字在页面上 | ✅ 两个视口 |
| `/admin/invites` `/admin/embedding` `/admin/users` → 对应锚点 URL | ✅ 两个视口 |
| 三条重定向真的滚到了目标分段（顶边距视口 16px） | ✅ 两个视口 |
| `/admin` → `/settings` | ✅ 两个视口 |
| 成员：目录只有「视觉模型」 | ✅ 两个视口 |
| 成员：`#invites` / `#embedding` / `#users` **一个都不在 DOM 里** | ✅ 两个视口 |
| 成员：页面上没有 Embedding 契约块 | ✅ 两个视口 |
| 成员访问 `/admin/embedding` 落到设置页、无该分段 | ✅ 两个视口 |
| 导航只剩 Mememio / 浏览 / 导入 / 设置 | ✅ 两个视口 |

另外两个视口各截了一张整页图人眼看过：分段顺序、目录、表格、契约块的缩进结构都正常。

### 实测中发现并修掉的一处

**锚点只滚一次会停在半路。** 第一轮实测三条重定向全部 FAIL，落点偏 498～1783px。
原因不是 hash 没生效，是**上面的分段数据回来之后把锚点往下推了**——`scrollIntoView` 在挂载时
就跑完了。改成 `use-hash-scroll.ts`：`ResizeObserver` 盯着页面高度，还在变就重新对齐，
用户一动手或 3 秒后撒手。修完落点 16px（= `scroll-margin-top`）。

这条**只有真在浏览器里跑才会发现**，typecheck 和 build 都是绿的。

### 没测的

- 真 api（全程打桩）
- 真机（只有 Playwright 视口）、Safari / Firefox
- 表格在窄屏的横向溢出：390×844 下用户表最后一列贴边，**这是并页之前就有的**，本次没改善也没恶化
- `POST /admin/reindex` 之后那句「已排队 N 条」仍然没人在浏览器里见过——它要真的保存一次换模型才触发，
  本次没走到，遗留项照旧挂着
