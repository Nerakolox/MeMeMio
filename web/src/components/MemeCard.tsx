import type { ReactNode } from 'react'
import { Heart } from 'lucide-react'
import type { Meme } from '../lib/api'
import { tagStatusLabel } from '../lib/tag-status'
import { cn } from '../lib/utils'
import { IMAGE_RADIUS, MemeImage, type ImageShape } from './MemeImage'

/**
 * 压在图上的浮动控件底座（「⋯」和收藏按钮共用）。
 *
 * 它可能落在图上任意位置，**底下是什么颜色的图不知道**，所以只有自带对比度的深色玻璃底
 * 才在两极都读得出来——浅色按钮压在白底表情包上会消失。
 *
 * ⚠️ 这里**不含尺寸**：两个使用者的桌面尺寸不一样（「⋯」跟收藏都是 32px，但「⋯」是由
 * `Button` 的 `size` 变体给的，收藏是手写的 `size-8`），尺寸留在各自的调用点，
 * 免得 twMerge 把它们搅在一起。
 */
export const OVERLAY_BTN =
  // 过渡属性写成一个 `transition-[…]` 而不是 `transition-colors`：
  // 用户（浮层按钮）还要叠一层 opacity，而 tailwind-merge 把 `transition-colors` 和
  // `transition-opacity` 看作同一组——两个类一起给只会留下后一个，另一个静默失效。
  // 一个类覆盖三种属性就没有这个二选一。
  'flex items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-[color,background-color,opacity] hover:bg-black/85 hover:text-white aria-expanded:bg-black/85 aria-expanded:text-white dark:hover:bg-black/85 dark:hover:text-white'

/**
 * 「操作器」的显形方式：**能 hover 的设备上默认藏起来，鼠标进来才显形**（GPT 那种）。
 *
 * ⚠️ **基线是「看得见」，藏起来是叠加在 `(pointer: fine)` 上的那一层。** 反过来写
 * （基线 `opacity-0`、hover 时 `opacity-100`）在触摸设备上就是**入口直接消失**：
 * `hover` 变体内建包着 `@media (hover: hover)`，手机上永远不成立。
 * 手机是这个产品的主场（styling.md），不能为了一种视觉效果把「⋯」和收藏弄没。
 *
 * 用 `(pointer: fine)` 而不是 `MemeImage` 那句话用的 `(hover: hover)`：判据不同是因为
 * 后果不同。播放动图判错了最多是「得点一下」，而这里判错了是「入口不见了」，
 * 所以要问的是「有没有一个精确指针会稳定地产生 hover」，粗指针一律按看得见处理。
 *
 * `group-focus-within` 是键盘那条路：Tab 到「⋯」时它必须显形，否则焦点落在看不见的按钮上。
 */
const REVEAL_ON_HOVER =
  'transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover/card:opacity-100 pointer-fine:group-focus-within/card:opacity-100'

/** 角标的底。深色玻璃底的理由同 `OVERLAY_BTN`。 */
const BADGE =
  'rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium leading-none text-white backdrop-blur-sm'

/**
 * 一张表情包卡片。**四个页面共用**：浏览页瀑布流、首页随机图墙、搜索结果、打标列表
 * （`project-structure.md` 的复用标准：被两个以上 feature 用到，所以放 `components/`）。
 *
 * ## 这一层只有「卡片」，图片本身在 `MemeImage`
 *
 * 角标与收藏按钮是**图片框的兄弟节点、不是它的子节点**——图片框有 `overflow-hidden`
 * （圆角要靠它裁），按钮进去就会被切掉一圈。
 *
 * ## 角标为什么是深色玻璃底而不是主题色
 *
 * 角标压在图上，底图可能是白的也可能是黑的。只有自带对比度的深色底在两极都读得出来。
 * `pending` / `needs_manual` **不用错误色**：它们是正常的中间态不是故障
 * （styling.md「状态的视觉表达」）。
 *
 * ## 两枚浮层操作器在能 hover 的设备上默认藏起来
 *
 * 「⋯」和收藏由 `REVEAL_ON_HOVER` 管，**规则与理由写在那份常量注释上，改之前先读**。
 * 一句话版：基线是「看得见」，藏起来是叠在 `(pointer: fine)` 上的那一层，
 * 触摸设备一行都不生效。**角标不在此列**（它是状态、是打标列表的全部信息量）。
 *
 * ## hover 遮罩的基线与那两枚**相反**，这是有意的
 *
 * 压在图上那层 `bg-black/20` 基线是「看不见」，hover / 焦点进卡片才亮。
 * 判据是同一条：**藏错了会丢什么。** 遮罩只是个视觉提示，没有入口可丢，所以可以放心默认不可见；
 * 操作器藏错了就是入口消失，所以必须默认可见。两个都靠 `group/card` 这个具名组。
 * 浅阴影不在这里——它挂在 `MemeImage` 有圆角的那个框上（挂在外层矩形上影子会是方的）。
 *
 * ## 为什么不给 `className` / `selected` / `role` 透传
 *
 * 搜索页的 `role="option"`、`data-index`、`aria-selected` 和选中描边**留在那一页的外层
 * wrapper 上**。描边落在卡片外面、不挤压网格，本来就是对的；把这层壳做进卡片里，
 * 等于让卡片同时理解「列表项」和「卡片」两种身份。
 */
