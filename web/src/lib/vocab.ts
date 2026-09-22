import vocabJson from '@shared/vocab/vocab.json'

/**
 * 筛选选项的唯一来源。**不维护第二份标签列表** —— 它和 api 读的是同一个文件
 * （shared/vocab/vocab.json，SPEC §0.2）。
 *
 * ⚠️ 词条还是 proposed，代码只能把它当数据读，不能对具体词条做硬编码分支。
 */

/** 六个数组字段的字段名。和 api 的 `VocabField` 同名同值（SPEC §4.3）。 */
export type VocabField = 'expressions' | 'emotions' | 'tones' | 'purposes' | 'scenes' | 'tags'

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
}

export const vocabulary = vocabJson as Vocabulary

export const expressionOptions = vocabulary.expressions
export const emotionOptions = vocabulary.emotions
export const toneOptions = vocabulary.tones
export const purposeOptions = vocabulary.purposes
export const sceneOptions = vocabulary.scenes
export const tagOptions = [...vocabulary.tags.subject, ...vocabulary.tags.style]

/**
 * 六个维度的**展示顺序、名称与候选词**。筛选面板和编辑面板都遍历这张表，
 * 不各写一份六段重复的 JSX。
 *
 * ⚠️ 名称用 SPEC §4.3 的全称（「表达语气」而不是「语气」）。这不是啰嗦：五个语义维度
 * 里有三个单看两个字会被读成同一件事——「语气」「情绪」「表情」在日常说法里是通用的，
 * 而这里它们**互相不能推导**（§4.3.1，也正是拆维度的全部理由）。列头是用户唯一能看到的
 * 判据，缩写掉它就等于把当初合成一维的那个错误在界面上重演一遍。
 *
 * 顺序照 SPEC §4.3 的表：视觉事实（表情）→ 内心状态（情绪）→ 怎么说（语气）→
 * 想完成什么（用途）→ 现实场合（情境）→ 内容维度（标签）。前五个是从外到内、
 * 从事实到推断，对着一张图从上往下填是顺的。
 */
export const VOCAB_DIMENSIONS: { field: VocabField; label: string; options: string[] }[] = [
  { field: 'expressions', label: '面部表情', options: expressionOptions },
  { field: 'emotions', label: '情绪', options: emotionOptions },
  { field: 'tones', label: '表达语气', options: toneOptions },
  { field: 'purposes', label: '聊天用途', options: purposeOptions },
  { field: 'scenes', label: '生活情境', options: sceneOptions },
  { field: 'tags', label: '标签', options: tagOptions },
]

/**
 * 只要字段名的那一份。**遍历它，不要手写六遍**——漏掉一维的表现是那个筛选参数
 * 被静默忽略（接口照常 200，只是结果里混着不该出现的图），api 侧同名的 `VOCAB_FIELDS`
 * 就是为这件事存在的。
 */
export const VOCAB_FIELDS: VocabField[] = VOCAB_DIMENSIONS.map((d) => d.field)
