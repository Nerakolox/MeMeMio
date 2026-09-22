/**
 * 从固定词表里多选标签的控件。
 *
 * 放在 `components/` 而不是某个 feature 里，是因为它被两个以上 feature 用到：
 * 浏览页的编辑侧边栏（`features/manage/`）现在用它，打标待处理列表的「补标签」
 * 将来也要用它（web/agents/rules/project-structure.md 的复用标准）。
 *
 * ⚠️ **只提供选择，不提供自由输入。** 人工编辑和模型输出走同一套词表校验
 * （SPEC §4.5）；给一个能打任意字符串的输入框，等于让人工编辑绕过词表约束，
 * 制造出模型永远不会产生的标签值。
 */

import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { TOUCH } from '../lib/touch'

/**
 * 切换一个值，返回的词表项**按 `options` 的顺序排列**。
 *
 * 顺序稳定不是洁癖：调用方要拿草稿和原值比「改没改」，
 * 按点击次序排的数组会在「取消了又选上」之后看起来变了，于是白发一次 PATCH。
 */
function toggleValue(selected: string[], options: string[], value: string): string[] {
  const next = new Set(selected)
  if (next.has(value)) next.delete(value)
  else next.add(value)

  return [
    ...options.filter((o) => next.has(o)),
    // 不在词表里的值原样留在末尾。词表是可以删词的（SPEC §4.4 的变更流程），
    // 而库里可能还有带着旧值的图——用户只改描述时，不该把那些旧标签静默丢掉。
    ...selected.filter((v) => !options.includes(v)),
  ]
}

/**
 * ## 2026-09-21：chip 从手写按钮换成 `Button`
 *
 * 换了皮、行为一个字没动（集合 toggle、按 `options` 序重排、词表外的旧值留在尾部）。
 *
 * 顺带修掉一个**一直存在的触摸目标违规**：上一版 chip 是 `padding: 4px 10px`（约 24px 高），
 * 而 `styles.css` 里那条窄屏触摸规则只覆盖了菜单项和面板关闭按钮——手机上这一屏标签
 * 全都低于 44（styling.md「至少 44×44px」，而且明写「没有例外」）。代价是三个分区变长，
 * 面板本来就能滚，所以不亏。
 *
 * 2026-09-22 那条闸门改成按**指针**分档（`lib/touch.ts`）：chip 在手指那一档仍是 44，
 * 鼠标那一档是 32。所以桌面筛选栏比迁移那天短了约三成——这是产品负责人要的，
 * 「所有的标签、按钮都太大了」那段话里的主角就是这 163 个 chip。
 */
export function VocabPicker({
  title,
  hideTitle = false,
  options,
  selected,
  onChange,
  disabled = false,
}: {
  title: string
  /**
   * 把 legend 变成 `sr-only`。给的是**已经在别处显示过同一个标题**的调用点
   * （`VocabSections` 的折叠头就是一个 h3），不是「这一组不需要名字」——
   * legend 本身必须留着，否则读屏念到的是一串没有归属的按钮。
   */
  hideTitle?: boolean
  /** 词表里的全部候选，来自 `lib/vocab.ts`（唯一来源，不维护第二份列表）。 */
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  return (
    // fieldset 的语义要留着：它把这组 chip 绑到一个 legend 上，读屏才会念出
    // 「情绪，三选一」而不是一串没有标题的按钮。默认边框与缩进要显式清掉。
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={disabled}>
      <legend className={cn('p-0 text-sm font-medium', hideTitle && 'sr-only')}>{title}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = selected.includes(opt)
          return (
            <Button
              key={opt}
              type="button"
              size="sm"
              variant={active ? 'secondary' : 'outline'}
              aria-pressed={active}
              // fieldset 的 disabled 已经让这些按钮在功能上被禁用（`:disabled` 会匹配到），
              // 这一个是为了让**视觉状态**不依赖那条容易忘的规则。
              disabled={disabled}
              /*
               * `cursor-pointer` 得自己写：Tailwind v4 起不再给 `<button>` 加 `cursor: pointer`
               * （styling.md），而**可点的元素才给 pointer**——`disabled` 时不给，光标是
               * 「点了会有事发生」的承诺。
               *
               * 它在浏览器里的落点在浏览页的筛选 chip 上：那一条 `cursor: pointer` 原先来自
               * `styles.css` 的 `.browse__tag-btn`，2026-09-22 那页迁到 Tailwind 时随 BEM 一起
               * 删掉了。放在这里而不是各调用点：同一组 chip 在编辑侧边栏里也要有同样的光标
               * （它以前是箭头，那不是有意设计的差别）。
               */
              className={cn(TOUCH, 'rounded-full px-3', !disabled && 'cursor-pointer')}
              onClick={() => onChange(toggleValue(selected, options, opt))}
            >
              {opt}
            </Button>
          )
        })}
      </div>
    </fieldset>
  )
}
