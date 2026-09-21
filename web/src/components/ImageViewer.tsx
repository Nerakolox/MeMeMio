import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import Lightbox from 'yet-another-react-lightbox'
import type { SlideImage } from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
// 只这一个：`plugins/zoom.css` 在 3.32.2 里**不存在**（exports 里只有 styles 与
// captions / counter / thumbnails 四个），照习惯补一行会让构建失败。
import 'yet-another-react-lightbox/styles.css'
import type { Meme } from '../lib/api'

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
 * （SPEC §9.2）。**网格仍然只加载缩略图**（styling.md「图片网格」），这里只影响全屏那一张。
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
  }
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
 */
const RENDER = {
  buttonPrev: () => null,
  buttonNext: () => null,
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
