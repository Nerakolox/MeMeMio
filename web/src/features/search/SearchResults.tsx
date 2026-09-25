import { TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { MemeGallery } from '../../components/ImageViewer'
import { MemeCard } from '../../components/MemeCard'
import { DegradedNotice, EmptyNotice, RewrittenNotice } from '../../components/Notice'
import { matchedBadges, type Meme, type SearchResult } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import type { SearchState } from './use-search'

/**
 * 结果网格与骨架网格**共用这一份类**——它们此前是同一组类写两遍（`.search__grid` 那份
 * 被两处用着），而两处一旦漂开，加载态和结果态的格子就对不上了。
 *
 * 模块内私有：这个文件是唯一使用者。跨 feature 的常量（`IMAGE_RADIUS`、`OVERLAY_BTN`）
 * 才需要导出，见 `styling.md`。
 *
 * 手机上缩到 140px：340px 内容宽排得下两列，而 160px 只排得下一列半。
 */
const RESULT_GRID =
  'grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 max-sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))]'

/** 一屏骨架的格数。**与结果无关，只是占位**——够铺满一屏即可。 */
const SKELETON_COUNT = 12

/** 卡片 / 按钮的可读名。与 `MemeImage` 的 `alt` 同一份来源。 */
function readableName(meme: Meme): string {
  return meme.description ?? meme.originalFilename ?? meme.id
}

/**
 * 搜索结果的五种形态：**loading / error / 空 / 有结果 / idle（什么都不渲染）**。
 *
 * 吃整个 `SearchState` 而不是拆成几个布尔量，是因为这几个形态互斥——拆开就会出现
 * 「既 loading 又 error」这种渲染不出来的组合（`code-style.md`「每个异步操作都要有三态」）。
 *
 * 结果区顶部的两句话**不能和结果抢位置**：降级与改写提示是一块普通面板（`NOTICE`），
 * 不遮不挡、不弹层，底下照常出图（http.md §5、SPEC §6.3.1）。
 *
 * 复制 / 下载的结果**不在这个文件里**：2026-09-24 起走右上角提示（`lib/toast.tsx`）。
 * 此前首页与浏览页各有一行自己的裸文字，同一件事两处呈现——其中一处改了就会漂，
 * `styling.md` 把这一笔记成了待办，本次一并收掉。
 */
export function SearchResults({
  state,
  selectedIndex,
  onFavorite,
  onRetry,
}: {
  state: SearchState
  selectedIndex: number
  onFavorite: (meme: Meme) => void
  onRetry: () => void
}) {
  if (state.kind === 'loading') {
    return (
      <div className={RESULT_GRID} aria-busy="true">
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          // `motion-reduce:animate-none` 不能省：注册表的 Skeleton 只有 animate-pulse
          <Skeleton key={i} aria-hidden="true" className="aspect-square motion-reduce:animate-none" />
        ))}
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      // `role="alert"` 由 Alert 自带，与旧实现逐字相同（这一条**是**警报，不是状态提示）
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>搜索失败</AlertTitle>
        <AlertDescription>
          <p>{state.error.message}</p>
          {/* requestId 必须露出来，报问题时它是唯一能对上服务端日志的东西（http.md §3） */}
          <p className="font-mono text-xs">requestId: {state.error.requestId}</p>
          {/* 重试**原样重跑当前搜索词**。旧实现这里调的是 `commit('')`，等于把用户的话删掉、
              把他丢回图墙——按钮上写着「重试」，做的却是另一件事（见 use-search.ts 的 retry） */}
          <Button variant="outline" size="sm" className={cn(TOUCH, 'mt-2')} onClick={onRetry}>
            重试
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (state.kind !== 'ok') return null

  const items = state.items

  return (
    <>
      {/* 这三块 2026-09-26 提到了 `components/Notice`：合并后的列表页也要挂同一份，
          留两份就是同一件事两处呈现。理由（为什么不用 Alert、为什么 w-fit）在那边 */}
      {state.degraded && <DegradedNotice />}

      {/* 展示改写结果是为了让用户理解「为什么搜出这些」，可以为 null（SPEC §6.3.1） */}
      {state.rewritten && <RewrittenNotice rewritten={state.rewritten} />}

      {/* 空结果：这一屏只有这句话，所以它是这块地方的**唯一内容**（图墙在这种状态下不渲染，见 home.tsx）。
          首页这条路的空结果只可能来自检索，所以 `searching` 恒为 true */}
      {items.length === 0 ? (
        <EmptyNotice searching />
      ) : (
        // 这一批就是「用户看的那一批」：全屏里 ←/→ 翻的就是这次搜索的结果
        <MemeGallery items={items}>
          <div className={RESULT_GRID} role="group" aria-label="搜索结果">
            {items.map((meme, index) => (
              // 服务端 RRF 已排好序，不要按 matchedBy 重排。见 SPEC §6.3.1
              <ResultItem
                key={meme.id}
                meme={meme}
                index={index}
                selected={index === selectedIndex}
                onFavorite={onFavorite}
              />
            ))}
          </div>
        </MemeGallery>
      )}

    </>
  )
}

/**
 * 一条结果。**外壳留在这一层、不进 `MemeCard`**：`data-index` 和选中描边都是
 * 「结果项」的身份，不是「卡片」的。
 *
 * ## 2026-09-24：`listbox` / `option` 换成 `group`
 *
 * 这一格里有可交互元素（图片帧、收藏）。`role="option"` 要求列表项自己
 * 承担选中语义，把按钮塞进去是**违反 ARIA 的**，读屏在两种模式之间来回切。
 * 而键盘路径也不靠列表项语义——焦点是**真的**移到结果项上（`use-search.ts` 的
 * `focusResult`），Enter 的判据就是「焦点在不在这一格」（`focusedOptionIndex`）。
 * 所以这里只留一个带可读名的 `group`，选中态交给那个真实焦点。
 *
 * ## 2026-09-26（裁定 4）：图片下面那枚全宽发送按钮撤掉了
 *
 * 撤掉它的理由写在 [SPEC §6.3.1](../../../spec/06-endpoints.md) 的任务裁定里：一个动作
 * 只出现一处。合并后的列表里「发送」在卡片上走「⋯」菜单（`MemeActions`，自带
 * `detectSendPath` 与 `usePrefetchShare`，分流逻辑不在这里丢一份），全屏阅览里走那枚
 * 新加的可见按钮。**连 `sendLabel` 与 `usePrefetchShare` 一起撤**——留着就是第二份实现。
 * 代价（发出去从 1 击变 2 击）是明码记过的，补回来的是阅览器那枚按钮。
 *
 * 描边用 `outline` + `outline-offset-2` 而不是 `ring` / `border`：它是**落在卡片外面**的，
 * 不占布局、不挤压网格，键盘 ↑↓ 选中时格子不会跳（styling.md）。描边颜色取 `currentColor`。
 */
function ResultItem({
  meme,
  index,
  selected,
  onFavorite,
}: {
  meme: SearchResult
  index: number
  selected: boolean
  onFavorite: (meme: Meme) => void
}) {
  const name = readableName(meme)

  return (
    <div
      data-index={index}
      // 焦点真的会落到这一格上（`focusResult`），没有可读名的话读屏只念得出「group」
      role="group"
      aria-label={`第 ${index + 1} 张：${name}`}
      className={cn(
        'flex flex-col gap-1',
        selected && 'outline outline-2 outline-offset-2 outline-current',
      )}
      tabIndex={-1}
    >
      <MemeCard
        meme={meme}
        recallBadges={matchedBadges(meme.matchedBy)}
        onFavorite={onFavorite}
      />
    </div>
  )
}
