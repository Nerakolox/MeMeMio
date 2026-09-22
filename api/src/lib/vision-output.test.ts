import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildSearchText,
  classifyHttpFailure,
  interpretVisionContent,
  isEmptyTagFields,
  parseChatEnvelope,
  type TagFields,
  type VocabAdapter,
  type VocabField,
} from './vision-output.js'

/**
 * 判定逻辑的单测，**样本来自 `docs/fixtures/responses/` 的真实响应**
 * （ai-providers.md §3：自己编的假响应只覆盖得到自己想得到的情况）。
 *
 * 两份样本各 30 条，是供应商探测任务实测出来的：
 *
 *   api.codexzh.com（grok-4.6）  30/30 HTTP 400 `protocol_not_supported`
 *   api.deepseek.com（deepseek-flash）23/30 正文空或半截，7/30 合法 JSON 但词表大面积越界
 *
 * ⚠️ **两份样本里都没有"内容策略拒绝"**——没有任何一条是 451、也没有一条返回
 *    「抱歉，我无法描述这张图片」。所以三种形态里的第二种（200 但正文是拒绝）
 *    只能用构造样本测，且下面对它做了显式标注。这一条已在任务验收里写明，
 *    不拿构造样本冒充实测覆盖。
 */

const RESPONSES_DIR = new URL('../../../docs/fixtures/responses/', import.meta.url)

type ProbeRecord = {
  file: string
  httpStatus: number
  rawResponse: string
  jsonValid: boolean
  rejectionKind?: string
}

function loadProbe(name: string): { model: string; results: ProbeRecord[] } {
  const raw = readFileSync(fileURLToPath(new URL(name, RESPONSES_DIR)), 'utf-8')
  return JSON.parse(raw) as { model: string; results: ProbeRecord[] }
}

const codexzh = loadProbe('api.codexzh.com-2026-09-14.json')
const deepseek = loadProbe('api.deepseek.com-2026-09-14.json')

// ── 真词表 ─────────────────────────────────────────────────────────
//
// 直接读 shared/vocab/vocab.json 而不是 import src/vocab.ts：被测文件是零 import 的
// 纯函数，测试也不该顺手把「词表怎么加载」拖进来。词表是数据，这里当数据用。

type VocabJson = {
  expressions: string[]
  emotions: string[]
  tones: string[]
  purposes: string[]
  scenes: string[]
  tags: { subject: string[]; style: string[] }
  aliases?: Record<string, string>
}

const vocabJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../shared/vocab/vocab.json', import.meta.url)), 'utf-8'),
) as VocabJson

const sets: Record<VocabField, Set<string>> = {
  expressions: new Set(vocabJson.expressions),
  emotions: new Set(vocabJson.emotions),
  tones: new Set(vocabJson.tones),
  purposes: new Set(vocabJson.purposes),
  scenes: new Set(vocabJson.scenes),
  tags: new Set([...vocabJson.tags.subject, ...vocabJson.tags.style]),
}

const vocab: VocabAdapter = {
  alias: (value) => vocabJson.aliases?.[value] ?? value,
  isKnown: (field, value) => sets[field].has(value),
}

/**
 * 补齐八个字段的 `TagFields`，只写用例关心的那几个。
 *
 * 不用 `as TagFields` 硬转：维度以后还会加，漏掉一维时这里要**编译不过**，
 * 而不是在某个断言里悄悄拿到 undefined。
 */
function fields(partial: Partial<TagFields> = {}): TagFields {
  return {
    ocrText: '',
    description: '',
    expressions: [],
    emotions: [],
    tones: [],
    purposes: [],
    scenes: [],
    tags: [],
    ...partial,
  }
}

function interpret(record: ProbeRecord) {
  const envelope = parseChatEnvelope(JSON.parse(record.rawResponse))
  if (envelope === null) throw new Error(`${record.file} 不是 chat completions 响应`)
  return interpretVisionContent(envelope.content, envelope.finishReason, vocab)
}

