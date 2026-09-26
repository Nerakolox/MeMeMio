import { useContext, useEffect, useMemo, useRef } from 'react'
import Lightbox from 'yet-another-react-lightbox'
import type {
  RenderSlideFooterProps,
  SlideImage,
  SlotStyles,
  ViewCallbackProps,
} from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
// 只这一个：`plugins/zoom.css` 在 3.32.2 里**不存在**（exports 里只有 styles 与
// captions / counter / thumbnails 四个），照习惯补一行会让构建失败。
import 'yet-another-react-lightbox/styles.css'
import type { Meme } from '../lib/api'
import {
  SEND_ICONS,
  SEND_LABELS,
  detectSendPath,
  sendMeme,
  sendNote,
  type SendTarget,
} from '../lib/clipboard'
import { notifySend } from '../lib/toast'
import { TOUCH } from '../lib/touch'
import { usePrefetchShare } from '../lib/use-prefetch-share'
import { cn } from '../lib/utils'
import { VOCAB_DIMENSIONS } from '../lib/vocab'
import { SessionContext, type SessionControls } from './viewer-session'

/**
 * 全屏阅览器本身：`<Lightbox>` 与它那几块自建浮层。**整个应用只有这一份**，
 * 由 `ImageViewer.tsx` 的宿主在**第一次打开阅览时**才加载（`React.lazy`）。
 *
 * ## 为什么单独一个文件
 *
 * 在此之前全屏阅览和 `MemeGallery` / `useImageViewer` 挤在同一个模块里，于是**每一个**
 * 页面——包括从来不打开全屏的那些首屏路径——都得先下载 YARL 与它的样式表。而这份代码
 * 只有当用户真的点开一张图时才用得上。切出去之后首屏那份包里就没有它了。
 *
 * 挂载点在宿主那边，这里只管「画出来」。**宿主与这个模块的通信只能走 props 和
 * `viewer-session.ts` 那个 context**：反向 import（这里 import 宿主）会把切出去的东西
 * 又拽回来，等于白切。
 *
 * ## 焦点不用自己还
 *
 * YARL 在焦点进入时记下 `relatedTarget`，卸载时 `focus()` 回去，已实测。
 * 本仓在 `MemeActions` / `MemeEditPanel` 里手写过两次这件事，这里不需要再补一遍
 * （补了只会和它抢）。
 *
 * ## z-index
 *
 * 默认 `.yarl__portal { z-index: 9999 }`，在 Radix 那一层（`z-50`）之上——全屏阅览本来
 * 就该压过外壳。本仓没有 z-index 总表，这条只在这里记着。
 *
 * ⚠️ 2026-09-22：顶栏是 `z-20`（为修「卡片浮层画到顶栏上面」那个缺陷抬的，见 `App.tsx`）。
 * **9999 > 20，全屏阅览比数值就赢**，与挂载位置无关（当天顶栏一度也是 9999，
 * 那时靠的是 DOM 顺序——portal 排在 `#root` 之后）。这条关系是**一条上限**：
 * 顶栏那个数可以往下调，但**不能加到 9999 以上**，否则阅览器的工具栏会被顶栏盖住。
 *
 * ⚠️ 2026-09-24：**唯一压在阅览器上面的是 toast（`z-index: 10000`）**，这是有意的——
 * `Ctrl+C` 的「已复制」只从 toast 出来，而这里的容器是**不透明黑底**，toast 在它下面
 * 就等于没有反馈（`components/ui/sonner.tsx` 那一段）。所以这里不再是「数值最大的一个」。
 *
 * ⚠️ 但它只**画**在上面：YARL 进这里时给 `#root` 挂了 `inert`（`dist/index.js` 的
 * `handleEnter`，见 `styling.md`「已知缺口」），Toaster 在那棵子树里，所以阅览器开着时
 * toast 上的按钮和链接**点不到**。层级解决不了这件事，别顺手去改 `10000`。
 */
