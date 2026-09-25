import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { SlideImage } from 'yet-another-react-lightbox'
import type { Meme } from '../lib/api'
// `SessionContext` 本文件不用（Provider 在 `LightboxViewer` 里，见 `viewer-session.ts`），
// 这里只要那两个类型。
import type { SessionControls, ViewerSession } from './viewer-session'

/**
 * 打开全屏阅览：**这张图，和这张图所在的那一批**。
 *
 * 给一批而不是单张，是因为 ←/→ 与缩略图翻的必须是「用户刚才在看的那个列表」——搜索
 * 翻出来的是这次搜索的那批，图墙翻出来的是这一屏随机的那批。给别的集合都是另一种功能。
 */
type OpenImage = (meme: Meme, items: readonly Meme[]) => void

const ImageViewerContext = createContext<OpenImage | null>(null)

/** 「这一屏正在展示的那批图」的登记处。四个列表各套一层，见 `MemeGallery`。 */
const GalleryContext = createContext<readonly Meme[]>([])

/**
 * 把「这一屏的那批图」告诉下面的 `MemeImage`。**四个列表各套一层**。
 *
 * `MemeImage` 自己看不出自己属于哪一批——它的祖先里谁持有列表，只有页面知道。不把列表
 * 当 prop 透传：`MemeCard` / `MemeImage` 是四页共用的卡片，为了一次阅览给它加一个只有
 * 阅览器用得上的参数，等于让卡片理解「列表」这个概念。
 *
 * **不套这一层不是坏掉**，是「一张一张地看」：`open` 兜住空列表那条路（单张成一批），
 * 翻页按钮与缩略图轨道也都不出现。导入页的待确认卡片、将来任何零散的单张入口都走这条。
 */
export function MemeGallery({ items, children }: { items: readonly Meme[]; children: ReactNode }) {
  return <GalleryContext.Provider value={items}>{children}</GalleryContext.Provider>
}

/**
 * 全屏阅览的宿主。**全应用只有这一份**，挂在 `App.tsx` 的 `AppLayout` 里。
 * 阅览器本体（`<Lightbox>` 与它那几块浮层）在 `LightboxViewer.tsx`，
 * **第一次打开时才加载**——理由见那个文件。
 *
 * ## 为什么它不能挂在 `MemeImage` 里
 *
 * 首页的键盘路径是挂在根 `<section>` 上的**一个 React `onKeyDown`**
 * （`features/search/use-search.ts`）：`Esc` 取消选中、`↑↓` 移动、`Enter` 打开全屏阅览。
 * 而 **React 的 portal 事件沿 React 树冒泡，不沿 DOM 树**——阅览器就算 portal 到
 * `document.body`，只要它的 React 父链经过那一页，键盘事件照样冒到那个 handler 上：
 * `Esc` 关不干净（背后的选中态被清掉）、`↑↓` 一边看图一边移动搜索结果。两件都不报错。
 *
 * ⚠️ 2026-09-26（裁定 4）：**`Enter` 已不在上面这张泄漏清单里**，别看漏。它此前泄漏的
 * 后果是「在阅览器里按一下复制 / 下载了一张图」，现在它做的是「打开阅览器」——而判据是
 * 焦点真的落在结果项自己身上（`focusedOptionIndex`），阅览器里的焦点不满足，于是
 * 什么都不会发生。**这条是判据带来的，不是给 `Enter` 单独打的补丁**：哪天判据换成
 * 「谁没挡冒泡」，它会立刻重新变成泄漏项。
 *
 * 挂在 `AppLayout` 里、摆在 `Outlet` 那条链的**祖先**上，`<Lightbox>` 的 React 祖先链
 * 就只有外壳，与任何页面无关。（不选「在阅览器上补 `stopPropagation`」：synthetic 的
 * `stopPropagation` 会连带调 `nativeEvent.stopPropagation()`，而 YARL 自己那条 `Esc`
 * 是**原生**监听，很可能被一起掐掉——那是更隐蔽的坏法。）
 *
 * 同理 `MemeGallery` 也只是个 context，不是第二个宿主：四处页面各挂一份 `<Lightbox>`
 * 就是四套焦点陷阱（`project-structure.md`）。
 */
