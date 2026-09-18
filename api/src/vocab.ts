import { readFileSync } from 'node:fs'
import type { VocabAdapter, VocabField } from './lib/vision-output.js'
import { VOCAB_PATH } from './paths.js'

/**
 * 标签词表。主源是 shared/vocab/vocab.json（SPEC §0.2），api 和 web 读**同一份文件**。
 *
 * 它是**闭集**：存在的理由是让不同模型的输出可比。梗名是开集，不进这里（SPEC §4、§9.18）。
 *
 * ⚠️ 词条现在还是 proposed，代码只能把它当数据读，不能 `if (emotion === '无语')`。
 *    见 joint-tasks/2026-09-13-skeleton.md 的注意事项。
 */

export type Vocabulary = {
  version: string
  status: string
  updatedAt: string
  emotions: string[]
  scenes: string[]
  tags: { subject: string[]; style: string[] }
  aliases?: Record<string, string>
}

function load(): Vocabulary {
  const raw = readFileSync(VOCAB_PATH, 'utf-8')
  return JSON.parse(raw) as Vocabulary
}

export const vocabulary: Vocabulary = load()

const emotionSet = new Set(vocabulary.emotions)
const sceneSet = new Set(vocabulary.scenes)
const tagSet = new Set([...vocabulary.tags.subject, ...vocabulary.tags.style])

/**
 * 词表校验是**双向**的：不只挡模型，人工编辑提交词表外的标签同样要被拒。
 * 见 agents/rules/testing.md §4。
 */
export function isKnownLabel(field: 'emotions' | 'scenes' | 'tags', value: string): boolean {
  if (field === 'emotions') return emotionSet.has(value)
  if (field === 'scenes') return sceneSet.has(value)
  return tagSet.has(value)
}

export const vocabularySize = {
  emotions: vocabulary.emotions.length,
  scenes: vocabulary.scenes.length,
  tags: tagSet.size,
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
