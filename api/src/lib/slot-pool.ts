/**
 * 固定上限的异步槽池。**纯内存、没有任何 import**，符合 `lib/` 的判断标准：
 * 不起 Postgres、不联网就能测。
 *
 * 它存在的全部理由是 `setLimit` 上调那一步，而那是[运行参数](../services/runtime-config.ts)
 * 这个功能最容易漏的陷阱：**等待者不会自己醒过来。**
 *
 * 等待者只在有槽被释放时才被唤醒，而调用方上调上限的那一刻，正在跑的活儿还没结束——
 * 也就是说**不会发生任何释放**。不主动补足唤醒的话，新上限要等到某次自然结束才生效，
 * 表现是「调了没用」，不报错、不告警，而调大恰恰是这个需求的主目的。见 SPEC §6.5.5。
 *
 * 用法：`acquire()` / `release()` 成对出现（release 放 `finally`）。
 * `setLimit` 可以随时调：**下调不打断已经在跑的任务**——砍掉它们会留下永远停在
 * `running` 的行，那正是 `stopTagWorker` 的注释写明要避免的（SPEC §6.5.5）。
 */

export type SlotPoolStats = {
  limit: number
  running: number
  waiting: number
}

export type SlotPool = {
  /** 拿到一个槽。没有空槽时挂起，直到有人释放或上限被调高。 */
  acquire(): Promise<void>
  /** 还回一个槽。**必须与 `acquire` 配对**，否则槽会永久泄漏。 */
  release(): void
  /** 改上限。上调会立刻唤醒能容纳的等待者，下调不打断在跑的。 */
  setLimit(next: number): void
  /** 当前状态。**只给测试与诊断用**，不要拿它做业务判断。 */
  stats(): SlotPoolStats
}

export function createSlotPool(initialLimit: number): SlotPool {
  let limit = initialLimit
  let running = 0
  const waiters: (() => void)[] = []

  /**
   * 把空出来的槽发给等待者。**记账在唤醒方**，被唤醒者醒来时已经持有槽位。
   *
   * ⚠️ 不这样写（让被唤醒者的续体自己 `running += 1`）的话，这个 while 会在同一轮里
   *    把**所有**等待者都唤醒：续体是 microtask，不会同步执行，于是 `running` 在这个
   *    循环眼里始终没涨，上限被当场冲穿——而冲穿的表现是「偶尔有一批 ffmpeg 一起跑」，
   *    不是报错。
   */
  function drain(): void {
    while (running < limit && waiters.length > 0) {
      running += 1
      waiters.shift()?.()
    }
  }

  return {
    async acquire(): Promise<void> {
      if (running < limit) {
        running += 1
        return
      }
      await new Promise<void>((resolve) => waiters.push(resolve))
    },

    release(): void {
      running -= 1
      drain()
    },

    setLimit(next: number): void {
      limit = next
      drain()
    },

    stats(): SlotPoolStats {
      return { limit, running, waiting: waiters.length }
    },
  }
}
