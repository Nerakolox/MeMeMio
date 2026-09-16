# §6 端点

[返回索引](INDEX.md)

全部以 `/api/v1` 为前缀。请求 / 响应约定见 [§1](01-http.md)，错误见 [§2](02-errors.md)，权限见 [§3.3](03-auth-permission.md)。

## §6.1 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | `{ inviteCode, name, password }` → 建会话并返回 User |
| POST | `/auth/login` | `{ name, password }` → 建会话并返回 User |
| POST | `/auth/logout` | 204 |
| GET | `/auth/me` | 当前用户；未登录返回 `UNAUTHENTICATED` |

`/auth/me` 是 SPA 启动时的第一个请求，返回 401 即跳登录页。

| 方法 | 路径 | 权限 |
|---|---|---|
| GET / POST | `/admin/invites` | admin，列出 / 生成邀请码 |
| GET | `/admin/users` | admin |
| PATCH | `/admin/users/{id}` | admin，仅能改 `role` 和 `storageQuotaBytes` |

## §6.2 导入

### §6.2.1 上传

前端预签名直传 R2，文件字节不经过 `api`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/imports` | `{ files: [{ fileName, sizeBytes }] }` → `{ batchId, uploads: [{ fileName, uploadUrl, tempKey }] }` |
| POST | `/imports/{batchId}/commit` | `{ items: [{ fileName, tempKey }] }` → 触发服务端处理，202 |
| GET | `/imports/{batchId}` | 批次当前状态，SSE 断线后用它补齐 |
| GET | `/imports/{batchId}/events` | SSE，见 [§1.4](01-http.md) |

签发预签名 URL 前检查配额；`commit` 时再检查一次，因为期间可能有并发上传。

### §6.2.2 服务端处理顺序

这个顺序是契约的一部分，不是实现细节——它决定了用户看到什么结果、以及花不花 AI 的钱：

```
magic bytes 探测真实格式（不信扩展名）
  → SHA-256 查库 → 精确命中 → exact_dup，静默跳过，删除暂存对象
  → pHash 计算 → 全库 Hamming 扫描 → 近似命中 → needs_review，不阻塞批次，不打标
  → 两关都过 → 写入 memes（tag_status = pending）→ 进打标队列
```

**近似命中的图先不打标**，等用户确认「仍然导入」后才进队列——否则被判为重复的那些白花钱。

**去重在调 AI 之前。** 表情包库重复率极高，先去重直接省掉相应比例的 AI 调用；用户自带 key 之后，这是在省用户自己的钱。

### §6.2.3 待确认队列

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/imports/reviews` | 当前用户全部待确认条目，跨批次 |
| POST | `/imports/reviews/{batchId}/{fileName}` | `{ action: "import" \| "skip" }` |

响应条目包含双方信息供并排对比：

```
{
  fileName, tempUrl, sizeBytes, width, height,
  distance,
  existing: { id, url, uploaderName, sizeBytes, width, height, createdAt } | null
}
```

**`existing` 可为 `null`。** 条目进队列后，被判为近似重复的那张已有图可能被软删——读路径按 [§3.4](03-auth-permission.md) 必须过滤 `deleted_at is null`，于是关联对象取不到。此时**不删除条目、也不自动入库**：客户端展示「原图已不存在」，`distance` 仍然显示，「仍然导入」/「跳过」两个操作照常可用。理由见 [§9.7](09-decisions.md)——系统不替用户猜，即使重复的理由已经消失，决定权仍在用户手上。

`tempUrl` 同样可为 `null`（暂存对象已过期清理），客户端展示「预览已过期」，不渲染空 `src`。

**不弹中途确认框。** 上千张图导入时每张都弹窗体验会崩掉，所以近似命中不阻塞导入，攒进队列、导入结束后一起处理。队列里只有 1 条时前端把它呈现成即时弹窗即可——**同一个接口，不同的呈现形式**，不为单张上传另做一套。

## §6.3 搜索与浏览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/search` | 主入口，三路融合 |
| GET | `/memes` | 按条件浏览，游标分页 |
| GET | `/memes/{id}` | 单条 |

### §6.3.1 搜索

```
GET /search?q=今天真的不想上班&limit=50
```

响应：