export function MemeCard({
  meme,
  shape = 'square',
  recallBadges,
  actions,
  onFavorite,
}: {
  meme: Meme
  shape?: ImageShape
  /** 已本地化的召回来源标签（`matchedBy`），只有搜索页有（SPEC §6.3.1）。 */
  recallBadges?: string[]
  /** 「⋯」入口整块。**由页面给**——图墙和打标列表没有发送 / 删除入口，不给就没有。 */
  actions?: ReactNode
  /** 不给就不渲染收藏按钮。收藏的乐观更新与回滚在页面里（state-navigation.md §8）。 */
  onFavorite?: (meme: Meme) => void
}) {
  const hasActions = Boolean(actions)
  const recall = (recallBadges ?? []).join('+')
  const hasBadges = meme.tagStatus !== 'ok' || meme.isAnimated || recall !== ''

  return (
    // `group/card` 是**具名**的：`ui/sidebar.tsx` 那些组件在更高层也挂了 `group`
    // （`group-data-[variant=…]`），用具名组才不会被外面那层顺带点亮。
    <div className="group/card relative">
      <MemeImage meme={meme} shape={shape} />

      {/*
        hover 时压在图上的那层深色遮罩。**必须 `pointer-events-none`**——它盖住的正是
        图片本身，吃掉指针事件等于把动图的 hover 播放和点按播放一起废了
        （下面角标行是同一条理由，那行也有同样的注释）。

        ⚠️ **基线和上面那两枚操作器相反，这里是「看不见」为基线。** 那边必须基线可见，
        是因为藏错了等于入口消失；这层遮罩没有入口可丢，反过来才对——基线写死可见的话，
        手机上每一张图都永久蒙着一层灰。`group-hover/card` 自带 `@media (hover: hover)`
        外壳，触摸设备上这一层永远不会亮。

        圆角用 `IMAGE_RADIUS` 而不是自己写：它是图片框的兄弟节点，不在那个
        `overflow-hidden` 里，圆角写岔了方角会从圆角外面露出来。
      */}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 bg-black/20 opacity-0 transition-opacity',
          'group-hover/card:opacity-100 group-focus-within/card:opacity-100',
          IMAGE_RADIUS,
        )}
      />

      {hasBadges && (
        // pointer-events-none：角标压在图上，不能吃掉图片自己的 hover / 点按
        // （动图靠它播放）。留出的 right-12 是给「⋯」的位置——只有真有「⋯」时才留。
        //
        // **角标不跟着「⋯」一起藏。** 它不是操作器，是状态，而且是打标列表的**全部信息量**
        // （那页的用途就是「看哪张卡卡在哪个状态上」，styling.md）。留出的那 48px 也照留：
        // 跟着显形一起变的话，鼠标一进一出角标就要重排一次，看着在跳。
        <div
          className={cn(
            'pointer-events-none absolute top-1.5 left-1.5 z-10 flex flex-wrap gap-1',
            hasActions && 'right-12',
          )}
        >
          {meme.tagStatus !== 'ok' && (
            <span className={BADGE}>{tagStatusLabel(meme.tagStatus)}</span>
          )}
          {meme.isAnimated && <span className={cn(BADGE, 'font-semibold tracking-wide')}>GIF</span>}
          {recall !== '' && <span className={cn(BADGE, 'bg-black/45')}>{recall}</span>}
        </div>
      )}

      {/*
        「⋯」是绝对定位的浮层，不占布局——弹层因此能探出图片边界。

        `has-[[aria-expanded=true]]` 那一层**不能省**：菜单是 portal 出去的，打开后焦点
        离开卡片，`group-focus-within` 立刻失效；鼠标一移开卡片，「⋯」就淡出了——
        留下一个悬在空中、锚点看不见的菜单。Radix 在打开期间会给触发器挂
        `aria-expanded="true"`，用它把这一格钉住。
      */}
      {hasActions && (
        <div
          className={cn(
            'absolute top-1.5 right-1.5 z-10',
            REVEAL_ON_HOVER,
            'pointer-fine:has-[[aria-expanded=true]]:opacity-100',
          )}
        >
          {actions}
        </div>
      )}

      {onFavorite && (
        <button
          type="button"
          onClick={() => onFavorite(meme)}
          aria-label={meme.favorited ? '取消收藏' : '收藏'}
          aria-pressed={meme.favorited}
          // 鼠标 32、手指 44：前者不至于把 160px 宽的格子压掉一块，后者按得准。
          // 闸门是**指针**不是宽度（`size-8 max-sm:size-11` 是 2026-09-22 之前那一版）：
          // 窄窗口不一定是手机（700px 的桌面窗口白扛一个 44 的方块），
          // 而 700px 宽的手机反而落不进 `max-sm`。同 `lib/touch.ts` 那条。
          className={cn(
            OVERLAY_BTN,
            'absolute right-1.5 bottom-1.5 z-10 size-8 pointer-coarse:size-11',
            REVEAL_ON_HOVER,
          )}
        >
          <Heart className="size-4" fill={meme.favorited ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  )
}
