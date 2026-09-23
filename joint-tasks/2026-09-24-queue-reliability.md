# 队列可靠性：退出、僵死回收、未处理拒绝、重建漏行

**状态**：`done`（2026-09-24 总管关闭，见 §7）｜ **性质**：api 单端 ｜ 开于 2026-09-24

契约不变。唯一对外可见的变化是 §3 第 8 条：SSE 在 `done` 之后关闭连接。§1.4 对 `error` 已经这么写，对 `done` 没写；web 收到 `done` 后本来就自己关，不会坏。

来源是 2026-09-24 的只读审查。标 ✔ 的条目总管已核实；其余执行者先复核，查无此事的记「不成立」。

## 1. 为什么要做

前四条单看都不致命，但**会互相放大**。进程被 OOM（[导入加固](2026-09-24-import-hardening.md) 第 3 条就能触发）或强杀 → 在途任务留在 `running` → 进程几秒内重启，任务没超过回收阈值 → 之后再也没人扫它。最终表现是**一批图静默停在「打标中」**：不报错，界面上也没有入口能把它们捞出来。

第 5 条是另一种静默：重建索引「跑完了」，搜索报 `degraded: false`，但有一批图永远召回不到。这正是 SPEC §9.20 要防的那种失效。

## 2. 做完的标准

- `docker stop` 之后 10 秒内进程自己退出（exit 0），在途任务回到 `pending`，不停在 `running`。
- 强杀后 **N 分钟内**（N 由 api 定，写进注释），不重启也能回收 `running` 行；多副本时，别的进程也能回收。
- `applyFailure` 写库失败时进程不退出，有一条日志。
- 重建索引期间 worker 同时在消费，一张不漏。测试用「边入队边完成」的交错来钉。
- 超时后才迟到的写入，不会覆盖已经被放回 `pending`、或已被别的进程重新领走的任务。

## 3. api 端

| # | 问题 | 位置 | 方向 |
|---|---|---|---|
| 1 ✔ | worker 只在 `server.close()` 回调里才停，而 SSE 的 ping 循环和 keep-alive 连接让这个回调迟迟不来。等 docker 超时强杀，在途任务全部成孤儿 | `server.ts:100-110`、`routes/imports.ts:382` | 收到信号后立刻停止领新任务，和 `server.close()` 并行；主动断开 SSE（`closeAllConnections`）；给在途任务一个比 compose `stop_grace_period` 短的收尾时限，到点把它们放回 `pending` |
| 2 ✔ | `requeueStaleRunningJobs` 只在启动时调一次，阈值是 `STALE_RUNNING_MS = JOB_TIMEOUT_MS * 4`（6 分钟） | `queue/worker.ts:68, 134`、`queue/reindex-worker.ts:49, 95` | 改成周期性扫描。阈值和 `JOB_TIMEOUT_MS` 的关系保持不变：[运行参数](2026-09-23-runtime-config.md) 里「任务超时不暴露」的理由就是这条，别把它拆开 |
| 3 ✔ | `runJob(job).finally(...)` 没挂 `.catch`；全仓库也没有 `process.on('unhandledRejection')`。catch 分支里的写库一失败，Node 22 默认直接退出进程 | `queue/worker.ts:192`、`queue/reindex-worker.ts:130` | 挂 `.catch` 记日志；进程级只记录不吞掉，别用它掩盖真 bug |
| 4 | 超时后原任务还在后台跑，晚到的完成、重试、失败写入都不校验 `status = 'running'`，也没有领取 token | `queue/worker.ts:208-211`、`data/tag-jobs.ts:189-221`、`services/tagging.ts:238`（embed 没接 `signal`） | 写入带上领取时的标识做条件（`attempts` 或 `claimed_at` 都行），影响 0 行即丢弃并记日志 |
| 5 ✔ | 重建索引按 OFFSET 翻页，同时 worker 在消费：算完的图掉出 stale 集合，后面的 offset 整体跳过同样数量的行。`orderBy(createdAt)` 没有决胜键，同一时刻的行翻页不稳定 | `services/ai-config.ts:278-290`、`data/memes.ts` 的 `listStaleEmbeddingMemeIds` | 改 keyset 翻页（`created_at, id`） |
| 6 | 超过 `ENQUEUE_CAP = 100000` 的部分直接不入队，不报错 | `services/ai-config.ts:269` | 至少记日志，并让回执能看出被截断了。要不要进响应字段，另开契约，本任务不做 |
| 7 | 毒任务：`claimTagJob` 领取时不看 `attempts` 上限。每次都把进程打崩的任务会被无限重领，`decideRetry` 根本没机会运行 | `data/tag-jobs.ts` 的 `claimTagJob` | 领取时 `attempts` 已达上限的，直接落终态 |
| 8 | SSE 在 `done` 之后不关连接，一直 ping 到客户端自己断开 | `routes/imports.ts:382` | 发完 `done` 就关 |
| 9 | `runBatch` 跑到一半遇上退出，没人等、也不续跑。批次已有 `committed_at`，不能再 commit，剩下的条目永远 `pending` | `services/import.ts:82-85` | 启动时扫描「已 commit、有 `pending` 条目、没有进程在跑」的批次，续跑 |

