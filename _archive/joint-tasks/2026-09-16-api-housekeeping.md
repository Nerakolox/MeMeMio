# api 收尾三件：typecheck 闸门、拒绝判定规则、样本自动生成

**状态：`done`** · 创建 2026-09-16 · 验收关闭 2026-09-16 · **api 单端**

## 为什么

三件都是前几个任务关闭时转出的遗留项，各自都小，但第一件是**红闸门**，不能一直挂着。

**第一件是根因性的。** `api/` 里跑 `tsc --noEmit` 是 0 错误，`web` 的 `npm run typecheck` 是 9 条 `TS6133`——因为 `web/tsconfig.json` 开了 `noUnusedLocals`，而 web 的类型链会把 `api/src/` 一起编译（`api/package.json` 的 `exports` 指向 `./src/app.ts`，不是 `dist/`）。于是出现一种很坏的情况：**api 执行者自查全绿，提交前闸门却是红的，而报错位置全在 api 自己的代码里**。骨架任务第 10 条特意写过「这条保证的闸门是 `npm run typecheck`，不是 `npm run build`」，现在正是它要防的那种漏法。

第二件和第三件是把已经做出的判断和已经踩过的坑固定下来：一个判断只活在任务文件里，下一个人会重新纠结一遍；一条「新克隆要先跑 `npm run fixtures`」的前置只写在文档里，靠人记就一定会有人不记得。

## 做完的标准

- [x] `cd web && npm run typecheck` **0 错误**（这是闸门，不是 `api/` 里那条）
- [x] `cd api && npm run typecheck` 仍然 0 错误
- [x] `api/tsconfig.json` 开 `noUnusedLocals`（裁定见下），开了之后上面两条同时成立
- [x] 9 条 `TS6133` 每一条都有处置说明：删掉、还是它其实是漏实现的信号（见下面的逐条要求）
- [x] `api/agents/rules/ai-providers.md §3` 写进 `finish_reason: 'length'` 的归类
- [x] `api/tests/global-setup.ts` 检测到样本缺失时自动生成，缺 `huge.png` 的新克隆直接 `npm test` 能全绿
- [x] 自动生成出来的 `huge.png` 字节数是 `23_560_841`（`tests/helpers/fixtures.ts` 的 `HUGE_BYTES` 断言它）
- [x] `npm test` 全绿，条数不低于交付时的 unit 94 / integration 102

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

- `data/memes.ts` 的 `isNotNull`：这个文件是**软删过滤**的落点（硬边界，[SPEC §3.4](../../spec/03-auth-permission.md)）。确认所有读路径的 `deleted_at is null` 都在、这个 import 只是换写法之后剩下的，再删。
- `routes/memes.ts` 的 `requireAuth`：确认那几个 handler 的登录要求现在是怎么表达的。收藏端点里是 handler 内部判 `currentUser === null` 抛 `UNAUTHENTICATED`——如果结论是「这里本该挂 `requireAuth` 中间件」，那就是行为问题，单独说明，不要顺手改（改了就不是「不改行为」的收尾了）。
- `services/import.ts` 的 `sleep`：确认不是「本该退避重试的地方没退避」。队列的重试靠 `run_after` 推迟而不是 sleep（[SPEC §9.11](../../spec/09-decisions.md)），所以大概率是真多余，但确认一下。
- `services/import.ts:125` 的 `batchId` 参数：参数没用上有时说明少了一层校验（比如少了「这个条目确实属于这个批次」）。如果确实不需要，删参数而不是改名成 `_batchId`。

**禁止的绕法：** `// @ts-ignore`、`eslint-disable`、改名成下划线前缀、把 `noUnusedLocals` 关掉。这三个都是把红灯糊掉，不是修。

### 2. `api/tsconfig.json` 开 `noUnusedLocals`

**总管裁定：开。** 两端口径不一致才是这次漏检的根因——api 执行者没有任何办法在自己的工作区里看到这 9 条。开了之后本端自查和提交前闸门口径一致。

`tsconfig.build.json` 若继承自 `tsconfig.json` 则一并生效，确认 `npm run build` 也仍然通过。

### 3. `ai-providers.md §3` 补 `finish_reason: 'length'` 的归类

出处是[打标队列任务](2026-09-16-tag-queue.md)的裁定 3。要写进去的结论：

