import { TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { MemeCard } from '../../components/MemeCard'
import { MATCHED_BY_LABELS, type Meme, type SearchResult } from '../../lib/api'
import { SEND_LABELS, detectSendPath } from '../../lib/clipboard'
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

/** `matchedBy` 里的通路标识翻成中文标签，未知取值原样显示（服务端可能新增通路）。 */
function matchedBadges(matchedBy: string[]): string[] {
  return matchedBy.map((m) => MATCHED_BY_LABELS[m] ?? m)
}

/**
 * 搜索结果的五种形态：**loading / error / 空 / 有结果 / idle（什么都不渲染）**。
 *
 * 吃整个 `SearchState` 而不是拆成几个布尔量，是因为这几个形态互斥——拆开就会出现
 * 「既 loading 又 error」这种渲染不出来的组合（`code-style.md`「每个异步操作都要有三态」）。
 *
 * 结果区顶部的两句话**不能和结果抢位置**：降级与改写提示是一条普通段落，
 * 不遮不挡、不弹层，底下照常出图（http.md §5、SPEC §6.3.1）。
 */
export function SearchResults({
  state,
  selectedIndex,
  copyNote,
  onActivate,
  onFavorite,
  onRetry,
}: {
  state: SearchState
  selectedIndex: number
  /** 复制 / 下载的结果，由 `sendNote` 给。null 表示不需要反馈。 */
  copyNote: string | null
  onActivate: (meme: SearchResult) => void
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
      {/* 降级不是错误：照常展示结果，只在顶部说明一句，不遮挡、不阻断（http.md §5）。
          用普通段落不用 Alert —— Alert 自带 `role="alert"`，而这条是状态说明，
          抢着打断读屏是错的（本端其它状态文案同理，见 EmbedSettings / ImportProgress） */}
      {state.degraded && (
        <p role="status" className="text-sm">
          向量通路当前不可用，本次只用了 OCR 和标签匹配，结果可能不全。
        </p>
      )}

      {/* 展示改写结果是为了让用户理解「为什么搜出这些」，可以为 null（SPEC §6.3.1） */}
      {state.rewritten && (
        <p className="text-sm text-muted-foreground">搜索理解为：{state.rewritten}</p>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">没有找到相关的图，换个说法试试</p>
      ) : (
        <div className={RESULT_GRID} role="listbox" aria-label="搜索结果">
          {items.map((meme, index) => (
            // 服务端 RRF 已排好序，不要按 matchedBy 重排。见 SPEC §6.3.1
            <ResultItem
              key={meme.id}
              meme={meme}
              index={index}
              selected={index === selectedIndex}
              onActivate={onActivate}
              onFavorite={onFavorite}
            />
          ))}
        </div>
      )}

      {copyNote && (
        <p role="status" className="text-sm">
          {copyNote}
        </p>
      )}
    </>
  )
}

/**
 * 一条结果。**外壳留在这一层、不进 `MemeCard`**：`role="option"` / `data-index` /
 * `aria-selected` 和选中描边都是「列表项」的身份，不是「卡片」的。
 *
 * 描边用 `outline` + `outline-offset-2` 而不是 `ring` / `border`：它是**落在卡片外面**的，
 * 不占布局、不挤压网格，键盘 ↑↓ 选中时格子不会跳（styling.md）。描边颜色取 `currentColor`。
 */
function ResultItem({
  meme,
  index,
  selected,
  onActivate,
  onFavorite,
}: {
  meme: SearchResult
  index: number
  selected: boolean
  onActivate: (meme: SearchResult) => void
  onFavorite: (meme: Meme) => void
}) {
  return (
    <div
      data-index={index}
      role="option"
      aria-selected={selected}
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
      {/*
        点击卡片与 Enter 同一条路径，行为一致（clipboard-share.md §7）：
        静图是「复制」，动图是「下载」——**文案在渲染时就分开**，
        不能让用户点了 GIF 之后发现没反应（§3）。
      */}
      <Button
        type="button"
        variant="secondary"
        className={cn(TOUCH, 'w-full')}
        onClick={() => onActivate(meme)}
      >
        {SEND_LABELS[detectSendPath(meme.isAnimated)]}
      </Button>
    </div>
  )
}
