/**
 * 视觉模型返回值的判定与校验。**纯函数、零 import**（project-structure.md）。
 *
 * 这个文件存在的全部理由是 agents/rules/ai-providers.md §3：**拒绝有三种形态**，
 * 而其中最阴险的一种（JSON 结构完整但内容全空）不会以任何错误的形式出现——
 * 解析成功、类型检查通过、字段都在，代码会把它当成一次成功的打标写进库，
 * 那张图从此带着一组空标签躺在共享库里，搜不到也没人知道为什么。
 *
 * 所以判定必须是独立的、可单测的一层，单测用 `docs/fixtures/responses/` 的**真实样本**
 * （见同目录 vision-output.test.ts）。自己编的假响应只覆盖得到自己想得到的情况。
 *
 * ⚠️ **禁止任何供应商特有的分支**（ai-providers.md §1）。下面所有正则匹配的都是
 *    **错误语义**（「不支持」「内容策略」「图片数超限」），不是某家厂商的域名或错误码前缀。
 *    不允许出现 `if (baseUrl.includes(...))` 这种东西。
 */

// ── 输出字段 ────────────────────────────────────────────────────────

/**
 * 单次视觉调用产出的全部字段，**不做独立 OCR 链路**（SPEC §5.2.3）。
 *
 * 六个数组是六个**互不推导**的维度（SPEC §4.3.1）：`expressions` 是脸上什么样，
 * `emotions` 是心里什么感受，两者不能互相补齐——一张微笑角色配「你说得都对」的图，
 * 正确答案是 `expressions: ['微笑']` 加上 `emotions: []`，不是 `emotions: ['开心']`。
 */
export type TagFields = {
  ocrText: string
  description: string
  expressions: string[]
  emotions: string[]
  tones: string[]
  purposes: string[]
  scenes: string[]
  tags: string[]
}

export type VocabField = 'expressions' | 'emotions' | 'tones' | 'purposes' | 'scenes' | 'tags'

/**
 * 六个维度，**有序**，顺序即语义强度：看得见的排前面，要推断的排后面。
 *
 * 本文件里所有「对每个维度做一遍」的地方都遍历它，不手写六次——加第七个维度时
 * 漏掉一处的表现是那一维静默不校验，模型输出什么就存什么。
 */
const LABEL_FIELDS = [
  'expressions',
  'emotions',
  'tones',
  'purposes',
  'scenes',
  'tags',
] as const satisfies readonly VocabField[]

/**
 * 词表能力的注入口。**这一层不认识词表文件**——`vocab.ts` 要读磁盘，
 * 而本文件必须保持零 import 才能「不起 Postgres、不联网」地被测（project-structure.md）。
 */
export type VocabAdapter = {
  /** 单跳别名归一化。词表里没有别名时原样返回。 */
  alias: (value: string) => string
  isKnown: (field: VocabField, value: string) => boolean
}

export type VocabViolation = { field: VocabField; value: string }

// ── 失败形态 ────────────────────────────────────────────────────────

/**
 * 一次视觉调用可能的失败。与 SPEC §2.4 的错误码一一对应，多出来的 `image_limit`
 * 是**刻意的**：SPEC §2.4 明说「图片数超限不落在那张表里」，它要先降帧而不是降通道。
 */
export type VisionFailure =
  | 'unreachable'
  | 'unsupported'
  | 'refused'
  | 'invalid_output'
  | 'image_limit'

/** 拒绝的三种形态里，能在正文里认出来的那两种。HTTP 层那种走 `classifyHttpFailure`。 */
export type RefusalForm = 'refusal_text' | 'empty_output'

export type VisionOutcome =
  | { kind: 'ok'; fields: TagFields; violations: VocabViolation[] }
  | { kind: 'refused'; form: RefusalForm; detail: string }
  | { kind: 'invalid_output'; detail: string }

// ── HTTP 层 ────────────────────────────────────────────────────────

/**
 * 图片数超限。**必须排在其他 4xx 判定前面**：它不是「失败」，是「换个发法再来一次」。
 *
 * `vision_multi_image` 只说明支不支持多图，**不说明最多几张**，测试连接探测不出上限
 * （image-pipeline.md §3），所以这种错误只会在运行时暴露，且只能靠错误文本认。
 */
const IMAGE_LIMIT_HINT =
  /too many images|image[_ ]?count|max(imum)?[^.]{0,16}images|images?[^.]{0,12}per request|图片数|图片过多|图片太多|最多[^。]{0,8}(张|幅)图/i

