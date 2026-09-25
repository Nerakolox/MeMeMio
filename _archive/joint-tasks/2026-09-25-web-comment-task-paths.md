# web 代码注释里的任务路径改成只写文件名

**状态**：`done` ｜ **性质**：web 单端，纯注释，不动行为 ｜ 开于 2026-09-25

契约不变：一个接口、一行 `spec/` 都不动。

## 1. 为什么要做

同 [api 那张](2026-09-25-api-comment-task-paths.md)：[任务板](../../joint-tasks/README.md)上 21 张 `done` 的任务文件卡着没归档，因为代码注释里写着它们在 `joint-tasks/` 下的路径，移了就指空。规则已补进 [documentation.md](../../agents/rules/documentation.md)：代码注释里引用任务只写文件名、不写目录，引用契约写 `SPEC §X.Y`。本任务把 web 的存量改过来。web 这边目前没有已经断掉的引用。

## 2. 做完的标准

| # | 判据 | 怎么证 |
|---|---|---|
| 1 | `web/` 下没有任何 `joint-tasks/2026` 字样 | `grep -rn 'joint-tasks/2026' web --include='*.ts' --include='*.tsx' --include='*.mjs' --exclude-dir=node_modules --exclude-dir=dist` 无输出 |
| 2 | 每一处都还能找到原来那份任务文件 | 改成 `任务 <文件名去掉 .md>`；原注释本就引了 SPEC 章节的保留章节号 |
| 3 | 行为不变 | 只改注释；`npm run typecheck`、`npm run build` 照旧干净 |

## 3. web 端

2026-09-25 盘点的清单：

| 文件:行 | 引用的任务 | 状态 |
|---|---|---|
| `web/src/features/discover/DiscoverWall.tsx:167` | `2026-09-19-browse-meme-actions` | 待归档 |
| `web/src/features/manage/MemeActions.tsx:32` | `2026-09-19-browse-meme-actions` | 待归档 |
| `web/src/features/manage/MemeEditPanel.tsx:141` | `2026-09-22-语义维度拆分` | 进行中 |
| `web/src/features/settings/settings-copy.ts:46` | `2026-09-23-runtime-config` | 进行中 |
| `web/src/lib/api.ts:219` | `2026-09-19-browse-meme-actions` | 待归档 |
| `web/src/routes/settings.tsx:26` | `2026-09-18-settings-merge` | 待归档 |
| `web/src/routes/settings.tsx:31` | `2026-09-19-tagging-status` | 进行中 |

另有 3 个文件被 `.gitignore` 忽略、不进仓库，但留着下次联调用，顺手一起改：`web/scripts/mock-api.mjs:59`、`web/scripts/verify-toast-feedback.mjs:2`、`web/scripts/verify-web-interaction-fixes.mjs:2`、`:34`。

行号以开工时 `grep` 的结果为准，上表只是盘点快照。

## 4. web 端验收

2026-09-25 web 执行者实测。

**改了什么**：开工 `grep` 结果与 §3 盘点一致，9 个文件 11 处全部改成 `任务 <文件名>`，去掉了 `joint-tasks/` 目录、`.md` 后缀和包着的反引号；接在中文后面的写成「见任务 …」「留在任务 …」。原注释里没有 SPEC 章节号，没有要保留的。只动了这几行注释，别的一行没碰。

- 进仓库的 6 个：`DiscoverWall.tsx`、`MemeActions.tsx`、`MemeEditPanel.tsx`、`settings-copy.ts`、`lib/api.ts`、`routes/settings.tsx`（2 处）
- 被忽略的 3 个本地脚本：`scripts/mock-api.mjs`、`scripts/verify-toast-feedback.mjs`、`scripts/verify-web-interaction-fixes.mjs`（2 处；`:33` 行末本来就有「任务」二字，`:34` 只留文件名，没写成「任务 任务」）。这几个不进仓库，`git diff` 看不到，改动只在本机

**判据 1**：在仓库根跑 `grep -rn 'joint-tasks/2026' web --include='*.ts' --include='*.tsx' --include='*.mjs' --exclude-dir=node_modules --exclude-dir=dist`，无输出，退出码 1。

**判据 2**：11 处都保留了完整的任务文件名（包括 `2026-09-22-语义维度拆分`），拿文件名在 `joint-tasks/` 或 `_archive/joint-tasks/` 下都能找到。

**判据 3**：
- `npm run typecheck`（`tsc -p tsconfig.json --noEmit`）：干净，没有输出
- `npm run build`：退出码 0，`✓ built in 6.97s`。有一条 `index-*.js` 536 kB 超过 500 kB 的 chunk 体积警告，原来就有，跟这次无关
- 3 个本地脚本不在 tsc 和 build 的范围里，另跑了 `node --check`，3 个都通过

没做浏览器实测，因为只改了注释，运行时不受影响。

## 5. 之后

两张都 `done` 后，由总管一次性归档，见 [api 那张](2026-09-25-api-comment-task-paths.md) §5。