export function LightboxViewer({
  controls,
  slides,
  close,
}: {
  controls: SessionControls
  /** 由宿主 memo 过：给它一个新的数组引用，YARL 会当成换了一批图，重走一遍加载与淡入。 */
  slides: SlideImage[]
  close: () => void
}) {
  const { session, show } = controls

  // 只有一张时不摆翻页按钮与缩略图轨道，见 `RENDER_SINGLE` 与 `viewerStyles` 的注释。
  const multiple = slides.length > 1
  const styles = useMemo(() => viewerStyles(multiple), [multiple])

  /**
   * 停到第 n 张这条路径的**库事件**那一半（翻页按钮 / `←→` / 滑动）：库走完转场之后经
   * `on.view` 回报结果，回报的正是它自己那个值。另一半是缩略图轨道直接调 `show`，
   * 见宿主里的注释。
   *
   * 依赖写 `show` 不写 `controls`：后者随 session 换引用，每次翻页都会重建这个对象，
   * 而 YARL 拿它当配置（同下面那几个模块级常量的理由）。
   */
  const on = useMemo(() => ({ view: ({ index }: ViewCallbackProps) => show(index) }), [show])

  /**
   * 当前这一张。翻页只换 `session.index`、数组引用不动，所以这个引用是稳的——
   * 底下的预取与快捷键都拿它当依赖，依赖它才不会每渲染一次就重挂一遍。
   */
  const current = session?.items[session.index]

  // 触屏那一档要在**渲染时**就把原图取好，按键时才来得及调 `navigator.share`
  // （理由见 `lib/clipboard.ts` 的 `SharePrefetch`）。卡片菜单那一份在 `MemeActions` 里，
  // 这里补的是「全屏看着这张图时按 Ctrl+C」。桌面那两档它什么都不做。
  usePrefetchShare(current)

  /**
   * `Ctrl+C` / `Cmd+C` 复制**当前这一张**。走的是和卡片「⋯」菜单里那一项**同一个函数**
   * （`lib/clipboard.ts` 的 `sendMeme`），所以三条路径的分流、每一句文案都不另写一份——
   * 动图在它上面同样落到「下载」并说明原因，不会按下去没反应（clipboard-share.md §3、§7）。
   *
   * ⚠️ 2026-09-26（裁定 4）起它**不是这一面唯一的入口**了：上面那枚 `SendButton` 是同一个
   * 动作的可见形态，两者调的是同一个 `sendImage`。改分流时两条一起改——但分流本身只有
   * `lib/clipboard.ts` 那一份，这里两处都只是调用点。
   *
   * ## 为什么挂在 `document` 上
   *
   * 阅览器开着时它就是全屏唯一的内容。焦点此刻可能在 YARL 的容器、底部轨道的一格、
   * 或者工具栏按钮上，逐个挂会漏。更要紧的是**焦点根本不在页面那棵树里**：阅览器是
   * portal 到 `body` 的，而页面那一侧（`#root`）此刻被 YARL 标了 `inert`——挂在页面
   * 组件上的 `onKeyDown` 收不到任何东西。`current === undefined` 那道判断让关闭之后
   * 这条路立刻消失——宿主是**常驻**的（`everOpened` 之后不卸载，见 `ImageViewer.tsx`）。
   *
   * ## 三个细节都不是装饰
   *
   * - `ctrlKey || metaKey` 都要：macOS 上那一下是 `Cmd+C`。
   * - `e.repeat` 挡掉按住不放的自动重复。下载那条路上，一次重复就是又一个文件落进下载目录。
   * - `preventDefault()`：浏览器默认动作是「把选区写进剪贴板」，而 `.yarl__container` 是
   *   `user-select: none`（`SlideFooter` 那段注释里记着），本来就没有东西可复制；不挡的话
   *   它会紧接着落一次空内容，和上面那条**异步**写入抢同一个剪贴板。
   */
  useEffect(() => {
    if (current === undefined) return
    // 箭头函数而不是函数声明：函数声明会被提升，TS 因此不认上面那道 `undefined` 收窄
    // （`sendImage` 要的就是一张真的图，不是 `Meme | undefined`）。
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.repeat || e.key.toLowerCase() !== 'c') return
      e.preventDefault()
      void sendImage(current)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [current])

  return (
    <SessionContext.Provider value={controls}>
      <Lightbox
        open={session !== null}
        close={close}
        slides={slides}
        // 库只认这个属性的**变化**：缩略图轨道靠它跳，其余三种翻页是库自己走完再经
        // `on.view` 回报，两边不会各推各的（回报的正是库里那个值）。
        index={session?.index ?? 0}
        plugins={PLUGINS}
        // 这两个手势的默认值**都是 false**。不显式打开的表现是「点了背景没反应」，
        // 而点背景关闭是这类组件的基本预期。下拉关闭是手机上的那份。
        controller={CONTROLLER}
        // 默认的 1 表示最多只能放到 1:1。梗图的信息常是图上压着的一行小字，
        // 放大正是这里的用途（styling.md「图片网格」那条的前提）。
        zoom={ZOOM}
        render={multiple ? RENDER : RENDER_SINGLE}
        styles={styles}
        labels={LABELS}
        on={on}
      />
    </SessionContext.Provider>
  )
}

