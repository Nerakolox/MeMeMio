import * as React from 'react'
import { Shimmer } from '../../components/ui/shimmer'
import { cn } from '../../lib/utils'

/**
 * 人物 / 系列的封面缩略图。两处格子（modal 里、浏览页头部）共用。
 *
 * **不裁剪**（styling.md「图片网格」）：固定方形容器 + `object-contain`。封面就是一张
 * 表情包，而表情包的信息常在边缘——裁掉之后用户认不出这是谁那一组，而这一格的全部
 * 意义就是「让人认出这是谁」。代价是宽图上下留白，那比裁掉半张脸好。
 *
 * 用缩略图不用原图：一屏几十格，原图会把流量打爆（同上）。
 *
 * ⚠️ **`cover` 对人物恒非 null、对系列可能是 null**（§6.7.2）：空系列没有封面。
 *    所以 `src` 允许为 null，那时渲染一块空底——**不是渲染破图标**。
 *
 * 骨架用 `Shimmer`（六处共用的那个）而不是自己写灰块：底色、扫光强弱、进场时长
 * 只有那一个落点。
 */
export function CoverThumb({
  src,
  className,
  /** 无障碍名。封面本身是装饰，说清它属于谁即可；纯装饰时传空串。 */
  alt = '',
}: {
  src: string | null
  className?: string
  alt?: string
}) {
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'failed'>(
    src === null ? 'ready' : 'loading',
  )

  return (
    <div className={cn('relative aspect-square w-full overflow-hidden rounded-2xl bg-muted', className)}>
      {/* 空系列（`src` 为 null）就停在这一层空底上，不出现扫光——扫光会让人以为「还在加载」 */}
      {src !== null && phase === 'loading' && <Shimmer aria-hidden="true" className="absolute inset-0" />}
      {src !== null && phase !== 'failed' && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className={cn(
            'relative size-full object-contain',
            // 加载中先藏起来：不藏的话浏览器会先画一行 alt 文字，再被图替掉，闪一下
            phase === 'loading' && 'opacity-0',
          )}
          onLoad={() => setPhase('ready')}
          onError={() => setPhase('failed')}
        />
      )}
      {/* 失败时**不留破图标**（styling.md），给一句话。这一格没有文件名可显示（接口不给） */}
      {phase === 'failed' && (
        <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted-foreground">
          封面加载失败
        </span>
      )}
    </div>
  )
}
