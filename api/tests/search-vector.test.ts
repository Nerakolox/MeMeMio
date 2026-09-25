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
const { searchFirstPage, searchNextPage } = await import('../src/services/search-snapshot.js')

const { sql, db } = createTestDb()

/**
 * 种子记录的 `embed_model` **必须和 `DEFAULT_EMBED_MODEL` 一模一样**。
 *
 * 向量路按 `embed_model` 过滤（SPEC §9.20）：换模型期间库里会同时存在两代向量，
 * 而两个模型的向量不在同一个空间里，它们之间的余弦距离只是噪声。种子不写这个字段
 * 的表现是**向量路一条都召不回**，而接口仍然 200、degraded 仍然 false——
 * 于是这一整个文件都在测一条根本没跑的通路。
 */
const EMBED_MODEL = 'qwen3-embedding-0.6b'

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
    const nearest = await makeMeme(db, {
      uploaderId: alice.id,
      embedding: unitVector(1),
      embedModel: EMBED_MODEL,
    })
    const farther = await makeMeme(db, {
      uploaderId: alice.id,
      embedding: unitVector(2),
      embedModel: EMBED_MODEL,
    })

    const outcome = await searchMemes('随便搜点什么', 10, null, 'test-request-id', db)

    expect(outcome.degraded).toBe(false)
    expect(outcome.items.map((i) => i.id)).toContain(nearest.id)
    expect(outcome.items.map((i) => i.id)).toContain(farther.id)
    expect(outcome.items.find((i) => i.id === nearest.id)?.matchedBy).toEqual(['vector'])
    // 离查询最近的排前面
    const ids = outcome.items.map((i) => i.id)
    expect(ids.indexOf(nearest.id)).toBeLessThan(ids.indexOf(farther.id))
  })

  it('rewritten 是 HyDE 的产物，**原查询和改写一起**送去 embedding', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1), embedModel: EMBED_MODEL })

    const outcome = await searchMemes('不想上班', 10, null, 'test-request-id', db)

    expect(outcome.rewritten).toBe(rewriteText)

    // ⚠️ 这条 2026-09-22 反过来了。原先断言的是「送去 embedding 的**不含**用户原话」，
    //    即改写**替换**原查询。那是个 bug：HyDE 的假设是「用户查询和文档不在一个表述层面，
    //    拿一段假文档去比更准」，但改写是模型的猜测，猜歪了整条向量路就跟着歪——
    //    而用户真正打的那几个字已经被丢掉了，没有任何东西能把它拉回来。
    //    实测里「不想上班」被改写成一段橘猫打瞌睡的描述，召回的全是猫。
    //    现在是拼接：原查询在前、改写在后（`services/search.ts` 的 embedInput）。
    expect(received.embeddings[0]?.input).toContain(rewriteText)
    expect(received.embeddings[0]?.input).toContain('不想上班')
  })

  it('⚠️ 拼接顺序是原查询在前 —— 截断发生在尾部，该被砍的是猜测那一半', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1), embedModel: EMBED_MODEL })

    await searchMemes('不想上班', 10, null, 'test-request-id', db)

    const input = received.embeddings[0]?.input ?? ''
    expect(input.indexOf('不想上班')).toBeLessThan(input.indexOf(rewriteText))
  })

  it('查询侧带 instruct 前缀，文档侧不带', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1), embedModel: EMBED_MODEL })

    await searchMemes('不想上班', 10, null, 'test-request-id', db)

    // qwen3-embedding 是指令感知模型；少了这个前缀检索质量会掉，但不会有任何报错
    expect(received.embeddings[0]?.input.startsWith('Instruct: ')).toBe(true)
    expect(received.embeddings[0]?.input).toContain('\nQuery: ')
  })

  it('HyDE 失败时用原查询兜底，向量路照常出结果', async () => {
    const alice = await createUser(db)
    const nearest = await makeMeme(db, {
      uploaderId: alice.id,
      embedding: unitVector(1),
      embedModel: EMBED_MODEL,
    })

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
      ocrText: '不想上班的表情',
      embedding: unitVector(1),
      embedModel: EMBED_MODEL,
    })
    const byTag = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '完全无关的正文',
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
      await makeMeme(db, {
        uploaderId: alice.id,
        ocrText: '不想上班',
        embedding: unitVector(i + 1),
        embedModel: EMBED_MODEL,
      })
    }

    const outcome = await searchMemes('不想上班', 2, null, 'test-request-id', db)

    expect(outcome.items).toHaveLength(2)
  })
})

/**
 * `GET /memes?q=` 的翻页（`services/search-snapshot.ts`）。
 *
 * 这个文件是唯一能测它的地方：**只有这里能数外部调用次数**。改写与查询向量是快照存在
 * 的两个理由之一（另一个是排序稳定），而「翻页少调了一次 AI」这件事在别的文件里
 * 只能靠 `degraded` / `rewritten` 前后一致间接推断。
 */
describe('检索快照翻页', () => {
  it('翻页不重跑 HyDE、不重新编码 —— 冻住的那一份改写与向量被复用', async () => {
    const alice = await createUser(db)
    for (let i = 0; i < 3; i += 1) {
      await makeMeme(db, {
        uploaderId: alice.id,
        tags: ['猫'],
        embedding: unitVector(i + 1),
        embedModel: EMBED_MODEL,
      })
    }

    const first = await searchFirstPage({
      query: '猫',
      filter: {},
      actorId: alice.id,
      requestId: 'test-request-id',
      limit: 2,
      db,
    })

    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    expect(first.degraded).toBe(false)
    expect(received.chat).toHaveLength(1)
    expect(received.embeddings).toHaveLength(1)

    // 这一页池子里只剩 1 条，会**翻倍重扫三路**——向量路也真的重扫了
    const second = await searchNextPage({
      cursor: first.nextCursor ?? '',
      actorId: alice.id,
      requestId: 'test-request-id',
      limit: 2,
      db,
    })

    // 重扫**不多一次外部调用**：不走 HyDE、不重新编码，用的是首屏冻住的向量。
    // 不冻的话滚一屏就是一次 LLM 调用，而且改写逐次不同 → 召回池变化 → 页间重复或漏
    expect(received.chat).toHaveLength(1)
    expect(received.embeddings).toHaveLength(1)
    // 降级判定同样冻住：一次检索只有一个答案，翻着翻着提示语变了会让人以为出了事
    expect(second.rewritten).toBe(first.rewritten)
    expect(second.degraded).toBe(first.degraded)
    expect(second.items.map((i) => i.id)).not.toContain(first.items[0]?.id)
  })
})