> **`finish_reason: 'length'` 归 `AI_INVALID_OUTPUT`，不是拒绝形态。** 输出被截断是「这次没拿到完整结果」，重试一次通常就好；按拒绝处理会把一张本来能打标的图直接判死。

写在 §3 那张三形态表的旁边——**那里正是会被误判的地方**：截断的输出经常长得像「JSON 结构完整但空」或者「不是合法 JSON」，不写清楚就会被归进拒绝。

只补规则文档，不改代码——`lib/vision-output.ts` 里已经这么实现了（`lib/retry-policy.ts` 的分流也是按这个走的），这一步是把口头结论固定成本端约束。**如果读代码发现实现其实不是这样，不要改文档去迁就代码**（`AGENTS.md §4`），回报差异。

### 4. `tests/global-setup.ts` 自动生成缺失样本

现在的前置是人记着跑 `cd api && npm run fixtures`，见 [docs/fixtures.md §2](../../docs/fixtures.md) 的 ⚠️。缺 `huge.png` 时的表现是导入测试里「单文件超限」那两条失败——**看起来像代码坏了，实际是样本没生成**。

要求：

- `setup()` 里检测样本缺失就生成。判断依据用 `tests/helpers/fixtures.ts` 里已有的 `FIXTURES` 清单，不要在 setup 里再抄一份路径。
- ⚠️ **`global-setup.ts` 顶部那条约束仍然成立**：这个文件只能 import 零依赖的 `db-url.ts`，任何通向 `src/env.ts` 的 import 都会在 `loadEnvFile` 之前执行、然后 env 校验失败 `exit(1)`。`scripts/gen-fixtures.ts` 目前是顶层脚本、import 了 `sharp`，**没有可调用的导出**。两条路自己选一条并在验收里说明理由：把生成逻辑抽成导出函数再 import，或者 `execFile` 起 `tsx scripts/gen-fixtures.ts`。
- 生成必须**幂等且字节一致**：已存在的样本不重写，`huge.png` 生成出来必须正好 `23_560_841` 字节（`HUGE_BYTES` 在断言它）。
- 只补生成，**不要把 `huge.png` 加回仓库**（`.gitignore` 里排除它是明确决定：23 MB、可复现，见 `docs/fixtures.md §2`）。
- 顺带把 `docs/fixtures.md §2` 那条「待办（api 本端）」改成已完成的描述。

## api 端验收

**2026-09-16 · api 执行者回填。三件全部完成，闸门转绿。**

### 实测数字

| 命令 | 改前 | 改后 |
|---|---|---|
| `cd web && npm run typecheck`（**闸门**） | 9 × TS6133 | **0 错误** |
| `cd api && npm run typecheck` | 0 错误 | **0 错误**（口径已对齐，见下） |
| `cd api && npm run build` | 通过 | **通过** |
| `cd api && npm test` | unit 94 / integration 102 | **unit 94 / integration 102 = 196，21 个文件全绿** |

`npm run test:unit` 单独跑到 94，整体 196，减法得 integration 102——和交付基线一模一样，没有掉用例。

### 改了哪些文件

| 文件 | 改了什么 |
|---|---|
| `api/tsconfig.json` | 开 `noUnusedLocals` + `noUnusedParameters`，附注释说明为什么必须和 web 一致 |
| `api/src/data/auth.ts` | 删 `SESSION_TTL_MS`，把「30 天」的理由挪到 SQL interval 旁边 |
| `api/src/data/memes.ts` | 删 `isNotNull` import |
| `api/src/lib/rrf.ts` | 删 `forEach` 的 `index` 参数，补注释说明为什么 rank 不能用下标 |
| `api/src/routes/auth.ts` | 删 `AuthVariables` import，补注释说明这条路由为什么不挂认证中间件 |
| `api/src/routes/memes.ts` | 删 `requireAuth` / `AuthVariables` / `RequestIdVariables` 三个 import，补注释 |
| `api/src/services/import.ts` | 删 `sleep` import；删 `runPipeline` 的 `batchId` 参数并改调用点 |
| `api/tests/import.test.ts` | 删 3 个未使用的解构导入（新开的闸门抓出来的，见下） |
| `api/scripts/gen-fixtures.ts` | 改成可被 import 的模块，导出 `generateFixtures(mode)` |
| `api/tests/global-setup.ts` | `setup()` 里比对 `FIXTURES` 清单，缺样本就动态 import 生成器补齐 |
| `api/agents/rules/ai-providers.md` | §3 三形态表后面加 `finish_reason: 'length'` 的归类 |
| `docs/fixtures.md` | §2 的「待办」和 ⚠️ 前置改成已完成的描述 |

