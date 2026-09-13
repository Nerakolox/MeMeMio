# §7 命名

[返回索引](INDEX.md)

## §7.1 三层命名

| 层 | 风格 | 例 |
|---|---|---|
| 数据库 | snake_case | `content_hash`、`tag_status`、`deleted_at` |
| 接口字段 | camelCase | `contentHash`、`tagStatus`、`deletedAt` |
| 路径 | kebab-case，资源名复数 | `/api/v1/memes`、`/api/v1/imports/reviews` |

转换只发生在一个地方——`api` 的序列化层。业务代码里不出现两套写法混用，前端代码里不出现 snake_case。

## §7.2 固定术语

同一概念只有一个词。以下对照表是硬性的，写代码、写文档、写 UI 文案都按它来：

| 概念 | 用 | 不用 |
|---|---|---|
| 一张表情包 | meme | image、picture、图片资源、素材 |
| 上传这张图的人 | uploader | owner、creator、所有者 |
| 视觉打标模型 | vision | vlm、多模态模型、打标模型（口语可以，字段名不行） |
| 向量化模型 | embed / embedding | vector model、向量模型 |
| 主 / 副视觉通道 | primary / fallback | backup、secondary |
| 精确重复 | exact duplicate | same、identical |
| 近似重复 | near duplicate | similar（`similarTo` 字段名是历史例外，见下） |
| 待确认队列 | review | confirm、pending（`pending` 已被 `tagStatus` 占用） |
| 固定标签词表 | vocabulary / vocab | taxonomy、词典、标签库 |

`uploader` 不叫 `owner`，是刻意的。库是共享的，上传者不拥有这张图，只是对它有写权限——命名如果暗示所有权，会把「多租户隔离」的直觉带回代码里。见 [§0.1](00-overview.md)。

`import_items.similar_to` 保留 `similar` 一词，因为它指向的是被比中的那条记录，不是「近似重复」这个概念本身。其余场合一律用 `nearDuplicate` / `exactDuplicate`。

## §7.3 三个维度的命名

`emotions` / `scenes` / `tags` 三个字段名在数据库、接口、`vocab.json`、筛选参数里**完全一致**，不做任何转写。词表主源见 [§4](04-vocabulary.md)。

不要出现 `emotion`（单数）、`sceneTags`、`labels` 这类变体——它们会让「这个字段和 vocab 的哪一段对应」这个问题需要查代码才能回答。

## §7.4 布尔字段

统一用 `is` / `has` / `can` 前缀：`isAnimated`、`hasEmbedding`、`canReceiveImage`。

测试连接返回的能力字段用 `xxxWorks`（`jsonModeWorks`、`dimParamWorks`），表示**实测通过**而不是「声明支持」，见 [§6.5.1](06-endpoints.md)。这个后缀是有意区别于 `isXxx` 的——`supportsJsonMode` 听起来像配置项，`jsonModeWorks` 听起来像探测结果，后者才是事实。

## §7.5 时间与 ID

时间字段一律 `xxxAt`，类型 `timestamptz`，接口输出 ISO 8601 UTC，见 [§1.2](01-http.md)。不出现 `xxxTime`、`xxxDate`、`timestamp`。

主键一律 `id`（uuid）。外键一律 `<单数资源名>_id`：`uploader_id`、`meme_id`、`user_id`、`batch_id`。

## §7.6 文件与目录

| 类型 | 风格 |
|---|---|
| 目录 | kebab-case |
| React 组件文件 | PascalCase，与默认导出同名 |
| 其余 ts / tsx | kebab-case |
| 迁移文件 | `NNNN_动词_对象.sql`，如 `0003_add_temp_storage_key.sql` |
| SPEC / docs | kebab-case，中文内容 |
| joint-tasks | `YYYY-MM-DD-主题.md` |

具体到某一端的结构约束见 `api/agents/rules/project-structure.md` 与 `web/agents/rules/project-structure.md`。
