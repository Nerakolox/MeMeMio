# 环境

## 1. 环境变量

```bash
# 命名（唯一需要改的）
APP_SLUG=mememio

# 数据库（主机名就是容器名，走内部网络）
DB_PASSWORD=<随机>
DATABASE_URL=postgres://${APP_SLUG}:${DB_PASSWORD}@${APP_SLUG}-db:5432/${APP_SLUG}

# 密钥
SESSION_SECRET=<随机>
CONFIG_ENC_KEY=<随机 32 字节>     # 加密用户 API Key 的主密钥

# 对象存储
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
R2_BUCKET=<bucket>
R2_KEY_PREFIX=${APP_SLUG}/        # ← 共用 bucket 时必须，否则对象互相覆盖

# 部署方提供的默认模型配置（用户未配置时使用）
DEFAULT_VISION_BASE_URL / DEFAULT_VISION_API_KEY / DEFAULT_VISION_MODEL
DEFAULT_EMBED_BASE_URL  / DEFAULT_EMBED_API_KEY  / DEFAULT_EMBED_MODEL
```

> 🔴 **`CONFIG_ENC_KEY` 丢失 = 所有用户配置的 API Key 全部永久解不开。**
>
> 它不在数据库备份里，必须单独离线备份。**这是本项目唯一一个「丢了就没法恢复」的东西**——数据库、图片、代码都能重建，它不能。

## 2. 启动时校验，不要运行时才发现

进程启动时一次性校验全部环境变量，**缺一个就拒绝启动并打印缺了哪个**。不要用 `process.env.X!` 这类写法把问题推到第一次调用时——那时的报错现场离根因已经很远了。

`CONFIG_ENC_KEY` 额外校验长度必须是 32 字节，短了直接拒启动。

实现约束见 `api/agents/rules/env-validation.md`。

## 3. 本地开发

需要：Node 22+、Docker（起 Postgres）、ffmpeg（本机装或用容器）。

```bash
# 1. 只起数据库
docker compose up -d db

# 2. 迁移
cd api && npm run migrate

# 3. 两端各自起
cd api && npm run dev     # :3000
cd web && npm run dev     # :5173，proxy /api → :3000
```

本地开发时前后端**不同域**（5173 vs 3000），靠 Vite 的 `server.proxy` 把 `/api` 转发过去，这样 cookie 仍然是同域的。生产是真同域，见 [deployment.md](deployment.md)。

本地 cookie **不设 `Secure`**，生产必须设。这是唯一一处允许按环境分支的会话配置。

## 4. 本地的 R2

两个选择：

| 方案 | 适用 |
|---|---|
| 连真实 R2 的一个 dev bucket，`R2_KEY_PREFIX=dev-<你的名字>/` | 推荐，行为与生产一致 |
| MinIO 容器 | 离线开发，但预签名 URL 的细节与 R2 有差异 |

**不要做「本地存文件系统」的分支。** 那会让上传路径在本地和生产走两套代码，而上传路径恰恰是最难在本地复现问题的地方。

## 5. 没有 AI Key 时怎么开发

大部分功能不需要真实的 AI 调用：

- 不配 `DEFAULT_VISION_*` 时导入仍然可用，图片入库为 `tagStatus = pending`，这是[产品明确要求的行为](product.md)
- 不配 `DEFAULT_EMBED_*` 时搜索降级为 OCR + 标签，响应带 `degraded: true`

**这两条降级路径不是为开发准备的便利，是生产也要走的真实路径**，所以本地跑在降级态是有价值的——它天天在验证降级没坏。

需要真实调用时（改提示词、跑评测集），用自己的 key 配进用户设置页，不要改环境变量。
