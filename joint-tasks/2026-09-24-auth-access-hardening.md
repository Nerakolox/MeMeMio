# 会话与访问收口：读路径登录、限流、注册竞态、401 跳转

**状态**：`in_progress`（§4 两项待裁定，本轮不实现）｜ **性质**：**跨端** ｜ 开于 2026-09-24

主体契约不变：SPEC §3.3 早就写明「搜索 / 浏览 / 使用：所有登录用户」，§2.2 早就定义了 `UNAUTHENTICATED` 跳登录、`RATE_LIMITED` 按 `Retry-After` 退避。本任务是把代码拉回契约，**不是**把 SPEC 改成代码现在的样子。

来源是 2026-09-24 的只读审查。标 ✔ 的条目总管已核实；其余执行者先复核，查无此事的记「不成立」。

## 1. 为什么要做

- **不登录也能看全库、调用部署方的 AI 额度** ✔。`routes/memes.ts:238`、`routes/search.ts:19` 挂的是 `optionalAuth`，注释写着「取决于部署方」，但 SPEC §3.3 没给这个选项。匿名搜索用的是部署方的 embedding；HyDE 也回落到部署方视觉通道（`ai/hyde.ts:75`）。全站又没有限流，谁都能刷部署方的账单，邀请制等于没有。
- **登录、注册没有限流，全局也没有请求体大小限制** ✔（`app.ts`）。注册先查重名、再做 scrypt、最后才校验邀请码（`routes/auth.ts:77-100`），未登录就能枚举用户名、消耗 CPU。
- **首个管理员有竞态** ✔。注册事务里先 `countUsers` 再建用户，没有锁；两个人同时注册，可能都成为 admin（`routes/auth.ts:86-90`）。
- **邀请码并发时能被重复使用**：先 select 再 update，update 没查影响行数（`data/auth.ts:85-104`）。
- **web 读路径遇到 401 不跳登录**：只有设置页三个保存点处理了 `UNAUTHENTICATED`（`save-error.ts:32`）。其余读路径只显示「加载失败」，会话过期后用户只能反复点重试。api 收口后，这条会变成常见路径。

## 2. 做完的标准

- 未登录请求 `GET /memes`、`GET /memes/{id}`、`/search`、随机图墙，一律 401 `UNAUTHENTICATED`。有一条测试钉住。
- 登录、注册超过阈值返回 429 `RATE_LIMITED`，并带 `Retry-After`。**在反代后面实测一次**，确认计数用的是真实客户端 IP（见 §3 陷阱）。
- 两个请求并发注册首个账号，只有一个 admin；同一邀请码并发使用，只有一个成功。
- web：任一读路径收到 401，都会清掉 `user`，跳到 `/login` 并带上回跳地址，登录后回到原页面。`/auth/me` 网络失败时显示「连不上服务器」，不当成未登录。
- `/ui` 组件展示页不进生产包，或放进 `RequireAuth`（二选一，web 定）。

## 3. api 端

| # | 改什么 | 位置 |
|---|---|---|
| 1 ✔ | `memes`、`search` 两组路由从 `optionalAuth` 改成 `requireAuth`。收藏端点顺带不再需要「未登录时 favorited 恒为 false」那条分支 | `routes/memes.ts:24-27, 238`、`routes/search.ts:15-19` |
| 2 ✔ | 登录、注册限流，返回 `RATE_LIMITED` 并带 `Retry-After`；全局加 `bodyLimit` | `app.ts`、`routes/auth.ts` |
| 3 ✔ | 注册改成「先校验邀请码 → 再查重名 → 最后 scrypt」 | `routes/auth.ts:77-100` |
| 4 ✔ | 首个用户判定加锁（`pg_advisory_xact_lock`，或 `lock table users in share row exclusive mode`） | `routes/auth.ts:86` |
| 5 | 消耗邀请码改成单条 `update … where used_by is null and expires_at > now() returning`，影响 0 行即判无效 | `data/auth.ts:85-104` |
| 6 | 路径参数和游标里的 id 先做 uuid 形状校验：不合法返回 404（或 400），不要落成 Postgres `22P02` → 500。retag 已经挡了（`routes/memes.ts:118`），照它做 | `/memes/:id` 系列、`?uploader=`、`/imports/:batchId`、`PATCH /admin/users/:id` |
| 7 | 管理员改配额时，`BigInt("abc")` 抛异常变 500，应该是 400 | `routes/admin.ts:109` |
| 8 | 「测试连接」的 fetch 改 `redirect: 'manual'`。这一条没有取舍：跟随 302 时 POST 会变 GET，上游响应经 `rawResponse` 原样回显，是完整回显的 SSRF | `ai/provider.ts:103`、`ai/probe.ts:62` |