/**
 * 把一张图发出去。**与首页 / 浏览页是同一条组成**：`sendMeme` 分流、`sendNote` 给文案、
 * `notifySend` 呈现——三者为什么分家写在 `lib/clipboard.ts` 的文件头。
 *
 * ⚠️ 由按键事件直接调起，中间不要先 await 别的请求：剪贴板写入要落在用户手势的同步调用栈里
 * （Safari 对这一条最严格，clipboard-share.md §4.1）。
 */
async function sendImage(target: SendTarget): Promise<void> {
  const note = sendNote(await sendMeme(target))
  if (note !== null) notifySend(note)
}

/**
 * 信息栏里要显示的标签值。**内容分级排最前**，其余按 `VOCAB_DIMENSIONS` 的顺序。
 *
 * 分级回答的是「这张图能不能在这儿出现」，不是「画面在表达什么」，所以它不在
 * 「表情 → 情绪 → 语气 → 用途 → 情境」那条从外到内的轴上（`lib/vocab.ts` 的注释、
 * SPEC §4.3）。排最前是它在界面上唯一的特殊待遇，也是它不被读成第七个语义维度的原因。
 *
 * 这里**不写死七次取值**：将来加维度时，漏掉一维的表现是这个词在信息栏里不出现，
 * 而图片本身照常打开——不报错，所以要靠遍历 `VOCAB_DIMENSIONS` 来免疫。
 *
 * ⚠️ **两个版式（宽屏的右栏、窄屏的底部浮层）都走这一份**，理由就是上面那条：
 * 各写一份的话，漏掉的那一维只会在一个版式里消失。
 */
function labelValues(meme: Meme): string[] {
  const described = VOCAB_DIMENSIONS.filter((d) => d.field !== 'ratings').flatMap(
    (d) => meme[d.field],
  )
  return [...meme.ratings, ...described]
}

/**
 * 阅览器的信息栏（2026-09-22 加，SPEC §9.24）。**这一份是窄屏的**：`lg` 以上换成右侧的
 * `ViewerAside`，内容同一份来源（`labelValues`）但版式不同。两个都渲染，靠断点各自显隐。
 *
 * ## 它为什么存在
 *
 * 在此之前阅览器**一条元数据都不显示**——它只把原图铺满屏幕。而全屏的用途恰恰是
 * 「图上压着的那行小字看不清，放大看看」，此时用户反而不知道自己看的是哪张、什么标签。
 * 卡片上也从不显示标签值，于是「成人向」这类词在界面上根本没有露出的地方。
 *
 * ## 版式：贴合内容宽度，两侧留出可点的背景
 *
 * 外层铺满整宽但 `pointer-events-none`，内层那张卡才接事件。**这条不能省**：YARL 的
 * 「点背景关闭」只认 `event.target` 本身是 `.yarl__slide` / `.yarl__slide_wrapper` 的点击，
 * 一个铺满整宽、能接事件的底栏会把底部那条关闭区整条吃掉（左右两个翻页按钮当年就是这么
 * 坏掉「点背景关闭」的，见下面 `RENDER_SINGLE`）。留出两侧之后，底部只剩中间一小块不可点，
 * 而 `Esc` / `×` / 下拉关闭三条路都还在。（宽屏的 `ViewerAside` 不需要这条：它根本不压在
 * 图上——容器整个缩成了舞台，见 `viewerStyles`。）
 *
 * ## 压在图上就得自己带对比度
 *
 * 底图可能是白的也可能是黑的，所以文字不借主题 token，走 `bg-black/70` + 白字 + 背景模糊
 * ——和 `MemeCard` 的 `BADGE` 同一条思路。`bg-black/70` 压在最亮的图上是 `#4d4d4d`，
 * 纯白字对它 8.1:1，降到 `text-white/75` 也还有 5.3:1，都过 AA。
 *
 * ## 四条库带来的约束（都在 `node_modules` 里实测过）
 *
 * 1. **阅览器里不能滚动**：`.yarl__container` 是 `touch-action: none`，且本仓开了
 *    `closeOnPullDown`。所以描述**只能截断**，`line-clamp` 不是美观选择而是唯一选择
 *    （与 YARL 官方 captions 插件同一档，它是 clamp-3）。窄屏这块地方只有一条，截 2 行。
 * 2. **`.yarl__*` 上写 Tailwind 类是静默失效的**（styling.md「库自带的 CSS 是无层的」）
 *    ——这里全是自建元素，不受影响，但**不要**顺手给 `.yarl__slide` 加类。
 * 3. `.yarl__container` 有 `user-select: none`，信息栏文字**选不中、复制不了**。接受。
 * 4. `.yarl__slide` 是 `overflow: hidden`，超出会被裁掉，所以不做超出屏幕的横向排布。
 *
 * ## 有意不做的
 *
 * 上传者名**不可点**：会变成阅览器里的一个触摸目标（得按指针分档），而应用里并没有
 * 「某个人的图」这个页面。整条信息栏是纯展示，44×44 那条约束管的是触摸目标，不适用。
 * 也不声明任何标签的来源——SPEC §4.3 明确要求别把 `ratings` 呈现成「模型标好了的」，
 * 一条不作声明的扁平标签行正合那条。
 */
