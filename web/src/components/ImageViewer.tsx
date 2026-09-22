import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import Lightbox from 'yet-another-react-lightbox'
import type { RenderSlideFooterProps, SlideImage } from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
// 只这一个：`plugins/zoom.css` 在 3.32.2 里**不存在**（exports 里只有 styles 与
// captions / counter / thumbnails 四个），照习惯补一行会让构建失败。
import 'yet-another-react-lightbox/styles.css'
import type { Meme } from '../lib/api'
import { VOCAB_DIMENSIONS } from '../lib/vocab'

type OpenImage = (meme: Meme) => void

const ImageViewerContext = createContext<OpenImage | null>(null)

/**
 * 全屏阅览的宿主。**全应用只有这一份**，挂在 `App.tsx` 的 `AppLayout` 里。
 *
 * ## 为什么它不能挂在 `MemeImage` 里
 *
 * 首页的键盘路径是挂在根 `<section>` 上的**一个 React `onKeyDown`**
 * （`features/search/use-search.ts`）：`Esc` 取消选中、`↑↓` 移动、`Enter` 复制 / 下载。
 * 而 **React 的 portal 事件沿 React 树冒泡，不沿 DOM 树**——阅览器就算 portal 到
 * `document.body`，只要它的 React 父链经过那一页，键盘事件照样冒到那个 handler 上：
 * `Esc` 关不干净（背后的选中态被清掉）、`↑↓` 一边看图和一边移动搜索结果、`Enter`
 * 在阅览器里**发起一次复制 / 下载**。三件都不报错。
 *
 * 挂在 `AppLayout` 里、摆在 `Outlet` 那条链的**祖先**上，`<Lightbox>` 的 React 祖先链
 * 就只有外壳，与任何页面无关。（不选「在阅览器上补 `stopPropagation`」：synthetic 的
 * `stopPropagation` 会连带调 `nativeEvent.stopPropagation()`，而 YARL 自己那条 `Esc`
 * 是**原生**监听，很可能被一起掐掉——那是更隐蔽的坏法。）
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
 */
export function ImageViewerProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Meme | null>(null)

  const open = useCallback<OpenImage>((meme) => setCurrent(meme), [])
  const close = useCallback(() => setCurrent(null), [])

  // 引用要锁住：给 YARL 一个新的 slides 数组，它会当成换了一批图，重走一遍加载与淡入。
  const slides = useMemo(() => (current ? [toSlide(current)] : []), [current])

  return (
    <ImageViewerContext.Provider value={open}>
      {children}
      <Lightbox
        open={current !== null}
        close={close}
        slides={slides}
        index={0}
        plugins={PLUGINS}
        // 这两个手势的默认值**都是 false**。不显式打开的表现是「点了背景没反应」，
        // 而点背景关闭是这类组件的基本预期。下拉关闭是手机上的那份。
        controller={{ closeOnBackdropClick: true, closeOnPullDown: true }}
        // 默认的 1 表示最多只能放到 1:1。梗图的信息常是图上压着的一行小字，
        // 放大正是这里的用途（styling.md「图片网格」那条的前提）。
        zoom={{ maxZoomPixelRatio: 2 }}
        render={RENDER}
        labels={LABELS}
      />
    </ImageViewerContext.Provider>
  )
}

/**
 * 打开全屏阅览。**没挂 Provider 直接抛错，不静默降级**——降级的表现是「点了没反应」，
 * 而「点了有反应」是这个功能唯一的存在意义。同源的一课见 `App.tsx` 里
 * `TooltipProvider` 缺失直接白屏那条。
 */
export function useImageViewer(): OpenImage {
  const open = useContext(ImageViewerContext)
  if (!open) throw new Error('useImageViewer 必须挂在 ImageViewerProvider 之内')
  return open
}

/**
 * 用**原图**而不是缩略图：全屏的意义就是看清，动图更是只有原图会动（缩略图是服务端转的
 * 静态首帧 WebP，见 `MemeImage`）。发送路径的依据是同一条——「展示和发送始终用原图」
 * （SPEC §9.4:145）。**网格仍然只加载缩略图**（styling.md「图片网格」），这里只影响全屏那一张。
 */
