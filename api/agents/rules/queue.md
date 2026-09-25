# 队列与定时任务

用 PostgreSQL 自身做队列，不引入 Redis。理由与推翻条件见 [SPEC §9.11](../../../spec/09-decisions.md)。

## 1. 取任务

```sql
select * from tag_jobs
where status = 'pending' and run_after <= now()
order by run_after
for update skip locked
limit 1;
```

`FOR UPDATE SKIP LOCKED` 是整个方案成立的基础——**多个 worker 不会取到同一条**。

**代码不假设单副本。** 首期只跑一个进程，但取任务、更新状态的逻辑必须在多副本下也正确。改成「先 select 再 update」这种两步写法就会出现重复消费。

## 2. 入队和写库在同一个事务

```ts
await tx(async (t) => {
  const meme = await insertMeme(t, data)
  await enqueueTagJob(t, meme.id)
})
```

这是[不用 Redis 换来的最大好处](../../../spec/09-decisions.md)——「图片入库了但队列任务丢了」根本不可能发生。**别为了"性能"把它拆开**，拆开就白放弃 Redis 了。

## 3. 重试

| 失败 | 处理 |
|---|---|
| `AI_UNREACHABLE` | 指数退避重试，上限 5 次，之后 `needs_manual` |
| `AI_REFUSED` | **不重试主通道**，直接走副通道 |
| `AI_INVALID_OUTPUT` | 主通道重试 1 次，仍失败按 `AI_REFUSED` 处理 |
| `AI_UNSUPPORTED` | **不重试**，标记失败并提示用户检查配置 |
| `AI_NOT_CONFIGURED` | **不入队**，图片留在 `pending`，等配置好后批量补打标 |

重试靠更新 `run_after`，不靠 `sleep`。**worker 里不要有长 sleep**——那会占着一个消费槽什么都不干。

`AI_REFUSED` 不重试主通道是重点：内容策略拒绝是确定性的，重试一百次也是拒绝，只会浪费用户的钱。

## 4. 并发按用户分

一个人导入一千张不该让别人的打标排到后面。取任务时按 `user_id` 做轮转或限制每用户在途任务数。

**这不是公平性洁癖**：共享库里一个人的批量导入会直接影响所有人的体验。

## 5. 每个任务必须有超时

外部调用超时（见 [ai-providers.md](ai-providers.md)）之外，任务本身也要有整体超时。

卡住的任务表现是「导入进度条不动」，**没有任何错误信息**——超时是唯一能让它变成可见错误的机制。

## 6. 定时任务

| 任务 | 频率 | 做什么 |
|---|---|---|
| **过期检索快照** ✅ | 每 5 分钟 | 删 `expires_at` 已过的 `search_snapshots` |
| 清理批次元信息 | 每小时 | 删 `expires_at` 已过的 `import_batches`，**保留 `needs_review` 条目** |
| 清理待确认超时 | 每天 | 7 天未处理的 `needs_review` 连同 `temp/` 对象一起删 |
| 清理孤儿 temp 对象 | 每天 | `temp/` 里没有对应 `import_items` 记录的 |
| 物理删除 | 每天 | 软删满 30 天的，删 R2 对象并释放配额 |
| 重算过期向量 | 手动触发 | `embed_model` 与当前配置不符的 |

✅ = 已实现，`queue/cleanup.ts`。**它是这张清单上的第一条**，在那之前本端一个定时任务都没有
（两个 worker 里的周期扫描是各自的 `setInterval`，不是这里说的清理）。

实现形状：**一个 `setInterval` + 一个 `sweep()`，新增清理任务往 `sweep()` 里加一行**，
不要每个任务各起一个定时器——那样进程里会躺着五六个几乎不工作的定时器，而 `unref`、
异常处理、停机收尾要各写一遍。它不消费队列，所以**不是 worker**，但同样无条件起。
所有异常只记日志，绝不让定时器挂掉。

**「保留 `needs_review` 条目」是最容易漏的一条。** 它看起来是导入日志，实际是用户的待办——按批次统一清理会让用户的待确认队列凭空消失。

清理任务**先记日志再删**，且要能 dry-run。删错了没法恢复。

先用 `countExpired*` 数一遍（= dry-run）、记下条数，再执行删除；条数为 0 就直接收工，不记日志。
实现见 `cleanup.ts` 的 `sweep()` 与 `data/search-snapshots.ts` 的两个函数。

## 7. 重建索引

管理员换 embedding 模型后触发，**全站重算**。

- 期间搜索降级为 OCR + 标签（`degraded: true`），**不中断服务**
- 进度可查（`GET /admin/reindex/status`）
- 用同一套队列机制，不另起一套
- 几千条重算只要几分钟、几毛钱，不需要为它做断点续传

## 8. 队列表也是 `memes` 的一部分吗

不是。`tag_jobs` 有自己的访问方法，**不走 `data/memes.ts`**。

但入队时拿到的 `memeId` 必须来自 `data/memes.ts` 的查询结果——**不要为了省一次查询直接在队列表上 join `memes`**，那会绕过 `deleted_at is null`，表现是给已删除的图打标。

**这条管的是写路径（入队）。** 读路径上反过来的 join 是允许的、有时还是必须的：只有 join 才能在队列表的行上**应用**软删过滤，不 join 反而会把已删除的图算进去。判据是 join 有没有带 `deleted_at is null` 这个条件，不是有没有 join。走这条路的查询要在注释里写明方向，别让人以为是照抄本节抄错了——[§6.6](../../../spec/06-endpoints.md) 的 `failures` 计数就是这么做的。
