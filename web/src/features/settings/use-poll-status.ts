import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'

/**
 * 「有动静就每 5 秒问一次服务端，直到没动静」——设置页里两块长任务面板
 * （重建索引、重新打标）共用的一段。
 *
 * ## 为什么合成一个 hook（2026-09-24）
 *
 * 两处原先各写了一遍，**而且两处都只在成功那条路上安排下一次轮询**：
 *
 * ```ts
 * try { … ; if (next.running) timer = setTimeout(poll, 5000) }
 * catch { setError(…) }   // ← 没有 setTimeout
 * ```
 *
 * 于是一次失败就把它彻底停掉——不是「慢下来」，是**再也不问**。而那正是这个功能最需要
 * 轮询的时候：服务重启、网络抖一下、反代 502，全在这一类里。用户看到的是「进行中」的
 * 徽标与一行错误提示**一起僵在那儿**，没有出路，只能手动刷新整页（而他多半不会知道要这么做）。
 *
 * 现在失败会**退避重试**（5s → 10s → 20s → 40s，之后停在 40s），并说明下一次是什么时候。
 *
 * ## 它是「中性提示」不是错误
 *
 * 连不上服务端不是用户做错了什么，而且它自己在重试——所以面板那边用
 * `role="status"` 的中性 `Alert`，不用 `destructive`（同 `ImportProgress` 的重连提示）。
 */

/** 有动静时的轮询间隔。原来是硬编码在面板里的那个 5 秒。 */
const POLL_MS = 5000

/**
 * 连续失败时每次等待多久。下标是「已经连续失败了几次」，取到末尾就停在那儿
 * ——**退避必须有个上限**：这几块面板是管理页，管理员就守在这一屏看着，
 * 退避到几分钟一次会让「跑完了吗」变成一个要等很久的问题。
 */
const BACKOFF_MS = [5000, 10_000, 20_000, 40_000] as const

function backoffMs(failures: number): number {
  return BACKOFF_MS[failures] ?? 40_000
}

export type PollProblem = {
  /** 服务端那句话，或调用方给的兜底文案。 */
  message: string
  requestId?: string
  /** 下一次重试还要等多久（毫秒）。**要在界面上说出来**，否则「卡住了」和「在重试」看起来一样。 */
  retryInMs: number
}

/**
 * 那句话本身。**一处定义**：两块面板遇到的是同一件事，各写一份就会各说各的。
 *
 * 不写「加载失败」了事——那会让人以为要自己去点重试。
 */
export function pollProblemText(problem: PollProblem): string {
  return `暂时连不上（${problem.message}），${Math.round(problem.retryInMs / 1000)} 秒后自动重试。`
}

type Options<T> = {
  /** 拉一次状态。 */
  load: () => Promise<T>
  /** 还有没有动静。返回 false 就停下来（空转时每 5 秒打一次接口没有意义）。 */
  isBusy: (data: T) => boolean
  /** `ApiError` 之外（断网时 `fetch` 抛的是 `TypeError`）的兜底文案。 */
  fallbackMessage: string
  /**
   * 变一次就**从头**再拉一次（回到 5 秒的节奏，失败计数清零）。
   *
   * 收字符串不收数字数组：两个面板都有两个来源要合起来（"换模型"与"刚点了按钮"），
   * 而拼成一个字符串既能当依赖用、又不会像「两个数相加」那样让 (1,0) 和 (0,1) 撞在一起。
   */
  restartKey: string
}

export function usePolledStatus<T>({
  load,
  isBusy,
  fallbackMessage,
  restartKey,
}: Options<T>): {
  status: T | null
  problem: PollProblem | null
} {
  const [status, setStatus] = useState<T | null>(null)
  const [problem, setProblem] = useState<PollProblem | null>(null)

  /**
   * 两个回调进 ref，**不进依赖**。
   *
   * `load` 常常是内联箭头函数（`() => fetchTagStatus('all')`），`isBusy` 更是每次渲染都是
   * 新的——放进依赖数组的话，任何一次状态更新都会把 effect 拆了重建，那就等于每次轮询
   * 回来都把定时器重置一遍：**轮询要么变成连发，要么永远等不到下一次**（两者都见过）。
   */
  const loadRef = useRef(load)
  const busyRef = useRef(isBusy)
  useEffect(() => {
    loadRef.current = load
    busyRef.current = isBusy
  })

  useEffect(() => {
    // 清理函数必须写，否则切走路由后这个轮询还在跑（code-style.md）
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    /** 连续失败了几次。成功一次就清零（退避只针对「一直在失败」这一种情况）。 */
    let failures = 0

    async function poll() {
      try {
        const next = await loadRef.current()
        if (!alive) return
        failures = 0
        setStatus(next)
        setProblem(null)
        if (busyRef.current(next)) timer = setTimeout(poll, POLL_MS)
      } catch (err) {
        if (!alive) return
        const retryInMs = backoffMs(failures)
        failures += 1
        setProblem({
          message: err instanceof ApiError ? err.message : fallbackMessage,
          requestId: err instanceof ApiError ? err.requestId : undefined,
          retryInMs,
        })
        // 这一行是本次修复的核心：失败也要安排下一次
        timer = setTimeout(poll, retryInMs)
      }
    }

    void poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [restartKey, fallbackMessage])

  return { status, problem }
}