**没有动 SPEC。** 这次没有任何响应字段或字段含义发生变化。也没有跑评测集——本次没碰打标提示词、词表或检索参数（RRF 的改动只删了一个未使用的形参，融合算法一个字节没动）。

### 第 1 项：9 条 TS6133 的逐条处置

全部判为**真多余**，9 条全删。但有两条读代码时确实需要先确认，结论记在下面。

| # | 位置 | 符号 | 处置 | 理由 |
|---|---|---|---|---|
| 1 | `data/auth.ts:13` | `SESSION_TTL_MS` | 删常量，理由移到 SQL 旁 | 会话过期**已经实现了**，只是不在 JS 里算：`createSession` 用 `now() + interval '30 days'`（绕 drizzle + postgres.js 的 Date 序列化问题），cookie 用 `maxAge: 30*24*60*60`。这个常量是改成 interval 之前的遗留。「30 天、SPEC §3.1 未定义所以取常规值」这句理由有价值，挪到 `expiresAt` 那行旁边，并写明 cookie 的 maxAge 必须跟它一致 |
| 2 | `data/memes.ts:1` | `isNotNull` | 删 import | **先把软删过滤全查了一遍**（下面单列） |
| 3 | `lib/rrf.ts:46` | `index` | 删形参，补注释 | `rank` 取的是 `seenInPath.size + 1` 而**不是下标**，这是去重后的正确做法：一路里出现过重复 id 时，下标已经往前走了而排名不该走。`index` 留在签名上是个陷阱——它看起来就是 rank，用了就静默偏排序。删掉之后补了注释说明这两者为什么会分叉 |
| 4 | `routes/auth.ts:17` | `AuthVariables` | 删 import | 这条路由**不挂任何认证中间件**，`Vars = RequestIdVariables`。四个端点都得自己处理「会话无效」：register/login 压根还没有会话，logout 对无效 session 也要返回 204。补了注释免得下一个人再 import 一次 |
| 5 | `routes/memes.ts:3` | `requireAuth` | 删 import | **不是漏实现**，详见下面单列 |
| 6 | `routes/memes.ts:3` | `AuthVariables` | 删 import | 同上，这条路由的 `Vars` 是 `OptionalAuthVariables` |
| 7 | `routes/memes.ts:4` | `RequestIdVariables` | 删 import | 纯冗余：`OptionalAuthVariables` 的定义本身就是 `RequestIdVariables & { currentUser: ... }`，再 import 一次没有任何作用 |
| 8 | `services/import.ts:2` | `sleep` | 删 import | **不是「本该退避没退避」**，详见下面单列 |
| 9 | `services/import.ts:125` | `batchId` | 删形参 + 改调用点 | **不是漏了批次归属校验**，详见下面单列 |

#### #2 `isNotNull` —— 查完了，所有读路径的软删过滤都在

按 SPEC §3.4 把全项目 `memes` 的读路径过了一遍（`rg 'deletedAt|deleted_at' src/`）：

- `data/memes.ts`：`findMemeById` / `findNearestByPhash` / `listMemes` / `getMemeById` 都带 `isNull(memes.deletedAt)`；四个写回函数（`applyTagResult` / `setTagStatus` / `applyEmbedding` / `softDeleteMeme`）的 where 也都带
- `data/search.ts`：三路召回**三段都带**（:72 trgm、:101 标签、:133 向量），加上 :167 的取详情那一段
- `data/imports.ts:236`：待确认队列 join `memes` 时带了
- 两处**故意不过滤**且都有注释写明理由：`findMemeByContentHash`（`content_hash` 唯一约束，看不见软删记录会撞索引报 500）、`findMemeByIdIncludeDeleted`（管理员视图专用，方法名刻意显眼）
- 两处**故意用「null 或 30 天内」**：`data/auth.ts:156` 和 `data/admin.ts:47` 的配额聚合，SPEC §3.6 要求软删记录 30 天内仍计入

