/**
 * 筛选面板的**内容**。桌面那一列与手机抽屉共用同一份——外壳不同（一个是 `<aside>`、
 * 一个是 `Sheet`），内容一样；分两份写迟早会漂（一侧加了条件，另一侧忘了加）。
 *
 * 这里没有任何本地 state：每一项的真源都是 URL（`use-browse-filters`）。
 */

import { Button } from '../../components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
import { Separator } from '../../components/ui/separator'
import { Switch } from '../../components/ui/switch'
import { VocabPicker } from '../../components/VocabPicker'
import type { User } from '../../lib/api'
import { TAG_STATUS_LABELS } from '../../lib/tag-status'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { emotionOptions, sceneOptions, tagOptions } from '../../lib/vocab'
import type { BrowseFiltersState } from './use-browse-filters'

/**
 * 「一行字 + 一个控件」那一行的高度。四行（两个开关、两个下拉）都用它。
 *
 * 与 `TOUCH` 是**同一条闸门**，只是这一行本身就是那个可点的目标、不由某个控件承担
 * （复选框自己的命中区只有 40×32、开关是 68×36，`min-h` 加在那些小方块上会把它们拉成长条）。
 * 细指针（鼠标）降到 32，粗指针（手指）仍是 44——产品负责人 2026-09-22 的原话是这一栏
 * 「太大」，而屏幕上最扎眼的就是这些 44 高的行。
 *
 * **行与行之间要留缝**（`ROW_GAP`），这不是审美：44 高的行贴在一起还算两件事，
 * 32 高的两个带边框的控件贴在一起就成了一坨——产品负责人下一句就是
 * 「俩筛选都挤到一起了」。
 *
 * 漏掉一行的表现是「整个面板里只有某一节偏高」，不会报错。
 */
const ROW = 'flex min-h-11 items-center gap-2 pointer-fine:min-h-8'
/** 同一组里行与行之间的缝。改小到 0 就会退回「挤成一坨」，见 `ROW` 那段。 */
const ROW_GAP = 'flex flex-col gap-1.5'

