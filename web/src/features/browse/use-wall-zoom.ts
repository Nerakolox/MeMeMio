/**
 * 图墙的 `Ctrl + 滚轮` / 触控板捏合：按累计量换档，换档后把指针下那张图**钉回指针附近**
 * （任务 2026-09-26-浏览页捏合缩放 §3 第 3 条——没有锚点就只是个换列宽的快捷键）。
 *
 * ## 为什么是原生监听
 *
 * React 的 `onWheel` 是 passive 的，`preventDefault()` 拦不住浏览器缩放。所以这里
 * `addEventListener('wheel', …, { passive: false })`，而且**只挂在结果列的滚动容器上**：
 * 指针在筛选列、搜索带、顶栏上时 `Ctrl + 滚轮` 仍是浏览器缩放，不接管整页。
 * 全屏阅览是 portal 到 body 的，原生事件沿 DOM 冒泡，进不到这里——它的 Zoom 插件不串。
 *
 * ## 累计阈值 + 冷却
 *
 * 鼠标滚轮一格 `deltaY` ≈ 100，触控板捏合是一串个位数。按累计量过阈值才换一档，换完清零并冷却，
 * 否则触控板一捏就跳到底。停手超过 `GESTURE_GAP_MS` 也清零——上一次没捏够的余量不留给下一次。
 *
 * ## 锚点
 *
 * 换档前从**位置器**（不是 DOM）里找指针下那一格：记下它的下标、指针落在它高度的几分之几、
 * 指针离滚动区顶的距离。换档那次渲染里位置器已经按新列宽重建（`BrowseWall` 的
 * `useScaledPositioner`，高度是按比例换算过的，不等量测），于是这一格的新位置**在渲染时就知道**：
 *
 * 1. 渲染时算出校正后的滚动量（`scrollTop` 覆盖值）交给 masonic 选格子。不这么做的话，
 *    那次渲染拿**旧**滚动量去套**新**位置，选出来的是另一段墙——指针下那张卡被摘掉、
 *    layout effect 校正之后再挂回来，`<img>` 重建一遍（实测：8 次换档里 4 次重挂）；
 * 2. layout effect 里把真的 `scrollTop` 设过去，再同步 `read()` 一次，状态与覆盖值对齐。
 *    两步都在绘制之前，所以屏幕上看不到中间态。
 *
 * 只能钉**纵向**：瀑布流把每一格塞进当时最短的那一列，横向落在哪一列由它决定，没有横向滚动可调。
 */

import type { Positioner } from 'masonic'
import * as React from 'react'

/** 过这个累计量换一档。鼠标一格（100）直接过，触控板要捏出一小段才过。 */
const STEP_THRESHOLD = 50
/** 换档后多久内不再换：触控板一次捏合的惯性尾巴会落在这段里。 */
const COOLDOWN_MS = 220
/** 两次 wheel 之间隔多久算「新的一次手势」，累计量清零。 */
const GESTURE_GAP_MS = 200

/** Firefox 的鼠标滚轮报的是「行」，换成像素才能和 Chromium 的数量级比。 */
function deltaPx(e: WheelEvent): number {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * 40
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * 800
  return e.deltaY
}

type Anchor = {
  /** 记下锚点那一刻的档位：档位变了才说明换档那次渲染到了。 */
  columnWidth: number
  index: number
  /** 指针落在那一格高度的几分之几（0 = 顶，1 = 底；落在格子上下的空隙里会略出界）。 */
  ratio: number
  /** 指针离滚动区可视顶的距离。 */
  viewY: number
}

/** 指针下那一格；落在列间空隙或格子之间时取最近的一格。墙外（下方空白）返回 null。 */
function findAnchor(
  positioner: Positioner,
  x: number,
  y: number,
): Pick<Anchor, 'index' | 'ratio'> | null {
  const { columnWidth } = positioner
  const best = { index: -1, top: 0, height: 0, d: Infinity }
  // 上下各放一格的量：指针恰好落在两格之间的空隙时，range(y, y) 里可能一格都没有
  positioner.range(y - columnWidth, y + columnWidth, (index, left, top) => {
    const pos = positioner.get(index)
    if (pos === undefined) return
    const dx = x < left ? left - x : x > left + columnWidth ? x - left - columnWidth : 0
    const dy = y < top ? top - y : y > top + pos.height ? y - top - pos.height : 0
    const d = dx * dx + dy * dy
    if (d < best.d) Object.assign(best, { index, top, height: pos.height, d })
  })
  if (best.index < 0) return null
  return { index: best.index, ratio: best.height > 0 ? (y - best.top) / best.height : 0 }
}

