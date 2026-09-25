/**
 * 列表页顶部那三块**状态说明**：降级、改写、空结果（SPEC §6.3.1）。
 *
 * 2026-09-26 从 `features/search/SearchResults.tsx` 提出来：合流之后**搜索结果区与
 * 浏览列表是同一个列表**，这三块要同时挂在两处（首页还留着冻结的 `/search` 那条路，
 * 见 [state-navigation.md §6](../agents/rules/state-navigation.md)）。留两份就是
 * 「同一件事两处呈现」——改一处就漂，而其中一处刚好是页面上唯一告诉用户
 * 「这次结果可能不全」的地方。
 *
 * ⚠️ **同日稍晚，第二处没了**：首页改版把首页那条搜索结果整个砍掉（SPEC §9.30），
 * 带 `?q=` 的老链接重定向到 `/browse`，于是**这三块今天的唯一挂载点是浏览页**。
 * 提取没有白做——留在 `SearchResults.tsx` 里的话它现在会跟着那个文件一起被删掉，
 * 而 `BrowseResults` 要用的是同一份。**留在这里、别搬回 feature 里**：它的下一处
 * 挂载点可能又是别的地方。
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
 * ## 撑满 + 下边距（2026-09-26 改，此前的理由是「`w-fit` 而不是撑满」）
 *
 * 原来写的是 `w-fit`：内容列到 1152px，一句 30 字的说明撑满一条横幅会留下一大片空白。
 * 产品负责人看过之后要求**占满宽度**，并**留出下边距**——理由站得住：这几块是**状态说明**，
 * 是「这一屏的结果是这么来的」的横幅，宽度跟着结果走才读得出「它在说下面这一整块」；
 * 缩成一小条反而像内容本身（与 [styling.md](../agents/rules/styling.md)「文案要有承载物」
 * 是同一条思路的另一半）。`mb-4` 与搜索带那条 `pb-4` 同值，是这块地方的行距。
 *
 * 三块现在都是撑满的（空结果那块一直是块级撑满，只有这两条曾经是 `w-fit`）。
 *
 * ⚠️ **曾经有两个挂载点，下边距不一样**（2026-09-26 量过并写进验收断言）：浏览页那处是
 * 块级流，相邻兄弟的外边距会折叠 → 面板之间、面板到图墙都是 **16px**；首页那处是
 * `flex flex-col gap-3`，flex 里外边距**不**折叠 → 12 + 16 = **28px**。
 * 首页那个挂载点当天稍晚随首页改版消失，所以**这 28 那个数现在没有消费者**；
 * 留在这里是因为「挂到 flex 容器里会变 28」这件事与挂载点无关，哪天再挂一处就要重量。
 */

import type { ReactNode } from 'react'
import { SearchX, Sparkles, TriangleAlert } from 'lucide-react'
import { cn } from '../lib/utils'

const NOTICE = 'mb-4 flex w-full items-start gap-2 rounded-2xl border bg-card px-3 py-2 text-sm'

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
