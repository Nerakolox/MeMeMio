import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/auth'
import { ImportProvider, useImport } from './contexts/import'
import { AppSidebar } from './components/AppSidebar'
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
 * 顶栏**故意不做 sticky**：它一旦吸顶，`styles.css` 里 `.browse__sidebar` 的 `top: 0`
 * 会让筛选栏滑到它底下，`#invites` 这类锚点的落点也会被它盖住
 * （`.settings-page__block` 的 `scroll-margin-top` 是按当前布局量的）。
 */
function AppLayout() {
  return (
    // Radix 的 Tooltip 没有 Provider 会**直接抛错**（不是降级），
    // 而侧边栏的图标窄栏模式全靠 tooltip 显示菜单名。registry 的 SidebarProvider
    // 里不含 Provider，这一步漏了整个应用白屏。
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="size-11" />
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
