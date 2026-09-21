import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/auth'
import { ImportProvider, useImport } from './contexts/import'
import { AppSidebar } from './components/AppSidebar'
import { ImageViewerProvider } from './components/ImageViewer'
import { Button } from './components/ui/button'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from './components/ui/sidebar'
import { TooltipProvider } from './components/ui/tooltip'
import { HomePage } from './routes/home'
import { BrowsePage } from './routes/browse'
import { ImportPage } from './routes/import'
import { LoginPage } from './routes/login'
import { RegisterPage } from './routes/register'
import { SettingsPage } from './routes/settings'
import { UiPage } from './routes/ui'
import { NotFoundPage } from './routes/not-found'

/** 未登录就跳登录页，并把当前地址原样带过去（state-navigation.md §5）。 */
function RequireAuth() {
  const { user } = useAuth()
  const location = useLocation()
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  return <Outlet />
}

/** 导入跑着的时候顶栏留个入口，切走再切回来能找到它（import-ux.md §9）。 */
function ImportProgressLink() {
  const { phase, items, done } = useImport()
  const running = phase === 'uploading' || phase === 'processing'
  const settled = items.filter(
    (it) => it.state !== 'waiting' && it.state !== 'uploading',
  ).length
  const total = done?.total ?? items.length

  if (!running || total === 0) return null

  return (
    <Button variant="ghost" size="sm" className="ml-auto tabular-nums" asChild>
      <Link to="/import">
        导入 {settled}/{total}
      </Link>
    </Button>
  )
}

/**
 * 登录后的外壳。2026-09-21 之前这里是顶部导航条 + `styles.css` 里一组 `.app__*`
 * 规则，现在换成 shadcn 的侧边导航（见 `components/AppSidebar.tsx`）。
 *
 * 顶栏**吸顶**（2026-09-21 改，此前故意不吸顶）：它唯一的常驻内容是折叠按钮，
 * 而不吸顶时按钮只在页面顶部可见——长页面往下一滚就再也折不动侧边栏了。
 *
 * 用 `sticky` 不用 `fixed`：`fixed` 把顶栏抽离文档流，下面那几处偏移量之外还得再补一层
 * `padding-top`，多一个会漂的量；`sticky` 的高度仍在流内，变的只是它在视口里的位置。
 *
 * 吸顶的代价是**几处「比它低」的地方**必须跟着算，全部按 `--app-header-h`
 * （`index.css` 的 `:root`，吸顶那天为它新加的一个值）：
 *   · 浏览页筛选列的 sticky `top` 与 `max-height`（`routes/browse.tsx`）
 *   · `SettingsCard` 的 `scroll-mt`（`#invites` 这类锚点的落点）
 * （**三处抽屉不在这张表里**：它们在 Radix 那一层、压得住顶栏，所以按注册表原样全高，
 * 见下面 `z-index` 那段。）
 * 再加上本条自己的高度。顶栏还得压住页面内容，所以 `bg-background` 不能省
 * ——省了不报错，是内容从顶栏底下透出来。
 *
 * ## z-index 20（2026-09-22 定；当天先从 `z-10` 抬到 9999、又落到 60，最终收到 20）
 *
 * 抬起来是修一个**真的会画错**的现象：卡片上的角标 /「⋯」/ 收藏
 * （`components/MemeCard.tsx`）也是 `z-10`，而它们 DOM 更靠后，`SidebarInset` 又只是
 * `relative`（**不构成层叠上下文**）——同一层里按 DOM 顺序比，滚动时卡片浮层会画到顶栏上面。
 * 20 > 10，这个缺陷是修好的（首页图墙那种不带 `transform` 的卡片格子上量得到）。
 *
 * **20 这个数只和两个邻居有关**，不是「越大越保险」：
 *   · 卡片浮层 `z-10`、侧边栏 `z-10`（轨道那条 `z-20` 的细线与顶栏不相交）—— 在下面；
 *   · Radix 那一层 `z-50`（手机端导航抽屉、Dialog、Sheet、Select、Popover）—— 在**上面**。
 *
 * ⚠️ **顶栏必须低于 Radix 那一层**，反过来（60 / 9999 那两版）都错过一次：顶栏一旦高过
 * 50，三处全高面板就被它切成「顶栏 + 面板」上下两条同时显示——手机端开导航抽屉时屏幕上
 * 还留着一条 56px 的顶栏和一个 ☰，产品负责人 2026-09-22 报的就是这个
 * （「和侧边栏展开有冲突，会一起显示」）。那条顶栏还是**假的**：Radix 的模态机制给 `body`
 * 挂了 `pointer-events: none`，在它上面按下命中的是遮罩、效果是**把抽屉关掉**，
 * 不是「顶栏还活着、点 ☰ 能开合导航」。
 *
 * 20 < 50 之后，三处抽屉按注册表原样全高（`inset-y-0`），遮罩也蒙住顶栏，
 * 不用再给它们各写一段 `top-(--app-header-h)`——省掉的正是那段推导。
 *
 * 全屏阅览（`components/ImageViewer.tsx`）不受影响：`.yarl__portal` 自带 `z-index: 9999`，
 * 本来就是数值最大的那一个。
 */
