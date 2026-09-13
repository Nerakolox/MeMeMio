import { Hono } from 'hono'
import { onError, onNotFound } from './middleware/error.js'
import { requestId, type RequestIdVariables } from './middleware/request-id.js'
import { healthRoutes } from './routes/health.js'

/**
 * Hono 应用本体。静态文件托管在 server.ts 里挂，这样测试不需要先构建 web。
 *
 * ⚠️ 路由必须**链式**注册（.use().route().route()），断开链条 Hono RPC 就推不出类型了，
 *    web 侧会安静地退化成 any。这是那条「改字段名 web 编译失败」保证的前提。
 */

export const app = new Hono<{ Variables: RequestIdVariables }>()
  .use('*', requestId)
  .route('/api/v1/health', healthRoutes)

app.onError(onError)
app.notFound(onNotFound)

/** web 通过它消费接口类型，没有生成步骤（SPEC §0.2）。 */
export type AppType = typeof app