**陷阱**：部署在 Caddy / nginx 后面时，所有请求的 socket IP 都是反代的。按 socket IP 限流，就会变成**全站共用一个计数器**，一个人输错五次，全站锁死。必须从 `X-Forwarded-For` 取客户端 IP，而且只信任反代那一跳。计数放在进程内存里即可，但它和运行参数一样是「每进程」的（§5.6 那条），在注释里写明。

**与 [导入加固](2026-09-24-import-hardening.md) 的关系**：两个任务都在 api 上，文件不重叠（本任务不碰 `services/import.ts`），可以并行。

## 4. 待裁定（本轮不实现）

两项都会改 SPEC，按 §8.1 先定契约。

1. **首个管理员的空窗期。** SPEC §3.2 规定「第一个注册的人自动成为 admin」，公网上线后、运维本人注册之前，谁先注册谁就是 admin，部署手册一字未提。候选方案：
   - ①首次注册要求 `BOOTSTRAP_TOKEN` 环境变量；
   - ②改用 CLI 脚本 `node dist/create-admin.js` 建首个 admin，注册一律要邀请码；
   - ③保持现状，只在部署手册里写「上线前先注册」。

   **总管倾向②**：它彻底消除空窗，而且和已有的 `migrate` 一样是部署步骤，不引入新的运行期状态。代价是本地开发多一步。**需要产品负责人拍板。** 拍板后，改 SPEC §3.2 + §9，部署手册那半进 [首次部署](2026-09-24-first-deploy.md)。
2. **「测试连接」要不要拒私网地址。** 只做 §3 第 8 条，挡不住直接填 `http://169.254.169.254`。但一律拒私网，会误伤最正当的自部署场景：局域网里的 Ollama / LM Studio。候选：默认拒私网和链路本地地址，部署方用环境变量放行。**需要产品负责人拍板。**

## 5. web 端

| # | 改什么 | 位置 |
|---|---|---|
| 1 | `lib/api.ts` 统一拦 `UNAUTHENTICATED`：清 `user` → `navigate('/login', { state: { from } })`。`save-error.ts` 里那份特判随之删掉，不要留两份 | `lib/api.ts`、`contexts/auth.tsx`、`features/settings/save-error.ts:32` |
| 2 | `/auth/me` 区分「401」和「网络失败」：后者显示可重试的错误，不踢回登录页 | `contexts/auth.tsx:15-25` |
| 3 | 登录、注册页收到 `RATE_LIMITED` 时显示 message，按 `Retry-After` 给出「N 秒后再试」 | `routes/login.tsx`、`routes/register.tsx` |
| 4 | `/ui` 不进生产包（`import.meta.env.DEV` 条件路由 + `React.lazy`），或放进 `RequireAuth` | `App.tsx:158` |

**阻塞关系**：web 第 1、2、4 条不依赖 api，可以先做。第 3 条要等 api §3 第 2 条合入，才能在真链路上看到 429；在那之前可以用替身，但替身必须按 api 实现逐字校准，并在验收里写明「对着替身」。

## 6. api 端验收

（待回填）

## 7. web 端验收

**四条都改完了**，但**只有第 1、2、4 条在真链路上验过**；第 3 条（429）与「读路径 401」这一条语义**对着替身验的**，原因见 §7.4。回填人：web 执行者，2026-09-24。

### 7.1 逐条

| # | 落地 | 证据 |
|---|---|---|
| 1 | `lib/api.ts` 的 `toApiError` 是**唯一发请求的地方**（http.md 的既定结构），会话过期就拦在这里：`err.code === 'UNAUTHENTICATED'` → 清 `user` → 跳登录页并带当前地址。副作用由 `AuthProvider` 用 `setUnauthenticatedHandler` 注册进去（那个模块不是 React 组件，拿不到 `useNavigate`）。`save-error.ts` 里的 `needsLogin` 分支与 `loginRedirectPath()` 已删，三个设置卡片里各写一次的跳转也删了 | 替身 §3/§5 两组；真链路 §7.2 |
| 2 | `contexts/auth.tsx` 的启动探测改成三态：`checking` / `ready`（未登录是 `ready` + `user === null`）/ `unreachable`。第三态渲染新文件 `features/auth/ServerUnreachable.tsx`——`连不上服务器` + `requestId` + 重试按钮 | 替身 §8、§8b；真链路 §7.2 |
| 3 | `LoginForm` / `RegisterForm` 新增 `use-cooldown.ts`，`ApiError.retryAfterSeconds` 由 `parseRetryAfter` 解析（**两种形式都认**：`delta-seconds` 与 HTTP-date），按钮禁用并显示「N 秒后可重试」 | **替身** §7（真链路拿不到，见 §7.4） |
| 4 | `/ui` 走 `import.meta.env.DEV` 条件路由 + `React.lazy`，**不放进 `RequireAuth`**。选前者是因为 `RequireAuth` 只挡住未登录的人，登录用户仍然在下载那一整包 `components/ui/*` | `dist/assets/index-*.js` grep：`组件库参照页` 0、`label:"组件"` 0、`routes/ui` 0；产物仍只有一个 JS chunk（那条 `import()` 被常量折叠成死代码）。dev 下 `/ui` 与侧边栏「组件」入口仍在（替身 §9） |

