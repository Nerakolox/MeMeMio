import { describe, expect, it } from 'vitest'
import {
  backoffMs,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  decideRetry,
  INVALID_OUTPUT_RETRY_MS,
  MAX_EMBED_ATTEMPTS,
  MAX_UNREACHABLE_ATTEMPTS,
} from './retry-policy.js'

/**
 * 重试矩阵的四个分支（queue.md §3）。这四条各自防的是不同的事故，
 * 合并成「失败就重试 N 次」会同时毁掉其中三条。
 */

describe('AI_UNREACHABLE：指数退避，上限 5 次', () => {
  it('前 4 次回队列，退避时间翻倍', () => {
    expect(decideRetry('unreachable', 1)).toEqual({ action: 'retry', delayMs: BACKOFF_BASE_MS })
    expect(decideRetry('unreachable', 2)).toEqual({ action: 'retry', delayMs: BACKOFF_BASE_MS * 2 })
    expect(decideRetry('unreachable', 3)).toEqual({ action: 'retry', delayMs: BACKOFF_BASE_MS * 4 })
    expect(decideRetry('unreachable', 4)).toEqual({ action: 'retry', delayMs: BACKOFF_BASE_MS * 8 })
  })

  it('第 5 次起转 needs_manual', () => {
    expect(decideRetry('unreachable', MAX_UNREACHABLE_ATTEMPTS))
      .toEqual({ action: 'fail', tagStatus: 'needs_manual' })
    expect(decideRetry('unreachable', MAX_UNREACHABLE_ATTEMPTS + 3))
      .toEqual({ action: 'fail', tagStatus: 'needs_manual' })
  })

  it('退避有封顶，不会退到明天', () => {
    expect(backoffMs(99)).toBe(BACKOFF_MAX_MS)
  })
})

describe('AI_REFUSED：不重试主通道', () => {
  it('第一次就终局——内容策略拒绝是确定性的，重试只是浪费用户的钱', () => {
    expect(decideRetry('refused', 1)).toEqual({ action: 'fail', tagStatus: 'needs_manual' })
  })
})

describe('AI_INVALID_OUTPUT：主通道重试 1 次', () => {
  it('第一次重试，几乎不退避——不是「等一会儿就好」的故障', () => {
    expect(decideRetry('invalid_output', 1))
      .toEqual({ action: 'retry', delayMs: INVALID_OUTPUT_RETRY_MS })
  })

  it('第二次仍失败就按 AI_REFUSED 处理，不再重试', () => {
    expect(decideRetry('invalid_output', 2)).toEqual({ action: 'fail', tagStatus: 'needs_manual' })
  })
})

describe('AI_UNSUPPORTED：不重试', () => {
  it('直接失败，等用户去改配置', () => {
    expect(decideRetry('unsupported', 1)).toEqual({ action: 'fail', tagStatus: 'needs_manual' })
  })
})

describe('embedding 失败：不回滚打标', () => {
  it('重试若干次，但终局**不动 tag_status**', () => {
    expect(decideRetry('embed_failed', 1)).toEqual({ action: 'retry', delayMs: BACKOFF_BASE_MS })
    expect(decideRetry('embed_failed', MAX_EMBED_ATTEMPTS))
      .toEqual({ action: 'fail', tagStatus: null })
  })
})