function toSlide(meme: Meme): SlideImage {
  return {
    src: meme.url,
    // 原图万一下不来，YARL 那个破图占位至少还挂着这行字——与 `MemeImage` 失败时
    // 显示文件名是同一条思路。
    alt: meme.description ?? meme.originalFilename ?? meme.id,
    // 尺寸只用于加载完成前占位。旧数据可能没有，**不要塞 null**（YARL 拿它当数字算）。
    ...(meme.width != null && meme.height != null
      ? { width: meme.width, height: meme.height }
      : {}),
    // 整条记录一起挂上去，给底部的信息栏取元数据用。**`slideFooter` 拿到的 `slide` 就是
    // 这个对象本身**，所以数据随 slide 走，`render` 不必依赖「当前是第几张」——
    // 这是下面 `RENDER` 能继续当模块级常量的原因。字段名与类型见 `yarl-augment.d.ts`。
    meme,
  }
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
 */
function labelValues(meme: Meme): string[] {
  const described = VOCAB_DIMENSIONS.filter((d) => d.field !== 'ratings').flatMap(
    (d) => meme[d.field],
  )
  return [...meme.ratings, ...described]
}

/**
 * 阅览器底部的信息栏（2026-09-22 加，SPEC §9.24）。
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
 * 坏掉「点背景关闭」的，见下面 `RENDER`）。留出两侧之后，底部只剩中间一小块不可点，
 * 而 `Esc` / `×` / 下拉关闭三条路都还在。
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
 *    `closeOnPullDown`。所以描述**只能截断**，`line-clamp-2` 不是美观选择而是唯一选择
 *    （与 YARL 官方 captions 插件同一档，它是 clamp-3）。
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
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
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
 * `plugins` 与 `labels` 都是模块级常量：每次渲染现写一个数组，YARL 会重新跑一遍插件装配。
 *
 * 库自带的文案是英文（`Close` / `Lightbox` / `Photo gallery` …），全站是中文，逐个换掉。
 * 单张阅览其实用不到 `Previous` / `Next`（只有一张时翻页按钮不出现），一并给出是为了
 * 哪天接了多张不用再回来找。`{index}` / `{total}` 是库的模板占位符，**不能翻译掉**。
 *
 * ⚠️ **插件的文案是插件自己那份 labels**，不在这几个里：`Zoom` 插件的放大 / 缩小按钮
 * 读的是 `Zoom in` / `Zoom out`，而插件默认**没有** `labels`——不显式给，那两个按钮的
 * 可读名就是英文。实测踩过：只改上面这一组的时候，读屏念的是「Zoom in」。
 */
const PLUGINS = [Zoom]

/**
 * **单张阅览必须把翻页按钮拿掉。** 库对这两个按钮是**无条件渲染**的
 * （`Navigation` 组件里没有 `count > 1` 之类的判断），只有一张图时它们既不是
 * `disabled` 也没被藏起来——表现是全屏里左右各挂一个 64×80 的箭头，按下去什么都不发生。
 *
 * 它们盖住的还正好是**唯一能点到的背景**：图上、下、左、右四块空白里，左右两条被这两个
 * 按钮整条占掉，于是「点背景关闭」在单张时几乎点不着（实测：左边缘 6px 是箭头图标、
 * 40px 是箭头按钮本身）。拿掉之后左右才回到 `yarl__slide_wrapper` 上。
 *
 * ⚠️ **哪天接了「←/→ 翻上下一张」，这两行要一起删掉**，否则新功能会以「按钮不见了」的形式坏掉。
 *
 * `slideFooter` 能一样是常量：它的 props 是 `{ slide }`（`types.d.ts:328`），要的数据随
 * slide 走，**与「当前是第几张」无关**，所以不存在「`slides` 换了、`render` 没换」的节奏问题。
 * 这同时绕开了浅合并那个坑——`render` 一旦改写成 `useMemo`/内联对象，很容易在某条分支上
 * 漏掉上面两个 `() => null`，左右箭头就悄悄回来了（上面刚说过的那个缺陷）。
 */
const RENDER = {
  buttonPrev: () => null,
  buttonNext: () => null,
  slideFooter: SlideFooter,
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
