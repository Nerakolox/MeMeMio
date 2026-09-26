import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Skeleton } from '../../components/ui/skeleton'
import { Button } from '../../components/ui/button'
import { ScrollArea } from '../../components/ui/scroll-area'
import { MemeGallery } from '../../components/ImageViewer'
import { MemeCard } from '../../components/MemeCard'
import { memeRatio } from '../../components/MemeImage'
import type { FetchMemesParams } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { useMemeBatch } from '../../lib/use-meme-batch'
import { cn } from '../../lib/utils'
import { FailureLine } from './FailureLine'

/**
 * 每条 rail 取 8 张。**取满是常事**——「我的收藏」空库时是 0 张，那时整条不渲染，
 * 所以这个数字只影响横滑的长短，不影响「有没有下一张」这件事（那由「查看全部 →」答）。
 */
const RAIL_SIZE = 8

/**
 * 一行里的每一格：**高定死、宽按这张图的比例算**（形状的来历见文件头）。
 *
 * 行高是 CSS 变量 `--rail-item-h`（值挂在行上，见 `RAIL_ROW`），宽度由 `itemWidth()`
 * 算出来内联在上面。**两边必须套同一个数**——同一个比例在 JS 与 CSS 各写一份，
 * 表现是格子与图对不齐，与全屏阅览器那对 `--viewer-aside-w` / `--viewer-rail-h`
 * 是同一种做法（那种做法正反两个方向都只允许一个数存在）。
 */
const RAIL_ITEM = 'h-(--rail-item-h) shrink-0'

/**
 * 一格的宽 = 行高 × 这张图的比例。`ratio` 一律来自 `MemeImage` 的 `memeRatio()`
 * （**与图片框自己那份占位是同一个函数**），rail 不自己算比例。
 */
function itemWidth(ratio: number): { width: string } {
  return { width: `calc(var(--rail-item-h) * ${ratio})` }
}

/**
 * 横滑那一行。**裁剪与滚动都交给 `ScrollArea`**（见 `RailScroller`）。
 *
 * ⚠️ **`p-1` 不是排版偏好**：卡片的图片帧是个按钮，聚焦环是 `focus-visible:ring-3`
 * ——**3px 的 box-shadow 外扩，画在盒子外面**，而滚动容器的 `overflow` 会把它一起裁掉
 * （规范：`overflow: auto` 也裁，**不是只有 `hidden` 才裁**；而且裁的是 ink overflow，
 * 不产生滚动条，所以不会看到任何提示）。不补这 4px 的表现是「Tab 到第一张，环缺一条边」，
 * 只在聚焦那一瞬间出现（styling.md「聚焦环要留出边距」）。
 *
 * `-mx-1`（在 `RailScroller` 的 ScrollArea 上）把那 4px 还给版心：不然整条会比上面的图墙
 * 和其它区块右移一格，对不齐。纵向那 4px 留着（`-my-1` 会把这一行和标题之间的 12px 挤成 8px）。
 *
 * 行高挂在**这一行**上而不是每一格上：它是这一行的属性，而 `itemWidth()` 算宽时要读它。
 * 窄屏 160、桌面 176——与固定宽度那一版同值，方图这一档看着没变。
 *
 * 不写 `items-start`：**高度一致之后这一行天然是对齐的**（形状见文件头），
 * flex 默认的 `stretch` 也拉不动一个写死了 `h-(--rail-item-h)` 的项。
 */
const RAIL_ROW = 'flex gap-3 p-1 [--rail-item-h:10rem] md:[--rail-item-h:11rem]'

/**
 * 横滑那一行**和它的滚动条**。三态共用（加载态那一排骨架走同一条路）。
 *
 * 用 shadcn 的 `ScrollArea`（`orientation="horizontal"`）而不是 `overflow-x-auto`：
 * 后者的滚动条是**系统原生那条**——桌面上一律 15px 灰条、在 macOS 上还会随系统偏好
 * 整条消失，与浏览页那两根（Radix 浮层、`bg-border` 圆头、10px）放在同一屏上一眼就不像
 * 一套。换过来之后两边是同一份实现，差别只有方向；浮层滑块也只在真溢出时才画。
 *
 * ⚠️ **`pb-3` 是给那条滚动条留的位。** Radix 的横条是 `position: absolute; bottom: 0`
 * 压在 viewport 上的**浮层**、不占内容高度，不留这几像素它就直接盖住图的下沿
 * （浏览页的 `pr-3` 是同一条，那边盖的是最右一列的图）。`-mx-1` 与 `RAIL_ROW` 的 `p-1`
 * 配对，理由写在那条常量上。
 *
 * ⚠️ **`overscroll-x-contain` 要挂到 viewport 上**（`overflow-x-auto` 那一版挂在自己身上）：
 * 滚动现在发生在 Radix 的 viewport 里——Root 那一层没有 `overflow`，写上去等于没写，
 * 而它**不报错**，只表现为「划到头之后整页跟着往两边动」。
 */
