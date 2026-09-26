/**
 * `usePositioner` 的替身：**列宽变了，已量出的高度按比例换算**，而不是原样搬过去。
 *
 * masonic 自己的 `usePositioner` 在选项变化时把旧位置器里的高度**原样**抄进新位置器
 * （它不知道格子高度与列宽的关系）。浏览页的格子是 `shape="natural"`——高度 = 列宽 ÷ 宽高比，
 * 所以换档后整墙先按旧高度排一遍，再等 ResizeObserver 一格一格改正：
 *   · 可视区里的格子会**跳两次**（先错位，下一帧再归位）；
 *   · 可视区外的格子要滚到才改正，于是指针下那张图的新 `top` 是错的——锚点钉不住。
 * 这里换算之后，重建出来的位置就是最终位置（至多差 1px 的取整，交给 ResizeObserver）。
 *
 * 顺带一件事：**算出来的列数和列宽都没变时不重建**——masonic 那版只要容器宽度变了
 * 1px 就整个重建。
 *
 * 列数 / 列宽的算法照抄 masonic 的 `getColumns`（它没导出），保持与改前逐像素一致。
 */

import { createPositioner, type Positioner } from 'masonic'
import * as React from 'react'

function getColumns(width: number, minWidth: number, gutter: number): [number, number] {
  const count = Math.floor((width + gutter) / (minWidth + gutter)) || 1
  return [Math.floor((width - gutter * (count - 1)) / count), count]
}

export function useScaledPositioner({
  width,
  columnWidth,
  columnGutter,
}: {
  width: number
  columnWidth: number
  columnGutter: number
}): Positioner {
  const [colWidth, colCount] = getColumns(width, columnWidth, columnGutter)
  const ref = React.useRef<Positioner | null>(null)

  const prev = ref.current
  if (prev !== null && prev.columnWidth === colWidth && prev.columnCount === colCount) return prev

  const next = createPositioner(colCount, colWidth, columnGutter, columnGutter)
  if (prev !== null) {
    // 首帧那个位置器是按 0 宽建的（量出来的高度也都是 0），没有比例可言，原样搬
    const scale = prev.columnWidth > 0 ? colWidth / prev.columnWidth : 1
    // 必须按下标顺序 set：瀑布流按插入顺序决定每一格落进哪一列
    for (let i = 0, n = prev.size(); i < n; i++) {
      const pos = prev.get(i)
      next.set(i, pos === undefined ? 0 : Math.round(pos.height * scale))
    }
  }
  ref.current = next
  return next
}
