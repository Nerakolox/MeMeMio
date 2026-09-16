import { describe, expect, it } from 'vitest'
import { EMBED_DIM, l2Normalize, truncateAndNormalize } from './vector.js'

/**
 * 归一化漏掉的后果是**搜索悄悄变差**：不报错、不崩溃、单元测试也不会红，
 * 只有检索质量一点点掉下去。所以这两条必须有测试盯着（database.md、api/AGENTS.md §4）。
 */

function norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
}

describe('l2Normalize', () => {
  it('归一化后模长为 1', () => {
    const normalized = l2Normalize([3, 4])

    expect(norm(normalized)).toBeCloseTo(1, 12)
    expect(normalized[0]).toBeCloseTo(0.6, 12)
    expect(normalized[1]).toBeCloseTo(0.8, 12)
  })

  it('已经归一化的向量再归一化不变', () => {
    const once = l2Normalize([1, 2, 3])
    const twice = l2Normalize(once)

    expect(twice).toEqual(once)
  })

  it('零向量原样返回，不产生 NaN', () => {
    // 除以 0 会得到全 NaN，进了 pgvector 就是「这条记录永远搜不到」，日志里什么都不会出现
    const zero = l2Normalize([0, 0, 0])

    expect(zero).toEqual([0, 0, 0])
    expect(zero.some(Number.isNaN)).toBe(false)
  })

  it('不改动入参', () => {
    const input = [3, 4]
    l2Normalize(input)

    expect(input).toEqual([3, 4])
  })
})

describe('truncateAndNormalize', () => {
  it('截断到 1024 维', () => {
    const long = new Array<number>(2048).fill(1)
    const result = truncateAndNormalize(long)

    expect(result).toHaveLength(EMBED_DIM)
  })

  it('截断之后**重新**归一化 —— 只 slice 不归一化是那个最安静的 bug', () => {
    // 全 1 的 2048 维向量模长是 sqrt(2048)；截断成 1024 维后模长变成 sqrt(1024)，
    // 但两个值都不等于 1。所以「只截断」和「截断+归一化」在数值上完全可分辨
    const long = new Array<number>(2048).fill(1)
    const result = truncateAndNormalize(long)

    expect(norm(result)).toBeCloseTo(1, 12)
    // 漏掉归一化时会拿到 sqrt(1024) ≈ 32
    expect(norm(result)).not.toBeCloseTo(Math.sqrt(EMBED_DIM), 6)
  })

  it('短于 1024 维时原样归一化，不补齐', () => {
    // 补齐与否是 embedder 的判断（向量比 1024 短会直接判 invalid_output）；
    // 这里只保证不会悄悄补出一串 0 —— 补 0 会改变方向，进而改变检索结果
    const result = truncateAndNormalize([3, 4])

    expect(result).toHaveLength(2)
    expect(norm(result)).toBeCloseTo(1, 12)
  })
})
