import { useState } from 'react'
import type { Meme } from '../lib/api'

/**
 * 图片承载：一张 `<img>` 的完整生命周期——按比例占位、加载骨架、失败兜底、深色底、动图播放。
 *
 * 只负责「把这张图画出来」。角标（tagStatus / GIF）、收藏、操作这些卡片层面的东西归 `MemeCard`，
 * 不在这里。`MemeCard` 被浏览 / 搜索 / 图墙 / 打标列表共用，本组件随之共用，
 * 兑现 styling.md「网格必须处理三件事」+「动图」+「深色模式」的承诺。
 */

/** hover 能力探测，模块级缓存一次（同 lib/clipboard.ts 的 `shareProbe` 模式）。
 *  触屏没有 hover，动图「再播」要靠点按；按平台能力分，不判 UA（clipboard-share.md §5）。 */
let hoverProbe: boolean | null = null
function canHover(): boolean {
  if (hoverProbe !== null) return hoverProbe
  hoverProbe =
    typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches === true
  return hoverProbe
}

export function MemeImage({
  meme,
  variant = 'square',
}: {
  meme: Meme
  /**
   * `square`（默认）：固定 1/1、`object-cover` 裁方——搜索页 / 图墙 / 打标列表用。
   * `natural`：按 `width`/`height` 算比例整张展示，不裁方——浏览页瀑布流用
   * （joint-tasks/2026-09-19-browse-masonry.md）。
   */
  variant?: 'square' | 'natural'
}) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  // 动图「再播」：true 时 src 换成原图。静图恒 false、无意义。
  const [playing, setPlaying] = useState(false)

  const animate = meme.isAnimated

  // 瀑布流占位比例：图片晚于布局到达，先按 width/height 把高度占住，加载后再补图，
  // 否则每张图 onLoad 时都会把下面整列推乱。width/height 为 null（旧数据/探测失败）兜底 1/1。
  const ratio =
    variant === 'natural' &&
    meme.width != null &&
    meme.height != null &&
    meme.width > 0 &&
    meme.height > 0
      ? `${meme.width} / ${meme.height}`
      : '1 / 1'

  // 缩略图是静态首帧（api 端 toThumbnail 未开 animated，见 image/decode.ts），
  // 所以「动图不自动播放」天然成立；播放时才换原图 url。
  const src = animate && playing ? meme.url : (meme.thumbUrl ?? meme.url)

  const alt = meme.description ?? meme.originalFilename ?? meme.id

  return (
    <div className="relative m-0 w-full overflow-hidden rounded-t-xl bg-white" style={{ aspectRatio: ratio }}>
      {status === 'loading' && <div className="absolute inset-0 bg-zinc-200" aria-hidden="true" />}

      {status === 'error' ? (
        // 加载失败显示文件名兜底，不显示破图标。originalFilename 就是为这件事存的（SPEC §5.2.3）。
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-100 p-2">
          <span className="truncate text-center text-xs text-zinc-500">
            {meme.originalFilename ?? '图片加载失败'}
          </span>
        </div>
      ) : (
        <img
          className={`block h-full w-full ${
            variant === 'natural' ? 'object-contain' : 'object-cover'
          }`}
          src={src}
          alt={alt}
          loading="lazy"
          width={meme.width ?? undefined}
          height={meme.height ?? undefined}
          onLoad={() => setStatus('loaded')}
          onError={() => {
            // 播放途中原图失败：缩略图本来好好的，退回缩略图，别把整卡打成失败态。
            if (animate && playing) setPlaying(false)
            else setStatus('error')
          }}
          onMouseEnter={animate && canHover() ? () => setPlaying(true) : undefined}
          onMouseLeave={animate && canHover() ? () => setPlaying(false) : undefined}
          onClick={animate && !canHover() ? () => setPlaying((p) => !p) : undefined}
        />
      )}
    </div>
  )
}
