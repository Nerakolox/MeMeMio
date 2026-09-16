import { describe, expect, it } from 'vitest'
import { COLLAGE_FRAME_COUNT, planVisionAttempts, takeTailFrames } from './frame-plan.js'

describe('planVisionAttempts', () => {
  it('静图只有一次尝试', () => {
    expect(planVisionAttempts(false, 1, true)).toEqual([{ mode: 'single' }])
    expect(planVisionAttempts(false, 1, null)).toEqual([{ mode: 'single' }])
  })

  it('去重后只剩一帧的动图按静图发——不给它拼一张 1 格的拼图', () => {
    expect(planVisionAttempts(true, 1, true)).toEqual([{ mode: 'single' }])
  })

  it('实测支持多图：10 帧 → 4 帧 → 拼图，三级都在同一个通道里', () => {
    expect(planVisionAttempts(true, 10, true)).toEqual([
      { mode: 'frames', count: 10 },
      { mode: 'frames', count: COLLAGE_FRAME_COUNT },
      { mode: 'collage' },
    ])
  })

  it('本来就不超过 4 帧时没有降帧那一级', () => {
    expect(planVisionAttempts(true, 3, true)).toEqual([
      { mode: 'frames', count: 3 },
      { mode: 'collage' },
    ])
  })

  it('没有探测记录（null）按最保守路径：直接拼图，不试多图', () => {
    expect(planVisionAttempts(true, 10, null)).toEqual([{ mode: 'collage' }])
    expect(planVisionAttempts(true, 10, false)).toEqual([{ mode: 'collage' }])
  })
})

describe('takeTailFrames', () => {
  it('降帧取末尾——文字往往要到后面几帧才出现', () => {
    expect(takeTailFrames([1, 2, 3, 4, 5, 6], 4)).toEqual([3, 4, 5, 6])
  })

  it('要的比有的多就全给', () => {
    expect(takeTailFrames([1, 2], 4)).toEqual([1, 2])
  })
})
