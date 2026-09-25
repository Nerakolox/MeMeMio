import { useState } from 'react'
import { ImageOff } from 'lucide-react'
import type { Meme } from '../lib/api'
import { useImageViewer } from './ImageViewer'
import { Skeleton } from './ui/skeleton'

/**
 * 卡片的比例形态。**两种都是既有行为，不是新选择**：
 *
 * - `natural`：按 `width / height` 占位、整张展示（浏览页瀑布流）。瀑布流的格子是绝对定位的，
 *   图片晚于布局到达，不占位的话每张图 `onLoad` 都会把下面整列推乱。
 * - `square`：固定 1:1 + `cover`（首页搜索、随机图墙、打标列表）。
 */
export type ImageShape = 'square' | 'natural'

/**
 * 一张表情包的承载层：占位、骨架、失败兜底、动图播放。
 *
 * 四个页面（浏览 / 搜索 / 图墙 / 打标列表）共用它，所以**角标、收藏按钮那些卡片级的东西
 * 不在这里**——它们住在 `MemeCard`，那是「一张卡片」，这里是「一张图」。
 *
 * ## 失败时显示文件名，不显示破图标
 *
 * 浏览器默认的破图标只说「这坏了」，而这里能说的是「是哪张坏了」——`originalFilename`
 * 是用户自己认得的字符串（styling.md「图片网格」）。
 *
 * ## 深色底是白的，而且**不跟主题走**
 *
 * 表情包多数是浅色背景，深色模式下要给图片容器一个浅色底，否则白底图和背景糊在一起
 * 看不出边界（styling.md「深色模式」）。
 *
 * 连带一条容易漏的：**这个框里的骨架和失败文字也不能用 `bg-muted` / `text-muted-foreground`**。
 * 那两个 token 在深色下是深色，压在强制白底上就是白底上的浅字。这里用固定的
 * `zinc` 深浅值——它们跟的是**这个框**，不是主题。
 *
 * ## 动图：静态首帧 + hover 播放，**不自动播放**
 *
 * 一屏几十个 GIF 同时播放会让手机发烫、滚动掉帧（styling.md「动图」）。缩略图本身就是
 * 静态首帧（服务端转的 webp），所以「不自动播放」是天然满足的，播放是**主动换 `src`**。
 *
 * 播放只在能 hover 的设备上发生，判据是 `(hover: hover)` 这个平台能力查询——与
 * `lib/clipboard.ts` 的 `pointer: coarse` 是同一类做法，不是 UA 判断。
 *
 * **触摸设备上没有「就地播放」这一档**（2026-09-21 起）：点按开全屏，动图在全屏里播。
 * 同一个手势不做两件事——在此之前点按是就地播放，而手机上一格只有 140px，播了也看不清
 * （styling.md「动图」那条已按此改写）。
 *
 * ## 点按 / 左键开全屏阅览
 *
 * 帧是一个 `<button>`，点它把这张图交给 `components/ImageViewer.tsx` 的全屏阅览器。
 * 用真按钮而不是挂 `role` 的 div：图本来就该键盘可达。
 *
 * ⚠️ **这里曾经挂着 `onKeyDown` 里的一句 `stopPropagation()`**（为了挡住首页根
 * `<section>` 上那个「Enter 发送」的 handler）。那是个补丁：同一条冒泡链上还有收藏按钮，
 * 挡不干净。现在闸门在**发起方**——只有焦点真的落在结果项自己身上才响应
 * （`features/search/use-search.ts` 的 `focusedOptionIndex`），所以这里一句都不用写。
 * 再想加回来之前先读那一段：加了就会把「Enter 开全屏阅览」重新掐掉——**2026-09-26
 * （裁定 4）之后 `Enter` 做的就是这一件事**，而焦点落在帧上时走的是本组件这条原生路。
 *
 * ⚠️ **`frameClass()` 里的 `block` 不能省**：`<button>` 的 UA 默认是 `inline-block`，
 * 它会变成一个行内级子元素、撑出行盒，而这个帧自带 `overflow-hidden`（基线因此取下外边距
 * 边缘），父元素被多顶出约 7px。四处页面的网格与瀑布流会一起漂，**而且不报错**。
 */
