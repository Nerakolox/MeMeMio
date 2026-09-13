# 目录结构

## 按业务切，不按类型切

```
src/features/
├─ search/       搜索框、结果网格、结果卡片
├─ browse/       筛选器、无限滚动
├─ import/       上传、SSE 进度、待确认队列
├─ manage/       编辑标签、删除、待处理列表
└─ settings/     用户设置、管理页
```

每个 feature 内部自己分文件，**不建全局的 `components/Button`、`hooks/`、`types/` 这种按类型切的目录**——那会让「改搜索」变成在四个目录之间来回跳。

`src/components/` 只放**真正跨 feature 复用**的展示组件（按钮、对话框、标签选择器）。判断标准：**被两个以上 feature 用到**。只有一个 feature 用的组件留在那个 feature 里，哪怕它看起来很通用。

## `src/lib/`

| 文件 | 内容 |
|---|---|
| `api.ts` | Hono RPC 客户端，**唯一发请求的地方** |
| `clipboard.ts` | 复制 / 下载 / 分享的分流，见 [clipboard-share.md](clipboard-share.md) |
| `vocab.ts` | 读 `shared/vocab/vocab.json`，提供筛选选项 |
| `format.ts` | 时间、文件大小等纯格式化 |

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
