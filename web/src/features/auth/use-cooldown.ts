import { useEffect, useState } from 'react'

/**
 * `RATE_LIMITED` 的退避倒计时（[SPEC §2.2](../../../../spec/02-errors.md)「按 `Retry-After` 退避」）。
 *
 * 传 `ApiError.retryAfterSeconds`，返回剩余秒数：`0` 表示可以再试。`null`（响应头缺失或
 * 格式不认识）也返回 `0`——**没有倒计时就只显示 message、按钮照常可点**，而不是瞎猜一个
 * 秒数把按钮锁上：锁多久都是编的，用户会以为界面卡死了。
 *
 * ⚠️ **这是本地倒计时，不是可信时钟。** 它只决定按钮什么时候恢复可点，真正的闸门在
 * 服务端（它才是唯一知道窗口还剩多久的一方）。所以不跟服务器对时、也不处理系统休眠
 * ——机器睡过去时定时器会被节流，醒来最多让用户早试一次，服务端仍然会拒。
 */
export function useCooldown(seconds: number | null): number {
  const [left, setLeft] = useState(seconds ?? 0)

  useEffect(() => {
    if (seconds === null || seconds <= 0) {
      setLeft(0)
      return
    }

    // 用「目标时刻」而不是每次减一：定时器被节流（后台标签页、休眠）时，
    // 递减法会把倒计时拖长，而它显示的秒数就不再是服务端那个窗口了。
    const until = Date.now() + seconds * 1000
    setLeft(seconds)

    const timer = window.setInterval(() => {
      const remain = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      setLeft(remain)
      if (remain === 0) window.clearInterval(timer)
    }, 1000)

    return () => window.clearInterval(timer)
    // `seconds` 变了就重新数：两次限流之间用户可能已经在别处等过了
  }, [seconds])

  return left
}
