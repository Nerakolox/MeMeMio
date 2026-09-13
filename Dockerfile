# 三阶段：前端产物 → 后端产物 → 运行镜像。理由与两个坑见 docs/deployment.md §5。
#
# 用 bookworm-slim 不用 Alpine：sharp 的预编译二进制在 musl 上经常出问题，
# 装 ffmpeg 也更麻烦。体积换调试时间，划算。

FROM node:22-bookworm-slim AS web
WORKDIR /w
COPY web/package*.json ./
RUN npm ci
# 词表是两端共享的主源（SPEC §0.2），web 在**编译期**把它打进产物。
# 放在 /shared 是为了让 ../shared/vocab/vocab.json 这个相对路径在容器里和仓库里一致。
COPY shared/ /shared/
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS api
WORKDIR /a
COPY api/package*.json ./
# 这里**不能**加 --omit=dev：tsc 是 devDependency，少了它 npm run build 直接
# `sh: 1: tsc: not found`。先装全，构建完再 prune 掉，最终镜像里仍然只有运行期依赖。
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
# 迁移文件必须进镜像：migrate 是独立命令（deployment.md §6），
# 启动时的「迁移版本检查」也要读 migrations/meta/_journal.json。
COPY --from=api /a/migrations  ./migrations
# SPA 产物，由 Hono 同域托管。
# ⚠️ Dockerfile 的 # 只有在**行首**才是注释，写成行尾注释会被当成额外的源路径，
#    报 `"/#": not found`。所有说明都必须单独一行。
COPY --from=web /w/dist        ./public
# api 运行期要读词表校验标签。WORKDIR 是 /app，所以 ../shared 正好是 /shared，
# 与仓库里 api/ → ../shared 的相对位置相同，两种形态用同一条路径。
COPY shared/ /shared/
CMD ["node", "dist/server.js"]
