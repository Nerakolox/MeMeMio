# api 代码注释里的任务路径改成只写文件名

**状态**：`done`（2026-09-25 总管核验后关闭，依据见 §4 之后的「总管核验」）｜ **性质**：api 单端，纯注释，不动行为 ｜ 开于 2026-09-25

契约不变：一个接口、一行 `spec/` 都不动。

## 1. 为什么要做

[任务板](../../joint-tasks/README.md)「已完成，待归档」里有 21 张 `done` 的任务文件卡着没移，原因是代码注释里写着它们在 `joint-tasks/` 下的路径，移了就指空。2026-09-25 盘点发现问题比板子上记的更大：**已经归档的任务同样被这样引用着，api 里有 7 处现在就是断的**，只是断了不报错。`check-doc-links.mjs` 只查 markdown，查不到这些。

规则已补进 [documentation.md](../../agents/rules/documentation.md)：代码注释里引用任务只写文件名、不写目录，引用契约写 `SPEC §X.Y`。本任务把存量改过来。

## 2. 做完的标准

| # | 判据 | 怎么证 |
|---|---|---|
| 1 | `api/` 下没有任何 `joint-tasks/2026` 字样 | `grep -rn 'joint-tasks/2026' api --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist` 无输出 |
| 2 | 每一处都还能找到原来那份任务文件 | 改成 `任务 <文件名去掉 .md>`；原注释本就引了 SPEC 章节的保留章节号 |
| 3 | 行为不变 | 只改注释；`npm run typecheck` 与现有测试照旧通过 |

## 3. api 端

2026-09-25 盘点的清单（`状态` 指被引任务文件现在在哪）：

| 文件:行 | 引用的任务 | 状态 |
|---|---|---|
| `api/src/data/search.ts:62`、`:164` | `2026-09-24-search-media-perf` | 待归档 |
| `api/src/image/probe.ts:321` | `2026-09-24-search-media-perf` | 待归档 |
| `api/src/lib/retry-policy.ts:90` | `2026-09-16-tag-queue` | **已归档，现已断** |
| `api/src/process-error-handlers.test.ts:10` | `2026-09-24-queue-reliability` | 待归档 |
| `api/src/routes/health.ts:9` | `2026-09-13-skeleton` | **已归档，现已断** |
| `api/src/shutdown.test.ts:5` | `2026-09-24-queue-reliability` | 待归档 |
| `api/src/storage/r2.test.ts:6` | `2026-09-18-r2-public-url-prefix` | 待归档 |
| `api/src/vocab.ts:20` | `2026-09-13-skeleton` | **已归档，现已断** |
| `api/tests/favorites.test.ts:5` | `2026-09-16-tag-queue` | **已归档，现已断** |
| `api/tests/import-reviews.test.ts:5` | `2026-09-15-import` | **已归档，现已断** |
| `api/tests/import-reviews.test.ts:228` | `2026-09-18-r2-public-url-prefix` | 待归档 |
| `api/tests/import.test.ts:5` | `2026-09-15-import` | **已归档，现已断** |
| `api/tests/meme-edit-delete.test.ts:6` | `2026-09-19-browse-meme-actions` | 待归档 |
| `api/tests/queue-reliability.test.ts:5` | `2026-09-24-queue-reliability` | 待归档 |
| `api/tests/retag.test.ts:5` | `2026-09-22-retag-endpoint` | 进行中 |
| `api/tests/tag-queue.test.ts:4` | `2026-09-16-tag-queue` | **已归档，现已断** |
| `api/tests/tag-status.test.ts:5` | `2026-09-19-tagging-status` | 进行中 |

行号以开工时 `grep` 的结果为准，上表只是盘点快照。

## 4. api 端验收

2026-09-25 api 执行者实测：

- **改动**：开工时 `grep` 命中 18 行（16 个文件，与第 3 节盘点一致；`search.ts`、`import-reviews.test.ts` 各两处）。全部改成 `任务 <文件名去掉 .md>`，原本就写成「任务 joint-tasks/…」的两处（`meme-edit-delete.test.ts`、`retag.test.ts`）去掉目录后不重复「任务」二字。原注释里的 `SPEC §X.Y` 和任务内小节号（`§1`、`§3`、「明确不做」、「验证点 1」）原样保留。只动注释。
- **判据 1**：`grep -rn 'joint-tasks/2026' api --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist` 无输出（退出码 1）。另查了 `api/` 下 `*.md` 以外的所有文件，也没有 `joint-tasks/2026`。
- **判据 3**：`npm run typecheck` 通过（退出码 0）。`npm run test:unit`：21 个文件、194 条测试全部通过。`npm test`（含集成测试）**没跑成**：`tests/global-setup.ts` 连 `127.0.0.1:5432` 报 `ECONNREFUSED`，本机 Docker Desktop 没开，Postgres 起不来。本次只改注释，集成测试结果预计不受影响，但这一项没有实测。

### 总管核验（2026-09-25）

`npm test` 没跑，这一条照实留着。关闭的依据是改动本身：总管逐行看了 `git diff -U0 -- api/src api/tests`，18 行改动全部落在 `//`、` * ` 注释里，没有一行可执行代码变化，所以集成测试的结果不会因为这次改动而不同。`grep -rn 'joint-tasks/2026' api web …` 总管复跑也没有输出。

## 5. 之后

本任务和 [web 那张](2026-09-25-web-comment-task-paths.md)都 `done` 后，总管一次性把板子上「已完成，待归档」的任务文件移进 `_archive/joint-tasks/`，改文档里的相对链接，跑 `node scripts/check-doc-links.mjs`。
