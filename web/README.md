# web

Vite + React + TypeScript 的 SPA。生产由 `api` 同域托管构建产物。

**当前状态：只有文档，没有代码。**

开工入口见 [AGENTS.md](AGENTS.md)。

## 计划的结构

```
web/
├─ src/
│  ├─ main.tsx
│  ├─ routes/            页面级组件，与路由一一对应
│  ├─ features/          按业务切：search / import / manage / settings
│  ├─ components/        跨 feature 复用的展示组件
│  ├─ lib/               api 客户端、剪贴板分流、纯函数
│  └─ styles/
└─ public/
```

## 页面

| 路由 | 内容 |
|---|---|
| `/` | 搜索 + 结果网格，主入口 |
| `/browse` | 按情绪 / 场景 / 标签 / 收藏 / 上传者 筛选浏览 |
| `/import` | 导入 + 进度 + 待确认队列 |
| `/settings` | 视觉模型配置、测试连接、自己的打标统计 |
| `/admin` | Embedding 配置、重建索引、用户与邀请码、全站统计 |
| `/login` | 登录 / 邀请码注册 |

## 本地开发

```bash
npm run dev      # :5173，proxy /api → :3000
```

需要 `api` 同时跑着。本地前后端不同域，靠 Vite 的 `server.proxy` 让 cookie 仍然同域。见 [`docs/environments.md`](../docs/environments.md)。

## 契约

- 端点与响应：[SPEC §6](../spec/06-endpoints.md)
- 错误码与客户端行为：[SPEC §2](../spec/02-errors.md)
- SSE 事件：[SPEC §1.4](../spec/01-http.md)
- 筛选选项数据源：[`shared/vocab/`](../shared/vocab/README.md)，**不维护第二份标签列表**

类型走 Hono RPC，从 `api` 直接 import，没有生成步骤。
