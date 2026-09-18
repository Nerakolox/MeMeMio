import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { app } from './app.js'
import { db, waitForDatabase } from './data/db.js'
import { checkMigrations } from './data/migration-state.js'
import { env } from './env.js'
import { log } from './logger.js'
import { assertRuntimeFilesPresent, WEB_DIST_DIR } from './paths.js'
import { startReindexWorker, stopReindexWorker } from './queue/reindex-worker.js'
import { startTagWorker, stopTagWorker } from './queue/worker.js'
import { assertR2Reachable } from './storage/r2.js'
import { vocabulary, vocabularySize } from './vocab.js'

/**
 * 启动顺序（agents/rules/env-validation.md §3）：
 *
 *   1. 校验 env       → 失败则 exit(1)      ← import './env.js' 时就做完了
 *   2. 探活 R2        → 失败则 exit(1)
 *   3. 连数据库       → 失败则重试几次后 exit(1)
 *   4. 检查迁移版本   → 落后则打印提示并 exit(1)
 *   5. 起 HTTP，再起打标 worker
 *
 * 第 2 步在连库之前：它和第 1 步是同一件事的两半——「变量填了」和「填的能用」。
 * 校验能不能用必须放在启动，因为 R2 配错**在运行期完全不报错**（预签名是纯本地
 * 计算，假凭证照样签得出 200），理由写在 storage/r2.ts 的 `assertR2Reachable`。
 *
 * 第 4 步**只检查，不自动执行**。多副本时自动迁移会并发跑，而那种故障发生在
 * 启动瞬间，最难排查。执行走独立命令，见 docs/deployment.md §6。
 */
async function main(): Promise<void> {
  assertRuntimeFilesPresent()

  log.info(
    { vocabVersion: vocabulary.version, vocabStatus: vocabulary.status, ...vocabularySize },
    '词表已加载',
  )

  // 没配默认模型不是错误，是产品要求的降级态。但必须说出来，否则「搜索为什么这么差」
  // 会变成一个查起来很贵的问题。见 agents/rules/env-validation.md §4。
  if (env.defaultVision === null) {
    log.warn({}, '未配置 DEFAULT_VISION_*：导入照常，但新图会停在 tagStatus = pending')
  }
  if (env.defaultEmbed === null) {
    log.warn({}, '未配置 DEFAULT_EMBED_*：搜索只走 OCR + 标签两路，响应会带 degraded: true')
  }

  await assertR2Reachable()

  await waitForDatabase()
  log.info({}, '数据库已连接')

  const migrations = await checkMigrations(db)
  if (!migrations.upToDate) {
    log.fatal(
      { applied: migrations.applied, expected: migrations.expected, pending: migrations.pending },
      '数据库迁移落后，拒绝启动',
    )
    process.stderr.write(
      `\n数据库迁移落后：已应用 ${migrations.applied} / ${migrations.expected} 条。\n`
        + `未应用：${migrations.pending.join(', ')}\n\n`
        + '迁移不会在启动时自动执行（docs/deployment.md §6）。请手动跑：\n'
        + '  本机   cd api && npm run migrate\n'
        + '  部署机 docker compose run --rm app node dist/migrate.js\n\n',
    )
    process.exit(1)
  }
  log.info({ applied: migrations.applied }, '迁移版本已是最新')

  mountWebDist()

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    log.info({ port: info.port, nodeEnv: env.nodeEnv }, 'HTTP 已启动')
  })

  // worker 在 HTTP 之后起：迁移检查已经过了，且它不影响接口可用性。
  // 没配 DEFAULT_VISION_* 时 worker 照样起——它自己会空转等待（不消费、不失败重试），
  // 配置好之后不需要重启进程就能开始补打标
  startTagWorker()

  // 重算 worker 是**另一个** worker，不是打标 worker 的一个分支（理由写在
  // queue/reindex-worker.ts 的文件头）。同样无条件起：没配 embedding 通道时它空转，
  // 管理员在界面上配好之后不用重启进程，重建就会自己开始动
  startReindexWorker()

  installShutdownHandlers(server)
}

/**
 * 优雅退出。**worker 必须等在途任务写完**，否则那些任务会永远停在 `running`，
 * 表现是「这几张图再也不会被打标」——不报错、不告警。
 *
 * 在途任务本身有整体超时，所以这里的等待是有界的。真被 SIGKILL 砍掉的那种
 * 由 worker 启动时的 `requeueStaleRunningJobs` 兜底。
 */
function installShutdownHandlers(server: { close: (cb?: () => void) => void }): void {
  let shuttingDown = false

  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, '收到退出信号，开始收尾')

    server.close(() => {
      // 两个 worker 并行收尾，不串行：各自的在途任务都有整体超时，串起来等于把两个
      // 超时上限加在一起，停机时间平白翻倍
      void Promise.allSettled([stopTagWorker(), stopReindexWorker()]).then(() => process.exit(0))
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

/**
 * 同域托管 SPA（SPEC §0.1 / §1.1）：/api/* 之外的路径回退到 index.html。
 * 开发态 public/ 不存在（web 跑在 Vite 上），跳过即可，不是错误。
 */
function mountWebDist(): void {
  const indexPath = join(WEB_DIST_DIR, 'index.html')
  if (!existsSync(indexPath)) {
    log.info({ dir: WEB_DIST_DIR }, '没有 web 构建产物，只提供 API（开发态正常）')
    return
  }

  const indexHtml = readFileSync(indexPath, 'utf-8')

  app.use('/assets/*', serveStatic({ root: './public' }))
  app.get('*', async (c, next) => {
    // /api/* 没命中就交给 notFound 出错误信封，不要给它返回一张 HTML
    if (c.req.path.startsWith('/api/')) return next()
    return c.html(indexHtml)
  })
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, '启动失败')
  process.stderr.write(`\n启动失败：${error instanceof Error ? error.message : String(error)}\n\n`)
  process.exit(1)
})
