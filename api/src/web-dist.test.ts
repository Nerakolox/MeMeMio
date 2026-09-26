import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mountWebDist } from './web-dist.js'

/**
 * 形状照着 Vite 产物搭：`assets/` 里是带哈希的 bundle，`web/public/` 的文件在**根目录**。
 * 第一条用例就是 2026-09-26 首次部署的 bug：根目录的 svg 被回退成了 index.html。
 */
describe('mountWebDist', () => {
  let dir = ''
  const INDEX = '<!doctype html><title>mememio</title>'

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mememio-web-dist-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), INDEX)
    writeFileSync(join(dir, 'mememio-mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function build() {
    const app = new Hono()
    app.get('/api/v1/health', (c) => c.json({ status: 'ok' }))
    app.notFound((c) => c.json({ error: { code: 'NOT_FOUND' } }, 404))
    expect(mountWebDist(app, dir)).toBe(true)
    return app
  }

  it('产物根目录的文件原样返回，不被回退成 index.html', async () => {
    const res = await build().request('/mememio-mark.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/svg+xml')
  })

  it('assets/ 里的 bundle 照常返回', async () => {
    const res = await build().request('/assets/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })

  it('前端路由回退到 index.html', async () => {
    const res = await build().request('/browse/deep/link')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(INDEX)
  })

  it('/api/* 不碰磁盘也不回退：命中的走路由，没命中的出错误信封', async () => {
    const app = build()
    expect(await (await app.request('/api/v1/health')).json()).toEqual({ status: 'ok' })

    const miss = await app.request('/api/v1/nope')
    expect(miss.status).toBe(404)
    expect(miss.headers.get('content-type')).toContain('application/json')
  })

  it('没有产物时不挂，返回 false', () => {
    expect(mountWebDist(new Hono(), join(dir, 'missing'))).toBe(false)
  })
})
