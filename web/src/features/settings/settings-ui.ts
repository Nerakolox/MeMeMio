/**
 * 设置页共用的两条样式常量。
 *
 * 放在这里而不是各自的组件里：它们各是一个**跨文件一致的约定**，散开写就会漂。
 */

/**
 * 触摸目标 44×44px 的落点（`agents/rules/styling.md`）。
 *
 * **shadcn 的控件默认都低于 44**：`Button` 默认 `h-9`（36px）、`Input` 与 `Select` 也是 `h-9`，
 * `size="sm"` 只有 32px。设置页在手机上要单手点，凡是能聚焦的控件都带上这一句。
 *
 * 这条要求以前住在 `styles.css`（`.config-fields__row input { min-height: 44px }` 等五条
 * 各自写一遍），随那套 BEM 一起删了；现在是一个常量，新加的控件自己带上。
 * 注意 `min-height` 会盖过 `height`——`h-9` 加 `min-h-11` 得到 44，不用去改 size 变体。
 *
 * **没有例外，表格里的控件也带它**（邀请码的「复制」、用户行的角色与配额、保存）。
 * 这一点是实测逼出来的：`Button size="sm"` 是 32px、`SelectTrigger size="sm"` 也是 32、
 * 而 `SelectItem`（下拉里那个选项本身）只有 36——三个都在手机上要手指点。
 * 代价是每行高一点，管理员表的行数是个位数，不值当为此破例。
 *
 * 下拉的 `SelectItem` 要单独带：它不在上面那几类的覆盖范围里，漏了的表现是
 * 「触发器是 44，展开后每一行又变回 36」。
 */
export const TOUCH = 'min-h-11'

/**
 * 契约文案面板（`settings-ux.md §4`、`SPEC §9.9`）。
 *
 * `whitespace-pre-wrap` 保住原文的缩进与分行——那是它的结构（「接口要求 / ⚠️ / 推荐」三段），
 * 拆成 `<p>` 重排会在下一次改动里悄悄走样。`wrap-anywhere` 让窄屏上的长 URL 不撑破面板。
 *
 * `text-sm` 是**不能更小的底线**：这两段是契约，§4 明令「不能删、不能弱化」，
 * 缩字号就是一种弱化。⚠️ 那两行尤其——它是共享库代价在界面上的唯一体现。
 */
export const NOTICE = 'rounded-2xl border bg-muted/40 p-4 font-mono text-sm whitespace-pre-wrap wrap-anywhere'