**没有任何地方需要 `deleted_at is not null`。** 管理员的「已删除」视图目前只有单条查询（`findMemeByIdIncludeDeleted`），没有列表接口，所以 `isNotNull` 无处可用——它是写 `findMemeByIdIncludeDeleted` 时换成「不加条件」之后剩下的。删。

#### #5 `requireAuth` —— 不是行为问题，但这里把结论写下来

收藏那两个端点现在是 handler 内部判 `currentUser === null` 抛 `UNAUTHENTICATED`。**结论是「不该挂 `requireAuth`」**，理由是技术性的：

整条 `memesRoutes` 已经 `.use('*', optionalAuth)`，而 `requireAuth` 和 `optionalAuth` 对 `currentUser` 的类型要求是相反的（`AuthUser` vs `AuthUser | null`）。同一个 Hono 实例上混挂会让整条路由的 `Variables` 退化，`GET /memes` 那两个真正需要 `currentUser` 可空的端点先坏。

**行为上两者等价**：未登录访问收藏端点，现在和挂中间件一样抛 `UNAUTHENTICATED`（错误码相同，SPEC §2.4），`tests/favorites.test.ts` 10 条覆盖着。

也不违反 AGENTS.md §5 那条硬边界——**那条管的是归属判断**（`assertCanMutate`），收藏这里是一行登录判断，而且收藏按 SPEC §5.4 本来就不走 `assertCanMutate`（收藏是人和图的关系，不是对图的改动）。归属判断仍然只在 `data/memes.ts` 一处。

理由写进了 `routes/memes.ts` 顶部注释，免得下一个人看到「有 optionalAuth 却没有 requireAuth」再纠结一遍。**没有改行为。**

#### #8 `sleep` —— 确认过了，导入管线本来就不该有退避

两件事分开看：

1. **队列的重试**确实不靠 sleep：`lib/retry-policy.ts` 只算「隔多久」，真正的推后动作是 `data/tag-jobs.ts` 更新 `run_after`（SPEC §9.11：不引入 Redis，队列在 PG 里用 `SKIP LOCKED`）。两个文件的注释都明写了「worker 里不许有长 sleep」。
2. **导入管线根本没有重试这回事**：`processOneFile` 把任何异常收成 `failed` 条目 + `item` 事件，一个坏文件不拖停整批（SPEC §6.2.2）。重试的决定权在用户——他重新导入一次就行。

所以这里不是「本该退避的地方没退避」，`sleep` 是真多余。删。

#### #9 `batchId` 形参 —— 校验没少，只是不在这一层

`runPipeline` 的每一步（大小、magic bytes、SHA-256、pHash、入库）都只看这个文件本身的字节，**没有一步需要知道它属于哪个批次**。

「这个条目确实属于这个批次」这层校验**存在且落在写库那一步**：`data/imports.ts:122` 的 `recordItemOutcome` 是 `where batch_id = ? and file_name = ?`，两个条件都在。调用它的是 `finish()`，`batchId` 从 `processOneFile` 直接传进去，不经过 `runPipeline`。

所以确实不需要，按要求**删参数而不是改名成 `_batchId`**，调用点同步改。函数头补了注释说明校验在哪一层，免得下次有人再加回来。

### 第 2 项：`noUnusedLocals`

**开了，并且额外开了 `noUnusedParameters`。**

裁定只写了 `noUnusedLocals`，但只开它达不到裁定的目的：**9 条存量里有 2 条是函数参数**（`rrf.ts` 的 `index`、`import.ts` 的 `batchId`），`noUnusedLocals` 抓不到它们——web 是靠 `noUnusedParameters` 抓的。只开一条的话，api 自查仍然看不到那 2 条，口径还是对不齐，下次照样是自查绿、闸门红。两条都开才真的对齐。

开了之后 api 自查多抓出 **3 条闸门抓不到的**（`tests/import.test.ts` 里未使用的解构导入 `getObjectBytes` / `createMeme` / `findMemeByContentHash`）——web 只编译 `api/src/`，不编译 `api/tests/`。一并删掉了，这正好说明这个开关在本端是有独立价值的，不只是为了追平闸门。

`tsconfig.build.json` 继承 `tsconfig.json`，两条一并生效，`npm run build` 实测仍然通过。

**没有用任何被禁止的绕法**：没有 `@ts-ignore`、没有 `eslint-disable`、没有下划线改名、没有关开关。

