/**
 * 设置页共用的样式常量。
 *
 * 放在这里而不是各自的组件里：它们是**跨文件一致的约定**，散开写就会漂。
 */

/**
 * 触摸目标 44×44px（`agents/rules/styling.md`）。
 *
 * ⚠️ **这条常量本身已经搬到 `src/lib/touch.ts`**（2026-09-21）：卡片层重做之后，
 * 图片操作菜单、编辑侧边栏、词表 chip 也都要用它，而它此前只属于设置页。
 * 这里保留转出，是为了让设置页那十几处调用点不用改一行——**值只有一份，在 `@/lib/touch`**。
 * 新代码从 `@/lib/touch` 取，别从这里取。
 */
export { TOUCH } from '../../lib/touch'

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
