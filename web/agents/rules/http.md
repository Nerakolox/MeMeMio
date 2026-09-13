# 接口调用

契约见 [SPEC §1](../../../spec/01-http.md)、[§2](../../../spec/02-errors.md)、[§6](../../../spec/06-endpoints.md)。

## 1. 只有一个地方发请求

`src/lib/api.ts`。**组件里不出现 `fetch`。**

用 Hono RPC 客户端，类型从 `api` 直接 import，没有生成步骤、不手写接口类型。

## 2. 响应没有 `data` 包装

成功响应就是资源本身，错误响应是 `{ error: { code, message, requestId, details } }`。**不要再包一层**。

## 3. 按 `code` 分支，不解析 `message`

```ts
// ✗ 措辞改了就坏
if (err.message.includes('权限')) { ... }

// ✓
if (err.code === 'FORBIDDEN') { ... }
```

`message` 是中文、面向用户、可直接展示，但**它随时可能改措辞**。

各错误码的客户端行为在 [SPEC §2.2](../../../spec/02-errors.md) 里有表：

| code | 做什么 |
|---|---|
| `UNAUTHENTICATED` | 跳登录页，**保留当前路由用于回跳** |
| `FORBIDDEN` | 展示 message，**不跳转** |
| `NOT_FOUND` | 空状态 |
| `QUOTA_EXCEEDED` | 展示剩余配额并**停止后续上传** |
| `RATE_LIMITED` | 按 `Retry-After` 退避 |
| `INTERNAL` | 展示 `requestId`，提示重试 |

**必须展示 `requestId`。** 用户报问题时它是唯一能对上服务端日志的东西。

## 4. 未知错误码要有兜底

服务端可能新增错误码（那是[兼容变更](../../../spec/08-collaboration.md)）。`switch` 必须有 `default` 分支，显示 `message` + `requestId`。

**不要因为遇到没见过的 code 就白屏。**

## 5. 降级不是错误

这三种情况**不能当错误处理**：

| 情况 | 怎么显示 |
|---|---|
| `degraded: true` | 结果区顶部提示「结果可能不全」，**照常展示结果** |
| `tagStatus: pending` / `needs_manual` | 卡片角标，不是错误色 |
| 测试连接不通过（HTTP 200） | 在设置页内展示诊断结果，**不弹错误 toast** |

测试连接**不通过也返回 200**——它是一次诊断，不是一次失败的操作。把它当成 HTTP 错误处理会丢掉响应体里的 `rawResponse`，而那是[那个接口的全部价值](settings-ux.md)。

## 6. 会话

cookie 自动带，**不手动加 Authorization header**。前后端同域（本地靠 Vite proxy）。

启动时第一个请求是 `GET /auth/me`，401 就跳登录页。

## 7. SSE

导入进度用 `EventSource` 订阅 `/imports/{batchId}/events`，事件类型见 [SPEC §1.4](../../../spec/01-http.md)。

三条要求：

- **必须在 `useEffect` 的清理函数里 `close()`**，否则路由切走后还在跑
- **断线后用 `GET /imports/{batchId}` 补齐**，不要只靠重连——中间漏掉的事件不会重发
- `done` 事件后主动关闭连接

## 8. 分页

搜索**不分页**（三路融合后只返回前 N 条）。浏览用游标分页，`cursor` 原样回传，**不解析它的内容**。

游标是不透明字符串。解析它的格式等于依赖服务端实现细节。

## 9. 幂等

导入用内容哈希做幂等，重复提交同一批不会产生重复记录。但**前端仍要禁用已点击的提交按钮**——幂等是安全网，不是让用户重复点的理由。
