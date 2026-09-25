/**
 * 浏览页的结果列：**搜索框** + 骨架 / 空 / 错误三态 + 瀑布流 + 无限滚动的观察点。
 *
 * 状态顺序与迁移前逐条相同（骨架在首屏、sentinel 在瀑布流之后）——变过三处：
 * 错误态从「一段手写文字 + 裸 button」换成了 `Alert`；原本排在图上面的那条页级
 * 反馈（复制 / 删除的结果）2026-09-24 搬去了右上角 toast（`lib/toast.tsx`），
 * 这一列于是不再有「反馈」这一态；**2026-09-26（裁定 1 合流）**多了一块东西——
 * 检索的三条状态说明（降级 / 改写 / 空结果，`components/Notice`）从搜索结果区
 * 搬了过来，搜索框也从首页搬了过来（不然 `/browse?q=` 只能靠手打地址进）。
 *
 * ## 瀑布流为什么不用现成的 `<Masonry>`（2026-09-22，改外壳式布局时发现的真问题）
 *
 * `<Masonry>` 自带的滚动位置来自 `useScroller()`，而那个 hook 读的是
 * **`window.scrollY`**（`@react-hook/window-scroll`）。md 以上页面已经不滚了、
 * 滚的是结果列，于是它量到的 `scrollTop` **恒为 0**，可见范围永远钉在
 * `[0, window.innerHeight × overscanBy]`——1600×900 上是墙的前 2700px。
 *
 * 后果不是「性能差一点」，是**滚到下面一片空白**：容器高度按全部条目算（4065px），
 * 而里面只摆了前 2700px 的格子；越滚越空，无限滚动还在往下追加，空白只会更长。
 * 实测：90 条 6 列，滚到列底时最低的那张图在视口上方 400px 处，底下全空。
 *
 * 所以这里改用 masonic 的**原语**自己喂滚动量（`useMasonry` 的 `scrollTop` / `height`
 * 文档里写明了这种用法：「在别的元素里渲染网格时，传那个元素的 `scrollTop` /
 * `offsetHeight`」）。`offset` 也照 `useScroller()` 的语义减掉：墙的上方还有
 * 手机工具条这些元素，它们占掉的高度不该算进「已经滚过了多少」。
 *
 * 两个滚动源都走同一段代码：**桌面是 ScrollArea 的 viewport**（`scrollEl`），
 * **手机不给 `scrollEl`**、退回窗口（整页在滚，与改动前一致）。
 */

