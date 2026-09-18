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
| `tagStatus` | 仅本人或 admin 可用，用于「待处理」列表（[§6.6.2](#662-待处理列表)） |

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

`PUT /config/embed` 的响应在配置之外多两个字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `reindexTriggered` | boolean | 本次保存是否换掉了模型 |
| `reindexEnqueuedCount` | number | 本次保存排进重算队列的条数；没换模型、或库里没有向量时为 `0` |

它们回答的是「**这一次保存**有没有引发重算」——`GET /admin/reindex/status` 只能告诉你此刻有没有重算在跑，分不出那是不是你刚才那一下造成的。

**条数不是布尔。** 入队时这个数已经算出来了，退化成 `true` / `false` 是白扔掉信息：管理员点完保存最想知道的就是「这一下牵动了多少条」。它和 `status.stale` 不是一个东西——`stale` 是此刻全局待重算的量，会被并发的手动触发和 worker 的消费改写；这个数是**那一次保存**的记账，不随后续变化。

名字必须带 `Count`。叫 `reindexEnqueued` 而返回数字，客户端写 `=== true` 会**静默**判错——不报错、不告警，只是保存完不跳进度条。

### §6.5.4 重建索引

`POST /admin/reindex` 把所有向量过期的记录排进重算队列，**幂等**——重复调用不会让同一条记录重算两遍。换模型时由 `PUT /config/embed` 自动触发，这个端点是管理员手动补触发用的（[queue.md §6](../api/agents/rules/queue.md) 的「重算过期向量」）。

它的响应体是 `{ enqueuedCount, ...status }`——`enqueuedCount` 是**这一次点击**排进队列的条数，
其余字段与 `GET` 的状态同形，省掉前端触发完再拉一次。`enqueuedCount: 0` 不是错误，
它的意思是「该排的都已经排上了」，幂等本来就该这样。

名字带 `Count` 的理由同 [§6.5.3](#653-配置的对外表示)：这个仓里已经因为一个叫得像布尔的数字
返回过一次契约偏差，同一个概念在两个端点上不能有两个名字。

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

## §6.6 打标状态

> **状态：`proposed`**（2026-09-19）。新增能力，两端确认后转 `accepted`。见[打标状态界面](../joint-tasks/2026-09-19-tagging-status.md)。

导入的终点是 `tag_status = pending`（[§6.2.2](#622-服务端处理顺序)），打标在后台队列里跑。**在补上本节之前，这件事对用户没有任何反馈**——打完了不知道，打失败了也不知道。

这不是新需求，是三处已经写下的承诺一直没有落点：[§5.2.3](05-data-models.md) 说 `needs_manual` 的图「在待处理列表里」，[§6.3.2](#632-浏览) 的 `tagStatus` 参数写着「用于「待处理」列表」，[styling.md](../web/agents/rules/styling.md) 说这类图「角标「需人工」，可点进去补」。**注意「列表」是有的（`GET /memes` 能按 `tagStatus` 筛），缺的是计数和入口**——没人知道有 7 张图卡着，自然也不会去看那个列表。

### §6.6.1 汇总

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/memes/tag-status` | 本人；`admin` 可带 `scope=all` |

```
GET /api/v1/memes/tag-status
```

```
{
  scope: "mine",
  visionConfigured: true,
  counts: { ok: 982, pending: 120, refused: 0, needsManual: 7 },
  running: 2,
  failures: [ { reason: "unreachable", count: 4 }, { reason: "refused", count: 3 } ]
}
```

| 字段 | 含义 |
|---|---|
| `scope` | 回显生效范围，`mine`（缺省）或 `all` |
| `visionConfigured` | 当前生效的视觉通道是否可用。`mine` 看调用者自己的（含部署方默认兜底），`all` 看全站是否有任一可用通道 |
| `counts` | 按 `tag_status` 分组的条数，四个取值全给，没有的写 `0` |
| `running` | 此刻库里 `status = running` 的打标任务数 |
| `failures` | 终局失败的任务按原因分组的条数，降序 |

**`counts.pending` 必须和 `visionConfigured` 一起看才有意义。** 前者是「多少张还没标」，后者回答「它们会不会自己好」——通道不可用时任务不消费、也不计失败重试（[§2.4](02-errors.md) 的 `AI_NOT_CONFIGURED`），**配好之后自动补打标，用户不需要做任何操作**。界面必须把这句话说出来，否则一大批 `pending` 看起来就是卡死了。

**计数口径**：`counts` 只统计 `deleted_at is null` 的记录（[§3.4](03-auth-permission.md)），`scope=all` 同理。同一批图必须和 `GET /memes?uploader=me&tagStatus=X` 的筛选结果一致——两处对不上就是有一个漏了软删过滤。

`failures[].reason` 是**失败类别**，只有 `unreachable` / `refused` / `invalid_output` / `unsupported` / `embed_failed` 五个取值，不是给用户看的文案——中文文案由客户端映射。

**只返回类别，不返回 `tag_jobs.last_error` 原文。** 原文是给日志看的诊断串：格式随时会变，而且随着供应商适配的深入迟早会把上游返回的内容带进来。**类别是契约，诊断串不是**——把诊断串发出去，等于让前端依赖一个从没承诺过的字符串格式，这和 [§2.1](02-errors.md) 不把底层 message 回显给用户是同一条理由。

> ⚠️ **`failures` 里会有 `tag_status = ok` 的图。** `embed_failed` 是「打标成功、向量没算出来」（[§5.2.3](05-data-models.md)），它**不落在 `counts.needsManual` 里**。所以 `sum(failures) ≠ counts.needsManual` 是正常的，不要试图让它们对上，也不要为了对上把它排除——那正是「这张图能被文字搜到、只是进不了向量路」这个状态唯一会被看见的地方。

`running` 取库里的真实值，不是进程内存计数：多副本下它合计所有副本在跑的任务。被 SIGKILL 卡住的 `running` 要到下次进程启动回收（`requeueStaleRunningJobs`）才降下来，在此之前这个数会偏大——这是可接受的近似，**不要为了它去加一个实时对账任务**。

`scope=all` 仅 `admin` 可用，其他角色传它返回 `FORBIDDEN`；缺省是 `mine`，不传参数的普通用户行为与显式传 `mine` 完全一致。

### §6.6.2 待处理列表

**列表复用 [§6.3.2](#632-浏览) 的 `GET /memes`，不新增端点。**

```
GET /api/v1/memes?uploader=me&tagStatus=needs_manual&limit=50
```

`tagStatus` 的参数语义、单值约束与权限在 §6.3.2 / §3.3 已定，本节不重复。视图按状态分开请求（一个 `tagStatus` 一次），因为参数是单值的。

`refused` 当前**不可达**：它要求主副通道都被拒绝，而副通道尚未接入（[§9.5](09-decisions.md) 仍是 `proposed`），所有终局失败都落 `needs_manual`。界面按四个取值全量映射文案，但不为 `refused` 单独做交互。

**`needs_manual` 的图这一版只能看，不能改。** [§6.4](#64-管理) 的 `PATCH /memes/{id}` 与 `POST /memes/retag` 都还没实现，所以「人工补」这一步没有落点。本节只保证这些图**可见、且能看出是什么原因失败的**，补标动作随 §6.4 一起做——不要在 §6.4 之外另造一个「重试」端点，那会让同一个语义有两条实现。
