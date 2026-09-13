# 目录结构

## 分层

```
routes/    →  services/  →  data/
              ai/ image/ queue/
              lib/（纯函数，谁都能用）
```

**依赖方向单向向下。** `data/` 不 import `services/`，`lib/` 不 import 任何其他层。

## 各层的职责与禁止

| 层 | 做什么 | **不做什么** |
|---|---|---|
| `routes/` | 参数校验、调 service、序列化响应 | **不写 SQL**、不判断权限、不调 AI |
| `services/` | 业务编排、事务边界 | 不直接拼 SQL 字符串、不认识 HTTP |
| `data/` | 全部 SQL、**三条硬边界** | 不调 AI、不认识 HTTP |
| `ai/` | VisionTagger / Embedder | 不写库、不认识 `memes` 这个概念 |
| `image/` | ffmpeg / sharp / pHash | 不写库、不调 AI |
| `queue/` | 取任务、消费、重试 | 不写业务逻辑，只负责调度 |
| `lib/` | 纯函数 | 不做 I/O，**一个 import 都不该有** |

`routes/` 里出现 `SELECT` 是本端最严重的结构问题——[三条硬边界](../../../AGENTS.md)全都靠 `data/` 是唯一入口才成立。绕过一次，`assertCanMutate` 和 `deleted_at is null` 的保证就不再成立了。

## `lib/` 放什么

判断标准：**能不能不起 Postgres、不联网就测**。

- 向量截断 + L2 归一化
- Hamming 距离 / bit_count
- 词表校验与 alias 归一化
- RRF 融合
- AI 拒绝形态判定（输入是响应对象，输出是枚举）
- 密钥脱敏（`"****" + 后四位`）

这几个是[最该被测的纯函数](../../../docs/testing.md)，放在 `lib/` 就是为了让它们没有借口不被测。

## 文件命名

kebab-case，见 [SPEC §7.6](../../../spec/07-naming.md)。

一个文件一个主题，**不建 `utils.ts` / `helpers.ts` / `common.ts`**。这三个名字是垃圾桶的别名，一旦存在就会无限增长且没人敢动。想不出名字说明这个函数的位置还没想清楚。

## 迁移

`migrations/NNNN_动词_对象.sql`，序号连续，**不改已合入的迁移文件**。

改错了就写下一个迁移改回来。改历史迁移在本地看起来没事，在已经跑过它的环境上是静默的不一致。

## 测试放哪

`tests/` 与 `src/` 同构。纯函数的单测可以放在 `src/lib/xxx.test.ts` 与被测文件同目录——那批文件应该被测这件事，越显眼越好。