import {
  useMasonry,
  usePositioner,
  useResizeObserver,
  type RenderComponentProps,
} from 'masonic'
import { TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { MemeGallery } from '../../components/ImageViewer'
import { MemeCard } from '../../components/MemeCard'
import { DegradedNotice, EmptyNotice, RewrittenNotice } from '../../components/Notice'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { matchedBadges, type Meme, type User } from '../../lib/api'
import type { SendTarget } from '../../lib/clipboard'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { MemeActions } from '../manage/MemeActions'
import type { BrowseList } from './use-browse-list'

/** 一屏骨架的格数。**与结果无关，只是占位**——够铺满一屏即可。 */
const SKELETON_COUNT = 12

/**
 * 骨架网格。`minmax(160px,1fr)` / `gap-3` 与 masonic 的 `columnWidth={160}` /
 * `columnGutter={12}` 是同一笔账：骨架与首屏结果尺寸不一致的话，骨架消失那一刻整页重排。
 *
 * 自己写死这一份，不从别处 import：骨架格数要跟着**这一页的列宽**走，而全仓只有这一处
 * 是 160px 列的瀑布流（首页图墙那张网格是 5 列等分，分档方式都不同）。
 */
const SKELETON_GRID =
  'grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]'

export function BrowseResults({
  list,
  user,
  searching,
  scrollEl,
  onSend,
  onEdit,
  onRemove,
}: {
  list: BrowseList
  user: User | null
  /**
   * 这一次列表带不带查询词（`use-browse-filters` 的 `query !== ''`）。
   *
   * 只用来决定**空结果那句话怎么说**：带 `q` 是「检索没召回到」，不带是「筛没了」。
   * 不在这里判「要不要走检索分支」——那由 `params` 决定，服务端说了算（SPEC §6.3）。
   */
  searching: boolean
  /**
   * 瀑布流所在的滚动容器（桌面是 ScrollArea 的 viewport）。**不给就是「整页在滚」**，
   * 手机端如此——那时 masonic 按窗口算，与迁移前一致。
   */
  scrollEl?: HTMLElement | null
  onSend: (target: SendTarget) => void
  onEdit: (meme: Meme) => void
  onRemove: (meme: Meme) => Promise<void>
}) {
  const { items, loading, initialDone, error, degraded, rewritten, epoch, sentinelRef } = list

  return (
    <>
      {!initialDone && loading && (
        <div className={SKELETON_GRID} aria-busy="true">
          {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            // `motion-reduce:animate-none` 不能省：注册表的 Skeleton 只有 animate-pulse
            <Skeleton
              key={i}
              aria-hidden="true"
              className="aspect-square motion-reduce:animate-none"
            />
          ))}
        </div>
      )}

      {/*
        检索的两条状态说明（SPEC §6.3.1）。**降级不是错误**：结果照常出，这里只说一句，
        不遮挡、不阻断（http.md §5）。无 `q` 时 `degraded` 恒 false、`rewritten` 恒 null，
        所以浏览态下这两块不会出现——不需要再判一次有没有 `q`。
      */}
      {degraded && <DegradedNotice />}
      {rewritten && <RewrittenNotice rewritten={rewritten} />}

      {initialDone && items.length === 0 && !loading && !error && <EmptyNotice searching={searching} />}

      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
            {/* requestId 必须露出来，报问题时它是唯一能对上服务端日志的东西（http.md §3） */}
            <p className="font-mono text-xs">requestId: {error.requestId}</p>
            <Button variant="outline" size="sm" className={cn(TOUCH, 'mt-2')} onClick={list.retry}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {items.length > 0 && (
        // 给的是**原始那批**，不是下面 `map` 出来的那份：全屏只认图，多出来的几个回调
        // 是图墙自己的事。滚到底新加载的那一批会接在后面，所以「翻到下一张」能一直翻下去。
        <MemeGallery items={items}>
          <BrowseWall
            // 换 key 强制重挂，位置器从零重建（删除让 items 缩短时必需，见 use-browse-list 的 epoch）
            key={epoch}
            scrollEl={scrollEl ?? null}
            items={items.map((meme) => ({
              meme,
              favorite: () => list.applyFavorite(meme),
              send: (t: SendTarget) => void onSend(t),
              edit: () => onEdit(meme),
              remove: () => onRemove(meme),
              // 编辑对所有人开放，删除只限上传者与 admin（SPEC §6.4 / §9.1）。
              // 前端判断只是体验，服务端仍会独立判一次。
              canDelete: user?.role === 'admin' || meme.uploaderId === user?.id,
            }))}
            itemKey={(item) => item.meme.id}
          />
        </MemeGallery>
      )}

      {/* sentinel —— 无限滚动观察它。`h-px` 不能写成 0 高：`threshold: 0.1` 对零面积元素
          永远不触发（而且不报错，表现是「滚到底不再加载」） */}
      <div ref={sentinelRef} className="mt-6 h-px" aria-hidden="true" />

      {loading && initialDone && <p className="text-center text-sm text-muted-foreground">加载中…</p>}
    </>
  )
}

// ---- 瀑布流 ----

/** 与 `SKELETON_GRID` 的 `minmax(160px,1fr)` / `gap-3` 是同一笔账，改一个要改另一个。 */
const COLUMN_WIDTH = 160
const COLUMN_GUTTER = 12
/** 图还没量出来时按多高占位。也决定首屏那一批先渲染多少格。 */
const ITEM_HEIGHT_ESTIMATE = 220
/** 视口上下各多渲染几屏。masonic 里这个系数是乘在 `height` 上的。 */
const OVERSCAN_BY = 3
/**
 * 滚动采样的节流（ms）。masonic 的 `scrollFps` 默认 12（≈83ms）就是干这个的：
 * 每次采样都要重算可见范围，跟着 60fps 走纯属浪费。
 */
const SAMPLE_MS = 80
/** 停手多久算「不滚了」。决定什么时候撤掉 `will-change` / `pointer-events`。 */
const IDLE_MS = 130

/**
 * 量「谁在滚，滚到哪了」，喂给 masonic。
 *
 * **滚动源由「谁真的在滚」决定，不由断点决定**：给了 `scrollEl` 但它其实不滚
 * （手机上那个 viewport 高度是 auto、跟着内容长，滚的是整页），就退回窗口。
 * 这样两端都能走虚拟化——按断点分叉的话，手机就得整份渲染出来（DOM 会随着
 * 无限滚动一直长），而这正是 masonic 存在的理由。
 *
 * ```text
 *   元素滚动（md 以上）  读 scrollEl.scrollTop / clientHeight
 *   整页滚动（手机）     读 window.scrollY / innerHeight
 * ```
 *
 * `offset` 一律减掉——墙的上方还有工具条，它的高度不是「已经滚过的量」。
 * 这一步等价于 masonic 自己 `useScroller(offset)` 里的 `max(0, scrollTop - offset)`。
 *
 * 返回的 `read()` 要给瀑布流那个 ResizeObserver 一起调：**内容长到超过一屏时
 * 不发 scroll 事件**，模式切换以及「又追加了一页」都靠它把新尺寸量进来。
 */
