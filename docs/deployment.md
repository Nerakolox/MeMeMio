# 部署

目标环境是**一台机器上同时跑多个项目**。这个前提决定了本文的绝大部分设计——不是为了跑起来，是为了**跑起来之后不影响别人、也不被别人影响**。

## 1. 命名冲突清单

单机多项目的冲突点远不止数据库名。按严重程度排列：

| 层 | Docker 默认值 | 撞车后果 |
|---|---|---|
| **数据卷** | `<目录名>_pgdata` | 🔴 **两个项目的 Postgres 挂同一个卷，数据直接损坏** |
| **网络** | `<目录名>_default` | 🔴 跨项目容器能互相连通，是安全问题 |
| 宿主机端口 | 5432 / 3000 | 🟠 后启动的那个起不来 |
| 容器名 | `<目录名>-<服务>-1` | 🟠 冲突时创建失败 |
| PG database / role | `postgres` / `postgres` | 🟠 共用实例时互相覆盖 |
| R2 对象键 | 无前缀 | 🟠 共用 bucket 时对象互相覆盖 |
| 镜像 tag | `<目录名>-app:latest` | 🟡 误推误拉 |

**最危险的是卷。** 端口冲突会立刻报错，很好发现；卷冲突是静默的——两个 Postgres 实例挂上同一个数据目录，数据库会被写坏，而且往往过一阵才发现。

## 2. 单一变量派生全部命名

不要在十几个地方各写各的前缀，**只维护一个变量，其余全部派生**。

`.env`：

```bash
APP_SLUG=mememio          # ← 全项目唯一需要改的命名变量
DB_PASSWORD=<随机生成>
```

`compose.yaml`：

```yaml
name: ${APP_SLUG}          # ← 主防线：容器/卷/网络自动带此前缀

services:
  app:
    build: .
    container_name: ${APP_SLUG}-app
    restart: unless-stopped
    env_file: .env
    depends_on:
      db: { condition: service_healthy }
    networks: [internal, proxy]
    # 注意：不映射任何宿主机端口，见 §4

  db:
    image: pgvector/pgvector:pg17
    container_name: ${APP_SLUG}-db
    restart: unless-stopped
    environment:
      POSTGRES_DB:       ${APP_SLUG}
      POSTGRES_USER:     ${APP_SLUG}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${APP_SLUG}"]
      interval: 5s
      retries: 10
    networks: [internal]
    # 同样不映射端口，数据库只在内部网络可见

volumes:
  pgdata:
    name: ${APP_SLUG}_pgdata      # 显式命名，不依赖默认推导

networks:
  internal:
    name: ${APP_SLUG}-internal
  proxy:
    external: true
    name: shared-proxy            # 全机共享的反代网络，见 §4
```

**顶层 `name:` 是主防线**——设了它之后，Compose 会自动给卷、网络、容器加上这个前缀，不再依赖「目录名」这个极易撞车的默认值。下面的 `container_name` 和卷的 `name:` 是第二层保险，同时让 `docker ps` 的输出一眼能看出归属。

> ⚠️ Compose 的顶层 `volumes:` / `networks:` 的 **key 不支持变量插值**，只有块内的 `name:` 字段支持。所以是 `pgdata: { name: ${APP_SLUG}_pgdata }`，不是 `${APP_SLUG}_pgdata:`。

## 3. 数据库：独占实例，不共用

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A. 每个项目自带 db 容器**（推荐） | 本项目一个 Postgres 容器 | 隔离彻底；代价是每实例约 100MB 内存 |
| B. 全机共用一个 Postgres | 各项目独立 database + 独立 role | 省内存；但**扩展版本互相牵制** |

**推荐 A，理由不是内存而是扩展**：本项目依赖 `pgvector` 和 `pg_trgm`，共用实例时升级 pgvector 会同时影响同机所有项目，牵一发动全身。独占一个容器，版本完全自己说了算。

若确实要走 B，则必须做到：独立 database（`mememio`）、独立 role（`mememio`）、`REVOKE` 掉该 role 对其他 database 的访问。**不要用共用 database + 表前缀的方式做隔离**——权限边界为零，一次写错 SQL 就能读到别的项目的数据。

## 4. 端口：一个都不映射

单机多项目下，手工分配宿主机端口是个治标不治本的办法，项目一多必然出错。

**做法：所有项目都不映射宿主端口，统一走一个反向代理容器。**

```
              ┌─────────────────────────────┐
  :80 :443 ── │  Caddy / nginx（唯一暴露端口）│
              └──────────────┬──────────────┘
                             │  shared-proxy 网络
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
     mememio-app      其他项目-app       又一个项目-app
            │
            │  mememio-internal 网络（外部不可达）
            ▼
       mememio-db
```

反代通过容器名访问（`http://mememio-app:3000`），**端口冲突这个问题从根上消失了**。数据库只挂在 `internal` 网络上，连反代都碰不到它。

`shared-proxy` 是一个外部网络，全机所有项目共用，需先手工创建一次：

```bash
docker network create shared-proxy
```

## 5. 镜像构建