export function MemeImage({ meme, shape = 'square' }: { meme: Meme; shape?: ImageShape }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const openImage = useImageViewer()

  /** `alt` 与按钮的可读名共用一份。见 MemeCard 的注释：角标与操作器不在这里。 */
  const label = meme.description ?? meme.originalFilename ?? meme.id

  const thumb = meme.thumbUrl ?? meme.url
  // 动图且已经切到原图时才播。用 thumbSrc ?? url 兜底：没有缩略图的动图，
  // 静态和播放是同一个地址，换 src 没有意义。
  const src = playing && meme.isAnimated ? meme.url : thumb

  /**
   * 按比例占位。`width`/`height` 为 null（旧数据、探测失败）时兜底 1:1——
   * 宁可占成一个方，也不能让格子高度塌成 0。
   */
  const ratio =
    meme.width != null && meme.height != null && meme.width > 0 && meme.height > 0
      ? `${meme.width} / ${meme.height}`
      : '1 / 1'

  function handleError() {
    // 播放失败退回静态首帧，**不把整张卡打成失败态**：第一帧本来就已经在屏幕上了，
    // 用户看到的仍然是一张正常的图，只是不动。
    if (playing) setPlaying(false)
    else setFailed(true)
  }

  if (failed) {
    // **不包按钮**：图都没出来，进去只会看到一张破图，而这里能给的（是哪个文件坏了）
    // 才是那一步该看的信息。失败态是这一帧唯一的出口，没有别的动作可给。
    return (
      <div className={frameClass(shape)} style={shape === 'natural' ? { aspectRatio: ratio } : undefined}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center">
          <ImageOff className="size-6 shrink-0 text-zinc-400" />
          <span className="line-clamp-3 text-xs break-all text-zinc-500">
            {meme.originalFilename ?? '图片加载失败'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => openImage(meme)}
      // 压在 `alt` 之上：`alt` 说的是「这是什么」，按钮的可读名要说「点它会怎样」。
      aria-label={`全屏阅览：${label}`}
      // `cursor-pointer` 得**自己写**：**Tailwind v4 起不再给 `<button>` 加
      // `cursor: pointer`**（v3 加、v4 去掉，preflight 里也没有这条），不写的话
      // 鼠标划到图上仍是箭头——「这里能点」只剩读屏和提示文案在说。
      className={`${frameClass(shape)} cursor-pointer`}
      style={shape === 'natural' ? { aspectRatio: ratio } : undefined}
    >
      <img
        className={
          shape === 'natural'
            ? 'h-full w-full object-contain'
            : 'h-full w-full object-cover'
        }
        src={src}
        alt={label}
        loading="lazy"
        width={meme.width ?? undefined}
        height={meme.height ?? undefined}
        onLoad={() => setLoaded(true)}
        onError={handleError}
        // 两个 handler 都在 `playing` 已经是目标值时不做事，避免重复 setState。
        //
        // 点开后这份播放会自己停：指针被覆盖层挡住，浏览器给 `<img>` 发 `pointerleave`
        // ——同一张动图不会在网格和全屏里同时解码。这条实测过，不是想当然。
        onPointerEnter={meme.isAnimated ? handlePointerEnter : undefined}
        onPointerLeave={meme.isAnimated ? handlePointerLeave : undefined}
      />
      {!loaded && <Skeleton className="absolute inset-0 rounded-2xl bg-zinc-200" />}
    </button>
  )

  /**
   * `matchMedia` 每次现问，**不缓存**：插上鼠标之后这个答案会变（平板接键盘壳、
   * 二合一笔记本），缓存住就成了「插了鼠标还是得点」。
   * 调用点在 hover 事件里，不在渲染路径上，一次点击一次查询的代价可以忽略。
   */
  function hoverCapable(): boolean {
    return window.matchMedia?.('(hover: hover)').matches === true
  }

  function handlePointerEnter() {
    if (!hoverCapable()) return
    setPlaying(true)
  }

  function handlePointerLeave() {
    if (!hoverCapable()) return
    setPlaying(false)
  }
}

/**
 * 图片框的圆角。**这是它的唯一落点**——`MemeCard` 里那层 hover 遮罩 import 它。
 *
 * 遮罩是卡片层的兄弟节点（不在这个框里，所以吃不到 `overflow-hidden` 的裁剪），
 * 圆角要是各写各的，改了这里忘了那里，遮罩的方角就会从圆角外面露出来。
 *
 * 同源的一条坑：**阴影必须挂在有圆角的这个元素上**，挂在外层那层矩形上，
 * 影子的四角是方的——图是圆的、影是方的。
 */
export const IMAGE_RADIUS = 'rounded-2xl'

/**
 * 图片框。**`overflow-hidden` 在图片这一层、不在卡片那一层**：
 * 比例由这个盒子持有，角标和收藏按钮是它的兄弟节点，裁不到。
 *
 * `shadow-sm`（`0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a`）是**浅阴影**，
 * 让白底卡片从背景上浮起来一点——瀑布流里几十张白图挨着排，没有它边界靠猜。
 * 量级与 `ui/sidebar.tsx` 的浮动侧边栏一致（那边也是 `shadow-sm`）。
 * 深色模式下这个影子看不出来，属正常（深色背景上的黑影子），没有另做 `dark:` 处理。
 *
 * ⚠️ **`block` 不是装饰**，两档都得有：帧现在是 `<button>`，UA 默认 `inline-block`，
 * 会撑出行盒而父元素被多顶出约 7px（组件头部的注释有完整推导）。失败态那一支是 `<div>`
 * ——两档共用这个函数，`block` 在那里同样是无害的默认值对齐。
 *
 * **这里没有 `cursor-pointer`，它在按钮那一支上单独写。** 光标是「点了会有事发生」的承诺，
 * 而失败态的帧**不可点**（见上一条注释），给它一个指针就是空承诺。两档的类是共用一份，
 * 但这一条故意不共用。
 */
function frameClass(shape: ImageShape): string {
  const base = `relative block w-full overflow-hidden ${IMAGE_RADIUS} bg-white shadow-sm`
  return shape === 'natural' ? base : `${base} aspect-square`
}