function useScrollMetrics(
  scrollEl: HTMLElement | null,
  wallRef: React.RefObject<HTMLElement | null>,
) {
  const [size, setSize] = React.useState({ height: 0, scrollTop: 0 })
  const [isScrolling, setIsScrolling] = React.useState(false)

  const read = React.useCallback(() => {
    const wall = wallRef.current
    /*
      能不能滚，看 scrollHeight 而不是「有没有传 scrollEl」。
      1px 的容差是给子像素舍入的：正好相等时算「不滚」，走窗口。
    */
    const scroller =
      scrollEl !== null && scrollEl.scrollHeight > scrollEl.clientHeight + 1 ? scrollEl : null

    let next: { height: number; scrollTop: number }
    if (scroller === null) {
      // 墙顶在文档里的 y：没有滚的祖先位移时 rect.top + scrollY 就是它
      const wallTop = wall === null ? 0 : wall.getBoundingClientRect().top + window.scrollY
      next = { height: window.innerHeight, scrollTop: Math.max(0, window.scrollY - wallTop) }
    } else {
      const inContent =
        wall === null
          ? 0
          : wall.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop
      next = { height: scroller.clientHeight, scrollTop: Math.max(0, scroller.scrollTop - inContent) }
    }

    setSize((prev) =>
      prev.height === next.height && prev.scrollTop === next.scrollTop ? prev : next,
    )
  }, [scrollEl, wallRef])

  React.useLayoutEffect(() => {
    let sample: ReturnType<typeof setTimeout> | undefined
    let idle: ReturnType<typeof setTimeout> | undefined

    const onScroll = () => {
      setIsScrolling(true)
      if (sample === undefined) {
        sample = setTimeout(() => {
          sample = undefined
          read()
        }, SAMPLE_MS)
      }
      if (idle !== undefined) clearTimeout(idle)
      idle = setTimeout(() => setIsScrolling(false), IDLE_MS)
    }

    // 挂载时就量一次：不量的话第一屏按 0 高算，什么都渲染不出来
    read()
    // 两个都听着：模式由 read() 现场判定，谁滚都收得到
    window.addEventListener('scroll', onScroll, { passive: true })
    scrollEl?.addEventListener('scroll', onScroll, { passive: true })
    // 高度还会因为窗口缩放、拖分隔条而变，这两种都不发 scroll 事件
    const observer = scrollEl === null ? null : new ResizeObserver(read)
    observer?.observe(scrollEl as HTMLElement)
    window.addEventListener('resize', read)

    return () => {
      window.removeEventListener('scroll', onScroll)
      scrollEl?.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', read)
      observer?.disconnect()
      clearTimeout(sample)
      clearTimeout(idle)
    }
  }, [scrollEl, read])

  return { ...size, isScrolling, read }
}

/**
 * 瀑布流本体。用 masonic 的原语自己拼，等价于 `<Masonry>` 去掉它自带的
 * `useScroller`（理由见文件头）。四件事一件不能少：
 *
 * 1. **宽度**自己量（`useLayoutEffect` + `ResizeObserver`）：`<Masonry>` 用
 *    `useContainerPosition` 干这个，列数由容器宽决定，拖分隔条时也得跟着变。
 *    放在 layout effect 里是为了首帧就拿到真宽度——放 effect 里会先按 0 宽算出一列再重排。
 * 2. `usePositioner` 建位置器，`useResizeObserver` 让图量出来之后重排。
 * 3. `scrollTop` / `height` 由 `useScrollMetrics` 给（不取窗口）。
 * 4. `render` 必须是模块级稳定引用，见下面那段注释。
 */
