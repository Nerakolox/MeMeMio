/**
 * 触摸目标 44×44px 的**唯一落点**（`agents/rules/styling.md`）。
 *
 * **shadcn 的控件默认都低于 44，而且没有例外**：`Button` 默认 `h-9`（36px）、`Input` 与
 * `Select` 也是 `h-9`，`size="sm"` 只有 32px，`SelectItem`（下拉里那个选项本身）36px。
 * 「小号」在触摸目标这件事上不存在——手机是这个产品体验最好的一端
 * （styling.md「移动端不是适配，是主场」），凡是能点的东西都要带它。
 *
 * 注意 `min-height` 会盖过 `height`——`h-9` 加 `min-h-11` 得到 44，不用去改 size 变体。
 *
 * ## 为什么这个常量从 `features/settings/` 搬到了 `lib/`
 *
 * 2026-09-21 之前它住在 `features/settings/settings-ui.ts`，只有设置页在用。卡片层重做那一次
 * （图片操作菜单、编辑侧边栏、词表 chip、收藏按钮）四个地方都要用它，**再抄一份就是第二个落点**
 * ——这条要求最早是在 `styles.css` 里散着写五遍才被收起来的，散开写会漏，且漏了不报错。
 *
 * `settings-ui.ts` 现在从 `@/lib/touch` 转出同一条常量，所以设置页那十几处调用点一行没改。
 *
 * ## 2026-09-22：44 只给**手指**，鼠标那一档回到库自己的尺寸
 *
 * 产品负责人看完成品提的：「所有的标签、按钮都太大了，浏览页的筛选板块是最佳实例」。
 * 那条 44 的来历（styling.md 那段）是**手机单手操作**，可它被写成了无条件——于是 1600px 的
 * 桌面上，163 个 chip、每一行复选框、每一个下拉都是 44 高，整整比 shadcn 自己的 `size="sm"`
 * 高出 12px，那一栏因此长三成，是面板里最扎眼的东西。
 *
 * **44 是给手指的，不是给宽度的**，所以闸门用**指针**而不是 `md:`：断点按宽度猜指针，
 * 两种都猜错——700px 的桌面窗口被当成手机（白扛 44），宽屏平板被当成桌面（手指按 32）。
 * `pointer` 描述的是**主指针本身**，与窗口多宽无关。
 *
 * 用 `pointer` 不用 `any-pointer`：后者问的是「这台机器有没有粗指针」，触屏笔记本
 * （有触控屏也有触摸板）会答「有」，于是每一台带触摸屏的桌面都退回 44 高的行。
 * 主指针就是「你现在正拿什么在点」，这才是决定尺寸的那件事。
 *
 * ```text
 *   pointer: coarse（手指/触控板以外的触摸屏）  min-h-11 = 44   ← 手机上这一档一个字没变
 *   pointer: fine（鼠标）                      min-h-8  = 32
 * ```
 *
 * `min-height` 只抬不压，所以细指针那一档落到**每个控件自己的 size 变体**上，也就是库作者的
 * 默认密度：chip 与 `SelectTrigger size="sm"` → 32，`SidebarMenuButton` 与 `SelectItem` → 36。
 * 换句话说这不是「把 44 改成 32」，是**在鼠标那一档取消我们额外加的那 12px**。
 *
 * `pointer-fine:` 不是新写法，`components/MemeCard.tsx` 的浮层显形（`REVEAL_ON_HOVER`）早在用，
 * 那条「默认藏起来」的叠法正是叠在 `pointer-fine:opacity-0` 上的。
 *
 * 还想要更小（连手机一起）就改这一行的 `min-h-8`。**`styles.css` 里已经一条
 * `min-height: 44px` 都不剩**：登录页那套 `.auth-form__*` 是最后一份，2026-09-23 随该页
 * 迁到 Tailwind 时按这条改掉了（`features/auth/`）。也就是说这条规则现在**全覆盖**，
 * 没有「那一页还没迁」这种例外可援引。
 *
 * ## 几个必须**单独**带上的地方
 *
 * - `SelectItem` / `DropdownMenuItem`：不在触发器那类的覆盖范围里，漏了的表现是
 *   「触发器是 44，展开后每一行又变回 36」。
 * - `AlertDialogAction` / `AlertDialogCancel`：注册表给的是 `size="default"`（`h-9`）。
 */
export const TOUCH = 'min-h-11 pointer-fine:min-h-8'