export function ImageViewerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ViewerSession | null>(null)

  /**
   * 阅览器**开过一次**了。
   *
   * `React.lazy` 的那份 chunk 要等 `setSession` 之后才被请求，而这个标记一旦置上就
   * **再也不收回**：chunk 已经在浏览器缓存里，收回来只会让「关掉再打开」多一次
   * （虽然命中缓存的）加载；而且卸载 `<Lightbox>` 会把它那条关闭动画一起掐掉——
   * 关闭时 `controls` 里 `session` 已经变 `null`，正是动画在跑的那一刻。
   */
  const [everOpened, setEverOpened] = useState(false)

  const open = useCallback<OpenImage>((meme, items) => {
    setEverOpened(true)
    // 找不到那张图（列表刚被别的操作换过）时**退回单张**而不是不打开：点了就得有反应是
    // 这个功能唯一的存在意义。
    const at = items.findIndex((m) => m.id === meme.id)
    setSession(at >= 0 ? { items, index: at } : { items: [meme], index: 0 })
  }, [])
  const close = useCallback(() => setSession(null), [])

  /**
   * 停到第 n 张。**这一条同时服务三种翻页**：
   *
   * - 库自己的翻页按钮 / `←→` / 滑动走的是内部那条带转场的路，停下之后经 `on.view`
   *   回报结果，走的就是这里（`LightboxViewer` 里的 `on`）；
   * - 缩略图轨道要**跳着走**，直接调这里。
   *
   * 不调库的 `next({ count })`：那个把「翻 n 张」当成 n 次连续转场，时长是
   * `swipe × n`——从第 1 张跳到最后一张要转十几秒。改 `index` 属性走的是库的 `update`
   * 那条路（`reducer` 里那支不带 `animation`），就地换一张、不做转场，正是缩略图要的手感。
   *
   * 相等就返回原状态：`on.view` 回过头来报的常常正是我们已经记下的那个数，不挡一下
   * 每次转场都要多渲染一轮。
   */
  const show = useCallback((index: number) => {
    setSession((prev) => (prev && prev.index !== index ? { ...prev, index } : prev))
  }, [])

  // 依赖是 `items` 而不是 `session`：翻页只换 index，那份数组的引用不动，slides 也不必重建。
  // 引用要锁住——给 YARL 一个新的 slides 数组，它会当成换了一批图，重走一遍加载与淡入。
  const items = session?.items
  const slides = useMemo(() => (items ?? []).map(toSlide), [items])

  const controls = useMemo<SessionControls>(() => ({ session, show }), [session, show])

  return (
    <ImageViewerContext.Provider value={open}>
      {children}
      {/*
        `everOpened` 而不是 `session !== null`：关闭时要把 `<Lightbox>` 留着跑完关闭动画
        （见 `everOpened` 的注释），所以判据是「开过没有」，不是「现在开着没有」。
        `fallback={null}`：这里的「加载中」最多是本地一个 chunk 的时间，摆个骨架反而是
        一次多余的闪动。
      */}
      {everOpened && (
        <Suspense fallback={null}>
          <LightboxViewer controls={controls} slides={slides} close={close} />
        </Suspense>
      )}
    </ImageViewerContext.Provider>
  )
}

/**
 * 阅览器本体。`import()` 而不是静态 import：它带着 YARL 与那份样式表，
 * 而绝大多数页面浏览都不打开全屏（见 `LightboxViewer.tsx` 的文件头）。
 */
const LightboxViewer = lazy(() =>
  import('./LightboxViewer').then((m) => ({ default: m.LightboxViewer })),
)

/**
 * 拿到底层的 `open(meme, items)`——**列表由调用方自己给**。
 *
 * 之所以要有这么一层，是因为 `useImageViewer()` 那份列表是从 `GalleryContext` 读的，
 * 而那是给**卡片**用的：`MemeImage` 就长在 `<MemeGallery>` 之内，天然读得到。
 * 页面级的键盘路径不在那棵树里——`use-search.ts` 是在 `<MemeGallery>` **之外**被调用的，
 * 在那里读 context 拿到的是默认值 `[]`，于是 `open(meme, [])` 会静默退回**单张**阅览
 * （`open` 里那条 `at = -1` 的兜底）：翻页按钮与缩略图轨道全没有，**而且不报错**。
 * 所以这一档把列表显式传进来，调用方本来就有（`state.items`）。
 *
 * ⚠️ 传进来的必须真是「用户刚才在看的那个列表」——给别的集合是另一种功能，
 * 见 `OpenImage` 的注释。
 *
 * **没挂 Provider 直接抛错，不静默降级**——降级的表现是「点了没反应」，而「点了有反应」
 * 是这个功能唯一的存在意义。同源的一课见 `App.tsx` 里 `TooltipProvider` 缺失直接白屏那条。
 */
export function useImageViewerOpen(): OpenImage {
  const open = useContext(ImageViewerContext)
  if (!open) throw new Error('useImageViewer / useImageViewerOpen 必须挂在 ImageViewerProvider 之内')
  return open
}

/**
 * 打开全屏阅览。**签名不变**（还是收一张图就打开），所以 `MemeImage` 一行都不用改
 * ——它本来就只 import 这个 hook。
 *
 * 这里把外面那层 `MemeGallery` 的列表接上去；列表本身怎么来、为什么另一条路要绕开它，
 * 见 `useImageViewerOpen`。
 */
export function useImageViewer(): (meme: Meme) => void {
  const open = useImageViewerOpen()
  const items = useContext(GalleryContext)
  return useCallback((meme: Meme) => open(meme, items), [open, items])
}

/**
 * 用**原图**而不是缩略图：全屏的意义就是看清，动图更是只有原图会动（缩略图是服务端转的
 * 静态首帧 WebP，见 `MemeImage`）。发送路径的依据是同一条——「展示和发送始终用原图」
 * （SPEC §9.4:145）。**网格仍然只加载缩略图**（styling.md「图片网格」），这里只影响全屏那一张。
 * 底部那条轨道是另一个例外，它专门用缩略图（见 `LightboxViewer` 的 `ThumbRail`）。
 *
 * 留在这儿（而不是跟阅览器一起切出去）是因为它**只碰类型**：`SlideImage` 是
 * `import type`，构建后不留一行 import，不会把 YARL 拽回这个（首屏就要的）模块。
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
    // 整条记录一起挂上去，给信息栏（宽屏的右栏与窄屏的底栏）取元数据用。**`slideFooter`
    // 拿到的 `slide` 就是这个对象本身**，所以数据随 slide 走，`render` 不必依赖「当前是
    // 第几张」——这是 `LightboxViewer` 里 `RENDER` 能继续当模块级常量的原因。
    // 类型见 `yarl-augment.d.ts`。
    meme,
  }
}
