import { log } from './logger.js'

/**
 * 优雅退出的编排。**单独一个文件是为了能被测**（`shutdown.test.ts`）——
 * 这块逻辑原本长在 `server.ts` 的 `installShutdownHandlers` 里，而 `server.ts`
 * 顶层就调 `main()`，import 它等于起一个进程，测不了。
 *
 * 这里只做编排，不 import 任何 worker 或 db：两样东西从参数进来。
 * 于是测试能拿假的对象把「server.close 回调一直不触发」这种场面摆出来。
 *
 * ## 为什么不能把收尾挂在 `server.close()` 的回调里
 *
 * `server.close()` 的回调**只在所有连接断开之后**触发。而连接不会自己走：
 * SSE 有 15 秒一次的心跳（`routes/imports.ts`），HTTP 有 keep-alive。
 * 于是「停 worker」被一个 ping 拖着，一直拖到容器层不耐烦 —— Docker 的默认
 * `stop_grace_period` 是 10 秒，超了直接 SIGKILL，**在途任务就停在 `running`**，
 * 而那是这个流程唯一要避免的结果（`queue/worker.ts` 的停机收尾就是为了它）。
 */

/**
 * 收尾总预算。Docker 默认 `stop_grace_period` 是 **10 秒**（`compose.yaml` 里没设，
 * 见 `docs/deployment.md`），留 2 秒给容器层自己收尾。
 *
 * 这个数**必须小于 10 秒**：等于或大于的话，等待中的优雅收尾自己就成了被 SIGKILL
 * 的那个，前面所有努力白做。改它之前先改 `stop_grace_period`。
 */
export const SHUTDOWN_DEADLINE_MS = 8_000

export type ShutdownOptions = {
  /**
   * 停收新连接，并**掐掉还挂着的**连接。同步返回，**不等回调**。
   * 生产里是 `server.close()` + `server.closeAllConnections()`，见 `server.ts`。
   */
  closeServer: () => void
  /**
   * 各 worker 的收尾，**调用即并行**（返回的 promise 数组不串起来）。
   * 每个都有内部超时，这里不再套一层。
   */
  stopWorkers: () => Promise<unknown>[]
  /** 生产里是 `process.exit`。测试里换成记录调用，否则测试进程自己先没了。 */
  exit: (code: number) => void
  /** 只给测试用。默认 `SHUTDOWN_DEADLINE_MS`。 */
  deadlineMs?: number
}

/**
 * 跑一次收尾。**幂等由调用方负责**（`installShutdownHandlers` 里的标志位），
 * 因为一次停机可能同时收到 SIGTERM 和 SIGINT。
 */
export async function shutdownOnce(signal: string, options: ShutdownOptions): Promise<void> {
  const { closeServer, stopWorkers, exit } = options
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS

  log.info({ signal, deadlineMs }, '收到退出信号，开始收尾')

  // ① 先关连接，**不 await 它的回调**。见文件头：那个回调可能永远不来，
  //    而它不来**不该**拖住 worker 的收尾。SSE 客户端会被这一步掐断，按 SPEC §1.4
  //    去拉一次快照对齐 —— 那条路本来就有（断线是它的常规路径，不是异常路径）
  closeServer()

  // ② 兜底闸。**不用 `unref()`**：这个定时器要能把进程按住，unref 之后它不挡退出，
  //    万一下面 await 的东西全都在等待中就没人兜底了
  let expired = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true
      // exit 0 而不是非 0：进程是按人家要求退出的，非 0 会让编排层以为它崩了，
      // 变成重启/告警。停在 running 的那些由 worker 的周期扫描回收（见 worker.ts）
      log.error(
        { signal, deadlineMs },
        '收尾超时，强制退出（在途任务会停在 running，由周期扫描回收）',
      )
      exit(0)
      // 生产的 `exit` 会当场终止进程，这一行到不了；它是给 `exit` 被换掉的场合留的出口
      // （测试），也是「超时之后不再干等一个永远不会结束的 worker」的保证
      resolve()
    }, deadlineMs)
  })

  // 两个 worker 并行收尾，不串行：各自的在途任务都有整体超时，串起来等于把两个
  // 超时上限加在一起，停机时间平白翻倍。
  // `allSettled` 而不是 `all`：一个 worker 收尾失败不该让另一个的半截状态没人管
  const drained = Promise.allSettled(stopWorkers()).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        log.error({ err: result.reason, signal }, 'worker 收尾失败')
      }
    }
  })

  try {
    // 到点就走，**不等** `drained`：一个卡在 15 秒 HTTP 调用上的在途任务不该拖着
    // 整个进程等下去，那正是 SIGKILL 的来源
    await Promise.race([drained, deadline])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }

  if (expired) return

  log.info({ signal }, '收尾完成，退出')
  exit(0)
}

/**
 * 挂上 SIGTERM / SIGINT 处理器。**返回收尾函数**，测试不用发真信号。
 *
 * `shuttingDown` 标志是必须的：Docker 先发 SIGTERM，超时才 SIGKILL，但开发时
 * Ctrl-C 连着按两下很常见，第二次进来会从头再跑一遍收尾（第二次的 `closeServer`
 * 对着已经关掉的 server 调用会抛）。
 */
export function installShutdownHandlers(
  options: ShutdownOptions & {
    /** 只给测试用。生产里默认挂到 `process` 上。 */
    register?: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void
  },
): (signal: string) => void {
  let shuttingDown = false

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      log.warn({ signal }, '收尾已经在跑，忽略重复的退出信号')
      return
    }
    shuttingDown = true
    // 刻意不 await：信号处理器返回值没人要，而这里也不该把异常漏成
    // unhandledRejection（那正是本任务要修的另一件事）
    void shutdownOnce(signal, options).catch((error: unknown) => {
      log.error({ err: error, signal }, '收尾过程本身异常，强制退出')
      options.exit(0)
    })
  }

  const register = options.register ?? defaultRegister
  register('SIGTERM', () => shutdown('SIGTERM'))
  register('SIGINT', () => shutdown('SIGINT'))

  return shutdown
}

function defaultRegister(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void {
  process.on(signal, handler)
}

/**
 * `unhandledRejection` 兜底。
 *
 * **只记日志，不退出。** Node 22 的默认动作是把它升级成致命错误、打一行堆栈然后
 * `exit(1)` —— 对一个人人都在跑后台任务的进程，那个默认值等于「一次写库抖动就把
 * 整个服务带走」。真实场景：worker 里任务超时后 `applyFailure` 写库失败（库刚好在
 * 重启），那次 reject 没人接，进程直接死。
 *
 * ⚠️ **这不是「写 `.catch` 的替代品」，是最后一道网。** 每个 promise 链的收尾都要
 *    自己接住异常（`queue/worker.ts` 的 `runJob(job).catch(...)`），因为走到这里的
 *    异常**已经脱离了业务上下文**：这里只能看见一个 unknown，说得出「有东西没接住」，
 *    说不出是哪个任务、哪张图。真有异常打进来，那是一条要修的 bug，不是一个状态。
 *
 * 进程继续跑是安全的：所有写回都是条件更新（拿着领取令牌比对），异常中断的那一步
 * 最多让某一行停在 `running`，而周期扫描会把它放回 `pending`（`queue/worker.ts`）。
 */
export function installProcessErrorHandlers(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    log.error(
      { err: reason },
      '有 promise 没有接住异常（unhandledRejection）。进程继续跑，这是个要修的 bug，不是正常状态',
    )
  })
}
