# api

Hono 后端。同域托管 `web` 的构建产物 + `/api/v1`。

**当前状态：只有文档，没有代码。** 本目录下除 `AGENTS.md` / `CLAUDE.md` / `README.md` / `agents/` 外都还不存在。

开工入口见 [AGENTS.md](AGENTS.md)。

## 计划的结构

```
api/
├─ src/
│  ├─ server.ts            入口：env 校验 → 迁移检查 → 起 Hono
│  ├─ routes/              handler，薄，只做参数校验和编排
│  ├─ services/            业务逻辑
│  ├─ data/                数据访问层 ← 三条硬边界在这里
│  ├─ ai/                  VisionTagger / Embedder，OpenAI 兼容
│  ├─ image/               ffmpeg 抽帧、sharp 缩放、pHash
│  ├─ queue/               Postgres 队列的取任务与消费
│  └─ lib/                 纯函数：向量归一化、Hamming、词表校验
├─ migrations/
├─ scripts/eval.ts         评测集运行器，见 docs/eval.md
└─ tests/
```

## 三件立刻会用到的事

**起服务**：需要 Postgres（pgvector + pg_trgm）和 ffmpeg。见 [`docs/environments.md`](../docs/environments.md)。

**没有 AI key 也能跑**：导入正常，图片入库为 `tagStatus = pending`；搜索降级为 OCR + 标签。这是生产也要走的真实路径，不是开发便利。

**迁移是独立命令**，不在启动流程里自动执行。理由见 [`docs/deployment.md`](../docs/deployment.md)。

## 数据与契约

- 表结构：[SPEC §5](../spec/05-data-models.md)
- 端点：[SPEC §6](../spec/06-endpoints.md)
- 错误码：[SPEC §2](../spec/02-errors.md)
- 词表：[`shared/vocab/`](../shared/vocab/README.md)

**类型通过 Hono RPC 导出给 `web` 消费，没有代码生成步骤。** 但类型只保证形状——`tagStatus: string` 编译得过，它必须是 SPEC §5.2.3 那四个值之一。语义靠测试和 SPEC，不靠类型检查。
