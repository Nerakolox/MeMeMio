import { describe, expect, it } from 'vitest'
import { app } from '../app.js'
import { vocabulary } from '../vocab.js'

/**
 * 健康检查不碰数据库，所以归 unit 组 —— 它是「进程活着、词表读到了」的探针，
 * 不是「依赖都健康」的探针。依赖健康与否由启动顺序保证（server.ts），
 * 起不来就没有这个接口可探。
 */
describe('GET /api/v1/health', () => {
  it('返回 200 和 SPEC §1.2 约定的字段', async () => {
    const res = await app.request('/api/v1/health')

    expect(res.status).toBe(200)
    // requestId 中间件对所有请求生效，包括健康检查
    expect(res.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/)

    const body = (await res.json()) as { status: string; startedAt: string; vocabVersion: string }
    expect(body.status).toBe('ok')
    // 精确到秒的 ISO 8601 UTC，不带毫秒（SPEC §1.2）
    expect(body.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    // 和 web 侧打进产物的是同一个 shared/vocab/vocab.json
    expect(body.vocabVersion).toBe(vocabulary.version)
  })

  it('未注册路径返回 NOT_FOUND 信封而不是 Hono 默认的纯文本', async () => {
    const res = await app.request('/api/v1/nope')

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; requestId: string } }
    // 客户端按 code 分支，不解析 message（SPEC §2.1）
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.requestId).toBe(res.headers.get('X-Request-Id'))
  })
})
