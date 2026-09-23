/**
 * 应用外壳的侧边导航。
 *
 * 放在 `components/` 而不是 `features/`：它不是某个业务功能的界面，是**外壳**——
 * 每条路由都挂在它下面（`src/App.tsx` 的 `AppLayout`）。`project-structure.md` 那条
 * 「被两个以上 feature 用到才放 `components/`」针对的是 feature 之间的复用；
 * 外壳不属于任何一个 feature，放回 `App.tsx` 会把那个文件顶过 `code-style.md §组件` 的 150 行。
 *
 * 折叠形态是 `collapsible="icon"`：收起后留一条图标窄栏，图标带 tooltip。
 * 手机端（<768px）shadcn 的 `Sidebar` 自己会换成 Sheet 抽屉，这里不用额外写分支。
 */

import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Blocks,
  House,
  Images,
  LogOut,
  Settings,
  Upload,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../contexts/auth'
import { ApiError, postLogout } from '../lib/api'
import { notifyFailure } from '../lib/toast'
import { TOUCH } from '../lib/touch'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from './ui/sidebar'

type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  /** 要登录才有意义的目的地。未登录时这两条不渲染。 */
  authOnly?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: '首页', icon: House },
  { to: '/browse', label: '浏览', icon: Images },
  { to: '/import', label: '导入', icon: Upload, authOnly: true },
  { to: '/settings', label: '设置', icon: Settings, authOnly: true },
  /*
    组件参照页（`App.tsx` 的 `/ui`）只有开发期有这条路由，入口跟着一起消失。
    判据用**同一个** `import.meta.env.DEV`，写成条件展开而不是「渲染时 filter 掉」：
    filter 掉的只是渲染结果，那条 `label: '组件'` 仍然躺在生产包里（`vite build` 后
    grep 得到）；条件展开能让 Rollup 判定整个字面量是死代码。两边分开写的话，
    生产包里会出现一个点了就掉进 404 的入口。
  */
  ...(import.meta.env.DEV
    ? [{ to: '/ui', label: '组件', icon: Blocks } satisfies NavItem]
    : []),
]

/**
 * 触摸目标 44×44px 的落点。
 *
 * 这条要求以前住在这里：`styles.css` 的 `.app__nav a { min-height: 44px }`，
 * 注释写明是 390×844 实测出来的——同一条导航上中文链接靠行高凑到 51px、
 * 拉丁字母的（品牌名）只有 26px，一条导航不该有两种可点尺寸。
 * 换成竖排侧边栏之后那个不对称从结构上消失了，但**尺寸要求还在**：
 * shadcn 的菜单项默认 `h-9`（36px），低于 44，所以这里统一抬到 44。
 *
 * 2026-09-22 起那一抬由 `TOUCH` 承担、按**指针**分档（`lib/touch.ts` 头部有推导）：
 * 鼠标那一档收回额外的 12px，菜单项落到 registry 自己的 `h-9` = 36，
 * 手指那一档仍是 44。写字面量 `min-h-11` 就等于绕过了那道闸门。
 *
 * 图标窄栏模式的那半句**不能并进 `TOUCH`**：那时 registry 用 `size-8!` 把按钮压成
 * 32×32 的方块，而 `min-height` 会盖过 `height`（不同的属性，`!important` 管不着），
 * 少了它按钮会变成 32 宽 × 44 高的长条。窄栏形态在**粗指针下也会出现**
 * （平板横屏 ≥768px 时收成图标栏），那时 `TOUCH` 给的是 44，所以这一条必须无条件写死。
 * 32 是窄栏的物理宽度（`--sidebar-width-icon: 3rem` 减去 `SidebarGroup` 的 `p-2`），
 * 手机端拿到的是 Sheet 里的**展开版**，那一档由 `TOUCH` 保住 44。
 */
const NAV_ITEM_SIZE = cn(TOUCH, 'group-data-[collapsible=icon]:min-h-8')

