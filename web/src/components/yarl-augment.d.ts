import type { Meme } from '../lib/api'

/**
 * 给 YARL 的 slide 挂一个 `meme` 字段，供自定义的 `render.slideFooter` 取元数据。
 *
 * ## 为什么是声明合并，不是强转
 *
 * `RenderSlideFooterProps` 只有 `{ slide }` 一个字段（`types.d.ts:328`），slide 上不带
 * 任何业务数据。要在 footer 里拿到 `Meme`，只有两条路：`(slide as SlideImage & { meme: Meme })`
 * 硬转，或者声明合并。本仓 `code-style.md` 禁止在接口返回值上用 `as`，`web/src/` 下
 * `grep "declare module\|@ts-expect-error\|as unknown as"` 是**零命中**——声明合并是这里
 * 唯一不违规的写法，它也正是 YARL 官方 captions 插件给自己的字段用的手法
 * （`dist/plugins/captions/index.d.ts:6`）。
 *
 * 能合并是因为 `Slide` 是**类型别名**（合并不了），而 `GenericSlide` 是 interface，
 * 且 `SlideImage extends GenericSlide`——合并 `GenericSlide` 就够覆盖 `Slide`。
 *
 * ⚠️ **字段名不能叫 `description`**：captions 插件已经合并过这个名字（`React.ReactNode`），
 *    而 `Meme['description']` 是 `string | null`，撞名得到的是类型冲突而不是覆盖。
 *    叫 `meme` 是整块挂上去，将来 footer 要用别的字段（`id`、`createdAt`…）不必再动这个文件。
 *
 * ⚠️ **上面那行 import 是这个文件的成因，不是引用**：`verbatimModuleSyntax` 下，没有顶层
 *    导入/导出的 `.d.ts` 是**全局脚本**，里面的 `declare module 'yet-another-react-lightbox'`
 *    会被读成「重新声明一个同名模块」（整个模块的类型被它替换掉），而不是扩充它——
 *    表现是 YARL 自己的类型全部消失。删掉那行 import 就等于把这个文件变成一颗雷。
 */
declare module 'yet-another-react-lightbox' {
  interface GenericSlide {
    /** 这张 slide 对应的图片记录。由 `ImageViewer.tsx` 的 `toSlide` 挂上。 */
    meme?: Meme
  }
}
