# 目录结构

## 按业务切，不按类型切

```
src/features/
├─ search/       搜索框、结果网格、结果卡片
├─ discover/     首页随机图墙（「随便看看」）
├─ browse/       筛选器、无限滚动
├─ import/       上传、SSE 进度、待确认队列
├─ tagging/      打标进度、待处理列表
├─ manage/       编辑标签、删除
└─ settings/     用户设置、管理页
```

> `discover/` 是首页下半屏那个随机图墙（2026-09-19 加）。它和 `search/` 同在一页但**不是一回事**：
> 搜索是「知道要找什么」，图墙是「不知道要找什么」，前者要有结果就渲染、后者要每次换一批。
> 混进 `search/` 会让那个目录同时装两种意图。接口是 `GET /memes?random=true`
> （[SPEC §6.3.2](../../../spec/06-endpoints.md)）。

> 「待处理列表」原本挂在 `manage/` 下（2026-09-19 改）。挪进 `tagging/` 是因为它读的是打标状态
> （[SPEC §6.6](../../../spec/06-endpoints.md)），和「打标进度」是同一份数据、同一个页面；
> `manage/` 留给 SPEC §6.4 的编辑与删除——那些是**写**操作，见
> [浏览页图片操作](../../../joint-tasks/2026-09-19-browse-meme-actions.md)。

每个 feature 内部自己分文件，**不建全局的 `components/Button`、`hooks/`、`types/` 这种按类型切的目录**——那会让「改搜索」变成在四个目录之间来回跳。

`src/components/` 只放**真正跨 feature 复用**的展示组件（按钮、对话框、标签选择器）。判断标准：**被两个以上 feature 用到**。只有一个 feature 用的组件留在那个 feature 里，哪怕它看起来很通用。

> **例外：应用外壳**。`components/AppSidebar.tsx`（侧边导航，2026-09-21 加）不属于任何一个
> feature——每条路由都挂在它下面（`App.tsx` 的 `AppLayout`）。上面那条「被两个以上 feature 用到」
> 针对的是 feature 之间的复用，外壳不在这个坐标系里；放回 `App.tsx` 会把那个文件顶过
> [code-style.md](code-style.md) 的 150 行上限。`components/ui/` 是另一回事（shadcn 拉下来的原语）。

## `src/lib/`

| 文件 | 内容 |
|---|---|
| `api.ts` | Hono RPC 客户端，**唯一发请求的地方** |
| `clipboard.ts` | 复制 / 下载 / 分享的分流，见 [clipboard-share.md](clipboard-share.md) |
| `vocab.ts` | 读 `shared/vocab/vocab.json`，提供筛选选项 |
| `format.ts` | 时间、文件大小等纯格式化 |
| `use-mobile.ts` | `useIsMobile()`，shadcn 的 `sidebar.tsx` 用它决定走桌面栏还是手机抽屉 |
| `touch.ts` | `TOUCH = 'min-h-11'`，触摸目标 44px 的**唯一落点**，见 [styling.md](styling.md) |

> `use-mobile.ts` 是 `npx shadcn add sidebar` 拉下来的，**落点是 `components.json` 的
> `aliases.hooks` 决定的**。CLI 默认写 `@/hooks`，那会建出本文件上面明令禁止的
> 「按类型切的全局 `hooks/` 目录」，所以 2026-09-21 把它改指 `@/lib`——CLI 自己就落在了
> 这里并 import `@/lib/use-mobile`，不用手改生成出来的源码。**下次拉带 hook 的组件前先看
> 一眼那行配置还在不在**，它被改回去的表现是仓库里凭空多一个 `src/hooks/`。

**`api.ts` 是唯一发请求的地方。** 组件里不出现 `fetch`。见 [http.md](http.md)。

## 路由与页面

`src/routes/` 下每个文件对应一条路由，**只做布局和数据编排**，具体 UI 在 `features/` 里。

路由文件应该短。一个 200 行的路由文件说明业务逻辑漏到了这一层。

## 命名

- React 组件文件 PascalCase，与默认导出同名
- 其余 ts 文件 kebab-case
- 目录 kebab-case

见 [SPEC §7.6](../../../spec/07-naming.md)。

## 不要做的

**不建 `utils.ts` / `helpers.ts` / `common.ts`。** 这三个名字是垃圾桶的别名。

**不手写接口类型。** 从 `api` import，见 [http.md](http.md)。手写一份 `interface Meme` 就意味着接口改了这边不会报错。

**不维护第二份标签列表。** 筛选选项从 [`shared/vocab/`](../../../shared/vocab/README.md) 读。