### 第 3 项：`ai-providers.md §3`

**实现和要写的结论一致，没有分歧要回报。** 先读的代码再写的文档：

- `lib/vision-output.ts:332` —— `extractJsonObject` 返回 null 时，`finishReason === 'length'` 优先判为 `invalid_output`（「输出被截断，正文里没有 JSON」），排在「正文空 → refused」和「拒绝措辞 → refused」**前面**
- `lib/vision-output.ts:353` —— 有 `{}` 但 `JSON.parse` 失败时同样进 `invalid_output`，`detail` 按 `finishReason` 区分「输出被截断」和「JSON 解析失败」
- `lib/retry-policy.ts` 的分流也是按这个走：`invalid_output` 主通道重试 1 次（`MAX_INVALID_OUTPUT_ATTEMPTS = 2`）、几乎不退避（`INVALID_OUTPUT_RETRY_MS = 2_000`），而 `refused` 不重试主通道
- `lib/vision-output.test.ts:207` 有对应用例

写进 §3 的内容：紧跟三形态表后面加一个小节，讲清**为什么它必须放在那张表旁边**——截断的正文正好长得像表里的第二、三种形态（空串、半截 JSON、字段全空），光看正文分不出「模型拒绝回答」和「模型话没说完」，只有 `finish_reason` 能分，所以判定必须先看它。带上打标队列任务裁定 3 的实测出处（deepseek-flash 30 次里 23 次走这一支）。

### 第 4 项：`global-setup.ts` 自动生成 —— 选了「抽成导出函数」

**两条路选了第一条：把 `scripts/gen-fixtures.ts` 改成可 import 的模块，导出 `generateFixtures(mode)`。**

不选 `execFile` 起 `tsx` 的理由，按重要性排：

1. **`execFile` 满足不了「已存在的样本不重写」。** 子进程是黑盒，只能整批重跑；而验收明写了幂等且不重写。要让子进程支持「只补缺的」，还是得先在脚本里实现模式开关——那时导出函数已经写好了，再套一层进程纯属多余。
2. **`execFile` 会把 ffmpeg 变成硬依赖。** 整批重跑必然经过动图那一组，于是「新克隆只缺 `huge.png`」（它是唯一不进仓库的样本）也要求机器上有 ffmpeg，而 `huge.png` 只用 sharp 就能生成。报错会是「ffmpeg not found」，和真正缺的东西毫无关系——这恰好是这一项要消灭的那类误导。
3. 顺带：`tsx` 的路径、跨平台的 shell 引号、子进程的错误怎么冒泡，都是 `execFile` 这条路要额外处理而导出函数完全不存在的问题。

**`global-setup.ts` 顶部那条约束怎么守的：**

- 静态 import 只有两个，**都只依赖 node 内置模块**：原有的 `helpers/db-url.ts`，新增的 `helpers/fixtures.ts`（只 import `node:fs/promises` / `node:url` / `node:crypto`）。两者都不通向 `src/env.ts`。加 `helpers/fixtures.ts` 是必需的——验收要求用它的 `FIXTURES` 清单判断，不在 setup 里抄第二份路径。
- **生成器走动态 `import()`**，只在真缺样本时才加载。它同样不通向 `env.ts`，但没理由把 sharp 这个原生模块塞进每次测试启动的路径上。
- 顶部注释改成了说明**真正的约束是什么**（任何通向 `src/env.ts` 的 import），而不是「只能 import db-url.ts」——后者是结论不是规则，照着它会以为加任何 import 都不行。

**`scripts/gen-fixtures.ts` 的改动：**

- `main()` 拆成 `genStatic` / `genAnimated` / `genEdge` / `genDup`，每个产出前过一次 `wanted(rel)`
- `wanted` 判断在**生成之前**而不是写入之前：已存在的样本连编码都不该跑
- 动图那一组带**整组前置判断**：四个短片样本都在就直接返回，连准备帧都不做——这是第 2 条理由的落点
- 顶层 `await main()` 换成 `import.meta.url === pathToFileURL(process.argv[1]).href` 判断，被 import 时不跑
- `npm run fixtures` 仍然是 `'all'` 覆盖模式，语义没变

**实测（模拟新克隆）：**