/** 内容策略拒绝。中英文都要认——中转服务的错误文案两种都有。 */
const POLICY_HINT =
  /content[_ -]?policy|content[_ -]?filter|safety|prohibited|not allowed|违规|敏感|内容策略|审核不通过|风控/i

/**
 * 能力 / 配置问题。**不重试**，重试一百次也是同一个结果，只会浪费用户的钱。
 *
 * 真实样本：`docs/fixtures/responses/api.codexzh.com-2026-09-14.json` 全部 30 条都是
 * HTTP 400 + 「模型 xxx 不支持 chat completions 协议」+ `code: protocol_not_supported`。
 */
const UNSUPPORTED_HINT =
  /unsupported|not[_ ]?support|does ?n[o']?t support|do not support|model[_ ]?not[_ ]?found|no such model|unknown model|invalid[_ ]?model|不支持|不存在该?模型|未知模型/i

/**
 * 把 HTTP 层的失败归到一种形态。
 *
 * **4xx 默认归 `unsupported` 而不是 `unreachable`**：SPEC §2.4 把 `AI_UNREACHABLE`
 * 限定在「超时、网络错误、5xx」。一个原样重发就会再被拒一次的 4xx 放进重试队列，
 * 只是把一次确定的失败拖成五次确定的失败。
 */
export function classifyHttpFailure(
  status: number,
  body: string,
): Exclude<VisionFailure, 'invalid_output'> {
  // 超时、限流、网关故障：换个时间再来是有意义的
  if (status === 408 || status === 429 || status >= 500) return 'unreachable'

  if (IMAGE_LIMIT_HINT.test(body)) return 'image_limit'

  // 451 是内容策略的标准状态码；其余状态码靠错误体关键词认
  if (status === 451 || POLICY_HINT.test(body)) return 'refused'

  if (UNSUPPORTED_HINT.test(body)) return 'unsupported'

  // 401 / 403 / 400 / 404 全部落到这里：都是「这么发就是不行」，要告诉用户检查配置
  return 'unsupported'
}

// ── 响应信封 ────────────────────────────────────────────────────────

export type ChatEnvelope = {
  content: string
  /** `stop` / `length` / null。`length` 意味着**输出被截断**，那是截断不是拒绝。 */
  finishReason: string | null
}

/**
 * 从 OpenAI 兼容的 chat completions 响应里取正文和 finish_reason。
 *
 * 第三方结构一律先当 `unknown` 再逐层校验（code-style.md）：`as ChatResponse` 是把
 * 类型检查关掉，不是把类型改对。返回 null 表示这压根不是一个 chat completions 响应。
 */
export function parseChatEnvelope(payload: unknown): ChatEnvelope | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null

  const first: unknown = choices[0]
  if (typeof first !== 'object' || first === null) return null

  const message = (first as { message?: unknown }).message
  const rawContent =
    typeof message === 'object' && message !== null
      ? (message as { content?: unknown }).content
      : undefined

  // content 缺席和 content 为空字符串是同一件事：模型什么都没说。
  // 实测 deepseek-flash 把预算烧在 reasoning_content 上时就是这样（见单测）。
  const content = typeof rawContent === 'string' ? rawContent : ''

  const rawFinish = (first as { finish_reason?: unknown }).finish_reason
  const finishReason = typeof rawFinish === 'string' ? rawFinish : null

  return { content, finishReason }
}

// ── 正文判定 ────────────────────────────────────────────────────────

/**
 * 拒绝措辞。**只在正文里压根没有 JSON 结构时才用**——见 `interpretVisionContent`。
 *
 * 不能无条件跑：`description` 里出现「无法」「不能」是完全正常的画面描述
 * （「一副生无可恋、什么都不能做的表情」），拿它判拒绝会把成功的打标误杀。
 */
const REFUSAL_HINT =
  /抱歉|很遗憾|无法(描述|识别|处理|回答|提供)|不能(描述|识别|处理|回答|提供)|拒绝|不便|违反|policy|sorry|cannot|can'?t (help|describe|assist)|unable to|not able to|I'?m not able/i

/** ```json ... ``` 围栏。模型很爱加，即使提示词说了不要。 */
const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/

function stripFence(raw: string): string {
  const fenced = FENCE.exec(raw)
  return fenced?.[1] ?? raw
}