```
{
  items: [ { ...Meme, matchedBy: ["vector", "ocr"] } ],
  degraded: false,
  rewritten: "一只趴在桌上的猫，看起来非常疲惫"
}
```

`matchedBy` 说明这条是被哪几路召回的，供前端做轻量提示，**不用于排序**——排序由服务端的 RRF 融合决定，客户端不重排。

`degraded: true` 表示本次搜索没有走向量通路（重建索引期间，或 embedding 未配置），只用了 OCR 和标签。前端应当告知用户结果可能不全，但**不阻断搜索**。

**`degraded` 说的是本次查询走了几路，不是库里每条记录被索引得多全。** 单条记录可能 `tag_status = ok` 但 `embedding` 为 null（打标成功、向量化失败，向量化会单独重试）。这种图不出现在向量路的召回里，但仍能被 OCR 和标签搜到，而 `degraded` 仍然是 `false`——因为向量路本身是通的。**不要用 `degraded` 判断某一张图有没有被索引**，那是两个不同层次的问题；分级降级的理由见 [§9.5](09-decisions.md)。

`rewritten` 是 HyDE 改写后的查询，返回它是为了让用户理解「为什么搜出这些」，可以不展示。改写失败时为 `null`，不影响其余通路。

**搜索不分页。** 三路融合后只返回前 N 条，默认 50、最大 100。用户只看前几个结果，翻页没有意义。

RRF 参数、HyDE 提示词、各通路权重都是 `api` 的实现约束，不在本规范定义，见 `api/agents/rules/retrieval.md`。

### §6.3.2 浏览

```
GET /memes?emotions=无语&tags=猫&isAnimated=true&favorited=true&uploader=me&cursor=...
```

| 参数 | 说明 |
|---|---|
| `emotions` / `scenes` / `tags` | 可重复，多值之间是 AND |
| `isAnimated` | 布尔 |
| `favorited` | `true` 时只返回当前用户收藏的 |
| `uploader` | `me` 或用户 id |
| `tagStatus` | 仅本人或 admin 可用，用于「待处理」列表 |

**`uploader` 和 `favorited` 是筛选项，不是安全边界。** 不传就是全库，这是设计本身，见 [§0.1](00-overview.md)。

## §6.4 管理

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| PATCH | `/memes/{id}` | 所有人 | 改 `description` / `emotions` / `scenes` / `tags`，写 `edited_by` |
| DELETE | `/memes/{id}` | 上传者或 admin | 软删，204 |
| POST | `/memes/{id}/restore` | 上传者或 admin | 撤销软删 |
| PUT / DELETE | `/memes/{id}/favorite` | 所有人 | 收藏 / 取消 |
| POST | `/memes/retag` | 上传者或 admin | `{ memeIds[] }` 或 `{ filter: {...} }`，批量重打标 |
| GET | `/memes/duplicates` | 所有人 | 主动查重，异步任务 |

`PATCH /memes/{id}` 的标签值必须在词表内，见 [§4.5](04-vocabulary.md)。人工编辑和模型输出走同一套校验，不开后门。

`POST /memes/retag` 用**调用者自己配置**的视觉模型，除非 admin 显式指定 `useDefaultConfig: true`——这是 admin 修复「别人用差模型污染公共库」的兜底手段，见 [§9.3](09-decisions.md)。

## §6.5 配置与测试连接

| 方法 | 路径 | 权限 |
|---|---|---|
| GET / PUT | `/config/vision` | 本人 |
| POST | `/config/vision/test` | 本人 |
| GET / PUT | `/config/embed` | admin |
| POST | `/config/embed/test` | admin |
| POST | `/admin/reindex` | admin |
| GET | `/admin/reindex/status` | admin |

### §6.5.1 测试连接是这里最重要的接口

用户会填各种中转服务，实际行为经常与文档不符。**不让用户手填能力、也不假设任何能力，全部实测。**

视觉测试响应：

```
{
  ok: true,
  canReceiveImage: true,
  jsonModeWorks: true,        // response_format: json_object
  multiImageWorks: false,     // 不支持则动图回退拼图模式
  vocabCompliant: true,       // 返回的标签是否落在词表内
  rawResponse: "..."          // 模型原始返回，失败时必须原样带回
}
```

Embedding 测试响应：

