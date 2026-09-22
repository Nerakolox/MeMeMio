import { describe, expect, it } from 'vitest'
import { createSlotPool, type SlotPool } from './slot-pool.js'

/**
 * 槽池的单测。**不起 Postgres、不跑 ffmpeg**，所以它必须在这里，且断言要具体。
 *
 * 重点是 `setLimit` 上调那一条：等待者不会自己醒，不主动补足唤醒就静默失效
 * （SPEC §6.5.5、任务 §陷阱一）。这个 bug 在真机上表现为「管理员调大了并发、
 * 速度没变」，不报错、不告警，除了这条测试没有别的东西抓得住它。
 */

/**
 * 让出到**宏任务**，等所有已排队的 microtask 跑完。
 *
 * ⚠️ 不能用 `await Promise.resolve()`：被唤醒的 `acquire()` 要经过
 *    「async 续体 → 函数返回 → `.then` 回调」两跳，一跳不够，断言会在续体还没跑完时
 *    就看到一个空数组——**看起来像实现没唤醒，其实是测试自己抢跑**。
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 挂起 n 个 `acquire`，并记下谁真的拿到了槽。 */
function pending(pool: SlotPool, n: number) {
  const woken: number[] = []
  for (let i = 0; i < n; i += 1) {
    void pool.acquire().then(() => {
      woken.push(i)
    })
  }
  return woken
}

describe('基本语义', () => {
  it('有空槽时立刻拿到，用满之后才排队', async () => {
    const pool = createSlotPool(2)

    await pool.acquire()
    await pool.acquire()
    expect(pool.stats()).toMatchObject({ running: 2, waiting: 0 })

    pending(pool, 2)
    expect(pool.stats()).toMatchObject({ running: 2, waiting: 2 })
  })

  it('release 恰好唤醒一个等待者，不多给', async () => {
    const pool = createSlotPool(1)
    await pool.acquire()

    const woken = pending(pool, 2)
    pool.release()
    await flush()

    expect(woken).toEqual([0])
    expect(pool.stats()).toMatchObject({ running: 1, waiting: 1 })
  })
})

describe('setLimit', () => {
  it('上调时主动唤醒等待者——不是干等到下一次 release', async () => {
    const pool = createSlotPool(1)
    await pool.acquire()

    const woken = pending(pool, 2)
    expect(pool.stats().waiting).toBe(2)

    // 关键：**全程没有任何 release**。现实里对应「管理员把上限从 1 调到 3 的那一刻，
    // 在跑的还没结束」。不主动唤醒的话这里的 woken 会是空的，而生产上的表现是
    // 「调了没用」——不报错、不告警
    pool.setLimit(3)
    await flush()

    expect(woken).toEqual([0, 1])
    expect(pool.stats()).toMatchObject({ limit: 3, running: 3, waiting: 0 })
  })

  it('上调只唤醒放得下的那几个，不把上限冲穿', async () => {
    const pool = createSlotPool(2)
    await pool.acquire()
    await pool.acquire()

    const woken = pending(pool, 4)
    pool.setLimit(4)
    await flush()

    // 恰好补 2 个。若唤醒方不记账、靠被唤醒者的续体记账（microtask，同步看不见），
    // 这里会 4 个全醒、running 变成 6——表现是「偶尔一批 ffmpeg 一起跑」，不是报错
    expect(woken).toEqual([0, 1])
    expect(pool.stats()).toMatchObject({ limit: 4, running: 4, waiting: 2 })
  })

  it('下调不打断在跑的，也不放新的进来', async () => {
    const pool = createSlotPool(4)
    for (let i = 0; i < 4; i += 1) await pool.acquire()

    const woken = pending(pool, 2)
    pool.setLimit(1)
    await flush()

    // 一个都不该醒：4 个在跑的还在跑（砍掉它们会留下永远停在 running 的行，SPEC §6.5.5），
    // 而 running 还没降到 1 以下
    expect(woken).toEqual([])
    expect(pool.stats()).toMatchObject({ limit: 1, running: 4, waiting: 2 })

    pool.release()
    await flush()
    expect(pool.stats()).toMatchObject({ running: 3, waiting: 2 })
  })
})
