import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Env, Hono } from 'hono'

/**
 * 同域托管 SPA（SPEC §0.1 / §1.1）：产物里有的文件原样返回，其余 /api/* 之外的路径回退到 index.html。
 *
 * ⚠️ **静态文件必须按整个产物目录挂，不能只挂 `/assets/*`。** Vite 把 `web/public/` 里的文件
 * （logo、favicon）原样复制到产物**根目录**，不进 `assets/`。只挂 `/assets/*` 时它们全落进
 * SPA 回退，`/mememio-mark.svg` 返回 200 + `text/html`——不报错，只是图全裂。
 * 2026-09-26 首次部署时就是这么上线的；开发态由 Vite 自己出这些文件，所以本地看不出来。
 *
 * 返回是否挂上了。开发态没有产物（web 跑在 Vite 上），不是错误。
 */
export function mountWebDist<E extends Env>(app: Hono<E>, dir: string): boolean {
  const indexPath = join(dir, 'index.html')
  if (!existsSync(indexPath)) return false

  const indexHtml = readFileSync(indexPath, 'utf-8')
  const serveDist = serveStatic({ root: dir })

  app.use('*', async (c, next) => {
    // /api/* 不去磁盘上找，没命中就交给 notFound 出错误信封
    if (c.req.path.startsWith('/api/')) return next()
    return serveDist(c, next)
  })
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next()
    return c.html(indexHtml)
  })
  return true
}