function RailScroller({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <ScrollArea
      orientation="horizontal"
      className="-mx-1 pb-3 [&>[data-slot=scroll-area-viewport]]:overscroll-x-contain"
    >
      <div className={RAIL_ROW} aria-busy={busy || undefined}>
        {children}
      </div>
    </ScrollArea>
  )
}

/**
 * 首页的一条横滑 rail（2026-09-26 首页改版）。
 *
 * ## 它和图墙是同一种东西吗
 *
 * 不是。图墙是「不知道要找什么」——每次点都是另一批；rail 是「**这一类里挑一张**」
 * ——顺序是定的（收藏时间 / 上传时间），看完了就走「查看全部 →」那条路。
 * 所以 rail **没有分页、没有换一批**：它是通往 `/browse` 的一个橱窗，
 * 而筛选、翻页、编辑那一整套都在那边（任务文件 §6「明确不做」）。
 *
 * ## 一行的形状：**高度一致、宽度不一致**（2026-09-26 产品负责人定）
 *
 * 每一格的高度是定死的（`--rail-item-h`），宽度按这张图自己的比例算出来（`itemWidth()`）
 * ——横图宽出去、竖图窄下来，**一行里的图上沿下沿是对齐的**。
 *
 * 这一版之前是反过来的（固定宽 160 / 176、高按比例），代价是这一行高度参差、
 * 下沿啃着滚动条。两种都是「不裁剪」的写法（`styling.md` 那条硬要求：表情包的信息常在
 * 边缘，`cover` 裁掉之后用户认不出这是哪张），差别只在**把不齐放在哪一根轴上**。
 * 取高度一致，是因为横滑这一行本来就是一「条」片子，而它的下沿要贴滚动条。
 *
 * **不设宽度上限**：比例 3 的那张在桌面上就是 528px。设上限要么裁（`object-cover`）、
 * 要么在不是这个比例的框里留白（`contain`），两条都比「这张图本来就宽」更糟。
 *
 * ## 卡上没有动作
 *
 * **一枚浮层按钮都没有**，收藏也不给：图墙那枚发送键是对裁定 4 的明写偏离，
 * 而那条偏离**只覆盖图墙卡片**（任务文件 §5.1 的语境是「随便看看」这一屏没有管理面）。
 * rail 上的图是预览，要发送就点开（全屏阅览器里有那一枚）或者去 `/browse`。
 * 这里因此也不需要收藏的乐观更新——`onFavorite` 不给，`MemeCard` 就不渲染那颗心。
 *
 * ## 空的时候整条不渲染（连标题一起）
 *
 * 新库、新用户会同时满足「收藏 0 张」和「上传 0 张」。留两个空盒子加两个
 * 「查看全部 →」是说不过去的——那不是内容，是两块占位。判断在**取数之后**做，
 * 所以标题也不会在加载时先冒出来再消失。
 */
export function MemeRail({
  title,
  params,
  moreHref,
}: {
  title: string
  /** 这一条要什么。`limit` 由 rail 自己定（`RAIL_SIZE`），调用点不要传。 */
  params: FetchMemesParams
  /** 「查看全部 →」的去向，带上这一条的筛选条件（如 `/browse?favorited=true`）。 */
  moreHref: string
}) {
  const { state, reload } = useMemeBatch({ ...params, limit: RAIL_SIZE })

  // 空态 = 这一条不存在。见文件头。
  if (state.kind === 'ok' && state.items.length === 0) return null

  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex items-center justify-between gap-3">
        {/* 与图墙的「随便看看」同形（`text-sm font-medium`）：这两块是并列的section */}
        <span className="text-sm font-medium">{title}</span>
        <Button variant="link" size="sm" className={cn(TOUCH, 'px-0')} asChild>
          <Link to={moreHref}>查看全部 →</Link>
        </Button>
      </div>

      {state.kind === 'loading' && (
        <RailScroller busy>
          {Array.from({ length: RAIL_SIZE }).map((_, i) => (
            /* 还不知道比例，骨架一律占成方的——与 `memeRatio()` 的兜底同一个形状 */
            <div key={i} className={RAIL_ITEM} style={itemWidth(1)}>
              {/* `motion-reduce:animate-none` 不能省：注册表的 Skeleton 只有 animate-pulse */}
              <Skeleton aria-hidden="true" className="size-full motion-reduce:animate-none" />
            </div>
          ))}
        </RailScroller>
      )}

      {state.kind === 'error' && <FailureLine error={state.error} onRetry={reload} />}

      {state.kind === 'ok' && state.items.length > 0 && (
        /* 每条 rail 各包一层：全屏里 ←/→ 翻的是**这一条**的图。
           不包不是坏掉，是「一张一张地看」（`ImageViewer` 的文件头），
           而这里要的显然是「顺着这一条翻下去」。 */
        <MemeGallery items={state.items}>
          <RailScroller>
            {state.items.map((meme) => (
              <div key={meme.id} className={RAIL_ITEM} style={itemWidth(memeRatio(meme))}>
                <MemeCard meme={meme} shape="natural" />
              </div>
            ))}
          </RailScroller>
        </MemeGallery>
      )}
    </section>
  )
}
