import type { ReactNode } from 'react'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'

/**
 * 设置页每一段的壳：一张 `Card`，标题、一句话说明、右上角一个状态位。
 *
 * 三段（视觉 / 邀请码 / Embedding / 用户）都用它，所以标题里的结构只写一遍。
 *
 * **`id` 挂在这张 Card 上，不是挂在里面**：旧地址 `/admin/invites` 这类重定向到
 * `/settings#invites`，`use-hash-scroll.ts` 用 `getElementById` 找落点，
 * 而**数据没回来之前锚点也必须存在**——挂在内层就意味着加载态下滚不到。
 * `scroll-mt` 是落点余量，让标题不贴着视口顶边（原来是 `.settings-page__block` 的
 * `scroll-margin-top: 16px`）。**2026-09-21 顶栏改吸顶之后这个余量要加上顶栏的高度**——
 * 顶栏从「滚上去就走」变成「一直占着视口最上面 3.5rem」，只留 16px 的话锚点会落进顶栏
 * 底下，`scrollIntoView()` 照样返回、不报错，人看到的是「点了邀请码却停在上一段」。
 * 值从 `--app-header-h` 算（`index.css` 的 `:root`），不写死两个数的和。
 *
 * 工具类里的 `_` 是空格：`calc()` 的 `+` 两侧**必须有空白**，写成 `+1rem` 整条会被浏览器丢弃。
 *
 * ```tsx
 * <CardTitle><h2>{title}</h2></CardTitle>
 * ```
 * 多这一层 `<h2>` 是因为 `CardTitle` 渲染的是 `<div>`，整页的标题大纲会断在 `<h1>` 上。
 * Tailwind 的 preflight 把标题的 font-size / font-weight 都归成 inherit，
 * 所以套一层不影响 `CardTitle` 的观感，只补回语义。
 */
export function SettingsCard({
  id,
  title,
  description,
  action,
  children,
}: {
  /** 锚点 id。只有被 `/admin/*` 重定向指到的分段需要，其余的分段不传。 */
  id?: string
  title: string
  description: string
  /** 右上角的状态位（当前生效的是哪一套、有几个、跑没跑着）。 */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card id={id} className="scroll-mt-[calc(var(--app-header-h)_+_1rem)]">
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  )
}
