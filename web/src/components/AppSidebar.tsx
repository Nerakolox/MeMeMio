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
  GalleryVerticalEnd,
  House,
  Images,
  LogOut,
  Settings,
  Upload,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../contexts/auth'
import { postLogout } from '../lib/api'
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
  { to: '/ui', label: '组件', icon: Blocks },
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
 * 图标窄栏模式例外：那时 registry 用 `size-8!` 把按钮压成 32×32 的方块，
 * 而 `min-height` 会盖过 `height`（不同的属性，`!important` 管不着），
 * 不加下面那半句按钮会变成 32 宽 × 44 高的长条。
 * 32 是窄栏的物理宽度（`--sidebar-width-icon: 3rem` 减去 `SidebarGroup` 的 `p-2`），
 * 且那个形态只在 md 以上的桌面出现——手机端拿到的是 Sheet 里的**展开版**，仍然是 44。
 */
const NAV_ITEM_SIZE = 'min-h-11 group-data-[collapsible=icon]:min-h-8'

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

  async function handleLogout() {
    closeDrawer()
    await postLogout()
    setUser(null)
    navigate('/login', { replace: true })
  }

  const items = NAV.filter((item) => !item.authOnly || user)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              tooltip="Mememio"
              className={NAV_ITEM_SIZE}
              onClick={closeDrawer}
            >
              <Link to="/">
                <GalleryVerticalEnd />
                <span className="truncate font-semibold">Mememio</span>
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
          */}
          <Badge variant="secondary" className="mx-2 group-data-[collapsible=icon]:hidden">
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
