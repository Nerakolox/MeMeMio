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
| GET | `/memes` | 按条件浏览，游标分页；`random=true` 时改为随机抽样 |
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

`degraded: true` 表示**本次搜索的向量通路没有覆盖全库**，只靠文本和标签补齐。两类情况会置位：

| 情况 | 向量路 |
|---|---|
| embedding 未配置，或编码 / 查询失败 | 完全没跑 |
| 有记录的 `embed_model` 与当前配置不一致（重算进行中、或重算任务卡在 `failed`） | 跑了，但**只在当前模型的向量里跑**，旧模型那部分召不回 |

前端应当告知用户结果可能不全，但**不阻断搜索**。

> **向量路按 `embed_model = 当前模型` 过滤，而不是整条路停摆。** 两个模型的向量在同一个空间里比距离是没有意义的——它们的余弦相似度不是「更像」，只是噪声，混进 RRF 会把无关的图推到前面。但换模型期间把向量路整条关掉又太狠：已经重算完的那部分是好的。所以过滤而非停摆，同时用 `degraded` 诚实地说「这次没覆盖全」。见 [§9.20](09-decisions.md)。

**`degraded` 说的是本次查询的召回覆盖，不是库里每条记录被索引得多全。** 单条记录可能 `tag_status = ok` 但 `embedding` 为 null（打标成功、向量化失败，向量化会单独重试）。这种图不出现在向量路的召回里，但仍能被文本和标签搜到，而 `degraded` 仍然是 `false`——因为向量路本身是通的、口径也是全库的。**不要用 `degraded` 判断某一张图有没有被索引**，那是两个不同层次的问题；分级降级的理由见 [§9.5](09-decisions.md)。

`rewritten` 是 HyDE 改写后的查询，返回它是为了让用户理解「为什么搜出这些」，可以不展示。改写失败时为 `null`，不影响其余通路。**它是一个字符串，不是结构化的查询理解结果**——改写只喂给向量路，不参与过滤。

**查询里的否定条件是过滤，不是打分。** 「不要真人」「别动漫」这类明确排除，在三路召回之前就把对应标签的图剔掉，不靠排序把它们压下去。模型推断出的偏好只加分，用户写死的条件才过滤。

**搜索不分页。** 三路融合后只返回前 N 条，默认 50、最大 100。用户只看前几个结果，翻页没有意义。

RRF 参数、HyDE 提示词、各通路权重都是 `api` 的实现约束，不在本规范定义，见 `api/agents/rules/retrieval.md`。

### §6.3.2 浏览

```
GET /memes?emotions=无语&tags=猫&isAnimated=true&favorited=true&uploader=me&cursor=...
```