// ── 形态一：HTTP 层 ─────────────────────────────────────────────────

describe('拒绝形态一：HTTP 层', () => {
  it('codexzh 全部 30 条 400 都判为 unsupported（不重试）', () => {
    expect(codexzh.results).toHaveLength(30)
    const kinds = new Set(
      codexzh.results.map((r) => classifyHttpFailure(r.httpStatus, r.rawResponse)),
    )
    expect([...kinds]).toEqual(['unsupported'])
  })

  it('样本里的错误体确实是「模型不支持该协议」而不是别的失败', () => {
    const first = codexzh.results[0]
    expect(first).toBeDefined()
    expect(first?.httpStatus).toBe(400)
    expect(first?.rawResponse).toContain('protocol_not_supported')
  })

  it('5xx / 429 / 408 归 unreachable，回队列重跑而不是换通道', () => {
    expect(classifyHttpFailure(500, 'bad gateway')).toBe('unreachable')
    expect(classifyHttpFailure(502, '')).toBe('unreachable')
    expect(classifyHttpFailure(429, 'rate limited')).toBe('unreachable')
    expect(classifyHttpFailure(408, '')).toBe('unreachable')
  })

  it('451 与内容策略关键词归 refused', () => {
    expect(classifyHttpFailure(451, '')).toBe('refused')
    expect(classifyHttpFailure(400, '{"error":{"code":"content_policy_violation"}}')).toBe('refused')
    expect(classifyHttpFailure(400, '{"error":{"message":"图片内容涉嫌违规"}}')).toBe('refused')
  })

  it('图片数超限单独成一类——它要降帧，不要降通道', () => {
    expect(classifyHttpFailure(400, '{"error":{"message":"too many images in one request"}}'))
      .toBe('image_limit')
    expect(classifyHttpFailure(400, '{"error":{"message":"单次请求最多 4 张图"}}'))
      .toBe('image_limit')
  })

  it('没有关键词的 4xx 归 unsupported，不进重试队列', () => {
    // 原样重发就会再被拒一次的 4xx 放进重试队列，只是把一次确定的失败拖成五次
    expect(classifyHttpFailure(401, 'unauthorized')).toBe('unsupported')
    expect(classifyHttpFailure(400, '{}')).toBe('unsupported')
  })
})

// ── 形态二：200 但正文是拒绝 ────────────────────────────────────────

describe('拒绝形态二：200 但正文是拒绝措辞', () => {
  // ⚠️ 构造样本。两份实测样本里没有内容策略拒绝，见文件头说明。
  it('纯文字拒绝判为 refused/refusal_text', () => {
    const outcome = interpretVisionContent('抱歉，我无法描述这张图片。', 'stop', vocab)
    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') expect(outcome.form).toBe('refusal_text')
  })

  it('英文拒绝同样认得', () => {
    const outcome = interpretVisionContent(
      "I'm sorry, but I can't help with identifying this image.",
      'stop',
      vocab,
    )
    expect(outcome.kind).toBe('refused')
  })

  it('description 里出现「无法」「不能」**不算**拒绝——这是最容易误杀的一处', () => {
    const content = JSON.stringify({
      description: '一个生无可恋的表情，一副什么都不能做也无法反抗的样子',
      emotions: ['生无可恋'],
      scenes: [],
      tags: [],
    })
    const outcome = interpretVisionContent(content, 'stop', vocab)
    expect(outcome.kind).toBe('ok')
  })
})

// ── 形态三：结构完整但内容全空 ──────────────────────────────────────