### 7.2 实测手段与结果

真 Chrome（零依赖 CDP 驱动系统 Chrome，仓库里没有 Playwright），桩与验收全在 `127.0.0.1`（`localhost` 在 Windows 上只解析到 `::1`，Vite 只绑得上一个）。替身 api 监听 3001，dev server 用既有的 `MEMEMIO_API_PROXY` 指过去。**没有新增依赖，没有 `--no-save`**。

- 替身链路 `run.mjs`：9 组 26 条断言**全部通过**，无未捕获异常。含：未登录 `next` 带完整 query、登录后回原页、读路径 401 → 清 `user` → 跳登录（`next` 含 `isAnimated=true`）、设置页写路径 401 同样统一跳转（替代原特判）、**密码错 401 不当会话过期**（停在 `/login`、表单不清）、429 显示 message + `requestId` + 倒计时并在 30 秒后恢复可点、`/auth/me` 500 与 CDP 拦网两条都进「连不上服务器」且重试可恢复。
- 真链路 `run-real.mjs`：无会话进 `/settings` → 真 api 的 `/auth/me` 401 → 跳 `/login?next=%2Fsettings`，登录表单渲染正常，**没有**落进「连不上服务器」那一屏。4 条全过。
- `npm run typecheck` 与 `npm run build` 干净。
- 截图：`.mememio-verify/shot-429.png`（按钮禁用、文案「30 秒后可重试」）、`.mememio-verify/shot-unreachable.png`（故障屏含 `requestId` 与重试）。验收脚本与替身在仓库外的临时目录，未进版本库。

### 7.3 与任务写的两处不同（都不改 SPEC）

1. **回跳机制用 `?next=` 而不是 `state: { from }`。** 任务 §5 第 1 条写的是 `navigate('/login', { state: { from } })`，但仓库里已经有成文的机制：state-navigation.md §5 的 `?next=` + `LoginForm.tsx` 的 `safeNext`（挡 `//evil.com` 之类跨源回跳）。再引入 `state` 会出现两套回跳、且刷新页面就丢，所以三条产生方（`RequireAuth`、会话过期拦截器、设置页）统一到一个 `loginPath(from)`。SPEC §2.2 只写了「跳登录页保留当前路由」，没钉机制，无需改契约。
2. **`/auth/*` 四条路径被排除在拦截之外。** 这是任务没提但**必须**做的：api 对「用户名不存在」和「密码错误」返回同一个 `UNAUTHENTICATED`（防枚举），不排除的话，密码输错一次就表现为「清空刚填的表单 + 从 `/login` 再跳一次 `/login`，且 `next` 指向 `/login` 自己」，登录成功后原地打转。排除清单在 `lib/api.ts` 的 `SESSION_PATHS`，含 `login` / `register` / `logout` / `me`。

### 7.4 真链路上验不到的两条（api 依赖）

- **读路径 401**、**429** 都要等 api §3 第 1、2 条合入。本轮 curl 实测真 api：`GET /api/v1/memes?limit=1` 未登录仍返回 **200**，登录接口也不限流。所以 §8 那两条联合验收现在只能对着替身走一遍，**替身是按任务 §3 第 2 条的写法手写的**（429 + `Retry-After: 30`），还没与真的 api 实现逐字对齐。api 合入后必须重跑，尤其是：
  - `Retry-After` 的实际形式（替身发秒数；若 api 发 HTTP-date，`parseRetryAfter` 也认，但没在真链路上走过一遍）；
  - 限流是按 IP 还是按账号、以及反代后面取没取到真实客户端 IP（api 端 §3 陷阱）；
  - 会话过期后读路径 401 的实际触发点（替身用 `GET /memes` 模拟）。
- 「密码错 401 不停在原地」这一条在替身上验的是 api 的**既有**行为（同一个 `UNAUTHENTICATED`），不是新契约，可以直接采信。

### 7.5 未做

- 未改 SPEC，未改 `api/` 任何代码。
- §4 两项待裁定与 web 无关。
- 组件参照页的 `React.lazy` 只在 dev 下生效，**生产包里连 chunk 都没有**，所以生产环境没有「懒加载 `/ui`」这回事。

## 8. 联合验收

真 api × 真浏览器：会话过期后从浏览页触发 401 → 跳登录 → 登录后回到原页面；连续输错密码触发 429 → 看到倒计时。