三阶段：前端产物 → 后端产物 → 运行镜像。

```dockerfile
FROM node:22-bookworm-slim AS web
WORKDIR /w
COPY web/package*.json ./
RUN npm ci
# 词表，web 在编译期打进产物
COPY shared/ /shared/
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS api
WORKDIR /a
COPY api/package*.json ./
# 这里不能加 --omit=dev：tsc 是 devDependency
RUN npm ci
COPY api/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=api /a/node_modules ./node_modules
COPY --from=api /a/dist        ./dist
# migrate 命令和启动时的版本检查都要读 migrations/
COPY --from=api /a/migrations  ./migrations
# SPA 产物，由 Hono 同域托管
COPY --from=web /w/dist        ./public
# 运行期校验标签用，和 web 打进去的是同一份
COPY shared/ /shared/
CMD ["node", "dist/server.js"]
```

**五个坑**（后三个是 2026-09-13 第一次真正构建这份 Dockerfile 时踩出来的，之前的版本构建不出来）：

- **用 `bookworm-slim`，不要用 Alpine。** `sharp` 的预编译二进制在 musl 上经常出问题，装 ffmpeg 也更麻烦。glibc 基础镜像大一些，但省掉的调试时间远超那点体积。
- **ffmpeg 会让镜像涨约 100MB+**，这是抽帧方案的必要成本，可接受。不要为了瘦身换成裁剪版 ffmpeg，动图格式的覆盖面会出问题。
- **api 阶段 `npm ci` 不能带 `--omit=dev`，构建完再 `npm prune --omit=dev`。** `tsc` 在 devDependencies 里，少了它直接 `sh: 1: tsc: not found`。prune 放在同一层，最终镜像里仍然只有运行期依赖。
- **Dockerfile 里 `#` 只有在行首才是注释。** 写成 `COPY a b   # 说明` 会把 `#` 和后面的词当成额外的源路径，报 `"/#": not found`。所有说明必须单独一行。
- **`shared/` 要 COPY 两次，路径必须是 `/shared/`。** web 阶段是编译期需要（走 Vite alias 打进产物），最终镜像是运行期需要（api 校验标签时读）。api 用 `process.cwd()/../shared/vocab/vocab.json` 定位它——开发时 cwd 是 `<repo>/api`，镜像里是 `/app`，两边都能解析到，**这是刻意对齐的，改 WORKDIR 会同时打断两边**。

还有一条不在 Dockerfile 里但由它引出：**`npm prune --omit=dev` 之后镜像里没有 `pino-pretty`**，所以日志器不能只按 `NODE_ENV` 决定挂不挂它——拿非 production 的 `NODE_ENV` 跑镜像会在加载日志器时就崩。`api/src/logger.ts` 探测的是「装没装」而不是「哪个环境」。

**`web` 的 `npm run typecheck` 必须进提交前检查和 CI。** `vite build`（esbuild）不做类型检查，`web` 与 `api` 之间的类型链路只有 `typecheck` 能验证。漏掉这条，`api` 改字段名后 `web` 端编译照过、链路断了也不知道。

不做 `npm workspaces`：两个阶段各自 `npm ci`，所以**两个工作区各有一份 lockfile**，没有根 lockfile。`web` 消费 `api` 类型靠 tsconfig `paths`（`@api/* → ../api/src/*`）+ `import type`，不走包解析，api 的运行时代码进不了前端产物。

这个 Dockerfile 同时从 `web/` 和 `api/` 构建，是[单仓库结构](architecture.md)的直接原因。

## 6. 迁移

用 `drizzle-kit` 一类工具，走**独立的 migrate 命令**：

```bash
docker compose run --rm app node dist/migrate.js
```

**不要放在容器启动流程里自动执行。** 将来跑多副本时会出现并发迁移，而那种故障发生在启动瞬间，最难排查。多一步手工命令换掉一类隐患，划算。

启动时**只检查不执行**：进程比对 `migrations/meta/_journal.json` 和库里 `drizzle.__drizzle_migrations` 的条数，落后就打印待跑的迁移名 + 上面那条命令，然后 `exit(1)`。「起不来」比「悄悄跑了迁移」好排查得多。

迁移文件名是 `NNNN_动词_对象.sql`（SPEC §7.6）。drizzle-kit 默认给随机名，**生成时必须带 `--name`**：

```bash
cd api && npm run db:generate -- --name=create_core_tables
```

`CREATE EXTENSION` drizzle-kit 不会生成，手工补在第一条迁移的最前面（`vector` 和 `pg_trgm`，建表就要用到）。**不要放进 compose 的 initdb 脚本**——那个只在卷第一次创建时跑一次，换环境就会漏。

## 7. 备份

| 对象 | 做法 |
|---|---|
| 数据库 | `pg_dump` 定时导出，落到 R2 或宿主机另一块盘 |
| 图片 | 已在 R2，建议开 bucket 版本控制 |
| `CONFIG_ENC_KEY` | **单独离线保存**，不放在 Docker 和数据库里 |

`pg_dump` 会带上 `vector` 类型列，**恢复端必须先装好 pgvector 扩展**，否则恢复会在中途失败。