export function AppSidebar() {
  const { user, setUser } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { setOpenMobile } = useSidebar()

  /*
   * 手机端 `Sidebar` 渲染的是一个 Sheet 抽屉（`sidebar.tsx` 里 `isMobile` 那一支），
   * 而 registry **没有**「导航后自动收起」这条——点进去只是路由变了，抽屉照旧盖在
   * 新页面上面，用户得再点一下遮罩才看得见自己刚点的页。桌面上 `isMobile` 为 false，
   * 这个 setter 无害。
   */
  const closeDrawer = () => setOpenMobile(false)

  /**
   * 登出。
   *
   * ⚠️ **这里必须有 try/catch**（2026-09-24 补）。`postLogout` 在非 204 时抛异常，
   * 而此前这个函数没有接：网络一失败就是一条未处理的拒绝——不跳转、不报错、
   * **按钮看起来完全是死的**，用户只会反复点。它和「复制」不同，失败并不会自己
   * 在别处显形。
   *
   * 失败时**不强行清本地会话**：服务端的会话还在，本地清掉只会让界面显示成已登出、
   * 而带着 cookie 的下一次请求又能通（`lib/api.ts` 的 `ApiError`）。如实报一句，
   * 让用户自己决定要不要再点一次。
   */
  async function handleLogout() {
    closeDrawer()
    try {
      await postLogout()
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null
      notifyFailure(`退出登录失败：${apiErr?.message ?? '请稍后重试'}`, apiErr?.requestId)
      return
    }
    setUser(null)
    navigate('/login', { replace: true })
  }

  const items = NAV.filter((item) => !item.authOnly || user)

  return (
    <Sidebar collapsible="icon">
      {/*
        品牌行**坐在顶栏的同一根中线上**（2026-09-22）。顶栏是一条 56px 的带子
        （`--app-header-h`），而 registry 的 `SidebarHeader` 自带 `p-2`，于是品牌行
        （`size="lg"` = `h-14`，也是 56px）落在 y=8..64：**logo 比 ☰ 低 8px**，
        两个都在左上角，一条水平线对不齐。`pt-0` 让这 56px 与顶栏那 56px 完全重合。
        窄栏（`collapsible=icon`）下按钮被压成 32px 的方块，同样要对齐 28 就得从 12 起，
        所以 `pt-3`。手机上侧栏是抽屉、按 md 断点判断，icon 模式到不了，故 `max-md:pt-2`
        把 registry 那 8px 留给它，抽屉里 logo 不至于贴着上沿。
      */}
      <SidebarHeader className="pt-0 group-data-[collapsible=icon]:pt-3 max-md:pt-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              tooltip="Mememio"
              // `justify-center` 只在窄栏下加：`size="lg"` 那一档的 registry 里写着
              // `group-data-[collapsible=icon]:p-0!`（**带 `!`**），于是 32px 的方块内边距为 0，
              // 图形 LOGO 贴死左沿——实测中心 16，而同栏里每一个导航图标都是 24。
              // 不跟那个 `!important` 硬碰（两条 `!` 规则比的是源码顺序，不稳），换 `justify-content`。
              className={cn(NAV_ITEM_SIZE, 'group-data-[collapsible=icon]:justify-center')}
              onClick={closeDrawer}
            >
              <Link to="/" aria-label="Mememio">
                {/* 图形 + 文字两颗 LOGO 替代了原来的通用图标 + 文字（2026-09-22）。
                    源文件在仓库根（`MeMeMio-LOGO.svg` / `MeMeMio-TEXT.svg`），这里是它的副本；
                    深色那一份由它换色得到（配方写在 `web/agents/rules/styling.md`），
                    设计师改图时四份要一起换。

                    两颗都 `alt=""` + 链接上 `aria-label`：窄栏下文字 LOGO 是 `hidden`，
                    名字若靠图的 alt 给，收起来就没了。

                    尺寸跟着 registry 的图标位走：`[&_svg]:size-4` 只管 svg，
                    `<img>` 得自己写；窄栏（`collapsible=icon`）是 32×32 的方块，取 16。

                    ## 为什么是 `<picture>` 而不是 `dark:invert`（2026-09-22 换掉）

                    原来靠 `filter: invert(1)` 反色，两处不对：字腔那两条 `#FEFDF9` 是
                    **故意画的「透底」**（应当露出侧栏底色），反色后变成近黑，而深色侧栏是
                    `oklch(0.205 0 0)` = `#171717`；favicon 也没有深色变体。

                    SVG 走 `<img>` 时取不到页面的 `currentColor`，而**在 SVG 文件里写
                    `@media (prefers-color-scheme: dark)` 是 WebKit 上不生效的**
                    （Safari 不把宿主页的配色传给图片文档），深色下会变成深底上的深 logo——
                    不是不好看，是看不见。所以备了两份文件、由 `<picture>` 在**页面这一侧**
                    挑（`<source media>` 是页面求值的，各浏览器一致），既不进 JS 包，
                    又只下载用到的那一份。

                    `display: contents` 让 `<picture>` 自己不生成盒子：它是 inline 元素，
                    留着会多一个行盒，整行一起漂（`ImageViewer` 那次记过同样的坑）。
                    `group-data-[collapsible=icon]:hidden` 因此挪到 `<picture>` 上。 */}
                <picture className="contents">
                  <source srcSet="/mememio-mark-dark.svg" media="(prefers-color-scheme: dark)" />
                  <img
                    src="/mememio-mark.svg"
                    alt=""
                    className="size-5 shrink-0 group-data-[collapsible=icon]:size-4"
                  />
                </picture>
                <picture className="contents group-data-[collapsible=icon]:hidden">
                  <source
                    srcSet="/mememio-wordmark-dark.svg"
                    media="(prefers-color-scheme: dark)"
                  />
                  <img src="/mememio-wordmark.svg" alt="" className="h-4 w-auto shrink-0" />
                </picture>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {items.map((item) => (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton
                  asChild
                  // 精确相等，不用 `startsWith`：`/` 是每条路由的前缀，
                  // 前缀匹配会让「首页」在每一页都亮着。
                  isActive={pathname === item.to}
                  tooltip={item.label}
                  className={NAV_ITEM_SIZE}
                  onClick={closeDrawer}
                >
                  <Link to={item.to}>
                    <item.icon />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      {user && (
        <SidebarFooter>
          {/*
            `User` 里没有邮箱和昵称（`lib/api.ts` 的 `User` 只有 id / role / 配额 / 创建时间），
            所以这里只显示角色，不编一个用户名出来。

            角色用**描边/实底**区分（2026-09-22 产品负责人定：管理员用 `default`、成员用
            `outline`），不是靠颜色深浅：`secondary` 对两个角色是一模一样的灰，扫一眼分不出
            自己是什么身份。深浅在同一块底色上也容易被当成「选中/未选中」。
          */}
          <Badge
            variant={user.role === 'admin' ? 'default' : 'outline'}
            className="mx-2 group-data-[collapsible=icon]:hidden"
          >
            {user.role === 'admin' ? '管理员' : '成员'}
          </Badge>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={handleLogout}
                tooltip="登出"
                className={NAV_ITEM_SIZE}
              >
                <LogOut />
                <span>登出</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      )}
    </Sidebar>
  )
}
