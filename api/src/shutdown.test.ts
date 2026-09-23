import { describe, expect, it } from 'vitest'
import { installShutdownHandlers, shutdownOnce, SHUTDOWN_DEADLINE_MS } from './shutdown.js'

/**
 * 停机收尾的编排（joint-tasks/2026-09-24-queue-reliability.md §1）。
 *
 * 这一组用例存在的理由是**一条实测过的坏行为**：收尾原本挂在 `server.close()` 的回调里，
 * 而那个回调只在所有连接断开后才触发——SSE 的 15 秒心跳和 HTTP keep-alive 把它一直挂着，
 * 于是两个 worker 的收尾根本没开始，进程被 Docker 在 10 秒后 SIGKILL，
 * 在途任务永远停在 `running`。表现是「这几张图再也不会被打标」，不报错、不告警。
 *
 * 所以下面第一条用例的形状就是那个 bug：`closeServer` 的回调**永远不调**。
 */

/** 一次收尾要用到的假件。`exit` 换成记录调用——真调 `process.exit` 的话测试进程先没了。 */
function harness(overrides: Partial<Parameters<typeof shutdownOnce>[1]> = {}) {
  const exits: number[] = []
  let stopped = 0
  let closed = 0

  return {
    exits,
    get stopped() {
      return stopped
    },
    get closed() {
      return closed
    },
    options: {
      closeServer: () => {
        closed += 1
      },
      stopWorkers: () => [
        Promise.resolve().then(() => {
          stopped += 1
        }),
        Promise.resolve().then(() => {
          stopped += 1
        }),
      ],
      exit: (code: number) => exits.push(code),
      ...overrides,
    },
  }
}

describe('停机收尾', () => {
  it('server.close 的回调不触发时，两个 worker 照样收尾，进程照样退出 0', async () => {
    // 这个 closeServer 就是那个 bug 的形状：它什么都不回调
    const h = harness()

    await shutdownOnce('SIGTERM', h.options)

    expect(h.closed).toBe(1)
    expect(h.stopped).toBe(2)
    expect(h.exits).toEqual([0])
  })

  it('worker 拖过收尾时限时，到点强制退出 0（不是等它，也不是非 0）', async () => {
    const h = harness({
      // 永远不结束的 worker：模拟一个卡在 15 秒 HTTP 调用上的在途任务
      stopWorkers: () => [new Promise<void>(() => {})],
      deadlineMs: 60,
    })

    const startedAt = Date.now()
    await shutdownOnce('SIGTERM', h.options)

    expect(h.exits).toEqual([0])
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('收尾时限必须短于 Docker 默认的 stop_grace_period（10 秒）', () => {
    // 等于或大于 10 秒的话，等待中的优雅收尾自己就成了被 SIGKILL 的那个，
    // 前面所有努力白做。改这个数之前先改 docs/deployment.md 里的 stop_grace_period
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(10_000)
  })

  it('一个 worker 收尾失败不影响另一个，进程仍然退出 0', async () => {
    const h = harness({
      stopWorkers: () => [Promise.reject(new Error('收尾炸了')), Promise.resolve()],
    })

    await shutdownOnce('SIGTERM', h.options)

    // `all` 而不是 `allSettled` 的话这里会抛出去，退不了也退不对
    expect(h.exits).toEqual([0])
  })

  it('第二个退出信号不会重跑一遍收尾', async () => {
    const h = harness()
    const handlers = new Map<string, () => void>()
    const shutdown = installShutdownHandlers({
      ...h.options,
      register: (signal, handler) => handlers.set(signal, handler),
    })

    handlers.get('SIGTERM')?.()
    handlers.get('SIGINT')?.()
    // 给两次收尾各留一轮微任务
    await new Promise((resolve) => setTimeout(resolve, 10))

    // 重跑的表现是对着已经关掉的 server 再调一次 close：开发时 Ctrl-C 连按两下就会踩到
    expect(h.closed).toBe(1)
    void shutdown
  })

  // `installProcessErrorHandlers` 的效果在子进程里验（见 `process-error-handlers.test.ts`）：
  // 它要断言的是「进程没死」，而在测试进程里造一个真的 unhandledRejection
  // 会被 vitest 自己捕获成整轮失败，测出来的不是被测代码的行为
})
