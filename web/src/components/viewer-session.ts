import { createContext } from 'react'
import type { Meme } from '../lib/api'

/**
 * 一次阅览会话的形状 + 它的 context。**单独一个模块，为的是打断一个环。**
 *
 * 状态在 `ImageViewer.tsx` 的宿主里（它才知道「这一屏是哪批图」），而消费它的
 * `ViewerControls` 住在 `LightboxViewer.tsx`（它是在 YARL 的 `render.controls` 里跑的，
 * 那个回调没有参数，只能走 context 拿数据）。两边各写一份 context 会得到两个互不相干的
 * Provider；由 `LightboxViewer.tsx` 导出、`ImageViewer.tsx` 静态 import 又会把 YARL
 * 拽回首屏包里。放这里两边都静态 import，谁也不用 import 谁。
 */

/** 一次阅览会话：这一批图 + 现在停在第几张。**同时只可能有一份**，所以状态只有一个。 */
export type ViewerSession = {
  items: readonly Meme[]
  index: number
}

export type SessionControls = {
  session: ViewerSession | null
  /** 跳到第 n 张。缩略图轨道用。 */
  show: (index: number) => void
}

export const SessionContext = createContext<SessionControls | null>(null)