describe('拒绝形态三：JSON 结构完整但内容全空', () => {
  it('五个字段全空判为 refused/empty_output', () => {
    const content = JSON.stringify({
      ocrText: '',
      description: '',
      emotions: [],
      scenes: [],
      tags: [],
    })
    const outcome = interpretVisionContent(content, 'stop', vocab)
    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') expect(outcome.form).toBe('empty_output')
  })

  it('词表过滤之后才全空的，同样被判空——顺序是「校验词表 → 判空」', () => {
    const content = JSON.stringify({
      description: '',
      emotions: ['这个词表里没有'],
      scenes: ['这个也没有'],
      tags: { subject: ['还是没有'], style: [] },
    })
    const outcome = interpretVisionContent(content, 'stop', vocab)
    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') expect(outcome.detail).toContain('词表')
  })

  it('只有 ocrText 有内容不算空——没文字的图 emotions 为空是正常的', () => {
    const content = JSON.stringify({ ocrText: '我裂开了', description: '', emotions: [] })
    expect(interpretVisionContent(content, 'stop', vocab).kind).toBe('ok')
  })

  it('isEmptyTagFields 只在八个字段全空时为真', () => {
    expect(isEmptyTagFields(fields())).toBe(true)
    expect(isEmptyTagFields(fields({ emotions: ['无语'] }))).toBe(false)
    // 新拆出来的三维同样算数：只标出了语气也不是「什么都没标出来」
    expect(isEmptyTagFields(fields({ tones: ['敷衍'] }))).toBe(false)
    expect(isEmptyTagFields(fields({ expressions: ['微笑'] }))).toBe(false)
    expect(isEmptyTagFields(fields({ purposes: ['表面附和'] }))).toBe(false)
  })
})

// ── 真实样本：deepseek-flash 的 30 条 ───────────────────────────────

describe('deepseek-flash 实测样本', () => {
  it('30 条全部能被判定，没有一条落到未处理分支', () => {
    expect(deepseek.results).toHaveLength(30)
    for (const record of deepseek.results) {
      expect(['ok', 'refused', 'invalid_output']).toContain(interpret(record).kind)
    }
  })

  it('正文空 + finish_reason=length 判为 invalid_output（截断，不是拒绝）', () => {
    // 这是实测里的主流失败：推理模型把预算烧在 reasoning_content 上，content 是空串。
    // 判成 refused 会触发「不重试主通道」，把一次重试就可能成功的调用直接丢掉。
    const empty = deepseek.results.filter((r) => {
      const envelope = parseChatEnvelope(JSON.parse(r.rawResponse))
      return envelope !== null && envelope.content === '' && envelope.finishReason === 'length'
    })
    expect(empty.length).toBeGreaterThan(10)
    for (const record of empty) {
      expect(interpret(record).kind).toBe('invalid_output')
    }
  })

  it('半截 JSON（260_表情_260.jpg）判为 invalid_output 而不是拒绝', () => {
    const record = deepseek.results.find((r) => r.file.startsWith('260_'))
    expect(record).toBeDefined()
    const outcome = interpret(record!)
    expect(outcome.kind).toBe('invalid_output')
    if (outcome.kind === 'invalid_output') expect(outcome.detail).toContain('截断')
  })

  it('jsonValid 的样本全部解析成功', () => {
    const valid = deepseek.results.filter((r) => r.jsonValid)
    expect(valid.length).toBeGreaterThan(0)
    for (const record of valid) {
      expect(interpret(record).kind).toBe('ok')
    }
  })

  it('84_表情_84.jpg：词表外的词条被丢掉，词表内的留下', () => {
    const record = deepseek.results.find((r) => r.file.startsWith('84_'))
    expect(record).toBeDefined()
    const outcome = interpret(record!)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return

    // 模型给的 emotions 是 ["委屈","可爱","不开心","气鼓鼓"]：
    // 「可爱」是 style 标签不是情绪，「不开心」「气鼓鼓」不在词表——只留「委屈」
    expect(outcome.fields.emotions).toEqual(['委屈'])
    // 同一个「可爱」作为 style 标签是合法的，字段不同结果就不同
    expect(outcome.fields.tags).toContain('可爱')
    expect(outcome.fields.tags).toContain('手绘')
    expect(outcome.fields.description).not.toBe('')
    // 越界词条要能带出去记日志——词表 v1 要靠它暴露缺词
    expect(outcome.violations.length).toBeGreaterThan(0)
    expect(outcome.violations).toContainEqual({ field: 'emotions', value: '不开心' })
  })

  it('实测样本里没有任何一条 HTTP 层拒绝或内容策略拒绝', () => {
    // 这条断言是给将来的人看的：形态二的覆盖依赖构造样本，不是这里漏测了
    expect(deepseek.results.every((r) => r.httpStatus === 200)).toBe(true)
  })
})

