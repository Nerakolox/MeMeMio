import { Navigate, Route, Routes, Link } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/auth'
import { ImportProvider, useImport } from './contexts/import'
import { HomePage } from './routes/home'
import { BrowsePage } from './routes/browse'
import { ImportPage } from './routes/import'
import { LoginPage } from './routes/login'
import { RegisterPage } from './routes/register'
import { AdminInvitesPage } from './routes/admin-invites'
import { AdminUsersPage } from './routes/admin-users'
import { AdminEmbeddingPage } from './routes/admin-embedding'
import { SettingsPage } from './routes/settings'
import { NotFoundPage } from './routes/not-found'
import { postLogout } from './lib/api'
import { useNavigate } from 'react-router-dom'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const location = window.location
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  return <>{children}</>
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  if (!user) {
    const next = encodeURIComponent(window.location.pathname + window.location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  if (user.role !== 'admin') return <Navigate to="/" replace />
  return <>{children}</>
}

/** 导入跑着的时候导航上留个入口，用户切走再切回来能找到它（import-ux.md §9）。 */
function ImportNavLink() {
  const { phase, items, done } = useImport()
  const running = phase === 'uploading' || phase === 'processing'
  const settled = items.filter(
    (it) => it.state !== 'waiting' && it.state !== 'uploading',
  ).length
  const total = done?.total ?? items.length

  return (
    <Link to="/import">
      导入
      {running && total > 0 && (
        <span className="app__nav-progress"> {settled}/{total}</span>
      )}
    </Link>
  )
}

function AppShell() {
  const { user, setUser } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await postLogout()
    setUser(null)
    navigate('/login', { replace: true })
  }

  return (
    <div className="app">
      <header className="app__header">
        <nav className="app__nav">
          <Link to="/">Mememio</Link>
          <Link to="/browse">浏览</Link>
          {user && <ImportNavLink />}
          {user && <Link to="/settings">设置</Link>}
          {user?.role === 'admin' && <Link to="/admin/invites">管理</Link>}
          {user?.role === 'admin' && <Link to="/admin/embedding">Embedding</Link>}
        </nav>
        {user && (
          <button className="app__logout" onClick={handleLogout}>
            登出
          </button>
        )}
      </header>
      <main className="app__main">
        {/* `*` 路由验证「刷新任意深层 URL 不 404」，见 api/src/server.ts mountWebDist */}
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <HomePage />
              </RequireAuth>
            }
          />
          <Route
            path="/browse"
            element={
              <RequireAuth>
                <BrowsePage />
              </RequireAuth>
            }
          />
          <Route
            path="/import"
            element={
              <RequireAuth>
                <ImportPage />
              </RequireAuth>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/invites"
            element={
              <RequireAdmin>
                <AdminInvitesPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/users"
            element={
              <RequireAdmin>
                <AdminUsersPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/embedding"
            element={
              <RequireAdmin>
                <AdminEmbeddingPage />
              </RequireAdmin>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  )
}

export function App() {
  return (
    <AuthProvider>
      {/* 导入队列挂在这里而不是 /import 里：切到搜索页时它要继续跑（import-ux.md §9） */}
      <ImportProvider>
        <AppShell />
      </ImportProvider>
    </AuthProvider>
  )
}
