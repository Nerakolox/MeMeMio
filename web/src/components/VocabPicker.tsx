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

export function VocabPicker({
  title,
  options,
  selected,
  onChange,
  disabled = false,
}: {
  title: string
  /** 词表里的全部候选，来自 `lib/vocab.ts`（唯一来源，不维护第二份列表）。 */
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  return (
    <fieldset className="vocab-picker" disabled={disabled}>
      <legend className="vocab-picker__title">{title}</legend>
      <div className="vocab-picker__options">
        {options.map((opt) => {
          const active = selected.includes(opt)
          return (
            <button
              key={opt}
              type="button"
              className={`vocab-picker__option${active ? ' vocab-picker__option--active' : ''}`}
              aria-pressed={active}
              onClick={() => onChange(toggleValue(selected, options, opt))}
            >
              {opt}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
