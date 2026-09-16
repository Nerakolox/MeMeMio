# api 收尾三件：typecheck 闸门、拒绝判定规则、样本自动生成

**状态：`in_progress`** · 创建 2026-09-16 · **api 单端**

## 为什么

三件都是前几个任务关闭时转出的遗留项，各自都小，但第一件是**红闸门**，不能一直挂着。

**第一件是根因性的。** `api/` 里跑 `tsc --noEmit` 是 0 错误，`web` 的 `npm run typecheck` 是 9 条 `TS6133`——因为 `web/tsconfig.json` 开了 `noUnusedLocals`，而 web 的类型链会把 `api/src/` 一起编译（`api/package.json` 的 `exports` 指向 `./src/app.ts`，不是 `dist/`）。于是出现一种很坏的情况：**api 执行者自查全绿，提交前闸门却是红的，而报错位置全在 api 自己的代码里**。骨架任务第 10 条特意写过「这条保证的闸门是 `npm run typecheck`，不是 `npm run build`」，现在正是它要防的那种漏法。

第二件和第三件是把已经做出的判断和已经踩过的坑固定下来：一个判断只活在任务文件里，下一个人会重新纠结一遍；一条「新克隆要先跑 `npm run fixtures`」的前置只写在文档里，靠人记就一定会有人不记得。

## 做完的标准

- [ ] `cd web && npm run typecheck` **0 错误**（这是闸门，不是 `api/` 里那条）
- [ ] `cd api && npm run typecheck` 仍然 0 错误
- [ ] `api/tsconfig.json` 开 `noUnusedLocals`（裁定见下），开了之后上面两条同时成立
- [ ] 9 条 `TS6133` 每一条都有处置说明：删掉、还是它其实是漏实现的信号（见下面的逐条要求）
- [ ] `api/agents/rules/ai-providers.md §3` 写进 `finish_reason: 'length'` 的归类
- [ ] `api/tests/global-setup.ts` 检测到样本缺失时自动生成，缺 `huge.png` 的新克隆直接 `npm test` 能全绿
- [ ] 自动生成出来的 `huge.png` 字节数是 `23_560_841`（`tests/helpers/fixtures.ts` 的 `HUGE_BYTES` 断言它）
- [ ] `npm test` 全绿，条数不低于交付时的 unit 94 / integration 102

## api 端要改什么

**涉及的 SPEC：** §2.4（错误码与各自的服务端行为）。另外必读本端规则 `api/agents/rules/ai-providers.md`、`code-style.md`、`testing.md`。

### 1. 9 条 TS6133，先判断再删

2026-09-16 实测清单：

| 位置 | 符号 |
|---|---|
| `src/data/auth.ts:13` | `SESSION_TTL_MS` |
| `src/data/memes.ts:1` | `isNotNull` |
| `src/lib/rrf.ts:46` | `index` |
| `src/routes/auth.ts:17` | `AuthVariables` |
| `src/routes/memes.ts:3` | `requireAuth` |
| `src/routes/memes.ts:3` | `AuthVariables` |
| `src/routes/memes.ts:4` | `RequestIdVariables` |
| `src/services/import.ts:2` | `sleep` |
| `src/services/import.ts:125` | `batchId` |

前两条（`data/auth.ts`、`routes/auth.ts`）是认证任务起就有的存量，其余七条随检索/导入/打标队列进来。

**不要一路 `删掉` 扫过去。** 未使用的符号有两种来源，处置完全不同：

- **真多余**（重构后留下的、复制过来没用上的）→ 删掉
- **漏实现的信号**——本来要用、写到一半改了思路 → 删掉就把问题藏起来了

这几条尤其要看一眼再动：