export function BrowseFilters({
  filters,
  user,
}: {
  filters: BrowseFiltersState
  user: User | null
}) {
  // tagStatus 只对 admin、或正在筛「只看我的」的人有意义（SPEC §6.3.2 + §3.3）：
  // 别人的打标状态既不是他该看见的信息，也不是他能处理的事。
  const canUseTagStatus = user?.role === 'admin' || filters.uploader === 'me'

  return (
    <div className="flex flex-col gap-4">
      {/*
        标题行。窄屏的「筛选」由抽屉自己的 `SheetHeader` 承担（否则一个抽屉里两个「筛选」），
        所以那个 `span` 是 md 以上才显示。
      */}
      <div className={cn(ROW, 'justify-end md:justify-between')}>
        <span className="hidden font-semibold md:block">筛选</span>
        {filters.hasFilters && (
          <Button variant="ghost" size="sm" className={TOUCH} onClick={filters.clear}>
            清除
          </Button>
        )}
      </div>

      {/*
        两个布尔筛选。**开关在右、字在左**（`justify-between`），不是「小方块 + 字」——
        换了 `Switch` 之后这一行读起来就是「这个东西开没开」，两行也不会看成一坨；
        整行的宽度都归它，鼠标和手指都好点。
      */}
      <div className={ROW_GAP}>
        {/*
          裸 `<label>` 包住整行，不用 `Label htmlFor` + id：内容这一份会**同时**挂在桌面列与
          手机抽屉两处（抽屉是 portal，两者都在 DOM 里），写 id 就必然撞。
          `<button>` 是 labelable 元素，点文字由浏览器把这次点击转发给 Radix 的 Switch
          （先例是 `routes/ui.tsx` 的组件示例页，同一条转发在 `Switch` 上要实测，不是想当然）。

          触摸目标由**这一行**兜住（`ROW`），不在开关上：`Switch` 自己是 44×20，
          伪元素命中区再撑 12/8 也只有 68×36，比 44 矮。
        */}
        <label className={cn(ROW, 'justify-between')}>
          只看动图
          <Switch
            checked={filters.isAnimated}
            // 不读回调参数，直接翻 URL 里那个值——真源只有一份（勾选态可能是 URL 改动带来的）
            onCheckedChange={() => filters.toggleBool('isAnimated')}
          />
        </label>

        <label className={cn(ROW, 'justify-between')}>
          只看收藏
          <Switch
            checked={filters.favorited}
            onCheckedChange={() => filters.toggleBool('favorited')}
          />
        </label>
      </div>

      {/* 两个下拉单独成组：`ROW_GAP` 是那 6px——之前这两行贴在一起（0 缝），
          32 高的两个带边框的控件上下相接，看着就是一坨。 */}
      <div className={ROW_GAP}>
        {/* `SelectTrigger` 默认是 `w-fit`，在 220px 的列里必须显式给宽度 */}
        <div className={ROW}>
          <span className="shrink-0">上传者</span>
          <Select
            value={filters.uploader ?? ''}
            onValueChange={(v) => filters.setString('uploader', v || null)}
          >
            {/* `aria-label` 而不是关联可见文字的 `Label htmlFor`：同上，id 会撞。
                可读名与旁边那行字一样，视觉与读屏读到的因此是同一件事。 */}
            <SelectTrigger size="sm" aria-label="上传者" className={cn(TOUCH, 'flex-1')}>
              {/* ⚠️ `placeholder="全部"` **不能省**，理由和下面那条 `value=""` 是同一件事的另一半：
                  Radix 把「触发器里显示什么」整个挂在 `shouldShowPlaceholder(value)`（`value === ''`
                  即真）上——**连选中项自己的文字要 portal 进来也被它挡着**
                  （`SelectItemText` 里那个 portal 的前置条件就是 `!shouldShowPlaceholder`）。
                  空串选项既然是这个值，不给 `placeholder` 就没有任何文字可显示：
                  默认态和选了「全部」之后，触发器都是一片空白只剩箭头。
                  非空值的下拉（`settings/UsersSettings.tsx`）踩不到这一条，那里 `placeholder` 可以省。 */}
              <SelectValue placeholder="全部" />
            </SelectTrigger>
            <SelectContent>
              {/*
                ⚠️ `value=""`（空串）在这个版本是**合法**的：`@radix-ui/react-select@2.3.7` 里
                已经没有那句「A <Select.Item /> must have a value prop that is not an empty string」，
                取而代之的是 `hasEmptyValueOption`——有空的选项时，占位符只在 `undefined` 时出现。
                这条**锁在版本上**：升级这个包之后如果它重新抛错，改成哨兵值（`'all'`）再映射回 null。
                每条 `SelectItem` 都要单独带 `TOUCH`：漏了的表现是「触发器 44，展开后每行 36」。
              */}
              <SelectItem value="" className={TOUCH}>
                全部
              </SelectItem>
              <SelectItem value="me" className={TOUCH}>
                只看我的
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {canUseTagStatus && (
          <div className={ROW}>
            <span className="shrink-0">标注状态</span>
            <Select
              value={filters.tagStatus ?? ''}
              onValueChange={(v) => filters.setString('tagStatus', v || null)}
            >
              <SelectTrigger size="sm" aria-label="标注状态" className={cn(TOUCH, 'flex-1')}>
                {/* 同上：空串选项必须有 `placeholder`，否则触发器是空白的 */}
                <SelectValue placeholder="全部" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="" className={TOUCH}>
                  全部
                </SelectItem>
                {/* 值与文案都取自 tag-status.ts 那一份表：选项顺序就是表里的顺序。
                    枚举直出英文会让用户对着一堆 tag_status 猜自己该选哪个。 */}
                {Object.entries(TAG_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value} className={TOUCH}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/*
        三个词表分区。用 `VocabPicker`（仓库已有的多选 chip 控件），不写第二份 chip 实现、
        也不引 `ToggleGroup`：它已经带上了 `TOUCH`、`aria-pressed` 与 fieldset/legend
        那套「读屏念得出这是一组、叫什么」的语义。
      */}
      <Separator />
      <VocabPicker
        title="情绪"
        options={emotionOptions}
        selected={filters.emotions}
        onChange={(next) => filters.setMulti('emotions', next)}
      />
      <Separator />
      <VocabPicker
        title="场景"
        options={sceneOptions}
        selected={filters.scenes}
        onChange={(next) => filters.setMulti('scenes', next)}
      />
      <Separator />
      <VocabPicker
        title="标签"
        options={tagOptions}
        selected={filters.tags}
        onChange={(next) => filters.setMulti('tags', next)}
      />
    </div>
  )
}
