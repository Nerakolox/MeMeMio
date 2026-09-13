import vocabJson from '@shared/vocab/vocab.json'

/**
 * 筛选选项的唯一来源。**不维护第二份标签列表** —— 它和 api 读的是同一个文件
 * （shared/vocab/vocab.json，SPEC §0.2）。
 *
 * ⚠️ 词条还是 proposed，代码只能把它当数据读，不能对具体词条做硬编码分支。
 */

export type Vocabulary = {
  version: string
  status: string
  updatedAt: string
  emotions: string[]
  scenes: string[]
  tags: { subject: string[]; style: string[] }
}

export const vocabulary = vocabJson as Vocabulary

export const emotionOptions = vocabulary.emotions
export const sceneOptions = vocabulary.scenes
export const tagOptions = [...vocabulary.tags.subject, ...vocabulary.tags.style]
