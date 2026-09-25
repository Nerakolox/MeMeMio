/**
 * 列表页顶部那三块**状态说明**：降级、改写、空结果（SPEC §6.3.1）。
 *
 * 2026-09-26 从 `features/search/SearchResults.tsx` 提出来：合流之后**搜索结果区与
 * 浏览列表是同一个列表**，这三块要同时挂在两处（首页还留着冻结的 `/search` 那条路，
 * 见 [state-navigation.md §6](../agents/rules/state-navigation.md)）。留两份就是
 * 「同一件事两处呈现」——改一处就漂，而其中一处刚好是页面上唯一告诉用户
 * 「这次结果可能不全」的地方。
 *
 * ## 为什么不用 `Alert`
 *
 * 它自带 `role="alert"`，而这几条都是**状态说明、不是警报**，抢着打断读屏是错的
 * （[http.md §5](../agents/rules/http.md)「降级不是错误」）。所以手写容器。
 *
 * ## `role` 为什么是个可选 prop，而且默认没有
 *
 * 降级那一条一直带 `role="status"`、改写那一条一直没有——**这是提取前就有的不对称**，
 * 本次原样保留（首页那条路要求逐字不变），不是新决定的。要统一是另一件事，
 * 得先想清楚「改写提示该不该被读屏主动念」。
 *
 * ## 底色为什么是 `bg-card` + `border` 而不是 `bg-muted`
 *
 * `text-muted-foreground` 落在 `--muted` 上（浅色 `oklch(0.97)`）对比度约 4.3，低于 4.5；
 * 落在 `bg-card` 上就是页面底色（浅色为白，深色为 `oklch(0.205)`），两条都在 4.7 以上。
 * **换底色要重量对比度。**
 *
 * ## `w-fit` 而不是撑满
 *
 * 内容列到 1152px，一句 30 字的说明撑满一条横幅会留下一大片空白。
 */

import type { ReactNode } from 'react'
import { SearchX, Sparkles, TriangleAlert } from 'lucide-react'
import { cn } from '../lib/utils'

const NOTICE = 'flex w-fit items-start gap-2 rounded-2xl border bg-card px-3 py-2 text-sm'

export function Notice({
  children,
  role,
  muted = false,
}: {
  children: ReactNode
  /** 只有降级那一条带它，见文件头「`role` 为什么是个可选 prop」。 */
  role?: 'status'
  muted?: boolean
}) {
  return (
    <div role={role} className={cn(NOTICE, muted && 'text-muted-foreground')}>
      {children}
    </div>
  )
}

/**
 * 向量通路降级（`degraded: true`）。
 *
 * **降级不是错误**：照常展示结果，只在顶部说明一句，不遮挡、不阻断
 * （[http.md §5](../agents/rules/http.md)）。文案是契约的一部分——它说的是
 * 「本次只用了 OCR 和标签匹配」，不是「搜索失败」。
 */
export function DegradedNotice() {
  return (
    <Notice role="status">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      向量通路当前不可用，本次只用了 OCR 和标签匹配，结果可能不全。
    </Notice>
  )
}

/**
 * HyDE 改写结果（`rewritten`）。展示它是为了让用户理解「为什么搜出这些」，
 * 可以不展示（SPEC §6.3.1）——但既然回来了就摆出来，它是这套检索唯一的解释入口。
 */
export function RewrittenNotice({ rewritten }: { rewritten: string }) {
  return (
    <Notice muted>
      <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      搜索理解为：{rewritten}
    </Notice>
  )
}

/**
 * 空结果。这一屏只有这句话，所以它是这块地方的**唯一内容**——给一个居中的空态块，
 * 不是一行浮在空白里的字。
 *
 * ⚠️ **两种成因说两句不同的话**：带 `q` 是「检索没召回到」（换个说法可能就有了），
 * 不带 `q` 是「筛没了」（换的是筛选条件，不是说法）。合成一句会有一半的时候在误导。
 * 第三种成因（这一页的条目被删光了）客户端区分不了，也不需要——`nextCursor` 已经
 * 把「还有没有下一页」答了（SPEC §6.3.1）。
 */
export function EmptyNotice({ searching }: { searching: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border bg-card px-6 py-8 text-center">
      <SearchX className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">
        {searching ? '没有找到相关的图，换个说法试试' : '没有符合条件的图片'}
      </p>
    </div>
  )
}
