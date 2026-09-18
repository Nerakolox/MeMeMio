import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBED_DIM } from '../lib/vector.js'
import { probeEmbed, probeVision } from './probe.js'

/**
 * 探测实现的单测（任务 D 项）。
 *
 * **本文件的重点是那条硬边界：`rawResponse` / `rawError` 里不可能出现 API Key。**
 *
 * 这是 SPEC §6.5.1 的「原始返回原样带回」和 AGENTS.md §5 的「API Key 不出响应」
 * 唯一一处正面相撞的地方。光看代码是说服不了人的——「我检查过出口只有一个」
 * 这种话下一个人改一行就不成立了，所以这里用**真实的泄露形态**去打：
 * `error-handling.md §4` 明写某些中转服务会在错误体里回显 Authorization 头，
 * 而那恰恰是填错 key 拿 401 时最容易发生的事，也正是测试连接最常触发的路径。
 *
 * 用单测而不是集成测试，是因为要断言的是**字节级**的性质（key 一个字节都不剩、
 * 其余内容一个字节都没变），它不需要数据库，也不该依赖数据库是否起着。
 */

/** 一把长得像真 key 的串。尾号 7788 用来验脱敏串是不是这一把的。 */
const KEY = 'sk-proj-x7Qd2LmNvTbA9fKeR3uW1pZs7788'
const MASKED = '****7788'

const CREDENTIALS = { baseUrl: 'https://relay.example.test', apiKey: KEY, model: 'probe-model' }

type Reply = { status: number; body: string }

let replies: Reply[] = []
let requests: { url: string; authorization: string; body: unknown }[] = []

beforeEach(() => {
  replies = []
  requests = []
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    requests.push({
      url: String(url),
      authorization: headers['Authorization'] ?? '',
      body: JSON.parse(String(init.body)),
    })
    // 依次取，用完之后重复最后一条——探测会发 1~3 次，用例只关心前几次
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]
    if (reply === undefined) throw new Error('用例没有准备这一次调用的响应')
    return new Response(reply.body, { status: reply.status })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function chatOk(fields: Record<string, unknown>): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify(fields) }, finish_reason: 'stop' }],
  })
}

const GOOD_FIELDS = {
  ocrText: '今天不想上班',
  description: '一只趴在桌上的猫，眼神疲惫，配着「今天不想上班」的文字',
  emotions: [],
  scenes: [],
  tags: [],
}

// ── key 不出 raw 字段 ───────────────────────────────────────────────

describe('rawResponse / rawError 里不可能出现 API Key', () => {
  it('中转把 Authorization 头原样抄进 401 错误体时，key 被换成脱敏串', async () => {
    // 这不是编出来的形状：error-handling.md §4 就是照着这类中转的行为写的
    const leaked = JSON.stringify({
      error: {
        message: `Incorrect API key provided: ${KEY}. You can find your API key at ...`,
        type: 'invalid_request_error',
        request: { headers: { authorization: `Bearer ${KEY}` } },
      },
    })
    replies = [{ status: 401, body: leaked }]

    const report = await probeVision(CREDENTIALS)

    // 1) 真的发出去了，而且请求头里确实带着明文 key——否则这个用例什么都没验到
    expect(requests[0]?.authorization).toBe(`Bearer ${KEY}`)
    // 2) 响应体里本来有两处 key
    expect(leaked.split(KEY).length - 1).toBe(2)
    // 3) 带回给用户的那份，一个字节都不剩
    expect(report.rawResponse).not.toContain(KEY)
    // 4) 换成的是脱敏串，不是删掉——用户得看得出「这里本来是你的 key」
    expect(report.rawResponse.split(MASKED).length - 1).toBe(2)
    // 5) 除了 key 之外**一个字节都没变**：不截断、不包装（settings-ux.md §5）
    expect(report.rawResponse).toBe(leaked.split(KEY).join(MASKED))
  })

  it('key 出现在 rawError 里时同样被换掉（embedding 侧走的是另一条出口）', async () => {
    const leaked = `401 Unauthorized: invalid token "${KEY}"`
    replies = [{ status: 401, body: leaked }]

    const report = await probeEmbed(CREDENTIALS)

    expect(requests[0]?.authorization).toBe(`Bearer ${KEY}`)
    expect(report.ok).toBe(false)
    expect(report.rawError).not.toContain(KEY)
    expect(report.rawError).toBe(`401 Unauthorized: invalid token "${MASKED}"`)
  })

  it('响应体里没有 key 时原文一个字节不动', async () => {
    // 抹 key 这件事不能顺手再删点别的——那会把用户真正需要的那行错误弄没
    const body = '<html><body>502 Bad Gateway\nupstream timed out</body></html>'
    replies = [{ status: 502, body }]

    const report = await probeVision(CREDENTIALS)

    expect(report.rawResponse).toBe(body)
  })

  it('成功那一路的 rawResponse 也过同一个出口', async () => {
    // 成功响应里一般没有 key，但出口是同一个 finish()——这里验的是「没有第二条出口」。
    // 真有中转在成功响应的 metadata 里回显 key 的话，这条路径也是干净的
    const body = chatOk({ ...GOOD_FIELDS, description: `${GOOD_FIELDS.description}（key=${KEY}）` })
    replies = [{ status: 200, body }]

    const report = await probeVision(CREDENTIALS)

    expect(report.ok).toBe(true)
    expect(report.rawResponse).not.toContain(KEY)
    expect(report.rawResponse).toContain(MASKED)
  })
})

