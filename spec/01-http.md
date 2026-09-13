# §1 HTTP 与 SSE

[返回索引](INDEX.md)

## §1.1 URL 与信封

所有业务接口以 `/api/v1` 开头。其余路径由 `api` 返回 `web` 的静态产物，SPA 路由回退到 `index.html`。

成功响应直接返回资源或集合，不包一层 `{ data: ... }`：

```
GET /api/v1/memes/{id}     → 200  { id, storageKey, ... }
GET /api/v1/memes          → 200  { items: [...], nextCursor: "..." | null }
```

失败响应结构见 [§2.1](02-errors.md)。区分成功与失败只看 HTTP 状态码，不看响应体里的布尔字段。

写操作成功返回被修改后的完整资源，避免客户端再查一次。删除返回 `204`。

## §1.2 时间

所有时间字段为 ISO 8601 UTC 字符串，带 `Z` 后缀，精确到秒：`2026-09-13T07:30:00Z`。

服务端不返回本地时区时间，也不返回 Unix 时间戳。客户端按浏览器时区展示，**展示格式不改变传输值**。

## §1.3 分页

列表接口使用游标分页，不用 offset。

| 参数 | 说明 |
|---|---|
| `limit` | 默认 40，最大 100 |
| `cursor` | 上一页返回的 `nextCursor`，首页不传 |

响应的 `nextCursor` 为 `null` 表示没有更多。游标是不透明字符串，客户端不解析、不构造。

搜索接口不分页——三路融合后只返回前 N 条（默认 50），再多没有意义。见 [§6.3](06-endpoints.md)。

## §1.4 SSE：导入进度

导入是异步的。上传完成后客户端持有一个 `batchId`，通过 SSE 订阅该批次的进度：

```
GET /api/v1/imports/{batchId}/events      Accept: text/event-stream
```

事件类型：

| event | data | 何时发送 |
|---|---|---|
| `progress` | `{ total, done, skipped, pending }` | 每处理完一个文件，或每 1 秒（取较慢者） |
| `item` | `{ fileName, result, memeId? , reason? }` | 单个文件有结论时 |
| `done` | `{ total, imported, exactDup, needsReview, failed }` | 批次全部处理完 |
| `error` | `{ code, message }` | 批次级失败，之后连接关闭 |

`item.result` 取值：`imported` / `exact_dup` / `needs_review` / `failed`。`needs_review` 表示进了待确认队列，见 [§6.2.3](06-endpoints.md)。

**连接断开不影响服务端处理。** 导入在服务端队列里继续跑，客户端重连同一个 `batchId` 会收到当前累计状态的 `progress`，再继续增量。批次状态保留 24 小时。

客户端**不能**把 SSE 当作唯一的结果来源——重连失败或页面关闭后重开时，用 `GET /api/v1/imports/{batchId}` 拉一次当前状态。

## §1.5 幂等

上传接口以文件内容哈希去重，重复上传同一文件不产生第二条记录，返回已有记录并标记 `exact_dup`。详见 [§6.2](06-endpoints.md) 与 [§9.7](09-decisions.md)。

其余写操作不要求幂等键。编辑和删除是最后写入生效，本项目并发编辑同一张图的概率极低，不引入版本比较。
