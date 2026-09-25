import { Link } from 'react-router-dom'
import { Skeleton } from '../../components/ui/skeleton'
import { Button } from '../../components/ui/button'
import { MemeGallery } from '../../components/ImageViewer'
import { MemeCard } from '../../components/MemeCard'
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

/** 一格一张卡。窄屏 160、桌面 176：390px 上一屏看得见两张出头，正是「还能往右划」的样子。 */
const RAIL_ITEM = 'w-40 shrink-0 md:w-44'

/**
 * 横滑那一行。
 *
 * ⚠️ **`p-1` 不是排版偏好，`-mx-1` 也不是手滑**：卡片的图片帧是个按钮，
 * 聚焦环是 `focus-visible:ring-3`——**3px 的 box-shadow 外扩，画在盒子外面**，
 * 而 `overflow-x-auto` 会把另一轴也变成 `auto`（规范：一个轴不是 `visible` 时，
 * `visible` 的那一轴按 `auto` 算），于是这一行**四边都在裁**。不补这 4px 的表现是
 * 「Tab 到第一张，环缺一条边」，只在聚焦那一瞬间出现（styling.md「聚焦环要留出边距」）。
 *
 * `-mx-1` 把那 4px 还回去：不然整条会比上面的图墙和其它区块右移一格，对不齐。
 * 纵向那 4px 留着（`-my-1` 会把这一行和标题之间的 12px 挤成 8px，不值当）。
 *
 * `items-start`：卡片是各自的比例、高度不一（见下面 `shape="natural"`），
 * 不写的话 flex 默认 `stretch`，短的那张会被拉长——图不跟着变，只是下面多一截白的。
 */
const RAIL_ROW = 'flex items-start gap-3 overflow-x-auto overscroll-x-contain p-1 -mx-1'

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
 * ## 卡上没有动作
 *
 * **一枚浮层按钮都没有**，收藏也不给：图墙那枚发送键是对裁定 4 的明写偏离，
 * 而那条偏离**只覆盖图墙卡片**（任务文件 §5.1 的语境是「随便看看」这一屏没有管理面）。
 * rail 上的图是预览，要发送就点开（全屏阅览器里有那一枚）或者去 `/browse`。
 * 这里因此也不需要收藏的乐观更新——`onFavorite` 不给，`MemeCard` 就不渲染那颗心。
 *
 * ## 卡片是 `natural`（各按自己的比例），不是图墙那种方格子
 *
 * 图墙的格子是 1:1 + `cover`（既有行为，改动它不在本任务范围），而
 * 「不裁剪」是这个项目写在 styling.md 里的硬要求——表情包的信息常在边缘，
 * 裁掉之后用户认不出这是哪张。rail 是新做的面，照规则走：**固定宽度 + 图片自己
 * 的宽高比**，代价是这一行的高度不齐（`items-start` 顶着上沿排）。
 * 换成 `square` 会让这一行齐，但那是拿裁剪换齐——不值当。
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
        <div className={RAIL_ROW} aria-busy="true">
          {Array.from({ length: RAIL_SIZE }).map((_, i) => (
            <div key={i} className={RAIL_ITEM}>
              {/* `motion-reduce:animate-none` 不能省：注册表的 Skeleton 只有 animate-pulse */}
              <Skeleton
                aria-hidden="true"
                className="aspect-square w-full motion-reduce:animate-none"
              />
            </div>
          ))}
        </div>
      )}

      {state.kind === 'error' && <FailureLine error={state.error} onRetry={reload} />}

      {state.kind === 'ok' && state.items.length > 0 && (
        /* 每条 rail 各包一层：全屏里 ←/→ 翻的是**这一条**的图。
           不包不是坏掉，是「一张一张地看」（`ImageViewer` 的文件头），
           而这里要的显然是「顺着这一条翻下去」。 */
        <MemeGallery items={state.items}>
          <div className={RAIL_ROW}>
            {state.items.map((meme) => (
              <div key={meme.id} className={RAIL_ITEM}>
                <MemeCard meme={meme} shape="natural" />
              </div>
            ))}
          </div>
        </MemeGallery>
      )}
    </section>
  )
}
