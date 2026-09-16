import { describe, expect, it } from 'vitest'
import { RRF_K, fuseRankings } from './rrf.js'

/**
 * RRF 是排序的唯一来源，所以这里断的是**性质**而不是具体数字：
 * 被多路召回的优先、名次靠前的优先、同分时顺序确定。
 */

describe('fuseRankings', () => {
  it('被多路引用的排在只被一路引用的前面', () => {
    const fused = fuseRankings(
      [
        { name: 'ocr', ids: ['a', 'b'] },
        { name: 'tags', ids: ['b', 'c'] },
      ],
      10,
    )

    // b 在两条路里都出现，累加两次 1/(k+rank)
    expect(fused[0]?.id).toBe('b')
    expect(fused.map((h) => h.id)).toEqual(['b', 'a', 'c'])
  })

  it('名次靠前的分更高', () => {
    const fused = fuseRankings([{ name: 'ocr', ids: ['first', 'second'] }], 10)

    expect(fused[0]?.id).toBe('first')
    expect(fused[0]?.score).toBeGreaterThan(fused[1]?.score ?? 0)
  })

  it('rank 从 1 开始而不是 0', () => {
    const fused = fuseRankings([{ name: 'ocr', ids: ['only'] }], 10)

    // 从 0 开始的话第一名是 1/k = 1/60，而不是 1/61
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 12)
  })

  it('matchedBy 记录被哪几路召回，顺序与通路顺序一致', () => {
    const fused = fuseRankings(
      [
        { name: 'vector', ids: ['x'] },
        { name: 'ocr', ids: ['x'] },
        { name: 'tags', ids: ['x'] },
      ],
      10,
    )

    expect(fused[0]?.matchedBy).toEqual(['vector', 'ocr', 'tags'])
  })

  it('同一路里重复出现的 id 只算一次分', () => {
    // 去重是数据层的责任，但真出现了也不能让一条记录凭空拿到双倍分
    const duplicated = fuseRankings([{ name: 'ocr', ids: ['x', 'x'] }], 10)
    const single = fuseRankings([{ name: 'ocr', ids: ['x'] }], 10)

    expect(duplicated[0]?.score).toBe(single[0]?.score)
  })

  it('并列时按 id 升序 —— 同样的查询不能两次给出不同顺序', () => {
    const paths = [
      { name: 'ocr', ids: ['m'] },
      { name: 'tags', ids: ['b'] },
      { name: 'vector', ids: ['z'] },
    ]

    // 三条各被一路以第 1 名召回，分数完全相同
    const first = fuseRankings(paths, 10).map((h) => h.id)
    const second = fuseRankings([...paths].reverse(), 10).map((h) => h.id)

    expect(first).toEqual(['b', 'm', 'z'])
    expect(second).toEqual(first)
  })

  it('limit 截断，且不改变前面的顺序', () => {
    const fused = fuseRankings([{ name: 'ocr', ids: ['a', 'b', 'c', 'd'] }], 2)

    expect(fused.map((h) => h.id)).toEqual(['a', 'b'])
  })

  it('没有任何一路召回时返回空数组', () => {
    expect(fuseRankings([], 10)).toEqual([])
    expect(fuseRankings([{ name: 'ocr', ids: [] }], 10)).toEqual([])
  })
})
