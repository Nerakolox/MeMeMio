import { cn } from '../lib/utils'

/**
 * 一格计数。**必须放在 `<dl>` 里**——它渲染的是 `dt` / `dd`，散在外面是无效 HTML。
 *
 * 放 `components/` 而不是某个 feature 里：导入进度（已入库 / 跳过重复 / 待你确认 / 失败）
 * 与打标汇总（已完成 / 待打标 / 需人工 / 已拒绝 / 正在打标）两处用的是同一套排版，
 * 而它们是两个 feature。按 `project-structure.md` 那条「被两个以上 feature 用到才放
 * `components/`」，这里正是那个判断的落点；各写一份就是两个会各自漂的落点。
 *
 * 数字用 `text-xl` 是有意的：这两屏用户都是来看「多少张卡在哪一步」的，
 * 标签和数字一样大的话要一行一行读过去才知道数在哪。`tabular-nums` 让换值时宽度不抖。
 *
 * `danger` 只给**终局失败**用。`pending` / `needs_manual` / `needs_review` 这些中间态
 * 一律不用错误色——它们是正常的，用错误色会让用户以为自己做错了什么
 * （`styling.md`「状态的视觉表达」）。
 */
export function StatTile({
  label,
  value,
  danger,
}: {
  label: string
  value: number
  danger?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'font-heading text-xl font-semibold tabular-nums',
          danger && 'text-destructive',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

/**
 * 一排计数的容器。和 `StatTile` 同属一份排版约定，所以一起放在这里。
 *
 * `flex-wrap` 而不是固定列数：两处的格子数不一样（4 个 / 4–5 个），而可用的内容宽度
 * 随侧边导航的展开收起变化——写死列数在窄档会把数字挤成两行。
 */
export const STAT_ROW = 'flex flex-wrap gap-x-6 gap-y-4'