function SlideFooter({ slide }: RenderSlideFooterProps) {
  // 理论上 `slides` 里每个元素都挂着 meme；`undefined` 时宁可不显示也不要崩。
  const meme = slide.meme
  if (!meme) return null

  const labels = labelValues(meme)

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3 lg:hidden">
      <div className="pointer-events-auto max-w-2xl rounded-xl bg-black/70 px-3.5 py-2.5 text-white backdrop-blur-sm">
        {labels.length > 0 && (
          <p className="text-sm font-medium leading-snug">{labels.join(' · ')}</p>
        )}
        {meme.description && (
          <p className="line-clamp-2 text-sm leading-snug text-white/75">{meme.description}</p>
        )}
        <p className="text-xs leading-snug text-white/75">@{meme.uploaderName}</p>
      </div>
    </div>
  )
}

/**
 * 宽屏（`lg` 以上）右侧那一栏：原先底部浮层里的那些内容，改成竖着排。
 *
 * ## 它为什么可以是一块实心的栏
 *
 * `SlideFooter` 要贴宽、两侧留白，是为了让出「点背景关闭」那条路。右栏**根本不压在图上**：
 * 它占的是容器让出去的那条带子（见 `viewerStyles`），点它命中不到 `.yarl__slide`，
 * 本来就不会关。
 *
 * ## 三个不能改的写法
 *
 * 1. **`fixed` 而不是 `absolute`**：容器现在只有舞台那么大（`viewerStyles`），
 *    `absolute` 会按舞台的盒子定位，右栏就叠到图上去了。`fixed` 的包含块是视口，
 *    也**不被祖先的 `overflow: hidden` 裁**——它必须能画在容器外面。
 * 2. **背景必须不透明**：纯黑底是 `.yarl__container` 自己的（`.yarl__portal` 没有背景），
 *    容器缩小之后这条带子底下什么都没有。原先用 `bg-white/[0.04]`（压在纯黑上=#0a0a0a），
 *    那只有 4% 白、96% 透明——**上一版的缺陷正是从这儿露出来的**：相邻幻灯片的图穿到
 *    右栏后面，隔着 96% 的透明度被看见了。`bg-neutral-950` 是同一个颜色的不透明版。
 *    顺带一提，当天第一反应是「加 z-index」——**那治不了这个病**：那道色带本来就在右栏
 *    *下面*（`elementFromPoint` 量过），只是透出来了。
 * 3. **不借主题 token**：底是恒定纯黑（不跟 `prefers-color-scheme` 走），所以这里写死
 *    黑白灰是对的，写 `text-muted-foreground` 才是错的（浅色主题下那是深灰字压在黑底上）。
 *    纯白字对 #0a0a0a 是 18:1，`text-white/60` 对它是 7.3:1，都过 AA。
 *
 * ## 描述还是截断
 *
 * 依旧不做滚动（`.yarl__container` 是 `touch-action: none`，且容器上挂着滑动翻页与下拉
 * 关闭——在栏里滚动会被当成那两个手势）。地方比底部那条大，所以放宽到 6 行。
 */