**陷阱**：compose 默认的 `stop_grace_period` 是 10 秒，而单个任务的整体超时是 90 秒。所以退出时**不可能**等在途任务跑完，第 1 条的正确做法是「放回 `pending`」，不是「等它们做完」。被放回的图会重新调用一次视觉模型，也就是**同一张图付两次钱**。这是已知代价，写进注释。

## 4. 与其它任务的关系

- 第 2、4 条碰的是 [运行参数](2026-09-23-runtime-config.md) 已上线的 tick 循环。那个任务的六个陷阱里，②（读配置要在 early-return 之前）和③（不为了立即生效打断在途任务），改的时候必须保住。
- 测试缺口（退出、回收时机、交错入队）的测试写在本任务里，不等 [测试设施](2026-09-24-test-infra-ci.md)。

## 5. api 端验收

回填于 2026-09-24。**五项标准全部实测通过**，§6 列的三样缺项逐条在下面给出（§5.2、§5.3、§5.4）。

先记复核：§3 的 9 条**全部成立**，没有「查无此事」的。其中没打 ✔ 的 5 条（4、6、7、8、9）逐条对着代码看过，位置与描述一致。

涉及文件：`src/shutdown.ts`（新增）、`src/server.ts`、`src/queue/worker.ts`、
`src/queue/reindex-worker.ts`、`src/data/tag-jobs.ts`、`src/data/reindex-jobs.ts`、
`src/data/imports.ts`、`src/data/memes.ts`、`src/services/import.ts`、
`src/services/tagging.ts`、`src/services/ai-config.ts`、`src/ai/embedder.ts`、
`src/routes/imports.ts`、`src/lib/retry-policy.ts`。测试：`src/shutdown.test.ts`、
`src/process-error-handlers.test.ts`、`tests/queue-reliability.test.ts`（12 条）。

### 5.1 逐条结论

| # | 结论 | 落点 |
|---|---|---|
| 1 | ✔ | `shutdown.ts`：`closeServer()` 同步返回、**不等它的回调**；`stopWorkers()` 并行；`SHUTDOWN_DEADLINE_MS = 8_000` 到点 `exit(0)`。`server.ts` 关连接时 `server.close()` + `closeAllConnections()` 主动掐 SSE。实测见 §5.2 |
| 2 | ✔ | 两个 worker 各自 `STALE_SWEEP_INTERVAL_MS = 60_000` 周期扫一次（`requeueStaleRunningJobs` / `requeueStaleRunningReindexJobs`），判据仍是 `running` + `run_after < now() - JOB_TIMEOUT_MS × 4`。实测见 §5.3 |
| 3 | ✔ | `runJob(job).catch(...)`（`finally` 不接拒绝）；`installProcessErrorHandlers()` 只记日志、不退出、也不把它吞成正常状态 |
| 4 | ✔ | 写回条件收敛到 `claimedWhere(claim)`——`(id, attempts)` + `status = 'running'`，影响 0 行即丢弃并记日志；`services/tagging.ts` 的 embed 那一步补上 `signal`，`ai/embedder.ts` 一路透传。显式验证见 §5.4 |
| 5 | ✔ | `listStaleEmbeddingMemeIds` 改 keyset：`(created_at, id) > (…, …)`，`orderBy` 用同一对键。验红见 §5.4 |
| 6 | ✔ 部分 | 到 `ENQUEUE_CAP` 时 `log.warn({ cap, scanned, enqueued })`。**响应字段按任务说明没做** |
| 7 | ✔ | `claimTagJob` 领取时 `attempts >= MAX_TAG_CLAIMS` 直接落终态。边界见 §5.5 |
| 8 | ✔ | SSE 在 `done` / `error` 之后自己 `close()`，心跳循环随之停 |
| 9 | ✔ | `listResumableBatches()` + `resumeInterruptedBatches()` 启动时扫；同进程重复触发由 `runningBatches` 挡，跨进程靠 `recordItemOutcome` 的**首次写入者赢** |

