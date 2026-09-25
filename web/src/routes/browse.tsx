/**
 * 浏览页：**检索与筛选合一的那条列表**（`GET /memes`，游标分页 + 无限滚动）。
 *
 * 2026-09-26（裁定 1）：`?q=` 与七个词表维度落在同一串参数上，先过滤后召回，
 * 所以这一页既是「筛着翻」也是「搜着翻」——**不再有第二个列表页**。
 *
 * 同日稍晚：首页改版把它自己那段结果整个砍了（SPEC §9.30），搜索框只把人送到
 * `?q=` 这里来。于是**全应用只剩这一条列表**，而 `/?q=…` 的老链接在 `App.tsx` 里
 * 重定向到这一页。
 *
 * 这一层只做**布局与编排**，三件事分别住在 `features/browse/`：
 *   · `use-browse-filters` —— URL ↔ 接口参数，**筛选与查询词的唯一真源**
 *   · `use-browse-list`    —— 列表、分页、本地变更
 *   · `use-browse-actions` —— 发送 / 收藏 / 删除 / 编辑侧边栏（操作反馈在右上角 toast）
 *
 * ## 布局：md 以上**页面本身不滚动**，两列各自滚（2026-09-22 第二稿）
 *
 * 要求是「左栏固定，不跟着右栏一起滚」。最早用的是 `position: sticky`，**做不到**，
 * 实测把原因量清楚了：
 *
 * ```text
 *   可粘余量 = 容器高 − 左列高
 *   左列高   = max-height = 100vh − 顶栏        （当时 163 个 chip 永远撑满，不缩）
 *   容器高   = max(左列高, 结果列高)             （md:items-start，两列各按自己长）
 * ```
 *
 * 于是**只要结果列比视口矮，余量就是 0**，左列整段跟着页面走：1920×1080 与 2560×1440
 * 上结果列只有 871 高（< 1024 / 1384），左栏一路跟着滚；1280×800 上结果列 865 > 744
 * 才真钉住。滚程那 48px 来自外壳 `p-6` 的上下内边距，滚到底还会再释放 24px。
 * 一句话：**sticky 版左栏的「固定」取决于结果列有多高**，图片少的时候立刻失效。
 *
 * 所以改成外壳式布局：md 以上的容器高度钉死为 `100svh − 顶栏`，两列各自内部滚动，
 * 文档不滚——左栏因此**无条件不动**，与结果多少、视口多高都无关。
 *
 * ```
 *   md:-my-6   抵消外壳 `p-6` 的上下内边距（同一个 6，改一个要改另一个），
 *              不抵消的话容器下移 24px，页面又多出 48px 可滚，左栏照样跟着漂
 *   md:h-…     减去顶栏（--app-header-h，见 index.css）
 *   md:py-6    加回来：容器正好铺满顶栏以下，而两列的位置与改前一模一样
 *   svh        外壳是 min-h-svh（sidebar-wrapper），两把尺要一样，否则在浏览器 UI
 *              会收起的设备上页面还能滚 `vh − svh` 那一段
 * ```
 *
 * 无限滚动的观察点不受影响：`IntersectionObserver` 的 `root` 是 null（视口），
 * 祖先裁剪会照算——sentinel 在列内滚到视口里照样触发下一页（实测见任务文件）。
 *
 * ## 第三稿（同日）：分栏可拖、两处滚动换成 shadcn 的 ScrollArea
 *
 * 用户看过截图后提的：此前是 `mx-auto max-w-6xl`，1600px 窗口两侧各留 96px 死白
 * （2560 上是 552px），左栏离左沿很远。要的是「左栏在左、右栏占满」，外加
 * 「两处滚动换成 shadcn 的滚动条组件、分栏换成可拖宽的组件」。于是：
 *
 * - **容器不再封顶**：masonic 按容器宽度算列数，铺满就铺满。代价记在这儿——
 *   2560px 下是十三列左右，单张图仍然 160px 起（`columnWidth={160}`），
 *   不会跟着窗口变大；想让图变大得动 masonic 的参数，那是另一件事。
 * - `ResizablePanelGroup` 是**唯一的**两列容器，手机上靠 `max-md:` 退回普通块级堆叠，
 *   **不是** JS 分支：`BrowseResults` 只能有一份实例，两份就是两个
 *   `IntersectionObserver` + 两次取数（何况 `useIsMobile()` 在手机上会先画一帧桌面版）。
 *   Panel 那些 `flex-basis` 是行内样式，块级上下文里不起作用，所以 `max-md:block`
 *   之后两个面板就是普通的 auto 高块；手机上分隔条与筛选列都 `hidden`，面板塌成 0 高。
 * - 结果列的滚动容器**就是** ScrollArea 的 viewport，`scroller` 那个 state 把它交给
 *   瀑布流（masonic 的虚拟化要自己喂 `scrollTop`，理由见 BrowseResults 的文件头）。
 *   此前那套 `scrollbar-gutter: stable` 不再需要：Radix 的滚动条是**浮层**、不占宽，
 *   「竖条出现 → 容器窄 15px → 列数变少 → 墙变矮 → 竖条消失」这条回路从根上不存在。
 *
 * ## 第四稿（2026-09-26）：搜索带横在两列**上面**，占满内容宽
 *
 * 形状定了三次，第三次才是要的样子——产品负责人的两句话：「搜索也要放在上面」、
 * 「而且也要占满宽度」。所以搜索**不在结果列里**，而是分栏组**上面一整条**：
 *
 * ```text
 *   ┌──────────────────────────────────────────────┐
 *   │ [ 用一句话描述你要找的图…            ] [搜索] │ ← 搜索带（整宽、md 以上钉住）
 *   ├────────────┬─────────────────────────────────┤
 *   │ 筛选列     │ 结果列（两根列各自滚）          │
 *   └────────────┴─────────────────────────────────┘
 * ```
 *
 * 结构上外层多了一根纵向 flex：外层拿高度（`100svh − 顶栏`，`md:-my-6` + `md:py-6`
 * 那套一个字没改，只是从分栏组挪到了外层），搜索带 `shrink-0`、分栏组 `md:flex-1 md:min-h-0`
 * ——**余量由 flex 分配，算式里不需要加搜索带这一项**。
 *
 * ⚠️ 分栏组自己那行内 `height: 100%` 要用 `md:h-auto!` 压掉：不压的话它按外层整高排，
 * 搜索带会被顶到可视区外面去（行内样式只服 `!important`，原因见 `ui/resizable.tsx`）。
 *
 * 两条走过的弯路，记下来免得再来一遍：
 *   · 第三稿把搜索框放进**结果列的滚动区**：省事，但滚下去就看不见了；
 *   · 第四稿初版把它**钉在结果列顶上**：滚不掉了，可它只占右列、还被 `max-w-2xl`
 *     封在 672px（「别横铺到头」是当时的理由，产品负责人否掉：搜的是一整句话，
 *     而这一条是这一页的主入口）。
 *
 * 搜索框本身同日也试过多行（`SearchBar` 的 `multiline`），**当天换回单行**——输入框在左、
 * 按钮在右，与首页那条路逐字一致。那个分支已删，别再恢复：要恢复先问，多行框的坑
 * （`Textarea` 没有 `forwardRef`、`TOUCH` 会压掉注册表的 `min-h-16`）不在代码里了。
 */

