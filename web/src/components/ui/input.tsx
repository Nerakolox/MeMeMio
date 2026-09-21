import * as React from "react"
import { cn } from "cn"

// 与注册表版本的唯一差异：下面包了一层 forwardRef（同 `button.tsx` / `badge.tsx`）。
// radix-luma 的组件是按 React 19 写的——19 里 ref 是普通 prop，展开即可透传；
// 本端仍跑 React 18，ref 不进 props，只有 forwardRef 组件收得到。
// 不包的话，首页搜索框那句 `inputRef.current?.focus()` 里是 null：
// **自动聚焦静默不生效**（dev 只报一行 "Function components cannot be given refs"，
// 生产构建里连那行都没有）。
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  function Input({ className, type, ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(
          "h-9 w-full min-w-0 rounded-3xl border border-transparent bg-input/50 px-3 py-1 text-base transition-[color,box-shadow,background-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
          className
        )}
        {...props}
      />
    )
  }
)

export { Input }
