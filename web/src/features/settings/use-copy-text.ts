import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 「把这段文字写进剪贴板，然后说一句」。设置页里两个调用点——原始输出（rawResponse /
 * rawError）与邀请码那一列——本来就是同一件事。
 *
 * ## 为什么合成一个 hook（2026-09-24）
 *
 * 两处原先各写了一遍，**而且两处都没有 `catch`**：`writeText` 被拒时（非安全上下文下
 * `navigator.clipboard` 整个不存在、用户拒绝了剪贴板权限、Safari 里文档没聚焦）
 * 那个 Promise 直接变成一条 unhandled rejection，界面上**什么都不发生**。
 * 剪贴板是不可见的，没有反馈的复制等于没复制（clipboard-share.md §4.1）——
 * 那一条对「复制文字」和对「复制图片」是同一个要求。
 *
 * 合成一处之后这类漏写只可能犯一次。**要加第三个复制的按钮就往这里加**，
 * 别在组件里再写一遍 `writeText`。
 */

/**
 * 复制失败的文案。**一处定义**：两个调用点说的是同一件事，各写一份就会各说各的。
 *
 * 不写「复制失败」四个字了事——用户要的是那段文字，所以还得告诉他下一步怎么办。
 */
export const COPY_FAILED_TEXT = '复制失败，请手动选中后复制'

export type CopyState = 'idle' | 'copied' | 'failed'

/** 「已复制」收回的时间。确认一下就够了，久了反而像一直在说。 */
const COPIED_MS = 1500

/**
 * 失败的提示留得久一些（4 秒）：它不是确认，是一句**要读的话**——用户正在疑惑
 * 「我点了没反应」，1.5 秒之内让他读完「复制失败，请手动选中后复制」并想明白下一步，
 * 做不到。下一次复制会立刻把它换掉。
 */
const FAILED_MS = 4000

export function useCopyText(): {
  /**
   * 最近一次复制的**目标文本**。一行一个按钮时靠它认出「是哪一行在说话」
   * （邀请码那张表：`copied` 只能出现在刚点的那一行上）。
   */
  target: string | null
  state: CopyState
  /** 写剪贴板并给出反馈。**不返回值**：调用方要的是那一句提示，不是成功与否。 */
  copy: (text: string) => void
} {
  const [feedback, setFeedback] = useState<{ target: string; state: CopyState } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 组件卸载时收掉那个定时器：不收的话它会对着一个已经卸载的组件 setState
  // （React 18 不再报那条警告，但那是「不再警告」，不是「不再发生」）。
  useEffect(
    () => () => {
      clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback((text: string) => {
    const settle = (state: CopyState) => {
      clearTimeout(timer.current)
      setFeedback({ target: text, state })
      timer.current = setTimeout(
        () => {
          timer.current = undefined
          // 只收回**自己那一条**：这中间用户可能又复制了别的，那条的倒计时还没到
          setFeedback((prev) => (prev !== null && prev.target === text ? null : prev))
        },
        state === 'failed' ? FAILED_MS : COPIED_MS,
      )
    }

    // 这个 async 函数体**同步**跑到 `writeText` 那一行才交出去，所以调用仍然落在
    // 用户手势的同步调用栈里——Safari 对剪贴板写入要求的那一条（clipboard-share.md §4.1）。
    // 不写成 `.then()` 链是因为**拿不到 `navigator.clipboard` 时它是同步抛的**：
    // 非安全上下文中这个属性根本不存在，`.catch` 接不住那个 TypeError。
    void (async () => {
      try {
        await navigator.clipboard.writeText(text)
        settle('copied')
      } catch {
        settle('failed')
      }
    })()
  }, [])

  return {
    target: feedback?.target ?? null,
    state: feedback?.state ?? 'idle',
    copy,
  }
}