import * as React from 'react'
import { SearchBar } from '../components/SearchBar'
import { Button } from '../components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../components/ui/resizable'
import { ScrollArea } from '../components/ui/scroll-area'
import { useAuth } from '../contexts/auth'
import { BrowseFilterSheet } from '../features/browse/BrowseFilterSheet'
import { BrowseFilters } from '../features/browse/BrowseFilters'
import { BrowseResults } from '../features/browse/BrowseResults'
import { useBrowseActions } from '../features/browse/use-browse-actions'
import { useBrowseFilters } from '../features/browse/use-browse-filters'
import { useBrowseList } from '../features/browse/use-browse-list'
import { MemeEditPanel } from '../features/manage/MemeEditPanel'
import { TOUCH } from '../lib/touch'

export function BrowsePage() {
  const { user } = useAuth()
  const filters = useBrowseFilters()
  const list = useBrowseList(filters.params)
  const actions = useBrowseActions(list)
  /*
    结果列的滚动容器。用 state 存元素而不是 ref：瀑布流量测的那个 effect 依赖它，
    而 ref 的 `current` 变化不触发渲染——存 ref 的话第一次量测读到的是 null。
  */
  const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null)

  return (
    <>
      {/*
        外层：md 以上**页面本身不滚动**（只有两根列各自滚），搜索带横在两列**上面**。

        `md:py-6` 不是「顺手加的间距」：它和 `md:-my-6` 一起把内容放回改前的位置
        （顶栏下 24px），见上面那段推导。`max-md:block` 让窄屏退回普通块级堆叠
        （那一档整页在滚，与改前逐字一致）。
      */}
      <div className="flex flex-col max-md:block md:-my-6 md:h-[calc(100svh_-_var(--app-header-h))] md:py-6">
        {/*
          搜索带：**横跨两列、占满内容宽**（产品负责人 2026-09-26 定的形状：
          「搜索也要放在上面」「而且也要占满宽度」）。

          `shrink-0` = 别被下面那根 `md:flex-1` 的分栏组挤扁；`pb-4` 是它与两列之间的
          空档（改前是 `mb-4`）。`md:pr-3` 与结果列的滚动区同值：浮层滚动条压的是
          内容右沿，这边不加的话按钮会比最右一列的图宽出去 12px。

          ⚠️ **`autoFocus={false}`**：这一页是「翻着看」的，进来多半是点筛选或直接滚，
          抢走焦点会让手机上先弹一层键盘盖住半屏；这里的查询词通常也是从 URL 进来的
          （别人分享的链接），不是现打的。理由与闸门写在 `components/SearchBar`。
        */}
        <div className="shrink-0 pb-4 md:pr-3">
          <SearchBar
            value={filters.draft}
            onChange={filters.setDraft}
            onSubmit={filters.commitQuery}
            autoFocus={false}
          />

          {/* 窄屏工具条：抽屉入口 + 快捷「清除」。桌面这行不存在（筛选列常驻在左边） */}
          <div className="mt-3 flex items-center gap-2 md:hidden">
            <BrowseFilterSheet filters={filters} user={user} />
            {filters.hasFilters && (
              <Button variant="ghost" size="sm" className={TOUCH} onClick={filters.clear}>
                清除
              </Button>
            )}
          </div>
        </div>

        {/*
          `md:flex-1 md:min-h-0`：分栏组吃掉搜索带以外的余量——**算式里不用加搜索带这一项**，
          由 flex 分配。两个类各挡一件事：`flex-1` 是「占满剩下的高」，
          `min-h-0` 是「可以矮过内容」（flex 项默认 `min-height: auto`，不给 0 的话
          两根列会被图墙撑高、自己就不滚了，等于退回成整页滚）。

          ⚠️ `md:h-auto!` 压掉库那行内 `height: 100%`：不压的话分栏组按外层整高排，
          搜索带会被顶到可视区外面去（行内样式只服 `!important`，见 `ui/resizable.tsx`）。

          面板尺寸用**数字**（react-resizable-panels v4 的约定：数字=像素，
          无单位字符串=百分比）：220 是筛选列原来的宽度；可拖范围 168（再窄 chip 就得换行）
          到 420。`groupResizeBehavior="preserve-pixel-size"` 让窗口变大时**筛选列宽度不变**，
          多出来的全归结果列——这就是「左栏固定、右栏占满」的字面意思。
        */}
        <ResizablePanelGroup
          orientation="horizontal"
          className="max-md:block! max-md:h-auto! md:h-auto! md:min-h-0 md:flex-1"
        >
          {/* 桌面筛选列。手机上 `hidden`（那时走 `BrowseFilterSheet` 抽屉）。 */}
          <ResizablePanel
            id="filters"
            defaultSize={220}
            minSize={168}
            maxSize={420}
            groupResizeBehavior="preserve-pixel-size"
            className="hidden md:block"
          >
            {/*
              `pr-3` 是留给滚动条的：Radix 的竖条是**浮层**，绝对定位在 Root 的右沿，
              而 viewport 是 `size-full`（撑满内容盒）——不留这几像素，筛选内容的右端
              会被浮层压住 8px。结果列同理（那边被压的是最右一列的图）。
            */}
            <ScrollArea className="h-full pr-3 [&>[data-slot=scroll-area-viewport]]:overscroll-contain">
              <BrowseFilters filters={filters} user={user} />
            </ScrollArea>
          </ResizablePanel>

          {/*
            拖拽手柄。`mx-3` 撑出两列之间的空档（改前是 `md:gap-6` 的 24px），
            1px 的线因此落在正中间。可见的那 1px 当然不到 44px 触摸目标，
            但**这条路径只在 md 以上存在**，且库自己给粗指针留了 37px 的命中区
            （`resizeTargetMinimumSize` 的默认值），不会「按不准」。
          */}
          <ResizableHandle className="mx-3 hidden md:flex" />

          <ResizablePanel id="results" minSize={320}>
            {/*
              **不要**往滚动区里塞内边距：瀑布流按容器的 `offsetWidth` 算列数，
              内边距会把最后一列顶出去。

              Radix 会在 viewport 里套一层 `display:table` 的行内样式 div，块级孩子
              进表里按收缩宽度算——实测瀑布流容器的 `offsetWidth` 仍是满宽
              （那层带着 `min-width:100%` 兜底），列数与改前逐字相同，所以没有加
              `[&>div]:block!`。**别照抄别人的写法**：这里加不加以量出来的列数为准，
              见任务文件的验收数字。

              `h-full`：面板的高度是定的（分栏组 `md:flex-1`），滚动区撑满它。
              **窄屏这一档它不生效也不该生效**：面板那时是普通块（`max-md:block!`）、
              高度 auto，滚动区高度由内容决定，滚的是整页——与改前逐字一致
              （`BrowseResults` 的 `useScrollMetrics` 正是按「谁真的在滚」判的）。
            */}
            <ScrollArea
              viewportRef={setScroller}
              /* `md:pr-3` 的 `md:` 不能省：手机上这个 viewport 不滚、没有滚动条可躲，
                 白扣掉的 12px 正好让列数从 2 掉到 1（(330+12)/172 = 1.98），
                 而 2 列才是这一档原来的样子。 */
              className="h-full md:pr-3 [&>[data-slot=scroll-area-viewport]]:overscroll-contain"
            >
              <BrowseResults
                list={list}
                user={user}
                searching={filters.query !== ''}
                scrollEl={scroller}
                onSend={(t) => void actions.send(t)}
                onEdit={(meme) => actions.openEditor(meme.id)}
                onRemove={actions.remove}
              />
            </ScrollArea>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/*
        编辑侧边栏。key 用 meme.id：换一张图时组件要重挂，草稿才有正确的初始值——
        同一个组件实例上换 props 会让草稿停留在上一张图的标签上。

        挂在分栏之外：它是个 Sheet（portal 到 body），挂哪一层都不影响布局，
        留在里面反而会在跨断点时被连带重挂、把草稿丢掉。
      */}
      {actions.editingMeme !== null && (
        <MemeEditPanel
          key={actions.editingMeme.id}
          meme={actions.editingMeme}
          currentUserId={user?.id ?? null}
          onClose={actions.closeEditor}
          onSaved={actions.handleSaved}
        />
      )}
    </>
  )
}
