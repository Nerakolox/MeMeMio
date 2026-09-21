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
 * ## 几个必须**单独**带上的地方
 *
 * - `SelectItem` / `DropdownMenuItem`：不在触发器那类的覆盖范围里，漏了的表现是
 *   「触发器是 44，展开后每一行又变回 36」。
 * - `AlertDialogAction` / `AlertDialogCancel`：注册表给的是 `size="default"`（`h-9`）。
 */
export const TOUCH = 'min-h-11'
