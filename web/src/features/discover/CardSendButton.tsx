import { OVERLAY_BTN } from '../../components/MemeCard'
import type { Meme } from '../../lib/api'
import {
  SEND_ICONS,
  SEND_LABELS,
  detectSendPath,
  sendMeme,
  sendNote,
  type SendTarget,
} from '../../lib/clipboard'
import { notifySend } from '../../lib/toast'
import { usePrefetchShare } from '../../lib/use-prefetch-share'
import { cn } from '../../lib/utils'

/**
 * 首页图墙卡片右上角那枚**直接发送**键（2026-09-26，首页改版任务 §5.1）。
 *
 * ## 为什么是光秃秃一枚按钮，而不是「⋯」菜单里的一项
 *
 * 这是对裁定 4（「一个动作只出现一处」、发送统一走「⋯」菜单）的**明写偏离**，理由在
 * 任务文件里：那条裁定的语境是**合并后的列表**，那里卡片同时需要编辑、删除、发送，
 * 所以菜单是对的；图墙**没有编辑也没有删除**（它是「随便看看」，不是管理面），
 * 为了一枚按钮挂一个只有一项的菜单是净负担，而发送是这个产品的核心动作、要一击可达。
 *
 * 全屏阅览器里那枚发送按钮同理保留（「点开之后想发」的出口）。
 *
 * ## 分流、文案、图标**全部**复用 `lib/clipboard.ts`
 *
 * 这里一行判断都没有：`detectSendPath` 说走哪条路、`SEND_LABELS` 给名字、
 * `SEND_ICONS` 给图标，三者都在渲染时定下来——动图在这一格上就是「下载」，
 * 与「⋯」菜单、阅览器那枚逐字一致。**同一个动作两套行为是本端最不能犯的错**
 * （clipboard-share.md §5）。
 *
 * ## 位置、尺寸与「⋯」逐字相同
 *
 * 走卡片右上角那个浮层位（`MemeCard` 的 `actions` 槽 + `OVERLAY_BTN`），
 * 鼠标 32 / 手指 44，闸门与「⋯」、收藏那条同为 `pointer-coarse`（`lib/touch.ts`）。
 * **不是** 09-26 撤掉的那种图片下方全宽按钮。
 *
 * ## 图标按钮必须有可读名
 *
 * 只剩一个图标时，`aria-label` 是读屏唯一的入口说明；`title` 让鼠标用户也能看见
 * 「点这一下会发生什么」——**这两个都要**，它们服务的不是同一批人。
 * 文案本身来自 `SEND_LABELS`（动图那一档是「下载」而不是「复制」）。
 */
export function CardSendButton({ meme }: { meme: Meme }) {
  const path = detectSendPath(meme.isAnimated)
  const Icon = SEND_ICONS[path]
  const label = SEND_LABELS[path]

  // 触屏那一档要在渲染时就把原图取好：分享必须落在用户手势的同步调用栈里，
  // 大 GIF 取完再调 `navigator.share` 时激活已经过期（`lib/clipboard.ts` 的 SharePrefetch）。
  // 一屏 10 张，正好在 `SHARE_PREFETCH_MAX`（12）以内，且图墙不虚拟化、不会重挂。
  // 浏览页「⋯」**不是**这么取的（菜单打开时才取，见 `MemeActions`）：这里是一击直发，
  // 没有「打开菜单」那段时间可借。
  usePrefetchShare(meme)

  return (
    <button
      type="button"
      // 与「⋯」菜单、阅览器那枚走的是同一个 `sendImage` 组成（`sendMeme` → `sendNote`
      // → `notifySend`），点下去同步进 `sendMeme`，剪贴板与系统分享的用户激活要求才成立
      onClick={() => void sendImage(meme)}
      aria-label={label}
      title={label}
      className={cn(OVERLAY_BTN, 'size-8 pointer-coarse:size-11')}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  )
}

/**
 * 把一张图发出去。**与浏览页、全屏阅览器是同一条组成**——为什么这三层分家、
 * 为什么三处各接一遍不是漏抽，写在 `lib/clipboard.ts` 的 `sendNote` 上。
 */
async function sendImage(target: SendTarget) {
  const note = sendNote(await sendMeme(target))
  if (note !== null) notifySend(note)
}
