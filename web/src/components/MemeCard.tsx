import type { Meme } from '../lib/api'

/**
 * 卡片本身是**展示组件**，收藏回调由调用方注入——搜索页和浏览页的乐观更新各自持有自己的列表
 * （两个 feature 各自维护缓存，见 web/agents/rules/state-navigation.md §2）。
 */
export function MemeCard({
  meme,
  matchedBy,
  selected = false,
  onFavorite,
}: {
  meme: Meme
  /** 召回来源角标，仅搜索结果有。不参与排序，只做提示（SPEC §6.3.1）。 */
  matchedBy?: string[]
  /** 键盘选中态。搜索结果支持 ↑↓ 选择（clipboard-share.md §7）。 */
  selected?: boolean
  onFavorite: (meme: Meme) => void
}) {
  return (
    <div
      className={`meme-card${selected ? ' meme-card--selected' : ''}`}
      data-selected={selected || undefined}
    >
      <img
        className="meme-card__img"
        src={meme.thumbUrl ?? meme.url}
        alt={meme.description ?? meme.originalFilename ?? meme.id}
        loading="lazy"
        width={meme.width ?? undefined}
        height={meme.height ?? undefined}
      />
      <div className="meme-card__footer">
        {meme.tagStatus !== 'ok' && (
          <span className="meme-card__status-badge">{meme.tagStatus}</span>
        )}
        {/* 动图写不进剪贴板，只能走下载。见 SPEC §9.2 */}
        {meme.isAnimated && <span className="meme-card__animated-badge">GIF</span>}
        {matchedBy && matchedBy.length > 0 && (
          <span className="meme-card__matched-badge">{matchedBy.join('+')}</span>
        )}
        <button
          className={`meme-card__fav-btn${meme.favorited ? ' meme-card__fav-btn--active' : ''}`}
          onClick={() => onFavorite(meme)}
          aria-label={meme.favorited ? '取消收藏' : '收藏'}
          aria-pressed={meme.favorited}
        >
          ♥
        </button>
      </div>
    </div>
  )
}
