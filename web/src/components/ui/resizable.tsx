"use client"

/*
 * 注册表（radix-luma）**原样**，一个字没改。两处“看起来像 bug”的地方记在下面，
 * 免得下一个人（包括我自己）又去“修”它。
 *
 * 一、分隔条的方向选择子看着像反的。`aria-orientation` 描述的是**分隔条自己**横还是竖，
 * 不是组的方向——横向分栏（`orientation="horizontal"`）实测拿到的是
 * `aria-orientation="vertical"`，正好落进基础样式那一支（`w-px` 竖线），
 * `aria-[orientation=horizontal]` 那一支留给竖向分栏。**这是量出来的**：
 * 第一版按“库把组的方向写进去”去改，分隔条当场变成 1281×1 的横线，两个面板被挤成 0 宽。
 *
 * 二、这个文件用了 react-resizable-panels **v4** 的 API（`Group` / `Panel` / `Separator`
 * 与 `GroupProps` / `PanelProps` / `SeparatorProps`）——v3 叫 `PanelGroup` /
 * `PanelResizeHandle`，装成 v3 会整片类型报错。
 *
 * 尺寸的写法（v4）：**数字按像素、不带单位的字符串按百分比**。
 * `defaultSize={220}` 是 220px，`defaultSize="22"` 是 22%。
 *
 * ⚠️ `Group` 会给自己写行内样式 `height:100%; width:100%; display:flex; flex-flow:row`，
 * 库的文档写明「除 `overflow` 外不可覆盖」——行内样式压不过 `!important`，
 * 要在断点上换高度/显示方式，调用处得写 `md:h-[…]!` 这种带 `!` 的类
 * （浏览页就是这么干的，见 routes/browse.tsx）。
 */

import { cn } from "cn"
import * as ResizablePrimitive from "react-resizable-panels"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
