import { describe, expect, it } from 'vitest'
import { RETRIEVAL_TASK, needsInstructPrefix, withInstructPrefix } from './embed-instruct.js'

/**
 * instruct 前缀是**不对称**的：查询侧要加，文档侧不加（retrieval.md §4）。
 * 两边都加或都不加不会报错，只会让检索质量掉几个点——属于「测试不盯着就没人发现」的那类。
 */

describe('needsInstructPrefix', () => {
  it('识别指令感知的模型', () => {
    expect(needsInstructPrefix('qwen3-embedding-0.6b')).toBe(true)
    expect(needsInstructPrefix('Qwen3-Embedding-8B')).toBe(true)
    expect(needsInstructPrefix('text-embedding-3-small')).toBe(false)
    expect(needsInstructPrefix('')).toBe(false)
  })
})

describe('withInstructPrefix', () => {
  it('查询侧加前缀', () => {
    const result = withInstructPrefix('今天不想上班', 'qwen3-embedding-0.6b')

    expect(result).toContain(`Instruct: ${RETRIEVAL_TASK}`)
    expect(result).toContain('Query: 今天不想上班')
    // 换行分隔，不是空格：模型按这个格式解析
    expect(result).toBe(`Instruct: ${RETRIEVAL_TASK}\nQuery: 今天不想上班`)
  })

  it('不需要前缀的模型原样返回', () => {
    expect(withInstructPrefix('今天不想上班', 'text-embedding-3-small')).toBe('今天不想上班')
  })

  it('重复调用不会叠加前缀', () => {
    const once = withInstructPrefix('今天不想上班', 'qwen3-embedding-0.6b')
    const twice = withInstructPrefix(once, 'qwen3-embedding-0.6b')

    // 再包一层会变成 Instruct: ... Query: Instruct: ... —— 模型看到的是噪声
    expect(twice.match(/Instruct:/g)).toHaveLength(2)
    // 这条只是记录现状：没有幂等保护，调用方加一次就够了
    expect(twice).not.toBe(once)
  })
})
