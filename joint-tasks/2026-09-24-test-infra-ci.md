# 测试设施与 CI

**状态**：`planning` ｜ **性质**：**跨端**（api + web 各自接入，契约不变）｜ 开于 2026-09-24

## 1. 为什么要做

- **仓库里没有 CI** ✔。没有 `.github/`，也没有 pre-commit hook。`docs/deployment.md §5` 和 `docs/testing.md §5` 却都写着「必须进 CI」。现在的闸门全靠执行者自觉：跑没跑、跑的是哪一组，只能看任务文件里怎么写。
- **web 没有任何常驻测试** ✔。`web/package.json` 只有 `dev` / `build` / `preview` / `typecheck`。任务里写的「35/35」「87 条断言」都来自跑完就删的一次性 CDP 脚本，归档里的数字全都无法复现。本次审查查出的 web 缺陷（首页 Enter 劫持、导入完成判定），改完之后同样没有任何回归保护。
- api 的 integration 测试要连真 Postgres（`tests/global-setup.ts` 会建 `<库名>_test`）。本地不起库时只能跑 unit，没有地方保证两组都跑过。

任务板上原有一段说明把 web e2e **排在 §6.4 和部署之后**。本任务沿用这个排期，先登记，不提前开工。

## 2. 范围（草案）

**CI**：api `typecheck` + unit + integration（CI 里起 Postgres 服务）；web `typecheck` + `build`。闸门以 `cd web && npm run typecheck` 为准，因为它会把 `api/src` 一起编译。

**web 常驻测试**，按任务板那段已有的取舍：

- 值得留：硬边界（key 不出响应）、错误码路径、403、重建端到端，加上本次的首页键盘路径、导入完成判定。
- 不留：布局类断言。视觉风格还没定稿，留下来只会因为装饰改动变红。
- 最先重建的是**六模式的模型上游替身**（`good` / `weak` / `small` / `badkey` / `offvocab` / `refuse`），设计记在[模型配置任务归档](../_archive/joint-tasks/2026-09-16-ai-config.md)的 web 验收里。

## 3. 开工条件

[回收站与定时清理](2026-09-24-trash-and-cleanup.md)（§6.4 余下部分）与[首次部署](2026-09-24-first-deploy.md)完成之后开工；CI 这一半可以提前，由总管和产品负责人决定。
