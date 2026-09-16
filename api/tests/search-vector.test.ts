import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'

/**
 * 向量路**真的跑起来**时的行为：HyDE 改写、instruct 前缀、降级判定。
 *
 * 前面两个搜索测试文件都刻意不配 embedding，所以「向量路不跑」测得很实，「向量路跑」是空白。
 * 这里补上：起一个本地 HTTP 服务冒充 OpenAI 兼容接口，把 `DEFAULT_EMBED_BASE_URL` 指过去，
 * 于是 provider / embedder / hyde 三层都是**真实代码路径**，只是对端换成了本地假服务。
 *
 * 这也顺带锁住了 instruct 前缀——假服务会把收到的请求体记下来，能直接断言查询侧带了前缀。
 * 打桩 `fetch` 做不到这件事：那等于把要测的拼装逻辑一起换掉了。
 */

/** 固定端口：`src/env.ts` 在 import 时就读环境变量，所以地址必须在 import 之前定下来。 */
const PORT = 38_921
const BASE_URL = `http://127.0.0.1:${PORT}/v1`

process.env['DEFAULT_EMBED_BASE_URL'] = BASE_URL
process.env['DEFAULT_EMBED_API_KEY'] = 'test-key-not-real'
process.env['DEFAULT_EMBED_MODEL'] = 'qwen3-embedding-0.6b'
process.env['DEFAULT_VISION_BASE_URL'] = BASE_URL
process.env['DEFAULT_VISION_API_KEY'] = 'test-key-not-real'
process.env['DEFAULT_VISION_MODEL'] = 'test-vision-model'

const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

/** 同 `search.test.ts`：走真路由就得让默认连接指向测试库，否则会去清开发库的表。 */
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme, unitVector } = await import('./helpers/factories.js')
const { searchMemes } = await import('../src/services/search.js')

const { sql, db } = createTestDb()

/** 假服务收到的请求体，用来断言查询侧真的带了 instruct 前缀。 */
const received: { embeddings: { input: string; dimensions?: number }[]; chat: unknown[] } = {
  embeddings: [],
  chat: [],
}

/** 假服务的行为开关，各用例自己拨。 */
let embedFails = false
let chatFails = false
let rewriteText = '一只趴在键盘上打瞌睡的橘猫，表情十分疲惫'

let server: Server

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => resolve(raw))
  })
}

/**
 * 造一个 2048 维、第 `axis` 维为 1 的向量。
 *
 * 故意**长于** 1024：embedder 会走「客户端截断 + 重新 L2 归一化」那条路（`dimParamWorks` 为 null），
 * 于是每跑一次这个测试就顺带验证一次截断后归一化没被写坏。
 */
function fakeEmbedding(axis: number): number[] {
  const vector = new Array<number>(2048).fill(0)
  vector[axis] = 1
  return vector
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req)
      const url = req.url ?? ''

      if (url.includes('/embeddings')) {
        if (embedFails) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'upstream boom' } }))
          return
        }
        const parsed = JSON.parse(raw) as { input: string; dimensions?: number }
        received.embeddings.push(parsed)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ embedding: fakeEmbedding(1) }] }))
        return
      }

      if (url.includes('/chat/completions')) {
        received.chat.push(JSON.parse(raw))
        if (chatFails) {
          res.writeHead(503)
          res.end('nope')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: rewriteText } }] }))
        return
      }

      res.writeHead(404)
      res.end()
    })()
  })

  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end()
})

beforeEach(async () => {
  await truncateAll(sql)
  received.embeddings.length = 0
  received.chat.length = 0
  embedFails = false
  chatFails = false
  rewriteText = '一只趴在键盘上打瞌睡的橘猫，表情十分疲惫'
})

describe('向量路跑起来时', () => {
  it('降级为 false，结果带 vector 标记', async () => {
    const alice = await createUser(db)
    const nearest = await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1) })
    const farther = await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(2) })

    const outcome = await searchMemes('随便搜点什么', 10, null, 'test-request-id', db)

    expect(outcome.degraded).toBe(false)
    expect(outcome.items.map((i) => i.id)).toContain(nearest.id)
    expect(outcome.items.map((i) => i.id)).toContain(farther.id)
    expect(outcome.items.find((i) => i.id === nearest.id)?.matchedBy).toEqual(['vector'])
    // 离查询最近的排前面
    const ids = outcome.items.map((i) => i.id)
    expect(ids.indexOf(nearest.id)).toBeLessThan(ids.indexOf(farther.id))
  })

  it('rewritten 是 HyDE 的产物，向量检索用的是改写后的文本', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1) })

    const outcome = await searchMemes('不想上班', 10, null, 'test-request-id', db)

    expect(outcome.rewritten).toBe(rewriteText)
    // 送去 embedding 的必须是改写后的文本，而不是用户原话（retrieval.md §3）
    expect(received.embeddings[0]?.input).toContain(rewriteText)
    expect(received.embeddings[0]?.input).not.toContain('不想上班')
  })

  it('查询侧带 instruct 前缀，文档侧不带', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1) })

    await searchMemes('不想上班', 10, null, 'test-request-id', db)

    // qwen3-embedding 是指令感知模型；少了这个前缀检索质量会掉，但不会有任何报错
    expect(received.embeddings[0]?.input.startsWith('Instruct: ')).toBe(true)
    expect(received.embeddings[0]?.input).toContain('\nQuery: ')
  })

  it('HyDE 失败时用原查询兜底，向量路照常出结果', async () => {
    const alice = await createUser(db)
    const nearest = await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1) })

    chatFails = true
    const outcome = await searchMemes('不想上班', 10, null, 'test-request-id', db)

    // 改写只是锦上添花：拿不到就用原话去搜，不能因此丢掉整条向量路
    expect(outcome.rewritten).toBeNull()
    expect(outcome.degraded).toBe(false)
    expect(outcome.items.map((i) => i.id)).toContain(nearest.id)
    expect(received.embeddings[0]?.input).toContain('不想上班')
  })

  it('embedding 调用报 5xx 时降级，OCR 与标签两路照常返回', async () => {
    const alice = await createUser(db)
    const byText = await makeMeme(db, {
      uploaderId: alice.id,
      searchText: '不想上班的表情',
      embedding: unitVector(1),
    })
    const byTag = await makeMeme(db, {
      uploaderId: alice.id,
      searchText: '完全无关的正文',
      emotions: ['无语'],
    })

    embedFails = true
    const outcome = await searchMemes('不想上班', 10, null, 'test-request-id', db)

    expect(outcome.degraded).toBe(true)
    const ids = outcome.items.map((i) => i.id)
    expect(ids).toContain(byText.id)

    // 标签路这次查询没命中词表，所以这条不该出现；它是用来确认「降级不等于全召回」的
    expect(ids).not.toContain(byTag.id)
    expect(outcome.items.every((i) => !i.matchedBy.includes('vector'))).toBe(true)
  })

  it('空库搜索返回空数组，不抛异常', async () => {
    const outcome = await searchMemes('什么都没搜到', 10, null, 'test-request-id', db)

    expect(outcome.items).toEqual([])
    expect(outcome.degraded).toBe(false)
  })

  it('limit 生效：超过 limit 的结果被截断', async () => {
    const alice = await createUser(db)
    for (let i = 0; i < 5; i += 1) {
      await makeMeme(db, { uploaderId: alice.id, searchText: '不想上班', embedding: unitVector(i + 1) })
    }

    const outcome = await searchMemes('不想上班', 2, null, 'test-request-id', db)

    expect(outcome.items).toHaveLength(2)
  })
})
