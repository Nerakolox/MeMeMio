import * as React from "react"
import { cn } from "cn"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

/*
 * 本地改动（2026-09-22）：多一个 `viewportRef`。
 *
 * 滚动**发生在 Viewport 上**（Root 只是 `relative` 的壳），而注册表的 `Root` 把
 * `...props` 全收下、Viewport 拿不到任何 ref——浏览页的瀑布流需要拿到那个元素量
 * `scrollTop` / `clientHeight` 才能算出该渲染哪些格子（masonic 的虚拟化按窗口滚动算，
 * 容器不是窗口时得自己喂，见 features/browse/BrowseResults.tsx）。
 * 不改注册表的其余部分。
 *
 * ⚠️ Viewport 内部还套了一层 Radix 自己生成的行内样式 div：
 * `style="min-width:100%; display:table"`。`display: table` 会让**块级布局的孩子**按
 * 收缩宽度算（`width:100%` 的表内子元素是循环依赖，靠 `min-width:100%` 兜底），
 * 往里面放网格 / 瀑布流这类布局容器时，得在调用处写 `[&>div]:block!` 把那层压回块级
 * （见 routes/browse.tsx）。**不在这里全局改**：横向滚动的内容正需要那层 table 撑宽。
 */
function ScrollArea({
  className,
  children,
  viewportRef,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