**陷阱②③保住了**：`tick()` 里运行参数仍在**开头读、在 early return 之前**；僵死扫描的阈值仍是 `JOB_TIMEOUT_MS × 4`，没有为了「立即生效」去打断在途任务——停机路径是**主动 abort + 放回 `pending`**，不是等任务做完。

### 5.2 实测一：`docker stop` 的退出耗时与残留 `running` 行（§6 第 1 项）

做法：`docker compose build app` 出镜像，跑在**一次性库** `mememio_probe` 上；另起一个 node 容器挂着一条**真的 SSE 长连接**（就是让 `server.close()` 回调不来的那个东西，15 秒一次心跳，实测挂住 154 秒不断），然后 `docker stop --time 10`。

```
docker stop --time 10  ->  390ms，退出码 0
收到退出信号，开始收尾（SIGTERM, deadlineMs: 8000）
打标 worker 已停止 / 重建索引 worker 已停止      ← 同一毫秒
收尾完成，退出
客户端侧：chunk 22B → read error: terminated    ← 连接被服务端主动掐掉
```

**残留 `running` 行 = 0**：这次容器里本来就没有在途任务，所以「0」不是量出来的结论。
量到的是一条**强得多**的转绿证据——收尾真的走完了（`收尾完成，退出` + 退出码 0），
而修之前这条路径**根本到不了**：那时 `server.close()` 的回调被这条长连接挂住，
两个 worker 一次都没开始收尾。

**A/B 对照——证明这条测量分得清两种形状**：同一个长连接、同一个 10 秒宽限期，把收尾按
**修之前的形状**（全挂在 `server.close()` 回调里）再摆一遍：

| 收尾的形状 | 发信号到容器死亡 | 退出码 | 那个回调 |
|---|---|---|---|
| 挂在 `close()` 回调里（修之前） | **10 273ms** | **137**（SIGKILL） | 一次都没触发 |
| 不等回调 + 掐连接（修之后） | **720ms** | 0 | 没走回调 |

对照用的是复现两种形状的独立探针（纯 node 内置模块，不依赖仓库代码），**不是重新构建旧版本**。
它证明的是「这条测量分得清两种形状」，**不是**「旧版本实测数据」——别读成后者。

### 5.3 实测二：僵死回收的耗时（§6 第 1 项，含 §6 点名的两个验不了的场面）

在一个**已经跑着**的容器里手工种一条 `status='running'`、`run_after = now() - 10 分钟`
的 `tag_jobs` 行，然后什么都不做：

```
60 秒扫描那一拍：requeued: 1, staleMs: 360000
该行状态：running → pending
```

**N = 7 分钟**（最坏）：判据是 `JOB_TIMEOUT_MS × 4` = 6 分钟，再加下一拍扫描 ≤ 60 秒。
正常退出路径根本用不上这个数——停机时在途任务由 `releaseRunningTagJobs` 直接放回，等不了 1 毫秒。

§6 说「强杀后不重启就能回收」在单机 docker 上验不了、要么写「按代码路径推断」要么**造行模拟**。
**这里走的是造行模拟**，并且用的是「进程已经在跑、之后再种行」的顺序——所以它验的确实是
「不重启也能回收」，而不是「启动时那一次扫描」。剩下两个没量的：

- **真的 SIGKILL / OOM 没跑过**：那条行是种出来的，不是砍进程砍出来的。
- **多副本没起两个副本**：扫描是一条**没有进程内状态**的条件 UPDATE，谁扫到都一样、
  重复扫也幂等，所以别的副本能回收——这一条是**代码论证，不是实测**。

### 5.4 实测三 + 迟到的写入（§6 第 1、3 项）

