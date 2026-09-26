import { cn } from 'cn'

/**
 * **图片**的占位块：一块灰底，上面一道横向扫光；图到了就被换掉。
 *
 * ## 为什么不是 `ui/skeleton.tsx`
 *
 * `Skeleton` 是注册表那一份，谁都能用、也不假定自己代表什么——设置页的一行文字、
 * 侧边栏菜单项、`/ui` 参照页都在用它，动它等于全站改观感。而且它**没有**下面这几条：
 *
 * | 这条 | 为什么图片占位块非有不可 |
 * |---|---|
 * | `motion-reduce:animate-none` | 扫光是**无限循环**的动效，比 pulse 更需要让路；注册表那份只有 `animate-pulse`，所以每个调用点此前都各写一句 |
 * | 进场淡入 | 「承载块出现」本身要有一个动画，不是硬生生闪出来 |
 * | 半透明底色 | 见下一节：那个强制白底的框逼的 |
 *
 * 一句话：`Skeleton` 是「这里将有东西」，这是「这里将有一张图」。
 *
 * ## 底色是**半透明**的，所以它跟着底下那层走
 *
 * `bg-muted-foreground/30` 压在什么上面就是什么颜色的灰：压在页面底色上是一块浅灰 /
 * 深灰（浏览页瀑布流、图墙、rail 的骨架），压在 `MemeImage` 那个**强制白底**的框上
 * 就是一块浅灰——**两种主题下都对**。
 *
 * 这一条是关键：那个框的底是写死的白、不跟主题走（`MemeImage` 文件头「深色底是白的，
 * 而且不跟主题走」），所以这里**不能**用 `bg-muted` 这类不透明的主题色——深色模式下
 * 它是一块深灰，糊在白框上像一块补丁。半透明的 tint 没有这个问题。
 *
 * ## 扫光在深色下要弱一档
 *
 * 白光压在浅灰上（浅色档）与压在深灰上（深色档）观感差得远：同一个 `white/60`，
 * 前者是柔和的一道，后者是一条扎眼的白杠。所以深色档收到 `white/15`。
 *
 * ⚠️ **代价是「底不是主题色」的那一处要自己覆盖回来**：`MemeImage` 的框在两个主题下
 * 都是白的，它在深色模式下要的是**浅色档**那道扫光，所以那里显式传
 * `dark:via-white/60`（`cn` 会把它并进同一个 `dark:via-*` 组，不是两份）。
 *
 * ## 扫光的两个属性各管各的
 *
 * 静止位置用 `left` 摆（`-left-full` = 停在容器左外侧），动画只碰 `transform`。
 * 理由与 `index.css` 里 `@keyframes shimmer` 那段一样：Tailwind v4 的 `translate-x-*`
 * 走的是 `translate` 独立属性，和 `transform` 会叠加，两边都写就扫不满。
 */
export function Shimmer({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="shimmer" className={cn(SHIMMER_BASE, className)} {...props}>
      <span className={SHIMMER_BAND} />
    </div>
  )
}

/**
 * 底色 + 进场。**`relative` 与 `overflow-hidden` 都在这**：扫光那条是绝对定位的，
 * 少一个容器就裁不住它（它会横穿整个页面）。
 *
 * ⚠️ **`relative` 是可以被覆盖的**，`MemeImage` 就传 `absolute inset-0` 把整个占位块
 * 铺在图片框里——`cn` 做的是 tailwind-merge 那套「后者赢」，不会两份都留在类名里。
 *
 * 进场是 **200ms 淡入**：这个工具要快（styling.md「不做的」），所以不吃 `animate-in`
 * 自带的那档默认时长，也**不做缩放**——缩放会让整墙的格子一起「弹」一下，
 * 而一屏可能有几十个。
 */
const SHIMMER_BASE =
  'relative block overflow-hidden rounded-2xl bg-muted-foreground/30 ' +
  'animate-in fade-in-0 duration-200 motion-reduce:animate-none'

/**
 * 扫光本身。**`w-full` 是「和容器一样宽」**，所以 `translateX(200%)` 正好从
 * 容器左外侧走到右外侧（见 `index.css` 的 keyframes）。
 *
 * `pointer-events-none` 是**声明意图**，不是眼下在挡谁：`MemeImage` 里这个占位块整个是
 * `<button>` 的子节点，那层按钮才是「点了会有事发生」的东西；这条扫光只是装饰，
 * 不该在任何时候参与命中测试（它能溢到容器外，虽然眼下被 `overflow-hidden` 裁住了）。
 */
const SHIMMER_BAND =
  'pointer-events-none absolute inset-y-0 -left-full w-full ' +
  'animate-shimmer bg-linear-to-r from-transparent via-white/60 to-transparent ' +
  'motion-reduce:animate-none dark:via-white/15'
