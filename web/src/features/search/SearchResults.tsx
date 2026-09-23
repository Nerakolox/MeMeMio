import { SearchX, Sparkles, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { MemeGallery } from '../../components/ImageViewer'
import { MemeCard } from '../../components/MemeCard'
import { MATCHED_BY_LABELS, type Meme, type SearchResult } from '../../lib/api'
import { SEND_LABELS, detectSendPath, type SendNote } from '../../lib/clipboard'
import { TOUCH } from '../../lib/touch'
import { usePrefetchShare } from '../../lib/use-prefetch-share'
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

/**
 * 状态说明的**承载面板**（2026-09-24 加）。
 *
 * 这三条文案（降级、改写、空结果）此前是裸 `<p>`，直接铺在页面底色上——文字没有承载物，
 * 看起来像页面漏渲染了一块。现在统一给一个浅底细边的面板。
 *
 * **不用 `Alert`**：它自带 `role="alert"`，而这几条都是状态说明、不是警报，抢着打断读屏是错的
 * （`http.md` §5「降级不是错误」）。所以这里手写容器，只保留与原实现一致的 `role="status"`。
 *
 * **底色用 `bg-card` + `border`，不用 `bg-muted`**：`text-muted-foreground` 落在
 * `--muted` 上（浅色 `oklch(0.97)`）对比度约 4.3，低于 4.5；落在 `bg-card` 上就是页面底色
 * （浅色为白，深色为 `oklch(0.205)`），两条都是 4.7 以上。**换底色要重量对比度。**
 *
 * `w-fit` 而不是撑满：首页内容列到 1152px，一句 30 字的说明撑满一条横幅会留下一大片空白。
 *
 * 模块内私有（同 `RESULT_GRID`）：这个文件是唯一使用者。
 */
const NOTICE = 'flex w-fit items-start gap-2 rounded-2xl border bg-card px-3 py-2 text-sm'

/** `matchedBy` 里的通路标识翻成中文标签，未知取值原样显示（服务端可能新增通路）。 */
function matchedBadges(matchedBy: string[]): string[] {
  return matchedBy.map((m) => MATCHED_BY_LABELS[m] ?? m)
}

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
  copyNote: SendNote | null
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
          `role="status"` 不是 `alert`，理由见 `NOTICE` 的注释 */}
      {state.degraded && (
        <div role="status" className={NOTICE}>
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          向量通路当前不可用，本次只用了 OCR 和标签匹配，结果可能不全。
        </div>
      )}

      {/* 展示改写结果是为了让用户理解「为什么搜出这些」，可以为 null（SPEC §6.3.1） */}
      {state.rewritten && (
        <div className={cn(NOTICE, 'text-muted-foreground')}>
          <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          搜索理解为：{state.rewritten}
        </div>
      )}

      {/* 空结果：这一屏只有这句话，所以它是这块地方的**唯一内容**——给一个居中的空态块，
          不是一行浮在空白里的字（图墙在这种状态下不渲染，见 home.tsx） */}
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border bg-card px-6 py-8 text-center">
          <SearchX className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">没有找到相关的图，换个说法试试</p>
        </div>
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
                onActivate={onActivate}
                onFavorite={onFavorite}
              />
            ))}
          </div>
        </MemeGallery>
      )}

      {copyNote && (
        <p role="status" className="text-sm">
          {copyNote.text}
          {/* 取不到原图时**给一个能点的链接**：那一下是用户自己的手势，不会被弹窗拦截
              （`lib/clipboard.ts` 的 `saveFile` 记着为什么不 `window.open`） */}
          {copyNote.fallbackUrl !== undefined && (
            <>
              {' '}
              <a
                className="underline underline-offset-2"
                href={copyNote.fallbackUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                在新标签页打开原图
              </a>
            </>
          )}
        </p>
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
 * 这一格里有三个可交互元素（图片帧、收藏、发送）。`role="option"` 要求列表项自己
 * 承担选中语义，把按钮塞进去是**违反 ARIA 的**，读屏在两种模式之间来回切。
 * 而键盘路径也不靠列表项语义——焦点是**真的**移到结果项上（`use-search.ts` 的
 * `focusResult`），Enter 的判据就是「焦点在不在这一格」（`focusedOptionIndex`）。
 * 所以这里只留一个带可读名的 `group`，选中态交给那个真实焦点。
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
  const name = readableName(meme)
  /** 文案在渲染时定下来，点击时不再改（clipboard-share.md §5）：一个按钮两种行为最糟。 */
  const sendLabel = SEND_LABELS[detectSendPath(meme.isAnimated)]
  // 触屏那一档要在**渲染时**就把原图取好，否则点下去时用户激活已经过期（见该 hook）
  usePrefetchShare(meme)

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
      {/*
        点击卡片与 Enter 同一条路径，行为一致（clipboard-share.md §7）：
        静图是「复制」，动图是「下载」——**文案在渲染时就分开**，
        不能让用户点了 GIF 之后发现没反应（§3）。
      */}
      <Button
        type="button"
        variant="secondary"
        // 一页里几十个「复制」，读屏一个一个念下来分不出是哪张（同 `ThumbRail` 的做法）
        aria-label={`${sendLabel}第 ${index + 1} 张：${name}`}
        className={cn(TOUCH, 'w-full')}
        onClick={() => onActivate(meme)}
      >
        {sendLabel}
      </Button>
    </div>
  )
}