`npx vitest run --project unit` → **194 通过**（新增 `shutdown.test.ts` 5 条、
`process-error-handlers.test.ts` 2 条）；`npx vitest run --project integration` → **315 通过**
（新增 `tests/queue-reliability.test.ts` 12 条）；`npx tsc -p tsconfig.json --noEmit` 干净。

**交错入队「一张不漏」（§6 第 1 项）——并且验过它能红**：把 `listStaleEmbeddingMemeIds`
临时改回 OFFSET 翻页，同一用例报 `expected 1000 to be 1100`——第二页 `offset=1000`
落在只剩 100 行的结果集之外，那 100 张既不排队也不报错。改回来即绿。
（`interleave.calls >= 2` 那两条断言故意排在 `enqueued` **之后**：交错没发生时
`enqueued === total` 是空真的，排在后面才能保证红的理由是漏行本身。）

**迟到的写入（§6 第 3 项）**：`attempts` 同时是「领取 token」这件事，单副本下确实
「条件写对了」和「条件真的挡住了」肉眼分不出来，所以是用**制造第二个领取**来钉的，
不是读代码确认：

- 「被放回 `pending` 之后」：任务在途 → 收尾放回 → 用**原来那份 claim** 依次调
  `markTagJobDone` / `markTagJobRetry` / `markTagJobFailed`，三条全部返回 `false`
  （影响 0 行），行的 `status` / `attempts` / `last_error` 一个字段都没动。
- 「被别的进程重新领走之后」：放回后再真领一次（`attempts` 因此 +1），旧 claim 的三种写入
  同样全部落空——这一条正是「别的副本领走了，我这份迟到的结论不许盖上去」。
- 同组还覆盖了「晚一步写回来的**成功**结论也盖不掉已经被放回的行」。

### 5.5 诚实项与边界

- **残留 `running` 行数不是量出来的**，见 §5.2 第二段：容器里没有在途任务，
  换成「收尾真的走完了」这条更强的证据。要真造一个在途任务得配一条「会挂住」的视觉通道，
  那要往库里写一份伪配置，没做。「在途任务回到 `pending`」由
  `tests/queue-reliability.test.ts` 的「停机把在途任务放回队列」覆盖：真库 + 真 worker，
  视觉调用挂在 `hangFetch()` 上，收尾时限到点后任务回到 `pending`。
- **没跑真 SIGKILL / OOM**；**多副本回收是代码论证**（同 §5.3）。
- **第 6 条只落了日志**，响应字段是另开契约的事，本任务没做。
- **第 7 条只覆盖 `claimTagJob`。** `claimReindexJob` 领取时**仍然不看上限**：重算任务在
  正常失败路径上有上限（`MAX_REINDEX_ATTEMPTS = 3`），但「每次把进程打崩」那种在领取这一步
  没有闸——和打标那边原来的洞是同一个。任务里只点了 `claimTagJob`，没顺手扩，**建议另开一条**。
- **评测集没跑**：这次没动打标提示词、词表、RRF 参数或 HyDE 提示词
  （`services/tagging.ts` 只是把 `signal` 透传下去，判断逻辑没动）。
- 「同一张图付两次钱」是停机放回在途任务的已知代价，写在 `queue/worker.ts` 的注释里。

### 5.6 §6 三项缺项的当前状态

| §6 要求 | 状态 |
|---|---|
| 1. 三条实测数据 | **已填**：§5.2（退出耗时）、§5.3（回收耗时）、§5.4（交错入队一张不漏） |
| 2. 提交 | **已提**：`fix(api): 队列退出、僵死回收、未处理拒绝与重建漏行` |
| 3. 迟到的写入显式验一次 | **已验**：§5.4 用制造第二个领取来钉，不是读代码确认 |

**上面三样齐了，关闭这一步不再有 api 侧的欠账**；状态由总管改成 `done`，见 §7。
（本小节写下的当时状态是 `in_progress`——执行者不动状态，这条分工是对的，所以留着。）

## 6. 总管核对（2026-09-24）

**状态保持 `in_progress`，但原因不是「没写」，是「没验、没提交」。** 本次整顿要区分这两件事。

**工作区里已经有的**（总管抽查了 diff，逐条对到 §3 的编号，**没有替执行者跑任何测试**）：