function AppLayout() {
  return (
    // Radix 的 Tooltip 没有 Provider 会**直接抛错**（不是降级），
    // 而侧边栏的图标窄栏模式全靠 tooltip 显示菜单名。registry 的 SidebarProvider
    // 里不含 Provider，这一步漏了整个应用白屏。
    <TooltipProvider>
      <SidebarProvider>
        {/*
          全屏阅览挂在**这一层**，不是挂在卡片里。位置是有讲究的：它包住 `SidebarInset`，
          于是 `<Lightbox>` 的 React 祖先链只有外壳，**不经过任何页面**——否则首页那个挂在
          根 `<section>` 上的键盘 handler 会连阅览器里的 Esc / ↑↓ / Enter 一起接走
          （`components/ImageViewer.tsx` 头部有完整推导，那是本次最容易静默出错的一处）。
        */}
        <ImageViewerProvider>
          <AppSidebar />
          <SidebarInset>
            <header className="sticky top-0 z-20 flex h-(--app-header-h) shrink-0 items-center gap-2 border-b bg-background px-4">
              {/*
                44 是手机那一档的（手指按抽屉开关），鼠标那一档回到 32——
                一个 44 的方块摆在 56 高的顶栏里，四周的空比图标本身还大。
                闸门是指针不是宽度，理由同 `lib/touch.ts`。
              */}
              <SidebarTrigger className="size-11 pointer-fine:size-8" />
              {/*
                进度放顶栏而不是侧边栏：手机端（<768px）整条导航收进抽屉，
                侧边栏上的角标就看不见了，而 import-ux.md §9 要的是「切走再切回来还能看到」。
                折叠成图标窄栏时侧边栏角标同样会隐藏，顶栏是唯一两个形态下都在的位置。
              */}
              <ImportProgressLink />
            </header>
            {/* `SidebarInset` 自己就是 `<main>`，这里不能再套一层，会出现两个 main 地标 */}
            <div className="flex-1 p-6">
              <Outlet />
            </div>
          </SidebarInset>
        </ImageViewerProvider>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export function App() {
  return (
    <AuthProvider>
      {/* 导入队列挂在这里而不是 /import 里：切到搜索页时它要继续跑（import-ux.md §9） */}
      <ImportProvider>
        <Routes>
          {/*
            登录 / 注册不带外壳。它们各自是一个专注任务页，旁边挂一条导航栏只是噪音；
            以前带导航是顶部条时代的遗留（那条导航在两页上也几乎全是登录后才有效的入口）。
          */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route element={<AppLayout />}>
            <Route element={<RequireAuth />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/browse" element={<BrowsePage />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>

            <Route path="/ui" element={<UiPage />} />

            {/*
              三个管理页并进了 /settings（见 routes/settings.tsx）。旧地址保留成重定向而不是
              直接删掉：管理员的书签和文档里的链接都指着它们，404 比多留三行路由贵。
              放在布局路由**里面**——放外面的话重定向会先卸掉整条外壳再挂回来，闪一下。
            */}
            <Route path="/admin" element={<Navigate to="/settings" replace />} />
            <Route
              path="/admin/invites"
              element={<Navigate to="/settings#invites" replace />}
            />
            <Route
              path="/admin/users"
              element={<Navigate to="/settings#users" replace />}
            />
            <Route
              path="/admin/embedding"
              element={<Navigate to="/settings#embedding" replace />}
            />

            {/* `*` 路由验证「刷新任意深层 URL 不 404」，见 api/src/server.ts mountWebDist */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </ImportProvider>
    </AuthProvider>
  )
}