- `data/memes.ts` 的 `isNotNull`：这个文件是**软删过滤**的落点（硬边界，[SPEC §3.4](../spec/03-auth-permission.md)）。确认所有读路径的 `deleted_at is null` 都在、这个 import 只是换写法之后剩下的，再删。
- `routes/memes.ts` 的 `requireAuth`：确认那几个 handler 的登录要求现在是怎么表达的。收藏端点里是 handler 内部判 `currentUser === null` 抛 `UNAUTHENTICATED`——如果结论是「这里本该挂 `requireAuth` 中间件」，那就是行为问题，单独说明，不要顺手改（改了就不是「不改行为」的收尾了）。
- `services/import.ts` 的 `sleep`：确认不是「本该退避重试的地方没退避」。队列的重试靠 `run_after` 推迟而不是 sleep（[SPEC §9.11](../spec/09-decisions.md)），所以大概率是真多余，但确认一下。
- `services/import.ts:125` 的 `batchId` 参数：参数没用上有时说明少了一层校验（比如少了「这个条目确实属于这个批次」）。如果确实不需要，删参数而不是改名成 `_batchId`。

**禁止的绕法：** `// @ts-ignore`、`eslint-disable`、改名成下划线前缀、把 `noUnusedLocals` 关掉。这三个都是把红灯糊掉，不是修。

### 2. `api/tsconfig.json` 开 `noUnusedLocals`

**总管裁定：开。** 两端口径不一致才是这次漏检的根因——api 执行者没有任何办法在自己的工作区里看到这 9 条。开了之后本端自查和提交前闸门口径一致。

`tsconfig.build.json` 若继承自 `tsconfig.json` 则一并生效，确认 `npm run build` 也仍然通过。

### 3. `ai-providers.md §3` 补 `finish_reason: 'length'` 的归类

出处是[打标队列任务](../_archive/joint-tasks/2026-09-16-tag-queue.md)的裁定 3。要写进去的结论：

> **`finish_reason: 'length'` 归 `AI_INVALID_OUTPUT`，不是拒绝形态。** 输出被截断是「这次没拿到完整结果」，重试一次通常就好；按拒绝处理会把一张本来能打标的图直接判死。

写在 §3 那张三形态表的旁边——**那里正是会被误判的地方**：截断的输出经常长得像「JSON 结构完整但空」或者「不是合法 JSON」，不写清楚就会被归进拒绝。

只补规则文档，不改代码——`lib/vision-output.ts` 里已经这么实现了（`lib/retry-policy.ts` 的分流也是按这个走的），这一步是把口头结论固定成本端约束。**如果读代码发现实现其实不是这样，不要改文档去迁就代码**（`AGENTS.md §4`），回报差异。

### 4. `tests/global-setup.ts` 自动生成缺失样本

现在的前置是人记着跑 `cd api && npm run fixtures`，见 [docs/fixtures.md §2](../docs/fixtures.md) 的 ⚠️。缺 `huge.png` 时的表现是导入测试里「单文件超限」那两条失败——**看起来像代码坏了，实际是样本没生成**。

要求：

- `setup()` 里检测样本缺失就生成。判断依据用 `tests/helpers/fixtures.ts` 里已有的 `FIXTURES` 清单，不要在 setup 里再抄一份路径。
- ⚠️ **`global-setup.ts` 顶部那条约束仍然成立**：这个文件只能 import 零依赖的 `db-url.ts`，任何通向 `src/env.ts` 的 import 都会在 `loadEnvFile` 之前执行、然后 env 校验失败 `exit(1)`。`scripts/gen-fixtures.ts` 目前是顶层脚本、import 了 `sharp`，**没有可调用的导出**。两条路自己选一条并在验收里说明理由：把生成逻辑抽成导出函数再 import，或者 `execFile` 起 `tsx scripts/gen-fixtures.ts`。
- 生成必须**幂等且字节一致**：已存在的样本不重写，`huge.png` 生成出来必须正好 `23_560_841` 字节（`HUGE_BYTES` 在断言它）。
- 只补生成，**不要把 `huge.png` 加回仓库**（`.gitignore` 里排除它是明确决定：23 MB、可复现，见 `docs/fixtures.md §2`）。
- 顺带把 `docs/fixtures.md §2` 那条「待办（api 本端）」改成已完成的描述。

## api 端验收

（执行者回填：改了哪些文件、9 条各自的处置与理由、两端 typecheck 与 `npm test` 的实测结果、第 4 项选了哪条路及理由。）