function BrowseWall({
  items,
  itemKey,
  scrollEl,
}: {
  items: BrowseMasonryItem[]
  itemKey: (item: BrowseMasonryItem) => string
  scrollEl: HTMLElement | null
}) {
  const wallRef = React.useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = React.useState(0)
  const { height, scrollTop, isScrolling, read } = useScrollMetrics(scrollEl, wallRef)

  const positioner = usePositioner({
    width,
    columnWidth: COLUMN_WIDTH,
    columnGutter: COLUMN_GUTTER,
  })
  const resizeObserver = useResizeObserver(positioner)

  /*
   * 量宽度。两个坑叠在一起，缺一个就退化成「一列」：
   *
   * 1. **首帧读到的 0 是真的**：面板宽度由 react-resizable-panels 自己算，
   *    它要等自己的 ResizeObserver 报数（实测：`offsetWidth` 先是 0，随后才是 1039）。
   *    所以只能靠 observer 把后来的宽度补上，一次性的首读不够。
   * 2. **容器元素会被换掉**：`useMasonry` 用 `key={didEverMount}` 在首帧之后重挂一次容器
   *    （为了 SSR 水合），observer 要是不跟着换，就永远盯着一个已经摘掉的节点——
   *    之后宽度怎么变都不再有回调。第一版就是栽在这儿：`offsetWidth` 是 1039，
   *    React 里的 `width` 停在 0，位置器按 1 列算，24 张图在 1039px 宽度里排成一竖条。
   *
   * 无依赖的 layout effect 只做一次 `===` 比较（不触发重排），元素没换就直接 return；
   * 换了才断开旧的、观察新的。宽度相等时 `setWidth` 返回原值，不会自激。
   */
  const measured = React.useRef<{ el: HTMLElement; observer: ResizeObserver } | null>(null)
  const measure = React.useCallback((el: HTMLElement) => {
    setWidth((prev) => (prev === el.offsetWidth ? prev : el.offsetWidth))
  }, [])

  /*
   * 墙的尺寸一变（追加了一页、图片量出真实高度）就顺手重新量一次滚动量：
   * 「内容长到超过一屏」这个时刻不发 scroll 事件，可它正是滚动源从窗口切到元素的那一下。
   * `read` 存进 ref 是因为元素没换时下面的 effect 直接 return，observer 里闭包着的
   * 会是旧那份 `read`（旧 `scrollEl`）。
   */
  const readRef = React.useRef(read)
  React.useEffect(() => {
    readRef.current = read
  }, [read])

  React.useLayoutEffect(() => {
    const el = wallRef.current
    if (el === null) return
    measure(el)
    if (measured.current?.el === el) return
    measured.current?.observer.disconnect()
    const observer = new ResizeObserver(() => {
      measure(el)
      readRef.current()
    })
    observer.observe(el)
    measured.current = { el, observer }
  })

  // 卸载时收掉最后一个 observer
  React.useEffect(() => () => measured.current?.observer.disconnect(), [])

  return useMasonry<BrowseMasonryItem>({
    positioner,
    resizeObserver,
    items,
    itemKey,
    containerRef: wallRef,
    scrollTop,
    isScrolling,
    height,
    overscanBy: OVERSCAN_BY,
    itemHeightEstimate: ITEM_HEIGHT_ESTIMATE,
    render: BrowseMasonryCell,
  })
}

// ---- 瀑布流单元格 ----

/**
 * 瀑布流单元格的载体：一条 meme + 页面注入的回调。
 *
 * 回调要跟着数据走，是因为 masonic 的 `render` 组件必须是**稳定引用**（模块级）——
 * 如果每次渲染都现写一个箭头函数，masonic 会把「render prop 换了新函数」当成换组件，
 * 所有可见卡片重挂，收藏、删除、编辑弹层这些交互的本地状态全被打断。
 * 所以把会变的回调放进 `data`（每帧重算没关系，key 是 meme.id，React 不会重挂）。
 *
 * 卡片本身（图片承载、角标、收藏按钮、比例占位）全在 `components/MemeCard.tsx`，四页共用；
 * 这一层只剩「瀑布流要的回调怎么接上去」。浏览页是四处里**唯一**带「⋯」的。
 */
type BrowseMasonryItem = {
  meme: Meme
  favorite: () => void
  send: (target: SendTarget) => void
  edit: () => void
  remove: () => Promise<void>
  canDelete: boolean
}

function BrowseMasonryCell({ data }: RenderComponentProps<BrowseMasonryItem>) {
  const { meme } = data

  return (
    <MemeCard
      // natural：按 width/height 整张展示、不裁方——表情包的信息常在边缘，
      // 裁掉之后用户认不出这是哪张（styling.md「图片网格」）。
      shape="natural"
      meme={meme}
      /*
        召回来源角标（SPEC §6.3.1）。**浏览态下 `matchedBy` 是 `[]`，角标自然不出现**
        ——所以这里不用判「这次搜没搜」，与服务端「响应形状恒定」是同一条省事的路。

        ⚠️ 它只是提示，**不参与排序**：服务端 RRF 融合后的顺序就是最终顺序，
        `BrowseWall` 按 `items` 原序渲染，不按角标重排（web/AGENTS.md §2）。
      */
      recallBadges={matchedBadges(meme.matchedBy)}
      actions={
        /*
          「⋯」是浏览页唯一的删除 / 编辑 / 发送入口。它是绝对定位的浮层，不占布局，
          弹层因此能探出图片边界（菜单本身走 portal，更不受裁剪影响）。
        */
        <MemeActions
          target={meme}
          canDelete={data.canDelete}
          deleteDeniedReason="只有上传这张图的人或管理员可以删除"
          onSend={(t) => void data.send(t)}
          onEdit={data.edit}
          onDelete={data.remove}
        />
      }
      onFavorite={data.favorite}
    />
  )
}
