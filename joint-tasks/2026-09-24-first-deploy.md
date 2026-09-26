# 首次部署与积压的联合验收

**状态**：`in_progress` ｜ **性质**：总管 + 运维（不改 `api/`、`web/` 代码）｜ 开于 2026-09-24

## 1. 为什么要做

**任务板上积压了一批永远到不了 `done` 的任务。** 它们卡在「真 api × 真浏览器联调没跑」，其中一部分还要求「部署 + 库里有真数据」。部署本身却一直没有任务，形成了死锁。

**照着 `docs/deployment.md` 部署不起来** ✔。手册讲清了命名隔离、端口、镜像、R2，但缺三样：

1. **从零到能访问的完整命令序列。** `docker network create shared-proxy` → build → `node dist/migrate.js` → up → 配反代 → 注册首个账号。这些步骤散落在 §4 / §5 / §6 里，没有串起来。
2. **反代配置样例。** §4 只有一张示意图，Caddy / nginx 一行配置都没有。另外，[会话与访问收口](2026-09-24-auth-access-hardening.md) 的限流依赖反代正确转发 `X-Forwarded-For`，样例里必须带上这一条。
3. **首个管理员怎么产生。** 全文没有「管理员」三个字。按 SPEC §3.2，谁先注册谁就是 admin，公网上线后有一段空窗期。怎么补取决于那个任务 §4 的裁定。

## 2. 积压的联合验收，分两类

**不需要部署**，本地真 api + 真 web 就能跑。这类现在就可以做，别被部署一起卡住：

| 任务 | 要验的 |
|---|---|
| [运行参数](2026-09-23-runtime-config.md) | web 断言全对着替身，两端从未对话；按该任务「总管裁定」列的三条去盯 |
| [打标状态界面](2026-09-19-tagging-status.md) | 造一张 `needs_manual`（连一个不存在的模型地址），核对「汇总 `needsManual` = 列表条数」 |
| [批量重打标](2026-09-22-retag-endpoint.md) | 真库全量重打。**要花 admin 的额度、约 9–20 分钟，跑之前问产品负责人** |

> ~~[迁 Tailwind v4](../_archive/joint-tasks/2026-09-21-web-tailwind-v4-radix-luma.md)：登录后四个业务页过一眼~~
> —— **2026-09-25 已解**：四页走查用替身 + 真图实测，不依赖登录凭据，也就不用等部署（见
> [`_archive/joint-tasks/2026-09-25-web-page-walkthrough.md`](../_archive/joint-tasks/2026-09-25-web-page-walkthrough.md)）。

**需要部署**，要真域名、真 R2、真配额，或者真机：导入任务转出的遗留项（`existing` 为 null 的降级、SSE 断线重连、`QUOTA_EXCEEDED` 展示、移动端 / Safari / Firefox）、首页图墙的空库态和失败态、复制 / 分享真机（`web/AGENTS.md §6`）。

## 3. 做完的标准

- `docs/deployment.md` 新增一节「首次部署」：一条可以照着敲完的命令序列 + 一份反代样例（含 `X-Forwarded-For`）+ 首个管理员的产生方式。
- 按这一节在一台干净的机器上真部署一次，**过程中卡住的每一处都写回手册**。
- §2 两张表逐项跑完，结果回填到各自的任务文件，由各任务自己转 `done`。

## 4. 阻塞

- ~~首个管理员那一段，等[会话与访问收口](2026-09-24-auth-access-hardening.md) §4 第 1 条的裁定。~~ —— 2026-09-26 裁定为「保持现状、手册写清」，见 [SPEC §9.32](../spec/09-decisions.md)。
- 需要一台部署目标机和一个域名：**由产品负责人提供**，本任务不假设已有。

## 5. 进展（2026-09-26）

**产品负责人给定的部署形态：** 服务器拉代码、自己 `docker compose build` 自己跑，不走镜像仓库；服务器上**已有**跑在 Docker 里的 Caddy / nginx 占着 80/443。这正好是现有 `compose.yaml` 的设计（不映射端口，挂 `shared-proxy`），**`compose.yaml` 与 `Dockerfile` 都没改**。

**手册已写**：`docs/deployment.md` 新增 §9「首次部署」（原 §9 清单顺延为 §10，新增 3 条勾选项）：

- §9.1 `.env` 与本机开发不同的项。单独标了 `NODE_ENV=production` —— 它同时是 cookie `Secure` 的开关，忘改是静默少一层保护，改了却走 HTTP 是「登录成功、下一个请求 401」；
- §9.2 命令序列：`network create` → `build` → `up -d db` → `migrate` → `up -d`；
- §9.3 Caddy / nginx 样例。nginx 带 `X-Forwarded-For`、Docker 内置 DNS、SSE 超时与 `proxy_buffering off`；写明 `TRUSTED_PROXY_HOPS = 1` 意味着**前面不能再套 CDN**；
- §9.4 首个管理员：反代一通立刻注册 + SQL 核对 + 被抢注时 `truncate users cascade`（只限新库）；
- §9.6 以后更新的四条命令。

**没验的，别读成验过了：**

- **一条命令都没在干净机器上跑过。** 本机试构建镜像时 Docker Desktop 没开，`docker compose build` 连不上 daemon，**镜像构建也没复跑**（上次真构建是 2026-09-13，之后两端依赖都变过）。
- nginx 样例是按代码推出来的，没对着真 nginx 起过；Caddy 那两行同理。
- `truncate users cascade` 没在库上执行过。

**下一步：** ①本机开 Docker Desktop，照 §9.2 走一遍（反代用一个临时 Caddy 容器、`localhost` 域名），卡住的地方写回手册；②产品负责人在服务器上真部署一次；③之后逐项跑 §2 的「需要部署」那一类。