export function useWallZoom({
  scrollEl,
  wallRef,
  positioner,
  columnWidth,
  step,
  read,
}: {
  scrollEl: HTMLElement | null
  wallRef: React.RefObject<HTMLElement | null>
  positioner: Positioner
  /** 当前档位。它变了才说明换档那次渲染到了，见下面那个 layout effect。 */
  columnWidth: number
  /** 见 `use-wall-density`。`undefined`（窄屏）时不挂监听，捏合留给浏览器。 */
  step: ((dir: 1 | -1) => boolean) | undefined
  /** `useScrollMetrics` 的 `read`：改完 `scrollTop` 要同步量一次。 */
  read: () => void
}) {
  const positionerRef = React.useRef(positioner)
  positionerRef.current = positioner
  const columnWidthRef = React.useRef(columnWidth)
  columnWidthRef.current = columnWidth
  const pending = React.useRef<Anchor | null>(null)

  // 换档那次渲染：锚点那一格在新位置器里的位置 → 墙内滚动量（masonic 的 `scrollTop` 语义）
  const anchor = pending.current
  const anchorPos =
    anchor !== null && anchor.columnWidth !== columnWidth ? positioner.get(anchor.index) : undefined
  const target =
    anchor === null || anchorPos === undefined
      ? null
      : anchorPos.top + anchor.ratio * anchorPos.height - anchor.viewY

  React.useEffect(() => {
    if (scrollEl === null || step === undefined) return
    let acc = 0
    let last = 0
    let cooldownUntil = 0

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return // 普通滚轮一律放行
      // 到头了也照样拦：指针在图墙里时 Ctrl + 滚轮的意思是「换密度」，不是「换成缩放整页」
      e.preventDefault()

      const now = e.timeStamp
      if (now - last > GESTURE_GAP_MS) acc = 0
      last = now
      if (now < cooldownUntil) {
        acc = 0
        return
      }
      acc += deltaPx(e)
      if (Math.abs(acc) < STEP_THRESHOLD) return

      // 往上滚 / 两指张开是 deltaY < 0 → 图变大（列变宽）
      const dir = acc < 0 ? 1 : -1
      acc = 0
      cooldownUntil = now + COOLDOWN_MS

      const wall = wallRef.current
      const wallRect = wall?.getBoundingClientRect()
      const hit =
        wallRect === undefined
          ? null
          : findAnchor(positionerRef.current, e.clientX - wallRect.left, e.clientY - wallRect.top)
      const from = columnWidthRef.current
      // 先写锚点再换档：换档触发的那次渲染要读到它
      pending.current =
        hit === null
          ? null
          : { ...hit, columnWidth: from, viewY: e.clientY - scrollEl.getBoundingClientRect().top }
      if (!step(dir)) pending.current = null // 到头：不换档，也就不需要校正
    }

    scrollEl.addEventListener('wheel', onWheel, { passive: false })
    return () => scrollEl.removeEventListener('wheel', onWheel)
  }, [scrollEl, wallRef, step])

  /*
    换档那次提交之后跑：把真的 `scrollTop` 设到 `target`（加上墙在滚动内容里的偏移）。

    判「换档那次渲染到了」看的是**档位**，不是位置器：容器窄的时候相邻两档可能分出同样的
    列数和列宽，位置器不重建——按位置器判的话这次锚点会一直挂着，留到下一次拖分隔条时
    才执行，凭空跳一下。按档位判，那种情况下校正等于原地不动。
  */
  React.useLayoutEffect(() => {
    const wall = wallRef.current
    if (target === null || scrollEl === null || wall === null) return
    pending.current = null
    // 墙顶在滚动内容里的 y（墙上方还有检索提示条这些）
    const wallInContent =
      wall.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
    scrollEl.scrollTop = wallInContent + target
    read()
  }, [target, scrollEl, wallRef, read])

  /** 非 null 时，这一次渲染 masonic 要用它代替 `useScrollMetrics` 量到的滚动量。 */
  return target === null ? null : Math.max(0, target)
}