| 参数 | 说明 |
|---|---|
| `expressions` / `emotions` / `tones` / `purposes` / `scenes` / `tags` / `ratings` | 七个词表维度（[§4.3](04-vocabulary.md)），各自可重复，**所有值之间都是 AND** |
| `isAnimated` | 布尔 |
| `favorited` | `true` 时只返回当前用户收藏的 |
| `uploader` | `me` 或用户 id |
| `tagStatus` | 仅本人或 admin 可用，用于「待处理」列表（[§6.6.2](#662-待处理列表)） |
| `limit` | 单页条数，默认 40、最大 100。`random=true` 时它同时是**抽样条数** |
| `random` | `true` 时随机抽样，见下 |

**`uploader` 和 `favorited` 是筛选项，不是安全边界。** 不传就是全库，这是设计本身，见 [§0.1](00-overview.md)。

#### `random=true`：随机抽样

> **状态：`accepted`**（2026-09-19 新增并转正）。兼容性新增能力，两端已确认。见[首页随机图墙](../joint-tasks/2026-09-19-home-random-grid.md)。
>
> 它**已经是线上行为**（两端已实现并在真库上跑通），但还没进 `stable`——`stable` 要等联合验收归档时由总管转，见 [§8.1](08-collaboration.md)。

```
GET /memes?random=true&limit=10
```

```
{ items: [ ...Meme ], nextCursor: null }
```

首页要有一屏「随便看看」，**它在全库里抽**，不是「最新的 N 张里抽几张」。这个区别是本节存在的理由：只在新图里随机的话，库用上三个月之后，用户按一百次刷新也见不到那张三个月前的图，而「把老图重新翻出来」正是这个入口唯一的用途。

- **抽样发生在所有筛选之后。** 七个词表维度 / `isAnimated` / `favorited` / `uploader` / `tagStatus` 照常生效，软删记录照常排除（[§3.4](03-auth-permission.md)）。**随机不绕过任何过滤**——这是实现时最容易出错的地方：`order by random()` 写起来太顺手，条件漏掉也不会报错，只会让别人的图或已删的图出现在首页。
- **`nextCursor` 恒为 `null`。** 随机序没有「下一页」这个概念，给出游标只会让客户端把「随机的第二页」接在「随机的第一页」后面，而那看起来像正常翻页。
- **与 `cursor` 互斥**：同时传返回 `VALIDATION_FAILED`。不静默忽略其中一个——忽略哪个都是客户端看不出错的错误结果。
- 返回顺序由抽样决定，**客户端不应假设任何顺序**（不保证与 `created_at` 有关）。
- `random` 是**兼容性新增**（[§8.3](08-collaboration.md)）：不传时行为与本节此前完全一致。

抽样怎么实现（`order by random()` 的扫描代价、什么规模要换方案）是 `api` 的实现约束，不在本规范定义，见 `api/agents/rules/database.md`。

## §6.4 管理

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| PATCH | `/memes/{id}` | 所有人 | 改 `description` 与七个词表维度数组，写 `edited_by` |
| DELETE | `/memes/{id}` | 上传者或 admin | 软删，204 |
| POST | `/memes/{id}/restore` | 上传者或 admin | 撤销软删 |
| PUT / DELETE | `/memes/{id}/favorite` | 所有人 | 收藏 / 取消 |
| POST | `/memes/retag` | 上传者或 admin | `{ memeIds[] }` 或 `{ filter: {...} }`，批量重打标 |
| GET | `/memes/duplicates` | 所有人 | 主动查重，异步任务 |

`PATCH /memes/{id}` 的标签值必须在词表内，见 [§4.5](04-vocabulary.md)。人工编辑和模型输出走同一套校验，不开后门。

`POST /memes/retag` 的语义见 [§6.4.3](#643-post-memesretag-的语义)——**实现口径与本节原措辞有一处已知偏差**（每张图用**其上传者**的配置，不是调用者的），那节说明了原因与它落不了地的部分。

### §6.4.1 `PATCH /memes/{id}` 的语义

> **状态：`accepted`**（2026-09-19 细化）。路径与权限自始为 `accepted`，本节补的是请求体与错误码——这些不定死，两端会各写一个。见[浏览页图片操作](../joint-tasks/2026-09-19-browse-meme-actions.md)。

请求体**只接受八个字段**：`description` / `expressions` / `emotions` / `tones` / `purposes` / `scenes` / `tags` / `ratings`。其余字段（**包括 `ocrText`**）出现在请求体里即 `VALIDATION_FAILED`（[§2.2](02-errors.md)）。

部分更新：**没出现的字段不动**。三种传法含义不同，实现必须区分：

| 传法 | 含义 |
|---|---|
| 字段不出现 | 不改这个字段 |
| `description: null` | 清空描述 |
| `tags: []` | 清空这个维度的标签 |

七个数组的每个元素必须在**对应维度**的词表内（[§4.5](04-vocabulary.md)，含 alias 归一化）。一个词属于哪个维度是确定的——`微笑` 是 `expressions`，传进 `emotions` 里同样是不合法值。**不在词表内返回 `VALIDATION_FAILED`，不是 `AI_INVALID_OUTPUT`**——后者（[§2.4](02-errors.md)）描述的是模型输出的失败，会走重试与降级；人工编辑是一次普通请求，客户端要展示的是「这个词不在词表里，请从列表里选」。**约束是同一套，错误码不是**，两者混用的表现是编辑失败时前端去等一个永远不会来的 AI 降级。

**`ocrText` 不可编辑**（它在库里是 `ocr_text`，[§5.2.3](05-data-models.md)）。它是模型对图像的读数，人工改它会让文本和图不再对应，而 `search_text` 会忠实转发这个错——一条搜出来的 OCR 文本和图上的字对不上，没有任何地方会报错。它是打标结果，要重来只能靠 `POST /memes/retag`，不是靠手改。

`edited_by` / `edited_at` 与内容字段**在同一条 UPDATE 里写**（[§3.3](03-auth-permission.md)）。**`search_text` 也必须在那一条里重算**——[§5.2.3](05-data-models.md) 那句「任一来源变更时必须重算」的落点就是这里，拆成两条语句中间崩掉会留下一条文本与标签对不上的记录，不报错。

响应是**更新后的完整 Meme**，与 `GET /memes/{id}` 同形（[§1.1](01-http.md)）。客户端据此就地更新列表，不再拉一次。

**并发编辑是最后写入者赢，不做冲突检测、不做 ETag。** 共享库里所有人都能编辑（[§9.1](09-decisions.md)），两个人同时改一张图的概率不低，而「谁赢了」没有正确答案可言。客户端因此**不维护影子副本**（[state-navigation.md §2](../web/agents/rules/state-navigation.md)）——那条规则的第一个真实后果就在这个端点上。

#### 编辑会让向量陈旧，本次不处理

改了 `description` 或三个数组就改了 `search_text`（[§5.2.3](05-data-models.md)），而它的 `embedding` 是拿旧文本算的。

**不自动重算，也不自动入队。** 两条理由都不是图省事：

1. **Embedding 走部署方的 key，而编辑对全员开放**（[§9.3](09-decisions.md)、[§3.3](03-auth-permission.md)）。每次编辑重算一次向量，等于给所有人开了一条烧部署方预算的路径，而这条路径上没有任何东西需要它——被改的字段本来就落在 `pg_trgm` 与标签过滤两路上，向量陈旧只让这一张图在语义检索里偏后。
2. 手动 [`POST /admin/reindex`](#654-重建索引) 已经覆盖它，管理员点一次就能补。

代价要如实记下：**被编辑过的图，语义检索质量会下降，而 `GET /admin/reindex/status` 的 `stale` 看不见它**——那个数的口径是 `embed_model` 与当前模型不一致，而编辑不改 `embed_model`。所以「`stale: 0` 但搜出来不对」不是 bug，是本节写下的取舍。增量重算是独立任务，见 [§9.19](09-decisions.md)。

### §6.4.2 `DELETE /memes/{id}` 的语义

> **状态：`accepted`**（2026-09-19 细化）。同上。

软删（[§5.2.5](05-data-models.md)），**204**。R2 上的对象 30 天后由定时任务物理删除，此时才从配额中释放。

**不幂等：对一条已软删的记录再调一次返回 `NOT_FOUND`，不是 204。** 与收藏那两条刻意不同——那两条幂等是因为前端会重发（双击、断网重试、乐观更新回滚），而**删除不做乐观更新**（[state-navigation.md §8](../web/agents/rules/state-navigation.md)），客户端不会在没看到结果的情况下再发一次。剩下的重复调用只可能来自「这张图已经不在列表里了」，此时 404 比 204 诚实：它同时是「别人已经删了」和「你删过了」的同一个答案。客户端把 404 当成功处理即可（那张图本来就要从列表里消失）。

**软删记录连 `PATCH` 也够不着**：改一条已删的图返回 `NOT_FOUND`，不是 `FORBIDDEN`、也不静默成功。这是 [§3.4](03-auth-permission.md) 软删过滤在写路径上的样子——先查（`deleted_at is null`）再判权限，查不到就把 `NOT_FOUND` 抛出去，归属检查根本没机会跑。

### §6.4.3 `POST /memes/retag` 的语义

> **状态：`accepted`**（2026-09-22）。路径与权限自始为 `accepted`（§6.4 那张表），本节把实现语义定死并**修正一处此前的措辞偏差**。见[批量重打标](../joint-tasks/2026-09-22-retag-endpoint.md)。

**用途：让已有的图按当前的提示词与词表重跑一遍视觉模型。** 它是 §6.6.2 那张表里的「换个配置重跑视觉模型」那一行，也是 `needs_manual` 的图**唯一**能被模型重新处理的路。改提示词或改词表之后，存量图不会自己更新——没有这个接口就只能靠人工逐张 `PATCH`。

请求体**两个形状，恰好给一个**：

| 形状 | 含义 |
|---|---|
| `{ memeIds: string[] }` | 指定这几张 |
| `{ filter: { uploader?, tagStatus? } }` | 按条件选中一批 |

**都给或都不给 → `VALIDATION_FAILED`**，不是「取并集」也不是「默认全库」。未知键出现在请求体里即 `VALIDATION_FAILED`（与 [§6.4.1](#641-patch-memesid-的语义) 同一条规则，包括与本节无关的 `useDefaultConfig`）。`memeIds: []` 是**合法的空集**，返回 `enqueuedCount: 0`——**不能**退化成「全库」；空数组和「没给这个字段」在客户端看起来都像「什么都没传」，把前者当后者解释的表现是「想重打一张，结果全库付了一遍钱」。

`filter.uploader` 取 `'me'` 或 uuid，`filter.tagStatus` 取四个状态之一。**`tagStatus` 先校验枚举、再判角色**（[§3.3](03-auth-permission.md) 的同一顺序）：一个非法枚举值不论调用者是谁都返回 `VALIDATION_FAILED`，不能因为「反正要 403 了」就跳过校验——那会让 `scope=foo` 那类静默越权在别处重演。`filter.uploader` 指向别人时非 admin 返回 `FORBIDDEN`，**不是静默收窄到自己**。

```
{ enqueuedCount: 74, skippedEditedCount: 1, skippedUnconfiguredCount: 0 }
```

三个计数**都带 `Count` 后缀**（[§6.5.3](#653-配置的对外表示) 的理由：叫得像布尔的数字会让客户端写 `=== true`，静默判错）。`enqueuedCount` 是**本次真正入队**的条数，不是选中条数——重复触发（上一轮还没跑完就又点一次）时已经处于 `pending` 的行不再计入，所以**对同一批连续调两次，第二次是 `0`**。

#### 不碰人工编辑过的图

**`edited_by` 非空的行直接跳过，计入 `skippedEditedCount`，不入队、不改它的 `tag_status`。** 九个字段（`description` 与七个词表维度数组、`ocrText`）是**破坏性覆盖**，重打会连同人补的标签一起换掉，而人工编辑没有任何自动留痕。§6.6.2 把「人工补」和「重跑模型」分成两条路，这里就是那条分界线的落点：**机器输出不该冲掉人的工作。**

代价要如实记下：**被跳过的图不会因此获得新的维度。** 词表新增一维之后，人工编辑过的那张图会**永久**保留空数组——`edited_by` 不会被清，仓库里也没有「取消编辑」的路径。出路是管理员用 `PATCH /memes/{id}` 人工补上那一维（[§6.4.1](#641-patch-memesid-的语义)）。要真的重跑它，得先接受人工编辑被覆盖。

#### 入队即置回 `pending`

入队与 `tag_status = 'pending'` 在**同一个事务**里提交（`queue.md §2`），这是选型的一部分，不是顺手的：

1. **进度唯一的可见来源就是它。** 重打没有自己的状态，跑完库里也没有「这张被重打过」的痕迹；界面轮询 [§6.6.1](#661-汇总) 的计数才看得到进展。不改 `tag_status` 的话，界面在整段时间里一动不动。
2. **它同时关掉了一条会让重打静默失效的快速路径。** `tagging.ts` 对「`tag_status = ok` 且无向量但有文本」的图只重算向量、**不调视觉**（那是省钱的正规分支）。只重置队列行、不改 `tag_status` 的话，这批图会被接口算作成功入队、花掉 embedding 的钱、**标签一个都不变**。

⚠️ 但要说完整：**重打一次并不持久地修好「`ok` 且无向量」这个群体。** 视觉成功之后 embedding 仍可能终局失败，图会回到 `ok` + 空向量，快速路径**重新武装**。只有成功的 embedding 才真的关掉它。

**正在跑（`status = running`）的行不能被改回 `pending`。** 消费端只看 `pending` 认领，重置一个在跑的行会让第二个 worker 认领同一条、**同一张图付两次钱**。所以入队只更新非 `running` 的行，且 `tag_status` 的置回**必须依据更新真的命中了哪些行**，不能依据传入的 id 列表——否则某个 id 因为 `running` 被跳过时，它的图仍被翻成 `pending`，两个写入互相矛盾。

#### 配置口径：用上传者的，不是调用者的

**每张图用它自己上传者的视觉配置。** 这与 §6.4 原先那句「用调用者自己配置的模型」不同，是**实现口径的既成事实**，本次把文档改成与实现一致，而不是反过来。

原因是结构性的：消费端在后台队列里跑，**没有请求上下文**，拿不到「谁点的这个按钮」。配置解析的入参只有图的 `uploaderId`。要真按调用者的配置跑，需要给 `tag_jobs` 加一列存配置快照、并把它串到 `resolveVisionConfig`——那是 [§9.3](09-decisions.md) 里「管理员兜底」那条设想的**前置条件**，不是一次改动能顺带做的。所以：

- **`useDefaultConfig` 在 v1 被拒绝（`VALIDATION_FAILED`），不是被忽略。** 它落在请求体里就按未知键处理。接受一个不生效的参数比拒绝它更坏——管理员会以为兜底生效了。
- **由此，§9.3 设想的「admin 对任意图片重新打标」目前只在「图的上传者自己配了通道」时成立。** 全站都没配的用户，其图重打不了。这是**已知缺口**，不是缺陷。
- 「没配通道就不入队」必须**逐个上传者判定**，不能用「全站是否配置过」的全局检查——后者在「A 配了、B 没配」时会排一批必然失败的任务，表现是那些图永远停在 `pending`、每轮被重新认领、**任何地方都不报错**。跳过多少张报在 `skippedUnconfiguredCount` 里。

#### 不是幂等的——它花钱

**再点一次就是再花一遍全库的视觉调用。** 与 [`POST /admin/reindex`](#654-重建索引) 刻意相反：那条是幂等且免费的（只算 embedding，走部署方 key），所以界面允许重复点、连说明都写着「重复触发是安全的」。**retag 不能复用那句话。**

调用者要担的是**图片上传者的** AI 预算（上方口径）。界面上这一条必须挡住误点：**确认框是主闸门**，另有「队列正在跑时禁用」作为辅助。⚠️ 辅助那条的判据只能是「有任务在 `running`」，**不能是「有任务 `pending`」**——`pending` 会由别人的上传造成，更会由「上传者没配视觉通道」的图**永远**停在那个状态（上方「配置口径」那条已知缺口），拿它当闸门等于把按钮永久禁用，那是比误点更坏的失败：不报错，也没有出路。

「已经 `pending` 的行不会重复入队」只保证**不重复收费**，不保证「再点一次没有代价」——上一轮跑完之后再点，全库会重新跑一遍。

#### 界面必须说出来的三件事

文案是契约（`settings-ux.md` 开头），所以在这里定死，不在 web 端现编。触发前的确认框要说：

1. **它花的是图片上传者的 AI 预算**，不是部署方的。
2. **重打可能让一部分图变成「需人工」——它们的旧标签不会丢。** 提示词多问了「是不是成人向」之后，一批原先 `ok` 的图可能终局失败（[§9.23](09-decisions.md) 记着这条没有实测支撑）。这不是数据损坏，是一个**可用的回退值**，但界面必须提前说明，否则管理员看到「需人工」变多会以为点坏了。
3. **人工编辑过的图会被跳过，而且不会因此获得新维度。**（上方「不碰人工编辑过的图」的代价。）

**`POST /admin/reindex` 那句「重复触发是安全的」不能复用。** 它成立的前提是幂等，而本接口不幂等。

进度**只轮询 [§6.6.1](#661-汇总) 的计数**（`scope=all`），不另做端点：retag 本身无状态，跑完库里没有任何「这张被重打过」的痕迹，专门的 status 端点只能是 `tag_jobs` 的计数换个地方再说一遍。**由此百分比没有服务端的分母**——`counts.pending` 是绝对值，界面上要做成百分比得用「本次触发排上的条数」当基线，那只在刚点过的那一屏里成立。跨页回来就只剩计数，这是正常的，不是残缺。

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

**队列里存在 `pending` / `running` / `failed` 任一状态的重算任务时，搜索必须返回 `degraded: true`**（[§6.3.1](#631-搜索)），因为此时库里的向量一部分仍属于旧模型，向量路只在当前模型那部分里召回、覆盖不全。判断这一条的查询会落在每个搜索请求上，必须是索引命中的存在性查询或带短期缓存，不能是全表 count。

**`failed` 也算。** 重试耗尽的任务留在表里不再推进，而它对应的记录仍然带着旧模型的向量——只看 `pending` / `running` 会让「未完成任务归零、混模型永久存在」这件事静默发生。见 [§9.20](09-decisions.md)。

### §6.5.5 运行参数

> **状态：`accepted`**（2026-09-23）。新增能力，两端已确认契约、实现已落两端。**尚未转 `stable`**——联合验收还差真 api × 真浏览器的联调，见[运行参数任务](../joint-tasks/2026-09-23-runtime-config.md)的「总管裁定」。

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/admin/runtime` | 仅 `admin` |
| PUT | `/admin/runtime` | 仅 `admin` |

```
{
  tagConcurrency: 2,           // 生效值，不是「存进去的值」
  tagPerUserInflight: 1,
  importConcurrency: 2,
  ffmpegConcurrency: 2,
  cpuCount: 8,                 // ffmpegConcurrency 的上限由来，界面要显示「上限 8（本机核数）」
  updatedAt: "2026-09-23T...", // 从没改过则 null
  updatedBy: "uuid" | null
}
```

`PUT` 的请求体是同样四个字段**全部必填**，一次性提交整组——不做部分更新：它本来就是一个四格表单，而部分更新会让界面不知道该显示哪一次的值。响应与 `GET` 同形，回显**归一化之后**的生效值（等于默认值的输入落成 `NULL`，见 [§5.6](05-data-models.md)）。

**返回生效值而不是原始值**，是为了让界面不必知道「哪些列是空的」。字段含义、上下限与交叉约束见 [§5.6](05-data-models.md)；越界返回 `VALIDATION_FAILED`。

**生效不是事务性的「立即」**，承诺的措辞是「保存后**新开的**任务按新值跑」：

| 谁 | 何时读到新值 |
|---|---|
| 打标 worker | 下一轮 tick。那一轮可能正卡在等一个在途任务完成上（`JOB_TIMEOUT_MS` 最长 90 秒） |
| 导入管线 | 下一批。**已经在跑的批次整批用旧值**，不中途改 |

**不为「立即生效」去打断在途任务。** 被打断的打标任务会永远停在 `running`，表现是「这几张图再也不会被打标」——不报错、不告警，正是 `stopTagWorker` 那条注释（`queue/worker.ts`）写明要避免的。

**不做「恢复默认」端点。** 四格填回默认值就是恢复默认，服务端把它归一成 `NULL` 即可；多一个端点等于多一条「默认值是什么」的知识要同步。

**不做单独的「当前吞吐是多少」端点。** 生效证据复用 [§6.6.1](#661-汇总) 的 `GET /memes/tag-status`——`counts.pending` 的下降速率就是它。新造一个端点只会把同一批计数换个地方再说一遍。

## §6.6 打标状态

> **状态：`accepted`**（2026-09-19 新增为 `proposed`，2026-09-24 转档）。两端实现已落、契约文本两端各自确认。**还不是 `stable`**：差的是一次验证——真库里造一张 `needs_manual`，核对汇总的 `needsManual` 等于列表条数。见[打标状态界面](../joint-tasks/2026-09-19-tagging-status.md)、[§9.28](09-decisions.md)。

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

**「人工补」是 [`PATCH /memes/{id}`](#641-patch-memesid-的语义)，不是重跑模型。** 两者不能互相替代，也不合成一个「重试」按钮：

| 你要做的 | 用哪个 | 花谁的钱 |
|---|---|---|
| 模型标错了 / 标得不全，人工补上 | `PATCH /memes/{id}`——改 `description` 与七个词表维度数组 | 不花钱 |
| 换个配置重跑视觉模型 | `POST /memes/retag` | **图片上传者**的 AI 预算（见 [§6.4.3](#643-post-memesretag-的语义)） |

**不要在 §6.4 之外另造一个「重试」端点**，那会让同一个语义有两条实现。`retag` 已实现（[§6.4.3](#643-post-memesretag-的语义)），所以 `needs_manual` 的图现在是**两条路都通**：人工用 `PATCH` 补，或按当前提示词重跑模型。**但人工编辑过的图会被 `retag` 跳过**——那是 [§6.4.3](#643-post-memesretag-的语义) 写下的取舍，不是这一节能替代的：一旦人补过标签，这张图就只会走人工那条路。

**「进度」不另做端点。** 重打没有自己的任务表，跑完库里也没有「这张被重打过」的痕迹，专门造一个进度接口只能把 [§6.6.1](#661-汇总) 的计数换个地方再说一遍。界面轮询 `GET /memes/tag-status?scope=all` 即可。
