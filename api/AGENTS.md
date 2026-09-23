# Mememio · api 执行者入口

本目录默认角色为 **api 执行者**：Hono API、数据访问、队列、AI 调用、图像管线。不修改 `web/` 的实现代码；需要改前端时回到 [总管入口](../AGENTS.md) 再切换角色。

## 1. 开工读取

| 顺序 | 读什么 |
|---|---|
| 1 | [共用规则索引](../agents/rules/INDEX.md) |
| 2 | [本端规则索引](agents/rules/INDEX.md)，按任务类型取正文 |
| 3 | [SPEC 索引](../spec/INDEX.md) 的「按任务读取」表，取相关章节 |
| 4 | [当前任务](../joint-tasks/README.md) |

**不要一次加载全部规则。** 按索引取需要的那几份；已完整读过且未变化的不重复读。

## 2. 本端职责边界

| 归 api | 不归 api |
|---|---|
| 接口实现、数据访问层、迁移 | 接口**语义**的定义（属 [SPEC](../spec/INDEX.md)） |
| 打标提示词、供应商适配、降级判定 | 词表词条本身（属 [`shared/vocab/`](../shared/vocab/README.md)） |
| 检索实现、RRF 参数、HyDE 提示词 | 返回给前端的结果结构（属 SPEC §6.3） |
| 队列、定时清理、重建索引 | 部署与命名（属 [`docs/deployment.md`](../docs/deployment.md)） |

**RRF 参数和提示词随便调，不用改 SPEC**；一旦响应里多一个字段或某个字段的含义变了，先改 SPEC。

## 3. 三条硬边界在本端的落点

[总管入口](../AGENTS.md) 列的三条硬边界，代码全都落在这里——**它们是 api 的责任，前端兜不了底**：

| 边界 | 落在哪 | 规则 |
|---|---|---|
| `assertCanMutate` | `memes` 访问层，不在 handler | [database.md](agents/rules/database.md) |
| `deleted_at is null` | 同上 | [database.md](agents/rules/database.md) |
| API Key 不出响应 | 序列化层 + 配置接口 | [error-handling.md](agents/rules/error-handling.md) |

这三条**只在一个地方实现**。在 handler 里手写一遍归属判断，哪怕写对了也是错的——下一个人会照着它再写一遍，然后写漏。

## 4. 本端特有的三件事

这三件在别的项目里通常不存在，是本端最容易做错的地方：

**AI 调用不可信。** 用户会填任意中转服务。不假设任何能力、不信任何返回。能力靠[测试连接实测](../spec/09-decisions.md)后存配置，运行时读配置分支；输出必须校验；失败要降级而不是报错。见 [ai-providers.md](agents/rules/ai-providers.md)。

**送 AI 的永远只有 PNG。** 动图统一抽帧，不指望模型看懂 GIF。见 [image-pipeline.md](agents/rules/image-pipeline.md)。

**向量截断后必须重新 L2 归一化。** 漏了不报错、不崩溃，只是搜索悄悄变差。见 [database.md](agents/rules/database.md)。

## 5. 交付

改完说明：本次改了什么、实测跑了什么、有没有动 SPEC、有没有阻塞。见 [git-and-delivery.md](../agents/rules/git-and-delivery.md)。

**动了打标提示词、词表或检索参数，交付时必须说明有没有跑[评测集](../docs/eval.md)。** 没跑就直说没跑，不要用「看着没问题」代替。

提交信息里不加 `Co-Authored-By` 或任何 AI / 工具署名行，见 [git-and-delivery.md](../agents/rules/git-and-delivery.md)。
