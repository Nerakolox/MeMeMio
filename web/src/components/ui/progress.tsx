import * as React from "react"
import { cn } from "cn"
import { Progress as ProgressPrimitive } from "radix-ui"

/**
 * 与注册表版本的**唯一差异**：`value` 也交给 `Root`。
 *
 * 注册表版本把它解构掉、只留给内层 Indicator 算 `transform`，于是 `Root` 收到的是
 * 未定义——Radix 据此判定「不确定进度」，`aria-valuenow` **整个不出现在 DOM 里**
 * （实测：进度条画到 73% 时 `aria-valuenow` 读回来是 `null`）。视觉是对的，
 * 屏幕阅读器读到的却是一条没有值的进度条，等于没读。
 *
 * 2026-09-22 由重打标面板的验收量出来。它不是那一次引入的——`ReindexPanel` 的
 * 进度条一直是这样。
 */
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn(
        "relative flex h-3 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