// ── 解析细节 ────────────────────────────────────────────────────────

describe('解析与结构校验', () => {
  it('```json 围栏和前后废话都能剥掉', () => {
    const content = '好的，结果如下：\n```json\n{"description":"一只猫"}\n```\n希望有帮助'
    const outcome = interpretVisionContent(content, 'stop', vocab)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.fields.description).toBe('一只猫')
  })

  it('tags 的两种形状都收：数组与 {subject, style}', () => {
    const flat = interpretVisionContent(JSON.stringify({ tags: ['猫', '手绘'] }), 'stop', vocab)
    const grouped = interpretVisionContent(
      JSON.stringify({ tags: { subject: ['猫'], style: ['手绘'] } }),
      'stop',
      vocab,
    )
    expect(flat.kind).toBe('ok')
    expect(grouped.kind).toBe('ok')
    if (flat.kind === 'ok' && grouped.kind === 'ok') {
      expect(flat.fields.tags).toEqual(grouped.fields.tags)
    }
  })

  it('字段类型不对判结构不符，不是「过滤掉就好」', () => {
    expect(interpretVisionContent('{"emotions":[1,2,3]}', 'stop', vocab).kind).toBe('invalid_output')
    expect(interpretVisionContent('{"description":42}', 'stop', vocab).kind).toBe('invalid_output')
  })

  it('五个字段一个都不出现判结构不符——那是另一个 JSON', () => {
    expect(interpretVisionContent('{"foo":"bar"}', 'stop', vocab).kind).toBe('invalid_output')
  })

  it('alias 单跳归一化：「服了」→「无语」', () => {
    const outcome = interpretVisionContent(JSON.stringify({ emotions: ['服了'] }), 'stop', vocab)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.fields.emotions).toEqual(['无语'])
  })

  it('同一个词条重复出现只留一个', () => {
    const outcome = interpretVisionContent(
      JSON.stringify({ emotions: ['无语', '服了', '无语'] }),
      'stop',
      vocab,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.fields.emotions).toEqual(['无语'])
  })

  it('parseChatEnvelope 对不是 chat completions 的结构返回 null', () => {
    expect(parseChatEnvelope({ data: [] })).toBeNull()
    expect(parseChatEnvelope(null)).toBeNull()
    expect(parseChatEnvelope('{}')).toBeNull()
  })
})

describe('search_text 拼接', () => {
  it('ocrText + description + 六个数组，空的部分不留空格', () => {
    expect(
      buildSearchText(
        fields({
          ocrText: '我裂开了',
          description: '一只崩溃的猫',
          emotions: ['崩溃'],
          tags: ['猫'],
        }),
      ),
    ).toBe('我裂开了 一只崩溃的猫 崩溃 猫')
  })

  /**
   * 顺序不是随便定的：`migrations/0006_split_label_dimensions.sql` 里的 search_text
   * 重算按同一个顺序拼。两边不一致的表现是——迁移过的图和之后重打标的图，
   * search_text 排列不同，diff 看起来像内容变了，其实只是顺序。
   */
  it('六个数组按 expressions → emotions → tones → purposes → scenes → tags 拼', () => {
    expect(
      buildSearchText(
        fields({
          ocrText: '你说得都对',
          description: '一个角色在微笑',
          expressions: ['微笑'],
          tones: ['敷衍'],
          purposes: ['表面附和'],
          scenes: ['上班'],
          tags: ['动漫'],
        }),
      ),
    ).toBe('你说得都对 一个角色在微笑 微笑 敷衍 表面附和 上班 动漫')
  })

  it('全空时是空串，不是一串空格', () => {
    expect(buildSearchText(fields())).toBe('')
  })
})
