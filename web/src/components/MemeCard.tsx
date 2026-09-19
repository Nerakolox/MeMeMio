import type { ReactNode } from 'react'
import type { Meme } from '../lib/api'
import { Heart } from 'lucide-react'
import { tagStatusLabel } from '../lib/tag-status'
import { MemeImage } from './MemeImage'

/**
 * 卡片本身是**展示组件**，收藏回调由调用方注入——搜索页和浏览页的乐观更新各自持有自己的列表
 * （两个 feature 各自维护缓存，见 web/agents/rules/state-navigation.md §2）。
 */
export function MemeCard({
  meme,
  matchedBy,
  selected = false,
  actions,
  onFavorite,
  variant = 'square',
}: {
  meme: Meme
  /** 召回来源角标，仅搜索结果有。不参与排序，只做提示（SPEC §6.3.1）。 */
  matchedBy?: string[]
  /** 键盘选中态。搜索结果支持 ↑↓ 选择（clipboard-share.md §7）。 */
  selected?: boolean
  /**
   * 右上角的操作入口（「⋯」按钮与它的弹层），只由浏览页传。
   *
   * 做成插槽而不是在这里直接渲染，是因为**入口归哪个页面是页面的事**：
   * 搜索页与首页图墙暂时不放这个入口（见任务的「明确不做」），
   * 而卡片本身要在三个地方复用。
   */
  actions?: ReactNode
  /**
   * `square`（默认）：固定方形，`object-fit: cover` 裁方——搜索页与首页图墙用。
   * `natural`：按 `width`/`height` 整张展示，不裁方——浏览页瀑布流用
   * （joint-tasks/2026-09-19-browse-masonry.md）。
   */
  variant?: 'square' | 'natural'
  onFavorite: (meme: Meme) => void
}) {
  return (
    <div
      className={`meme-card rounded-xl border bg-card shadow${
        selected ? ' meme-card--selected' : ''
      }${actions ? ' meme-card--with-actions' : ''}`}
      data-selected={selected || undefined}
    >
      {/* 不套额外的 div：卡片是 flex 容器，多一层就会多出一个占位的 flex item。
          入口自己用 position: absolute 脱出文档流（见 styles.css 的 .meme-card__actions）。 */}
      {actions}
      <MemeImage meme={meme} variant={variant} />
      <div className="meme-card__footer">
        {/*
          角标只说中文。`ok` 不显示——绝大多数图都是好的，给它一个角标等于给每张图加噪声。
          `pending` / `needs_manual` 是正常的中间态，**不要用错误色**：
          视觉规则见 styling.md「状态的视觉表达」，修饰类名留给那一次样式改动挂上去。
        */}
        {meme.tagStatus !== 'ok' && (
          <span className={`meme-card__status-badge meme-card__status-badge--${meme.tagStatus}`}>
            {tagStatusLabel(meme.tagStatus)}
          </span>
        )}
        {/* 动图写不进剪贴板，只能走下载。见 SPEC §9.2 */}
        {meme.isAnimated && <span className="meme-card__animated-badge">GIF</span>}
        {matchedBy && matchedBy.length > 0 && (
          <span className="meme-card__matched-badge">{matchedBy.join('+')}</span>
        )}
        <button
          className={`meme-card__fav-btn flex h-9 w-9 items-center justify-center rounded-full transition-colors max-sm:h-11 max-sm:w-11 ${
            meme.favorited
              ? 'text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          onClick={() => onFavorite(meme)}
          aria-label={meme.favorited ? '取消收藏' : '收藏'}
          aria-pressed={meme.favorited}
        >
          <Heart className="h-4 w-4" fill={meme.favorited ? 'currentColor' : 'none'} />
        </button>
      </div>
    </div>
  )
}
