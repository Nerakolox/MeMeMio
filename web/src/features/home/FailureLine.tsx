import { Button } from '../../components/ui/button'
import type { ApiError } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'

/**
 * 首页那两条 rail 与状态条**共用的失败态**：一行字 + 「重试」+ `requestId`。
 *
 * ## 为什么不是图墙那种 `Alert`
 *
 * 图墙自己那一块是这一屏的主体，失败时它整块是空的，所以给一个带标题的
 * `Alert destructive`——那是**这一屏的主要出口**。rail 和状态条各是页面的一小节，
 * 三条 rail 各弹一个红框会把首页变成一张错误清单；而它们要说的只有两件事：
 * 「这一条没取到」和「点这里再试一次」。
 *
 * ## `requestId` 必须露出来
 *
 * 它是用户报问题时唯一能对上服务端日志的东西（[http.md §3](../agents/rules/http.md)），
 * 所以哪怕这一行是紧凑版也带着它。措辞与层级压低（`text-xs` + `font-mono`）只是
 * 让它不抢「重试」那枚按钮的注意力，不是「可以省」。
 */
export function FailureLine({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
      <span>{error.message}</span>
      <Button variant="link" size="sm" className={cn(TOUCH, 'px-0')} onClick={onRetry}>
        重试
      </Button>
      <span className="font-mono text-xs">requestId: {error.requestId}</span>
    </p>
  )
}