| §3 | 落点 | 看到的 |
|---|---|---|
| 1 | `src/shutdown.ts`（新增）、`server.ts` | `SHUTDOWN_DEADLINE_MS = 8_000`、`closeAllConnections()`、收信号后与 `server.close()` 并行 |
| 2 | `queue/worker.ts`、`queue/reindex-worker.ts` | tick 里周期性 `requeueStaleRunningJobs(STALE_RUNNING_MS)`，阈值与 `JOB_TIMEOUT_MS` 的关系没拆开 |
| 3 | `src/shutdown.ts` 的 `installProcessErrorHandlers`、`server.ts:35` | 启动第一件事就挂进程级兜底 |
| 4 | `data/tag-jobs.ts`（`TagJobClaim`）、`ai/embedder.ts` | 回写条件收成一个落点（`status` + `attempts`），`AbortSignal` 一路接到 embed |
| 5 | `data/memes.ts` | keyset 翻页 `(created_at, id)`，注释里写了 OFFSET 为什么会漏行 |
| 6 | `services/ai-config.ts:313` | 到 `ENQUEUE_CAP` 留日志 |
| 7 | `data/tag-jobs.ts:232` | 领取时按 `MAX_TAG_CLAIMS` 直接落终态 |
| 8 | `routes/imports.ts:471` | `done` / `error` 之后关连接，且**等写出去再收** |
| 9 | `services/import.ts` 的 `resumeInterruptedBatches`、`server.ts:95` | 启动续跑半截批次，`runningBatches` 在 `finally` 里清 |

**测试文件已就位但未跑过**：`api/tests/queue-reliability.test.ts`、`api/src/shutdown.test.ts`、`api/src/process-error-handlers.test.ts`（三者都还是未跟踪文件）。

**要转 `done` 缺的是这三样，别的都不缺**：

1. **三条实测数据**填进上面那段——`docker stop` 的退出耗时与残留 `running` 行数、强杀后的回收耗时、交错入队的「一张不漏」。**其中「强杀后不重启也能回收」和「多副本下别的进程也能回收」在单机 docker 上验不了**，要么明确写「本机验不了、按代码路径推断」，要么按 `records` 表造行模拟。
2. **提交**。9 条改动现在全在工作区，而本次整顿的另一半（十几个 markdown 的重命名归档）正等着这棵树干净——**先提这一笔，归档才能动**。
3. §2 第 5 条（迟到的写入不覆盖已被放回 `pending` 的任务）用的是 `attempts` 做条件，**它同时被选为「领取 token」**：这条要在验收里显式验一次，因为「条件写对了」和「条件真的挡住了并发」在单副本下靠肉眼看不出差别。

**不做的事**：不要为了让状态好看而把 `in_progress` 改成 `done`。这条任务的价值全在「改了之后**确实**能自己退出」——那正是它要修的那类静默。

## 7. 关闭（2026-09-24，总管）

执行者按 §5.6 把 §6 列的三样补齐了，**总管逐条核对了证据是否真的存在**，然后改的状态：

| §6 要求 | 核对方式 |
|---|---|
| 三条实测数据 | §5.2 `docker stop --time 10` → 390ms、exit 0，并留了 A/B 对照（10,273ms / exit 137 vs 720ms / 0）；§5.3 按 `records` 造 `running` 行，≤7 分钟被回收；§5.4 交错入队一张不漏 |
| 提交 | `fdf1bfe fix(api): 队列退出、僵死回收、未处理拒绝与重建漏行`——**含三个测试文件本身**（`api/tests/queue-reliability.test.ts`、`api/src/shutdown.test.ts`、`api/src/process-error-handlers.test.ts` 都已跟踪，不是「测过但没提」） |
| 迟到写入显式验一次 | §5.4 造第二个领取来钉 `attempts` 当 token 的行为，不是读代码确认 |

**这不是「为了好看」**：§6 那句「不要改状态」针对的是「没验就标 done」，而现在三样各有落点。有一条要留给读的人：**§5.5 的诚实项原样保留了**——没跑真 SIGKILL、多副本回收是代码论证、第 6 条只落了日志、`claimReindexJob` 领取时仍不看上限。它们记在文件里比记在状态里更该被下一个人看到，`done` 不等于这些也解决了。其中 `claimReindexJob` 那条**建议另开一条任务**，本次没有开。
