/**
 * 浏览页图墙的**密度档位**：一组列宽，`Ctrl + 滚轮` / 触控板捏合在档位之间跳
 * （任务 2026-09-26-浏览页捏合缩放）。
 *
 * ## 为什么是分档、不是连续缩放
 *
 * 表情包是「认图」：扫一大片时要密，确认是不是这张时要大——两种状态，不是一条连续谱。
 * 连续缩放每一帧都要重排整墙（masonic 换 `columnWidth` 就重建位置器），分档一次手势
 * 只重排一两次。iOS 相册也是这么跳的。
 *
 * ## 为什么落 `localStorage`、不进 URL
 *
 * 档位是**本机显示偏好**：不影响结果集，别人点开你分享的 `/browse?q=` 不该被改成你的密度
 * （state-navigation.md §3 第四类）。丢了不心疼，所以读写都吞掉异常（隐私模式会抛）。
 *
 * ## 窄屏恒为默认档
 *
 * 手机上不接管捏合（那是浏览器原生缩放），而窄屏那一档要求「与改前逐字一致」——
 * 所以桌面上存下的档位**不带到窄屏**：窗口拖窄到 md 以下，列宽回到 160，拖回来再恢复。
 */

import * as React from 'react'

/**
 * 列宽档位（px），从密到疏。默认档 160 是改前写死的那个值。
 *
 * 两头的取值理由（1264 / 1920 / 2560 三个宽度上看过，数字见任务文件 §5）：
 * - **100**：再小角标（「GIF」「待打标」）就要压住半张图了，而一屏已经是 2560 下二十列上下；
 * - **300**：缩略图长边 400px（api `THUMB_LONG_EDGE`），再往上在 1x 屏也开始发虚，
 *   而 1264 宽下已经只剩两列——「看清是不是这张」够了。
 */
export const DENSITY_STEPS = [100, 130, 160, 220, 300] as const
const DEFAULT_WIDTH = 160
const STORAGE_KEY = 'mememio.browse.columnWidth'

/** 与 Tailwind 的 `md`（48rem）同一条线：`browse.tsx` 在这条线上切换「列内滚 / 整页滚」。 */
const DESKTOP_QUERY = '(min-width: 48rem)'

function readStored(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const n = raw === null ? NaN : Number(raw)
    // 不在档位表里就当没存过：旧版本的档位、手改的值都退回默认
    return (DENSITY_STEPS as readonly number[]).includes(n) ? n : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

function writeStored(width: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width))
  } catch {
    /* 隐私模式 / 配额满：这一档只在本次会话里生效，不打扰用户 */
  }
}

function subscribeDesktop(onChange: () => void) {
  const mql = window.matchMedia(DESKTOP_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

/**
 * 用 `useSyncExternalStore` 而不是 `lib/use-mobile`：后者首帧恒为 false，
 * 在手机上会先按桌面档位排一次、下一帧再换回 160——换列宽等于重建位置器，那一下就是整墙重排。
 */
function useIsDesktop(): boolean {
  return React.useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
  )
}

export type WallDensity = {
  /** 当前生效的列宽（窄屏恒为默认档）。骨架网格与瀑布流都读它。 */
  columnWidth: number
  /**
   * 往疏（`+1`，图变大）或往密（`-1`）跳一档，返回**是否真的换了**——到头时返回 false，
   * 调用方据此决定要不要做锚点校正。窄屏上为 `undefined`：不接管捏合。
   */
  step: ((dir: 1 | -1) => boolean) | undefined
}

export function useWallDensity(): WallDensity {
  const desktop = useIsDesktop()
  const [stored, setStored] = React.useState(readStored)

  // 滚轮事件是原生监听，闭包里读 state 会读到旧值；两次换档之间有冷却，但仍以 ref 为准
  const storedRef = React.useRef(stored)
  storedRef.current = stored

  const step = React.useCallback((dir: 1 | -1) => {
    const steps = DENSITY_STEPS as readonly number[]
    const next = steps[steps.indexOf(storedRef.current) + dir]
    if (next === undefined) return false
    storedRef.current = next
    setStored(next)
    writeStored(next)
    return true
  }, [])

  return { columnWidth: desktop ? stored : DEFAULT_WIDTH, step: desktop ? step : undefined }
}
