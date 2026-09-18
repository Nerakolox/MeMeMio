import { Hono } from 'hono'
import { onError, onNotFound } from './middleware/error.js'
import { requestId, type RequestIdVariables } from './middleware/request-id.js'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { adminRoutes } from './routes/admin.js'
import { embedConfigRoutes, visionConfigRoutes } from './routes/config.js'
import { memesRoutes } from './routes/memes.js'
import { searchRoutes } from './routes/search.js'
import { importRoutes } from './routes/imports.js'

/**
 * Hono 应用本体。静态文件托管在 server.ts 里挂，这样测试不需要先构建 web。
 *
 * ⚠️ 路由必须**链式**注册（.use().route().route()），断开链条 Hono RPC 就推不出类型了，
 *    web 侧会安静地退化成 any。这是那条「改字段名 web 编译失败」保证的前提。
 */

export const app = new Hono<{ Variables: RequestIdVariables }>()
  .use('*', requestId)
  .route('/api/v1/health', healthRoutes)
  .route('/api/v1/auth', authRoutes)
  .route('/api/v1/admin', adminRoutes)
  // 配置是两个路由组，因为权限不同：视觉是本人，embedding 是管理员（SPEC §6.5）。
  // 权限由中间件表达，一个组只挂一套——理由写在 routes/config.ts 的文件头
  .route('/api/v1/config/vision', visionConfigRoutes)
  .route('/api/v1/config/embed', embedConfigRoutes)
  .route('/api/v1/memes', memesRoutes)
  .route('/api/v1/search', searchRoutes)
  .route('/api/v1/imports', importRoutes)

app.onError(onError)
app.notFound(onNotFound)

/** web 通过它消费接口类型，没有生成步骤（SPEC §0.2）。 */
export type AppType = typeof app
