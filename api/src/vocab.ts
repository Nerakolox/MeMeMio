import { readFileSync } from 'node:fs'
import type { VocabAdapter, VocabField } from './lib/vision-output.js'
import { VOCAB_PATH } from './paths.js'

/**
 * 标签词表。主源是 shared/vocab/vocab.json（SPEC §0.2），api 和 web 读**同一份文件**。
 *
 * 它是**闭集**：存在的理由是让不同模型的输出可比。梗名是开集，不进这里（SPEC §4、§9.18）。
 *
 * v0.2.0 起是**六个维度**：五个语义维度 + 一个内容维度。它们**不能互相推导**——
 * 微笑是 expressions、开心是 emotions，前者看得见后者看不见（SPEC §4.3.1、§9.22）。
 *
 * ⚠️ 词条现在还是 proposed，代码只能把它当数据读，不能 `if (emotion === '无语')`。
 *    见 joint-tasks/2026-09-13-skeleton.md 的注意事项。
 */

export type Vocabulary = {
  version: string
  status: string
  updatedAt: string
  expressions: string[]
  emotions: string[]
  tones: string[]
  purposes: string[]
  scenes: string[]
  tags: { subject: string[]; style: string[] }
  aliases?: Record<string, string>
}

function load(): Vocabulary {
  const raw = readFileSync(VOCAB_PATH, 'utf-8')
  return JSON.parse(raw) as Vocabulary
}

export const vocabulary: Vocabulary = load()

/**
 * 六个维度的取值集合。**顺序就是提示词和前端筛选区的展示顺序**，
 * 从「看得见」排到「要推断」：表情 → 情绪 → 语气 → 用途 → 情境 → 主体风格。
 */
const sets: Record<VocabField, ReadonlySet<string>> = {
  expressions: new Set(vocabulary.expressions),
  emotions: new Set(vocabulary.emotions),
  tones: new Set(vocabulary.tones),
  purposes: new Set(vocabulary.purposes),
  scenes: new Set(vocabulary.scenes),
  tags: new Set([...vocabulary.tags.subject, ...vocabulary.tags.style]),
}

/** 六个维度的字段名，**有序**。需要遍历全部维度的地方都从这里取，不要各处手写数组。 */
export const VOCAB_FIELDS = [
  'expressions',
  'emotions',
  'tones',
  'purposes',
  'scenes',
  'tags',
] as const satisfies readonly VocabField[]

/** 某个维度的全部词条，按 JSON 里的顺序。 */
export function termsOf(field: VocabField): readonly string[] {
  if (field === 'tags') return [...vocabulary.tags.subject, ...vocabulary.tags.style]
  return vocabulary[field]
}

/**
 * 词表校验是**双向**的：不只挡模型，人工编辑提交词表外的标签同样要被拒。
 * 见 agents/rules/testing.md §4。
 *
 * **按维度校验，不是按全表校验。** 一个词只属于一个维度（SPEC §4.3.2），
 * `微笑` 传进 `emotions` 和传进一个不存在的词一样不合法——这正是拆维度想挡住的错误。
 */
export function isKnownLabel(field: VocabField, value: string): boolean {
  return sets[field].has(value)
}

/** 任一维度里有这个词就算数。只给检索侧的查询分词用（它不知道用户说的是哪一维）。 */
export function isKnownTerm(value: string): boolean {
  return VOCAB_FIELDS.some((f) => sets[f].has(value))
}

export const vocabularySize = {
  expressions: sets.expressions.size,
  emotions: sets.emotions.size,
  tones: sets.tones.size,
  purposes: sets.purposes.size,
  scenes: sets.scenes.size,
  tags: sets.tags.size,
}

/**
 * 把词表接进纯函数层。`lib/vision-output.ts` 自己不读磁盘，所以别名表从这里注入。
 *
 * ⚠️ **全进程只有这一份。** 打标（`services/tagging.ts`）和测试连接的探测
 *    （`ai/probe.ts`）用的必须是同一个适配器——「不要为测试连接另写一套判定，
 *    两套判定迟早给出不同结论」。两套的表现是测试连接说 `vocabCompliant: true`，
 *    同一个模型打标时标签却被丢掉。
 */
export const vocabAdapter: VocabAdapter = {
  alias: (value: string): string => vocabulary.aliases?.[value] ?? value,
  isKnown: (field: VocabField, value: string): boolean => isKnownLabel(field, value),
}