function ViewerAside({ meme }: { meme: Meme }) {
  const labels = labelValues(meme)

  return (
    <aside className="fixed inset-y-0 right-0 hidden w-(--viewer-aside-w) flex-col gap-4 overflow-hidden border-l border-white/10 bg-neutral-950 p-5 text-white lg:flex">
      {labels.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {labels.map((value, i) => (
            // 用下标当 key：同一个词可能同时出现在两个维度上，用它当 key 会让 React 报重复
            <li key={i} className="rounded-md bg-white/10 px-2 py-1 text-xs leading-none break-all">
              {value}
            </li>
          ))}
        </ul>
      )}
      {meme.description && (
        <p className="line-clamp-6 shrink-0 text-sm leading-relaxed break-words text-white/90">
          {meme.description}
        </p>
      )}
      {/* `mt-auto`：内容少的时候上传者名落在栏底，与微博 / QQ 空间那种右栏一致 */}
      <p className="mt-auto shrink-0 text-xs text-white/60">@{meme.uploaderName}</p>
    </aside>
  )
}

/**
 * 宽屏（`lg` 以上）底部的缩略图轨道：**一格一张，点哪张跳哪张**，当前那张自己滚进视野中央。
 *
 * 只有 `lg` 以上才显形：`--viewer-rail-h` 在窄屏是 0，而窄屏本来就不是左右那种布局
 * （右栏没地方放），底部那一格已经给了信息卡。手机上的翻页是滑动、左右按钮与 `←→`，
 * 那条路是完好的。
 *
 * ## 只用缩略图
 *
 * `thumbUrl ?? url` 与网格里那条同源（styling.md「图片网格」：列表不加载原图）。动图的
 * 缩略图是服务端转的静态首帧，在 64px 的格子里也看不出动没动——那件事由全屏那张负责。
 * `loading="lazy"` 不能省：浏览页翻过几百张之后这个轨道就有几百格。
 *
 * ## 当前那张滚进视野用手算的 `scrollTo`，不用 `scrollIntoView`
 *
 * `scrollIntoView` 会顺着**所有**可滚祖先一路滚上去。这里祖先恰好都不可滚（portal 是
 * `fixed`、容器是 `overflow: hidden`），所以它是「能用但靠运气」——哪天中间多一层能滚的
 * 容器，表现是点开一张图整页跟着跳一下。手算 `scrollLeft` 没有这个面。
 *
 * `prefers-reduced-motion` 那一档退回即时跳：轨道自己动起来是动效，不长在信息本身上，
 * 该听用户的（同 `MemeImage` 的 hover 播放、`Shimmer` 的 `motion-reduce:animate-none`）。
 */