## 8. R2：开通、公开访问与 CORS

图片全部走 R2，浏览器**直接和 R2 打交道两次**——上传时 PUT 到预签名 URL，浏览时 GET 公开地址。这两条路各有一套配置，少配一边的表现完全不同，所以分开列。

### 8.1 开通与凭证

1. Cloudflare 控制台开通 R2（需要绑卡，有免费额度）。
2. 建 bucket，名字填进 `R2_BUCKET`。
3. 在 **R2 Overview 页右上角的 `{} API` → Manage API Tokens** 建令牌：**Create User API Token**，权限选 **Object Read & Write**，Specify bucket 限定到本 bucket。
4. 建完那一屏给出 **Access Key ID** 和 **Secret Access Key**，分别填 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`。**这一屏关掉就看不到第二次了。**
5. `R2_ACCOUNT_ID` 填 account id，就是 32 位十六进制那一段。

> ⚠️ **两个 2026-09-18 现踩的坑：**
>
> - 令牌**不在 bucket 设置里**，在 R2 账户级的 Manage API Tokens。从 Cloudflare 通用的 **My Profile → API Tokens** 页建出来的令牌只给一个 token value，**不是** S3 的 Access Key ID / Secret Access Key，填进去必然连不上。
> - `R2_ACCOUNT_ID` **只填那 32 位十六进制**，不要把整条 `https://<id>.r2.cloudflarestorage.com` 粘进去。粘了之后 endpoint 会拼成两层域名，而这**不报错**——一路错到浏览器的 `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`，离根因隔着整条链路。

### 8.2 公开访问

bucket 设置里开 **Public Access**，拿到 `https://pub-<hash>.r2.dev` 形式的地址（或绑自定义域），填进 `R2_PUBLIC_BASE_URL`。

两条硬性格式要求，填错进程直接起不来或图片全裂：

- **不带末尾 `/`**（`api/src/lib/env.ts` 会拦下来）。
- **不要把 `R2_KEY_PREFIX` 拼进这个地址。** 前缀由代码统一加（`api/src/storage/r2.ts` 的 `key()`），拼进来等于前缀在两个环境变量里各写一份，两边什么时候不一致都不报错。

### 8.3 CORS

**上传必须配，浏览必须不配。** 上传是浏览器跨域 PUT，没有 CORS 会被预检拦掉；公开 GET 是 `<img>` 加载，不受 CORS 管。

在 bucket 的 Settings → CORS Policy 填（正式部署把 origin 换成自己的域名）：

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

上面这份 2026-09-18 实测可用。生产同域部署时 origin 是反代那个域名，**不是** api 容器的地址——CORS 看的是浏览器地址栏。

### 8.4 配错了怎么发现

进程启动时会对 bucket 做一次探活（`api/src/storage/r2.ts` 的 `assertR2Reachable`），不通就**拒绝启动**，日志里给出 endpoint、bucket、前缀和错误类型。

这一步是有来历的：在它存在之前，R2 配错**全程没有任何一处报错**——预签名是纯本地 HMAC 计算，假凭证照样签得出格式完美的 URL，导入接口返回 200，一切看起来都在正常工作。所以**「起不来」在这里是想要的行为**，别把它当成需要绕过的障碍。

## 9. 落地检查清单

新机器部署或者新加一个同机项目时，逐条核对：

- [ ] `.env` 里 `APP_SLUG` 已改成本项目专属值，且与同机其他项目不重复
- [ ] `docker volume ls` 中本项目的卷带 `APP_SLUG` 前缀，且不与他人同名
- [ ] `docker network ls` 中内部网络带前缀；`shared-proxy` 已创建
- [ ] compose 里**没有任何 `ports:` 映射**（db 尤其不能暴露）
- [ ] **部署机上不存在、也永远不要用 `compose.dev.yaml`**——它唯一的作用是给本机开发把 db 的 5432 绑到 `127.0.0.1`，只在显式 `-f compose.dev.yaml` 时才生效。命名成 `compose.override.yaml` 会被自动加载，所以刻意**没有**这么命名
- [ ] `R2_KEY_PREFIX` 已设置（若与其他项目共用 bucket），且以 `/` 结尾
- [ ] `R2_PUBLIC_BASE_URL` 已设置，**不带末尾 `/`**，且**没有**把 `R2_KEY_PREFIX` 拼进去（§8.2）
- [ ] R2 的 S3 凭证来自 **R2 → Manage API Tokens**，不是通用 API Tokens 页那个 token value（§8.1）
- [ ] bucket 的 CORS 已配，`AllowedOrigins` 是**正式域名**而不是 `localhost:5173`（§8.3）
- [ ] 起一次进程确认没有「R2 探活失败」——它是 R2 配错唯一会主动报出来的地方（§8.4）
- [ ] 真导一张图，在浏览器里打开返回的 `url` 和 `thumbUrl`，**看到图**而不是 404
- [ ] `CONFIG_ENC_KEY` 已离线备份到 Docker 和数据库之外的地方
- [ ] 反代已配置指向 `${APP_SLUG}-app`
