/**
 * 窄屏（<768px）的筛选入口：一个抽屉。
 *
 * 迁移前这一档是「把 163 个 chip 排在图片前面」，进页第一屏一张图都看不到。收进抽屉之后
 * 内容列从第一屏起就是图。
 *
 * 断点取 `md`(768) 而不是迁移前 `styles.css` 里的 640：**全站只有一个手机断点**，
 * 就是外壳那一套（shadcn 侧边栏 / `useIsMobile` 的 768）。641–767px 这一档因此也变成
 * 抽屉 + 满宽瀑布流（迁移前是 chip 墙压在图上）——这是有意的，记在任务文件里。
 */

import { SlidersHorizontal, X } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../../components/ui/sheet'
import type { User } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { BrowseFilters } from './BrowseFilters'
import type { BrowseFiltersState } from './use-browse-filters'

export function BrowseFilterSheet({
  filters,
  user,
}: {
  filters: BrowseFiltersState
  user: User | null
}) {
  return (
    <Sheet>
      {/* 触发器就是抽屉关掉后的焦点落点——Radix 会还给它，所以这里不用手写「焦点交回」 */}
      <SheetTrigger asChild>
        <Button
          variant="outline"
          className={TOUCH}
          /* 角标那枚数字会被并进可读名（读出来是「筛选1」），给了 label 才说得清它是什么。
             `aria-label` 只换可读名，按钮上的文字不受影响。 */
          aria-label={
            filters.activeCount > 0 ? `筛选，${filters.activeCount} 个条件生效` : '筛选'
          }
        >
          <SlidersHorizontal className="size-4" />
          筛选
          {/* 角标是「有几个条件正在生效」：抽屉关着的时候，用户唯一能看出筛选没清干净的地方 */}
          {filters.activeCount > 0 && <Badge variant="secondary">{filters.activeCount}</Badge>}
        </Button>
      </SheetTrigger>

      <SheetContent
        side="left"
        // 注册表那枚关闭按钮是 `size="icon-sm"`（32px，低于 44）且没有再传 className 的口子，
        // 所以关掉它、自己放一个（同 `AppSidebar` / `MemeEditPanel` 对注册表缺陷的做法）。
        showCloseButton={false}
        /*
         * 宽度要带**同一个 `data-[side=left]:` 前缀**才盖得住注册表的 `w-3/4`（变体不同不合并）。
         * 高度保持注册表的 `inset-y-0`（**全高**）：顶栏 `z-20` 在 Radix 这层（`z-50`）之下，
         * 抽屉与遮罩都盖得住它——2026-09-22 那天曾反过来给顶栏抬到 `z-60`、再让抽屉
         * 从顶栏下沿开始，结果是两条同时在屏幕上（`App.tsx` 有完整推导）。
         */
        className="data-[side=left]:w-[85vw]"
      >
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b px-6 py-4">
          {/* `SheetTitle` 不能省：没有它 Radix 不产出 `aria-labelledby`，
              而本仓把 Radix 的 dev 警告打桩掉了——漏了不报错，只是读屏读不出这是哪一层 */}
          <SheetTitle>筛选</SheetTitle>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className={TOUCH} aria-label="关闭">
              <X className="size-4" />
            </Button>
          </SheetClose>
        </SheetHeader>

        {/* 只让中间这段滚、标题常驻（同 MemeEditPanel 的结构）：六个维度共 190 个 chip，
            展开两三维就比屏幕长了（收起时不长，但常驻标题对两种情形都不亏） */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 py-4">
          <BrowseFilters filters={filters} user={user} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