// ── 视觉探测的判定 ─────────────────────────────────────────────────

describe('probeVision', () => {
  it('第一次就打不通时不再发后两次——不拿用户的钱确认同一件事', async () => {
    replies = [{ status: 401, body: 'nope' }]

    const report = await probeVision(CREDENTIALS)

    expect(requests).toHaveLength(1)
    expect(report).toMatchObject({
      ok: false,
      canReceiveImage: false,
      jsonModeWorks: null,
      multiImageWorks: null,
      vocabCompliant: null,
    })
  })

  it('收到图但输出不合格：canReceiveImage 为真，vocabCompliant 是 null 不是 false', async () => {
    // 「拿不到可校验的字段」和「字段不在词表里」是两件事。报 false 会让用户
    // 以为是词表的问题，跑去改提示词
    replies = [{ status: 200, body: chatOk({ nonsense: 1 }) }]

    const report = await probeVision(CREDENTIALS)

    expect(report.ok).toBe(false)
    expect(report.canReceiveImage).toBe(true)
    expect(report.vocabCompliant).toBeNull()
    expect(requests).toHaveLength(1)
  })

  it('三次调用都成功：走 json mode 的那次开了 response_format，多图那次发两张', async () => {
    replies = [{ status: 200, body: chatOk(GOOD_FIELDS) }]

    const report = await probeVision(CREDENTIALS)

    expect(report).toMatchObject({
      ok: true,
      canReceiveImage: true,
      jsonModeWorks: true,
      multiImageWorks: true,
      vocabCompliant: true,
    })
    expect(requests).toHaveLength(3)

    // 基线那次**不开** json mode：任何能用的通道都该过得去的最保守形态
    expect(requests[0]?.body).not.toHaveProperty('response_format')
    expect(requests.some((r) => (r.body as Record<string, unknown>)['response_format'] !== undefined)).toBe(true)

    // 多图那次真的发了两张图（第二条 message 的 content 里有两个 image_url）
    const imageCounts = requests.map((r) => {
      const messages = (r.body as { messages: { content: unknown }[] }).messages
      const content = messages[1]?.content
      return Array.isArray(content)
        ? content.filter((p) => (p as { type?: string }).type === 'image_url').length
        : 0
    })
    expect(imageCounts).toContain(2)

    // 全程只有一个 baseUrl、一个端点——没有按供应商分叉的第二条路径
    expect(new Set(requests.map((r) => r.url))).toEqual(
      new Set(['https://relay.example.test/v1/chat/completions']),
    )
  })

  it('标签不在词表里时 vocabCompliant 为假，但仍然算 ok', async () => {
    // 判定用的是 src/vocab.ts 那一份适配器，和打标是同一个——这条用例就是在验这件事：
    // 另写一套判定的话，「测试连接说能用、打标时全被丢掉」不会被任何测试抓住
    replies = [
      { status: 200, body: chatOk({ ...GOOD_FIELDS, tags: ['这个词绝对不在词表里'] }) },
    ]

    const report = await probeVision(CREDENTIALS)

    expect(report.ok).toBe(true)
    expect(report.vocabCompliant).toBe(false)
  })
})

// ── Embedding 探测的判定 ───────────────────────────────────────────

function embeddingBody(dim: number): string {
  return JSON.stringify({ data: [{ embedding: new Array<number>(dim).fill(0.01) }] })
}

describe('probeEmbed', () => {
  it('原生 2048 维、dimensions 参数生效：willTruncate 为假', async () => {
    replies = [
      { status: 200, body: embeddingBody(2048) },
      { status: 200, body: embeddingBody(EMBED_DIM) },
    ]

    const report = await probeEmbed(CREDENTIALS)

    expect(report).toEqual({
      ok: true,
      nativeDim: 2048,
      dimParamWorks: true,
      willTruncate: false,
      rawError: null,
    })
    // 第二次真的带了 dimensions，否则这条结论是瞎猜的
    expect((requests[1]?.body as Record<string, unknown>)['dimensions']).toBe(EMBED_DIM)
    expect((requests[0]?.body as Record<string, unknown>)['dimensions']).toBeUndefined()
  })

  it('中转把 dimensions 参数忽略掉（照样返回 2048 维）判成不生效', async () => {
    // 只看状态码会把「它压根没理这个参数」判成生效，然后运行时拿着一个
    // 没归一化的长向量去写库——不报错，只是搜索悄悄变差
    replies = [{ status: 200, body: embeddingBody(2048) }]

    const report = await probeEmbed(CREDENTIALS)

    expect(report.dimParamWorks).toBe(false)
    expect(report.willTruncate).toBe(true)
  })

  it('原生就是 1024 维时 willTruncate 为假——分不出「照办」和「忽略」，也不需要分', async () => {
    replies = [{ status: 200, body: embeddingBody(EMBED_DIM) }]

    const report = await probeEmbed(CREDENTIALS)

    expect(report.nativeDim).toBe(EMBED_DIM)
    expect(report.dimParamWorks).toBe(true)
    expect(report.willTruncate).toBe(false)
  })

  it('成功时不把 1024 个浮点数塞进 rawError', async () => {
    replies = [{ status: 200, body: embeddingBody(EMBED_DIM) }]

    const report = await probeEmbed(CREDENTIALS)

    expect(report.rawError).toBeNull()
  })
})