```
{
  ok: true,
  nativeDim: 2560,            // 实测，不信文档、不让人填
  dimParamWorks: true,        // dimensions 参数是否生效
  willTruncate: true,         // 需要客户端截断 + 重新归一化
  rawError: null
}
```

**`rawResponse` / `rawError` 是这个接口的核心价值**——失败时把模型的原始返回原样展示出来，用户才能判断是模型能力问题还是配置填错。不要吞掉它，也不要包装成友好文案。

### §6.5.2 测试不通过不允许保存

`PUT /config/*` 校验该配置组合已有成功的测试记录（按 baseUrl + model 匹配），否则返回 `CONFIG_TEST_REQUIRED`。

Embedding 实测维度 < 1024 直接拒绝保存，返回 `EMBED_DIM_TOO_SMALL`。

更换 embedding 模型且库里已有数据时，`PUT` 需要带 `confirmReindex: true`，否则返回 `EMBED_MODEL_CHANGED`。确认后自动触发全站重建索引，期间搜索降级（`degraded: true`），不中断服务。理由见 [§9.6](09-decisions.md)。

**测试记录由服务端保存，客户端不参与。** 探测结果字段不接受客户端写入（[§5.3](05-data-models.md)），所以「测过了」这件事不能靠前端回传——`POST /config/*/test` 必须把结果存在服务端，`PUT` 从那条记录里抄探测结果写进配置行。存法属实现细节，但记录里**不保存 key 明文或密文**。

匹配三要素：**baseUrl + model + key 指纹**（key 的 SHA-256，只用于比对）。比 §6.5.2 开头那句多一个 key——key 恰恰是最常填错的那一项，只按 baseUrl + model 匹配会让「换了 key 没测就保存」通过校验，而那正是最需要挡住的情况。

### §6.5.3 配置的对外表示

`GET /config/vision`：

```
{
  source: "user" | "default",     // 当前生效的是自己的配置还是部署方默认
  baseUrl: "https://...",         // source=default 时回显部署方默认值
  model: "...",
  apiKey: "****1234",             // 固定 "****" + 后四位；未配置时 null
  verifiedAt: "2026-09-16T...",   // 没通过过测试则 null
  jsonModeWorks: true,            // 探测结果，未测过则 null
  multiImageWorks: false
}
```

`GET /config/embed` 同构，能力字段换成 `nativeDim` / `dimParamWorks`。

`PUT /config/*` 与 `POST /config/*/test` 的请求体同形，只有 `baseUrl` / `model` / `apiKey` 三个字段——**探测结果字段不出现在请求体里**。`apiKey` 传脱敏串视为「不修改」（[§3.5](03-auth-permission.md)）；此前没配过 key 时传脱敏串等于没传，返回 `VALIDATION_FAILED`。

测试要能在保存之前跑，所以 `POST /config/*/test` 接受尚未保存的配置；它不改变当前生效的配置。

### §6.5.4 重建索引

`POST /admin/reindex` 把所有向量过期的记录排进重算队列，**幂等**——重复调用不会让同一条记录重算两遍。换模型时由 `PUT /config/embed` 自动触发，这个端点是管理员手动补触发用的（[queue.md §6](../api/agents/rules/queue.md) 的「重算过期向量」）。

**重算只重算 embedding。** 从 `search_text` 重新生成向量，不重新调视觉模型、不改 AI 产出字段——换 embedding 模型不影响打标结果，重跑视觉是白花钱。

`GET /admin/reindex/status`：

```
{
  running: boolean,      // 队列里还有未完成的重算任务
  total: number,         // 有向量的非软删记录数
  done: number,          // embed_model 与当前配置一致的条数
  stale: number,         // 待重算
  failed: number         // 重试耗尽的条数，需要看日志
}
```

进度必须来自库里的真实计数，**不能是进程内存里的计数器**——重启后内存计数归零，进度条会从头开始，那是假的。失败的条目留在队列里不做断点续传（[queue.md §7](../api/agents/rules/queue.md)），`stale` 长时间不降就是出了问题。

`running` 为真时搜索必须返回 `degraded: true`（[§6.3.1](06-endpoints.md)），因为此时库里的向量一部分属于旧模型，向量路的结果不可信。判断这一条的查询会落在每个搜索请求上，必须是索引命中的存在性查询或带短期缓存，不能是全表 count。
