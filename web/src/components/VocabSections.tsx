/**
 * 词表七个维度（六个语义 + `ratings` 分级，SPEC §4.3）的多选分区，筛选面板与编辑面板共用。
 *
 * ## 为什么是折叠的
 *
 * v0.2.0 把语义维度从两个拆成五个（SPEC §4.3），候选词从 163 个涨到 190 个。全部摊开的话
 * 这一版面在 220px 的筛选列里有两千多像素高——**用户要滚四屏才能看见「标签」那一节**，
 * 而他多半只想按其中一维筛。产品负责人 2026-09-22 已经为这一栏的体量提过两次
 * （「所有的标签、按钮都太大了，浏览页的筛选板块是最佳实例」），段数只增不减
 * 等于把那句话再放大一倍。
 *
 * 折叠的代价是**可发现性**：收起来的维度用户不知道里面有什么。两处补偿：
 *   - 列头用 SPEC 的全称（`lib/vocab.ts` 有完整理由），收起时也读得出这一维问的是什么；
 *   - **有选中值的维度默认展开**，所以分享来的筛选链接一打开就能看见生效中的条件，
 *     不会出现「角标说有 3 个条件，面板上一个都看不见」。
 *
 * ## 默认展开只算一次
 *
 * `defaultValue` 是非受控初值，只在挂载时求值。这正是想要的：用户手动收起一个有值的维度
 * 之后，不该因为他又点了一个 chip 就被强行展开回去。两个调用点都满足「换对象就重挂」——
 * 编辑面板挂在 `key={meme.id}` 上，筛选面板整屏只有一份 URL。
 */

import { useState } from 'react'
import { Badge } from './ui/badge'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from './ui/accordion'
import { VocabPicker } from './VocabPicker'
import { cn } from '../lib/utils'
import { TOUCH } from '../lib/touch'
import { VOCAB_DIMENSIONS, type VocabField } from '../lib/vocab'

export function VocabSections({
  values,
  onChange,
  disabled = false,
  className,
}: {
  /** 七个维度当前的值。筛选面板给的是 URL 里的，编辑面板给的是草稿里的。 */
  values: Record<VocabField, string[]>
  onChange: (field: VocabField, next: string[]) => void
  disabled?: boolean
  className?: string
}) {
  const [defaultOpen] = useState(() =>
    VOCAB_DIMENSIONS.filter((d) => values[d.field].length > 0).map((d) => d.field),
  )

  return (
    // `type="multiple"`：这不是一个「选一节看」的导航，几维一起筛是常态，
    // 单开模式会在用户点第二维时把第一维收起来，看上去像是刚才的选择没了。
    <Accordion type="multiple" defaultValue={defaultOpen} className={className}>
      {VOCAB_DIMENSIONS.map(({ field, label, options }) => {
        const selected = values[field]
        return (
          <AccordionItem key={field} value={field}>
            {/* 注册表默认 `p-4`（16px）+ `items-start`。七段叠起来那 32px 的竖直内边距
                很显眼，而这一行的可点性由 `TOUCH` 兜（粗指针 44、细指针回到库自己的密度）。 */}
            <AccordionTrigger
              className={cn(TOUCH, 'items-center gap-2 px-3 py-2')}
              disabled={disabled}
            >
              <span className="flex min-w-0 items-center gap-2">
                {label}
                {/* 收起状态下这是唯一能看出「这一维筛过」的东西，所以数字不能省。
                    选中的**词**不在这里列：全摊开就是另一个太长的版面。 */}
                {selected.length > 0 && (
                  <Badge variant="secondary" className="shrink-0">
                    {selected.length}
                  </Badge>
                )}
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-0">
              {/* 可见标题已经在上面那个 `AccordionHeader`（h3）里了，legend 再显示一次是重复；
                  但 fieldset/legend 的**语义**要留着，读屏才会念出「这是一组，叫什么」——
                  所以是 `sr-only` 而不是不传 title。 */}
              <VocabPicker
                title={label}
                hideTitle
                options={options}
                selected={selected}
                onChange={(next) => onChange(field, next)}
                disabled={disabled}
              />
            </AccordionContent>
          </AccordionItem>
        )
      })}
    </Accordion>
  )
}