/**
 * 从正文里抠出 JSON 对象。模型常在前后各加一句话，掐头去尾比直接 parse 宽容得多，
 * 而宽容在这里是对的：多花几个字符的解析，换回一次本来要重试的调用。
 */
function extractJsonObject(raw: string): string | null {
  const text = stripFence(raw).trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items: string[] = []
  for (const item of value) {
    // 逐项查 typeof。混进数字或 null 的数组是结构错误，不是「过滤掉就好」
    if (typeof item !== 'string') return null
    items.push(item)
  }
  return items
}

/**
 * `tags` 的两种形状都收：`string[]` 和 `{ subject, style }`。
 *
 * 两种都要认不是"兼容一下"：词表本身就把 tags 分成 subject / style 两组
 * （shared/vocab/vocab.json），提示词按分组问出来的质量更好，而库里的 `tags`
 * 是一个扁平 text[]（SPEC §5.2.3）。分组只活在提示词和响应里，进库前拍平。
 */
function parseTags(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  const flat = asStringArray(value)
  if (flat !== null) return flat

  if (typeof value !== 'object') return null
  const grouped = value as { subject?: unknown; style?: unknown }
  const subject = grouped.subject === undefined ? [] : asStringArray(grouped.subject)
  const style = grouped.style === undefined ? [] : asStringArray(grouped.style)
  if (subject === null || style === null) return null
  return [...subject, ...style]
}

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  return value
}

type RawFields = {
  ocrText: string
  description: string
} & Record<VocabField, string[]>

/**
 * 第二步：校验结构。返回 null 表示「解析出来的不是我们要的那个东西」。
 *
 * 八个字段**全部可缺席**（缺席按空处理），但**出现就必须是对的类型**。
 * 全都缺席也算结构不对——那说明模型回的是另一个 JSON，不是我们要的。
 *
 * 实测样本里 `ocrText` 经常整个不出现（deepseek 那 7 条合法 JSON 全都没有它），
 * 所以「缺席即空」不是宽容，是现实。
 *
 * **老模型 / 老提示词只会回 `emotions` / `scenes` / `tags` 三个维度**，缺席的
 * `expressions` / `tones` / `purposes` 按空处理即可——那是「这次没标」，不是结构错误。
 */
function validateStructure(value: unknown): RawFields | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  const known = ['ocrText', 'description', ...LABEL_FIELDS]
  if (!known.some((key) => raw[key] !== undefined)) return null

  const ocrText = asText(raw['ocrText'])
  const description = asText(raw['description'])
  if (ocrText === null || description === null) return null

  const labels = {} as Record<VocabField, string[]>
  for (const field of LABEL_FIELDS) {
    // tags 多收一种形状（{ subject, style }），其余五维只收扁平数组
    const parsed = field === 'tags' ? parseTags(raw[field]) : parseLabelArray(raw[field])
    if (parsed === null) return null
    labels[field] = parsed
  }

  return { ocrText, description, ...labels }
}

function parseLabelArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  return asStringArray(value)
}

/**
 * 第三、四步：alias 归一化 → 词表校验。
 *
 * **词表外的词条被丢掉，不是把整次调用判失败。** 顺序在 ai-providers.md §5 里写死了：
 * 校验词表**之后**才判空——如果词表越界是直接整条拒绝，判空那一步就永远走不到。
 * 丢掉之后全空的那种情况，正是由判空接住的。
 *
 * 违规词条要带出去记日志：词表 v1 要靠真实打标结果暴露缺词，这是唯一的来源。
 *
 * **校验按维度进行。** 一个词只属于一个维度（SPEC §4.3.2）——模型把 `微笑` 放进
 * `emotions` 时它是违规词条，会被丢掉并记一条 violation，**不会被搬到 expressions 里**。
 * 自动搬运看着贴心，实际是替模型做判断：它把表情当情绪这件事，正是评测集要看见的信号。
 */
function applyVocab(
  raw: RawFields,
  vocab: VocabAdapter,
): { fields: TagFields; violations: VocabViolation[] } {
  const violations: VocabViolation[] = []

  const filter = (field: VocabField, values: string[]): string[] => {
    const kept: string[] = []
    const seen = new Set<string>()
    for (const value of values) {
      const trimmed = value.trim()
      if (trimmed === '') continue
      const canonical = vocab.alias(trimmed)
      if (!vocab.isKnown(field, canonical)) {
        violations.push({ field, value: trimmed })
        continue
      }
      if (seen.has(canonical)) continue
      seen.add(canonical)
      kept.push(canonical)
    }
    return kept
  }

  const labels = {} as Record<VocabField, string[]>
  for (const field of LABEL_FIELDS) labels[field] = filter(field, raw[field])

  return {
    fields: {
      ocrText: raw.ocrText.trim(),
      description: raw.description.trim(),
      ...labels,
    },
    violations,
  }
}

