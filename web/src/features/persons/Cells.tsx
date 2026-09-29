import type { ReactNode } from 'react'
import { Images, Users } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Person, Series } from '../../lib/api-persons'
import { CoverThumb } from './CoverThumb'

/**
 * 人物 / 系列各一格。modal 里两列都用它，格子的样子只写一遍。
 *
 * 两个格子长得像但**不是同一个东西**，所以没有合成一个泛型组件：
 *   - 人物的封面**恒有**（§6.7.2），系列的空系列没有（要渲染空底）；
 *   - 系列多一行「人物数」，因为那一格回答的是「这个系列里有哪些人」。
 *
 * ⚠️ **两处都不出现任何相似度数字**（§6.7.2、任务 §5.1 第 5 条）。接口也不给。
 *    这不是「暂时没显示」——数值一旦外露，前端就会长出第二套阈值。
 */

/** 一格的壳。名字与计数两行，整格可点。 */
function CellFrame({
  onClick,
  cover,
  title,
  subtitle,
  titleClassName,
}: {
  onClick: () => void
  cover: ReactNode
  title: string
  subtitle: ReactNode
  titleClassName?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // 整格都是命中区，所以 min-h 加在这里没用（高度由封面决定）；宽度靠 grid 分。
        // 圆角与封面那层一致，聚焦环才贴着图走（styling.md「聚焦环要留出边距」）。
        'flex flex-col gap-2 rounded-2xl p-1 text-left outline-none',
        'hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring',
      )}
    >
      {cover}
      <span className="flex min-w-0 flex-col gap-0.5 px-1 pb-1">
        <span className={cn('truncate text-sm font-medium', titleClassName)}>{title}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  )
}

export function PersonCell({ person, onClick }: { person: Person; onClick: () => void }) {
  return (
    <CellFrame
      onClick={onClick}
      cover={<CoverThumb src={person.cover.thumbUrl} />}
      // `name` 为 null 是「未命名」，**不是空字符串**（§5.7）。显示成空白的话这一格
      // 看起来像坏了，而且用户不知道这里能起名。斜体把它和真名字区分开。
      title={person.name ?? '未命名'}
      titleClassName={person.name === null ? 'text-muted-foreground italic' : undefined}
      subtitle={
        <>
          <Images className="size-3" aria-hidden="true" />
          {person.memeCount} 张
          {/* 隐藏只是「在列表里默认不出现」，不是删除（§6.7.4）。标出来免得用户
              以为自己在看一个已经删掉的人物 */}
          {person.isHidden && <span className="ml-1">已隐藏</span>}
        </>
      }
    />
  )
}

export function SeriesCell({ series, onClick }: { series: Series; onClick: () => void }) {
  return (
    <CellFrame
      onClick={onClick}
      // 空系列的 `cover` 是 null（§6.7.2）——给一块空底，不给占位图标
      cover={<CoverThumb src={series.cover?.thumbUrl ?? null} />}
      title={series.name}
      subtitle={
        <>
          <Users className="size-3" aria-hidden="true" />
          {series.personCount} 人
          <span aria-hidden="true">·</span>
          <Images className="size-3" aria-hidden="true" />
          {series.memeCount} 张
        </>
      }
    />
  )
}

/**
 * 一格都没取到的空态。**三种成因给三句话**，因为出路完全不同：
 * 名字没匹配上要改词、已隐藏里没有要退回去、图数门槛挡住要放开门槛。
 * 一句话打发的话，用户只会觉得「这个功能是空的」。
 */
export function EmptyCells({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{text}</p>
}