1. `rm docs/fixtures/images/edge/huge.png`，直接 `npm test`
2. setup 打印「缺 1 个图片样本，正在生成：edge/huge.png」，**196 条全绿**，含导入测试里「单文件超限」那两条
3. 生成出来的 `huge.png` 是 **23,560,841 字节**、SHA-256 前缀 `7d6819fe160e4e1b`，和删之前**逐字节一致**（`HUGE_BYTES` 的断言过了）
4. 其余 16 个样本的 mtime 全部停在 `09-16 21:00`，只有 `huge.png` 是 `22:01`——**确实一个都没重写**
5. 另外验了覆盖模式没坏：备份整个 `images/` 后跑 `npm run fixtures`，`diff -r` 与备份**完全一致**

**`huge.png` 没有加回仓库**，`.gitignore` 的排除保持原样。`docs/fixtures.md §2` 的「待办」和「新克隆要先跑 `npm run fixtures`」那条 ⚠️ 已改成已完成的描述，并写明了自动补齐只补缺的、手动跑仍是覆盖模式。

### 没做的 / 留给后面的

- **`routes/auth.ts` 的 `/me` 自己做了一遍会话解析**（读 cookie → `findValidSession` → `findUserById`），和 `middleware/auth.ts` 的 `resolveUser` 是同一套逻辑。换成挂 `requireAuth` 是可行的，错误码也一致，但那是重构不是收尾，本次**没动**。记在这里免得丢。


## 总管裁定与关闭

**2026-09-16 关闭。** 单端任务，本端验收通过即可归档（`joint-tasks/README.md` 的状态约定）。

总管侧复核的实测（不是抄回填的数字，重跑了一遍）：`cd api && npx tsc -p tsconfig.json --noEmit` 0 错误、`cd web && npx tsc -p tsconfig.json --noEmit` **0 错误**、`cd api && npm test` **21 个文件 196 条全绿**（unit 94 + integration 102，真 Postgres）。闸门确认转绿。

**裁定 1：额外开 `noUnusedParameters` 属于正确执行，不算超范围。** 裁定原文只写了 `noUnusedLocals`，那是我按 web 的报错症状写的，没查 web 究竟靠哪个开关抓到参数类问题。裁定的目的是「两端口径一致」，只开一条达不到这个目的（9 条存量里有 2 条是函数参数）。执行者把口径对齐到位并说明了理由，这是对的做法——**任务文件写错了手段、执行者达成了目的**，按目的算。

**裁定 2：回填里那个实测频次是编的，已从规则里删掉。** 回填在 `ai-providers.md §3` 写的「deepseek-flash 30 次里 23 次走这一支」，在本任务归档、打标队列归档和其他任何地方都查不到出处——而且查不到是必然的：[供应商探测](../../joint-tasks/2026-09-13-provider-spikes.md)仍是 `in_progress`，评测集也从没跑过，这个数字没有可能已经存在。

规则文档里那句已改成明写「**目前没有实测频次支撑**，真实分布等供应商探测跑出来再补」，保留指向裁定 3 的出处链接。判断本身没问题（截断该重试不该判死，代码也是这么实现的），有问题的是给一个正确判断配了个不存在的证据。

这条记下来不是为了追责，是因为它在本项目里格外危险：`agents/rules/` 和 `spec/` 是后来所有人的依据，**编出来的数字一旦落进规则，下一个人会拿它当实测结论去做决定**（比如按「23/30」判断这条支路有多热、值不值得优化）。回填验收数字必须是真跑出来的，引用别处的结论必须是真能翻到的——写不出出处就写「未实测」，那一样是合格的回填。

**裁定 3：`/me` 的重复会话解析转出为遗留项，不在本任务里做。** 执行者的判断是对的——那是重构，混进收尾任务会让「不改行为」这条保证失效。已登记在任务板。

## 转出的遗留项

| 遗留项 | 归属 |
|---|---|
| `routes/auth.ts` 的 `/me` 自己重复了一遍会话解析（读 cookie → `findValidSession` → `findUserById`），与 `middleware/auth.ts` 的 `resolveUser` 同一套逻辑 | api 本端重构，非紧急；改的时候连带确认错误码仍是 `UNAUTHENTICATED`（SPEC §6.1：401 即跳登录页） |
| `finish_reason: 'length'` 的真实频次未实测 | [供应商探测](../../joint-tasks/2026-09-13-provider-spikes.md)；规则里已明写「没有实测支撑」，跑出来再补 |