function ThumbRail({
  items,
  index,
  onPick,
}: {
  items: readonly Meme[]
  index: number
  onPick: (index: number) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const rail = railRef.current
    const tile = rail?.children[index]
    if (!rail || !(tile instanceof HTMLElement)) return
    rail.scrollTo({
      left: tile.offsetLeft - (rail.clientWidth - tile.offsetWidth) / 2,
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [index])

  return (
    // `fixed` 与不透明的底：同 `ViewerAside` 那三条（容器现在只有舞台那么大，
    // 这条带子底下什么都没有）。
    // `no-scrollbar`（`shadcn/tailwind.css` 的 utility）只藏滚动条，滚动本身照旧——
    // 一条横在图片下面的滚动条在这个全黑的场子里比缩略图本身还显眼。
    // `overscroll-contain` 挡住横向滚到头之后接着把整页往两边带。
    <div
      ref={railRef}
      className="no-scrollbar fixed bottom-0 left-0 hidden h-(--viewer-rail-h) items-center gap-2 overflow-x-auto overscroll-contain bg-neutral-950 px-3 right-(--viewer-aside-w) lg:flex"
    >
      {items.map((meme, i) => (
        <button
          key={meme.id}
          type="button"
          onClick={() => onPick(i)}
          // 可读名要说「这是第几张」：格子里那张图读屏念不出内容
          aria-label={`第 ${i + 1} 张：${meme.description ?? meme.originalFilename ?? meme.id}`}
          aria-current={i === index}
          className={cn(
            // `cursor-pointer` 得自己写，Tailwind v4 起不再给 `<button>` 加（styling.md）
            'size-16 shrink-0 cursor-pointer overflow-hidden rounded-lg bg-white/5 transition-opacity',
            // 非当前那几张压暗而不是藏起来：轨道要能一眼看出「一共多少、现在在哪」
            i === index ? 'opacity-100 ring-2 ring-white' : 'opacity-50 hover:opacity-90',
          )}
        >
          {/* `object-contain` 不裁剪：表情包的信息常在边缘（styling.md「图片网格」） */}
          <img
            src={meme.thumbUrl ?? meme.url}
            alt=""
            loading="lazy"
            className="size-full object-contain"
          />
        </button>
      ))}
    </div>
  )
}

/**
 * 阅览器里我们自己那几块（`render.controls`）：**发送按钮（哪个尺寸都有）**、
 * 宽屏右栏、宽屏缩略图轨道。
 *
 * 数据从 `SessionContext` 拿——`render.controls` 是个没有参数的 render 函数
 * （`RenderFunction<void>`，`types.d.ts:346`），拿不到 props。而这个组件渲染在
 * `<Lightbox>` 的 React 树里，宿主的 Provider 正是它的祖先，context 天然可用。
 * （context 本身放在 `viewer-session.ts`，理由见那个文件。）
 *
 * 它渲染的位置在 `.yarl__container` **里面**（`Controller` 里 `render.controls?.()` 那行，
 * 排在轮播之后）。而容器现在只有舞台那么大（`viewerStyles`），所以这几块走 `fixed`
 * 按视口定位——它们是容器的后代，但**不看容器的盒子**。
 *
 * ⚠️ **发送按钮在这里、不在宽屏那一支里**：它是裁定 4 给这一面的唯一入口，而
 * `ViewerAside` / `ThumbRail` 都是 `lg` 起才显形的，触屏设备一个都看不到。摆错位置
 * 的表现是「手机上阅览器里发不出去」，而且不报错。
 */
function ViewerControls() {
  const controls = useContext(SessionContext)
  const session = controls?.session
  const meme = session?.items[session.index]
  if (!controls || !session || !meme) return null

  return (
    <>
      <SendButton meme={meme} />
      <ViewerAside meme={meme} />
      {session.items.length > 1 && (
        <ThumbRail items={session.items} index={session.index} onPick={controls.show} />
      )}
    </>
  )
}

/**
 * 全屏阅览里那枚**看得见的**发送按钮（2026-09-26 加，裁定 4）。
 *
 * ## 它为什么存在
 *
 * 此前阅览器里唯一的发送入口是 `Ctrl+C`，而界面上一个字都没提这个快捷键——
 * **看不见的入口等于没有入口**。同一批裁定又把卡片图片下方那枚全宽按钮撤了
 * （那个文件是 `SearchResults.tsx`，2026-09-26 随首页改版删除），理由是一个动作只出现一处；
 * 于是这枚按钮同时是**列表里鼠标用户的实际出口**，不是顺手补的装饰，位置和文案都不该轻动。
 *
 * 它**不是唯一的发送入口**了：首页图墙卡片上那枚 `CardSendButton` 走的是同一条分流，
 * 是对裁定 4 的明写偏离（图墙没有编辑也没有删除，任务文件 §5.1）。
 *
 * ## 分流与 `Ctrl+C`、与卡片「⋯」完全同一份
 *
 * 调的是同一个 `sendImage`（`sendMeme` → `sendNote` → `notifySend`），所以分流只看
 * `isAnimated` 与能力探测、**不看用户是点按钮还是按键**：动图在这里同样落到「下载」
 * 并说明原因（clipboard-share.md §3）。文案与图标在**渲染时**定下来（`detectSendPath`
 * + `SEND_LABELS` / `SEND_ICONS`）——一个按钮两种行为是最糟的设计（§5）。
 *
 * ## 位置：左上角，不是左下角
 *
 * 窄屏底部中间是 `SlideFooter`（信息卡）、宽屏底部整条是 `ThumbRail`，左下角在两种版式
 * 里都被占着。库的工具栏固定在右上角（见 `viewerStyles`），所以只有**左上角**空着。
 *
 * 压在图上的东西都得自带对比度：底图可能是白的也可能是黑的，所以走 `bg-black/70` +
 * 白字 + 背景模糊，与 `SlideFooter` / `MemeCard` 的 `BADGE` 同一条思路（`bg-black/70`
 * 压在最亮的图上是 `#4d4d4d`，纯白字对它 8.1:1）。**不借主题 token**：这里的底是图，
 * 不是页面。
 *
 * ## `Ctrl+C` 那句按**指针**分档，不按宽度
 *
 * 触屏那一档没有 Ctrl 键，提示留在那儿只是噪声。闸门是 `pointer-coarse` 而不是
 * `max-sm`（700px 的桌面窗口不是手机，宽屏平板也不该按桌面处理，`lib/touch.ts` 有完整
 * 推导）。基线是**看得见**、藏起来叠在粗指针上——反过来写的话，探针一旦不成立提示
 * 就整个消失，而它是这枚按钮存在理由的另一半。
 *
 * ## 预取不用在这里再挂一份
 *
 * `usePrefetchShare(current)` 已经在 `LightboxViewer` 上按**当前这一张**挂过了，这里拿的
 * 正是同一张（都读 `session.items[session.index]`）。再挂一份是空操作，只会让下一个人
 * 以为这里是第二个落点。
 */
function SendButton({ meme }: { meme: Meme }) {
  const path = detectSendPath(meme.isAnimated)
  const Icon = SEND_ICONS[path]

  return (
    // 外层铺开只为定位，`pointer-events-none` 让它不吃掉「点背景关闭」；只有两枚元素自己接事件
    <div className="pointer-events-none fixed top-3 left-3 flex flex-col items-start gap-1.5">
      <button
        type="button"
        // 与 `Ctrl+C` 同一个函数，中间不 await 别的请求：剪贴板写入要落在用户手势的
        // 同步调用栈里（clipboard-share.md §4.1）
        onClick={() => void sendImage(meme)}
        // 读屏用户看不到下面那行提示，快捷键得从属性里说出来
        aria-keyshortcuts="Control+C Meta+C"
        className={cn(
          'pointer-events-auto flex cursor-pointer items-center gap-1.5 rounded-full bg-black/70 px-3 text-sm font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/85',
          // 手指那一档 44，鼠标那一档回到 32，同 `lib/touch.ts`
          TOUCH,
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
        {SEND_LABELS[path]}
      </button>
      <span
        className={cn(
          'pointer-events-none rounded-full bg-black/70 px-2 py-0.5 text-[11px] leading-none text-white backdrop-blur-sm',
          'pointer-coarse:hidden',
        )}
      >
        Ctrl+C 也可以
      </span>
    </div>
  )
}

/**
 * `plugins` 与 `labels` 都是模块级常量：每次渲染现写一个数组，YARL 会重新跑一遍插件装配。
 *
 * 库自带的文案是英文（`Close` / `Lightbox` / `Photo gallery` …），全站是中文，逐个换掉。
 * `{index}` / `{total}` 是库的模板占位符，**不能翻译掉**。
 *
 * ⚠️ **插件的文案是插件自己那份 labels**，不在这几个里：`Zoom` 插件的放大 / 缩小按钮
 * 读的是 `Zoom in` / `Zoom out`，而插件默认**没有** `labels`——不显式给，那两个按钮的
 * 可读名就是英文。实测踩过：只改上面这一组的时候，读屏念的是「Zoom in」。
 */
const PLUGINS = [Zoom]

const CONTROLLER = { closeOnBackdropClick: true, closeOnPullDown: true }

const ZOOM = { maxZoomPixelRatio: 2 }

/** 多张时那一份 `render`：翻页按钮留给库自己的（可读名、禁用态都是现成的）。 */
const RENDER = {
  slideFooter: SlideFooter,
  controls: ViewerControls,
}

/**
 * **单张阅览必须把翻页按钮拿掉。** 库对这两个按钮是**无条件渲染**的
 * （`Navigation` 组件里没有 `count > 1` 之类的判断），只有一张图时它们既不是
 * `disabled` 也没被藏起来——表现是全屏里左右各挂一个 64×80 的箭头，按下去什么都不发生。
 *
 * 它们盖住的还正好是**唯一能点到的背景**：图上、下、左、右四块空白里，左右两条被这两个
 * 按钮整条占掉，于是「点背景关闭」在单张时几乎点不着（实测：左边缘 6px 是箭头图标、
 * 40px 是箭头按钮本身）。拿掉之后左右才回到 `yarl__slide_wrapper` 上。
 *
 * ⚠️ 这两行**只在单张时**生效。当年这里是唯一的 `render`，接上多张之后才分家——多张时
 * 反过来要的正是库那两个按钮。（`render` 是**浅合并**到库的默认值上的，所以单张这档
 * 不是「藏起来」而是「没给这个键」。）
 */
const RENDER_SINGLE = { ...RENDER, buttonPrev: () => null, buttonNext: () => null }

/**
 * 把容器**缩成图片那一块**，右边与下边让给信息栏与缩略图轨道。
 *
 * 走 `styles` 属性（内联样式），**不在 `.yarl__*` 上写 Tailwind 类**：库自带的样式表是无层的，
 * 压得过 Tailwind 的 `@layer utilities`（styling.md「库自带的 CSS 是无层的」）。
 *
 * ## 为什么是宽度/高度，不是给容器加 padding
 *
 * 一开始用的是 `padding`（占位，图片自然缩小到剩下那块）。**那是错的**，而且错得很隐蔽：
 * `.yarl__container` 的 `overflow: hidden` 裁的是**padding 盒**，也就是整块屏幕——
 * 而轮播里相邻的那几张幻灯片本来就摆在容器外面等着滑进来，于是「下一张」的图会**穿过
 * 右栏那条让出来的地方**。库默认的幻灯间隔是 30%，1088 宽的舞台上下一张的图从 x=1430
 * 起步，视口到 1440 为止，正好露出 10px（2026-09-23 实拍：右栏最右侧一道竖着的色带）。
 *
 * 做成 `width/height` 之后容器**就是**舞台：裁剪边界、`containerRect`（`clientWidth`
 * 直接就是舞台宽）、图片的 `slideRect`、滑动距离**全是同一个数**，不需要再各配一次。
 * 连带三个原先要手动挪的浮层也回到了默认位置，一个都不用改：
 *
 * - `toolbar`（关闭 / 放大缩小）默认钉容器右上角 = 舞台右上角；
 * - 两个翻页按钮默认按容器垂直居中 = 舞台垂直居中；
 * - `navigationNext` 默认 `right: 0` = 舞台右边缘，正好贴着右栏。
 *
 * ## 代价：黑底不再铺满
 *
 * 纯黑背景是 `.yarl__container` 自己的（`.yarl__portal` 没有背景），容器一缩小，
 * 右栏与轨道那两条带子就没有底了——要靠 `ViewerAside` / `ThumbRail` 各自铺满
 * （它们同时还得是**不透明**的，理由见 `ViewerAside`）。同理它们不能再用 `absolute`：
 * 那会按容器的盒子定位，现在容器只有舞台那么大。改 `fixed`，按视口定位——`fixed` 的
 * 包含块是视口，**不被祖先的 `overflow: hidden` 裁**，所以照样画在舞台外面。
 *
 * ⚠️ 两个量来自 `index.css` 的 `:root`（窄屏是 0，`min-width: 64rem` 那一档才有值）。
 * **必须是变量**：这边给 YARL 的是舞台的宽高，右栏与轨道那边用 `w-(--viewer-aside-w)`
 * 量的是自己的宽高，两边套同一个值才对得上。
 *
 * `withRail` 只有多张时才是 true：单张时不摆轨道，也就不该白留一条黑边。
 */
function viewerStyles(withRail: boolean): SlotStyles {
  return {
    container: {
      width: 'calc(100% - var(--viewer-aside-w))',
      height: withRail ? 'calc(100% - var(--viewer-rail-h))' : '100%',
    },
  }
}

const LABELS = {
  Previous: '上一张',
  Next: '下一张',
  Close: '关闭',
  Slide: '图片',
  Carousel: '图片轮播',
  Lightbox: '图片阅览',
  'Photo gallery': '图片阅览',
  '{index} of {total}': '第 {index} 张，共 {total} 张',
  'Zoom in': '放大',
  'Zoom out': '缩小',
}