/**
 * 第五步：判空。**三种拒绝形态里最阴险的那一种**（ai-providers.md §3）。
 *
 * 判据是「**全部**字段都空」，不是「某个字段空」：一张没有文字的图 `ocrText` 本来就该是空，
 * 一张看不出情绪的图 `emotions` 空也正常——SPEC §4.3.1 还明写着「证据不足就留空」。
 * 只有全空才说明这次调用什么都没产出。
 */
export function isEmptyTagFields(fields: TagFields): boolean {
  if (fields.ocrText !== '' || fields.description !== '') return false
  return LABEL_FIELDS.every((field) => fields[field].length === 0)
}

/**
 * 正文 → 结果。校验顺序固定（ai-providers.md §5）：
 *
 *   解析 JSON → 校验结构 → alias 归一化 → 校验词表 → **判空**
 *
 * `finishReason === 'length'` 单独先判：那是**输出被截断**，不是拒绝。
 * 实测 deepseek-flash 有 23/30 走这一支（推理把预算烧光，`content` 是空串或半截 JSON），
 * 把它判成 `refused` 会让「不重试主通道」那条规则吃掉一次本来重试就能成的调用。
 */
export function interpretVisionContent(
  content: string,
  finishReason: string | null,
  vocab: VocabAdapter,
): VisionOutcome {
  const candidate = extractJsonObject(content)

  if (candidate === null) {
    if (finishReason === 'length') {
      return { kind: 'invalid_output', detail: '输出被截断，正文里没有 JSON' }
    }
    if (content.trim() === '') {
      // 正文空 + 正常结束：模型看了图然后什么都不说，这就是一次拒绝
      return { kind: 'refused', form: 'empty_output', detail: '正文为空' }
    }
    if (REFUSAL_HINT.test(content)) {
      return { kind: 'refused', form: 'refusal_text', detail: firstLine(content) }
    }
    return { kind: 'invalid_output', detail: '正文不是 JSON' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    // 有 `{` 有 `}` 但解析不了，多半是被截断在中间（实测 260_表情_260.jpg 就是）。
    // 这里**不跑拒绝措辞匹配**：半截 JSON 里的 description 很可能正好含「无法」「不能」。
    return {
      kind: 'invalid_output',
      detail: finishReason === 'length' ? '输出被截断' : 'JSON 解析失败',
    }
  }

  const structure = validateStructure(parsed)
  if (structure === null) return { kind: 'invalid_output', detail: '结构不符' }

  const { fields, violations } = applyVocab(structure, vocab)

  if (isEmptyTagFields(fields)) {
    return {
      kind: 'refused',
      form: 'empty_output',
      detail: violations.length > 0 ? '词表过滤后内容全空' : '内容全空',
    }
  }

  return { kind: 'ok', fields, violations }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

// ── 派生字段 ────────────────────────────────────────────────────────

/**
 * `search_text` = `ocr_text` + `description` + 六个数组（SPEC §5.2.3）。
 *
 * **派生字段，任何一个来源字段变更时必须重算**，所以拼接只有这一个实现——
 * `PATCH /memes/:id` 改标签时用的也是它。两处各拼一份的表现是
 * 「手动改过的图搜不到」，不报错。
 *
 * ⚠️ **它只喂 embedding，不再是 pg_trgm 的匹配目标**（SPEC §9.21）。标签值已经由
 *    标签通路精确命中一次，让 trgm 也匹配它们等于同一个信号被计两遍分。向量这边
 *    要保留标签：一句「一只很累的猫」对上库里的 `疲惫 猫`，正是向量路该干的事。
 *
 * ⚠️ `original_filename` **不进 search_text**，因此不进 embedding。它参与 pg_trgm
 *    但待遇不同是有意的：大量文件名是 `IMG_1234.jpg` 这类纯噪声（SPEC §5.2.3）。
 */
export function buildSearchText(fields: TagFields): string {
  return [fields.ocrText, fields.description, ...LABEL_FIELDS.flatMap((f) => fields[f])]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ')
}
