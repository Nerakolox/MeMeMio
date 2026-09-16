import { log } from '../logger.js'

/**
 * 导入进度的进程内广播。
 *
 * **为什么不做成持久订阅（比如 Postgres LISTEN/NOTIFY）**：导入进度是**可能丢**的信息。
 * SPEC §1.4 明确写了「连接断开不影响服务端处理」，而且客户端**不能**把 SSE 当作唯一
 * 的结果来源——重连后先拉 `GET /imports/{batchId}` 补快照，再听增量。既然快照是权威，
 * 事件通道掉了只是少收几条增量，不值得为它引入跨进程的基础设施。
 *
 * 反过来说，**这里的每个订阅者都必须容忍漏事件**：断线期间的进度靠快照补，
 * 不靠这里补发。所以没有重放缓冲区，只有当前活跃订阅者。
 *
 * 首期只跑一个进程（agents/rules/queue.md §1 的口径），进程内广播成立。
 * 将来真要多副本，广播换成 NOTIFY 即可，订阅端的代码不用改。
 */

export type ImportEventName = 'progress' | 'item' | 'done' | 'error'

export type ImportEvent =
  | { event: 'progress'; data: { total: number; done: number; skipped: number; pending: number } }
  | {
      event: 'item'
      data: { fileName: string; result: string; memeId?: string; reason?: string }
    }
  | {
      event: 'done'
      data: { total: number; imported: number; exactDup: number; needsReview: number; failed: number }
    }
  | { event: 'error'; data: { code: string; message: string } }

type Subscriber = (event: ImportEvent) => void

const subscribers = new Map<string, Set<Subscriber>>()

/** 订阅。返回退订函数——**调用方必须在连接关闭时调它**，否则进度条页面关多了会漏内存。 */
export function subscribe(batchId: string, fn: Subscriber): () => void {
  let set = subscribers.get(batchId)
  if (set === undefined) {
    set = new Set()
    subscribers.set(batchId, set)
  }
  set.add(fn)

  return () => {
    const current = subscribers.get(batchId)
    if (current === undefined) return
    current.delete(fn)
    if (current.size === 0) subscribers.delete(batchId)
  }
}

/**
 * 广播。没有订阅者时**什么都不做，也不留缓冲**。
 *
 * 「重连后能不能收到断线期间的事件」的答案是不能，而这是设计的一部分：
 * 客户端先拉快照补齐，再听增量。加缓冲反而会让重连时新旧事件交错，
 * 出现进度条倒退这种看起来像 bug 的现象。
 */
export function publish(batchId: string, event: ImportEvent): void {
  const set = subscribers.get(batchId)
  if (set === undefined) return
  for (const fn of set) {
    try {
      fn(event)
    } catch (error) {
      // 一个订阅者写失败（客户端刚断开、socket 已关）不能影响其他订阅者，
      // 更不能中断导入本身——处理管线是「发完事件继续干」的
      log.warn({ err: error, batchId, event: event.event }, 'SSE 推送失败，忽略')
    }
  }
}

/** 测试用：当前订阅者数量。别在生产代码里依赖它做逻辑判断。 */
export function subscriberCount(batchId: string): number {
  return subscribers.get(batchId)?.size ?? 0
}
