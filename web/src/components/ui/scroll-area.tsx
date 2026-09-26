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
 *
 * 本地改动二（2026-09-26）：多一个 `orientation`。
 *
 * 注册表这一份**只挂一根竖条**（`<ScrollBar />` 那个默认值），横向滚动的内容拿不到
 * 滚动条。首页两条 rail 是横向的，而它们要的是「滚动条与浏览页那两根是同一种东西」
 * ——原生条在桌面上一律 15px、在 macOS 上还会随系统偏好整条消失，两种放在同一屏上
 * 一眼就不像一套。于是把方向提成 prop 传下去（见 features/home/MemeRail.tsx）。
 *
 * ⚠️ **别图省事改成「两根都渲染」。** Radix 是按「挂着哪几根条」决定 viewport 的
 * `overflow` 的：Scrollbar 一挂上就调 `onScrollbarX/YEnabledChange(true)`，viewport 的
 * `overflow-x/y` 跟着从 `hidden` 变成 `scroll`。多挂一根用不上的条，那一轴就**白白
 * 变成一个滚动容器**——它的滑块在没有溢出时不画，所以看不出任何异常。
 *
 * ⚠️ `orientation` 是 **Scrollbar** 的 prop，Radix 的 **Root 没有**它，所以必须在形参上
 * 解掉、不能落进 `...props`（透下去会变成 Root 上一个没人认识的自定义 prop）。
 */
function ScrollArea({
  className,
  children,
  viewportRef,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>
  /** 滚动条那一条的方向。默认竖着——横滑的内容要显式传 `horizontal`，理由见上。 */
  orientation?: 'vertical' | 'horizontal'
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
      <ScrollBar orientation={orientation} />
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
