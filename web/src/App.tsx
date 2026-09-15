import { Navigate, Route, Routes, Link } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/auth'
import { HomePage } from './routes/home'
import { BrowsePage } from './routes/browse'
import { LoginPage } from './routes/login'
import { RegisterPage } from './routes/register'
import { AdminInvitesPage } from './routes/admin-invites'
import { AdminUsersPage } from './routes/admin-users'
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
          {user?.role === 'admin' && <Link to="/admin/invites">管理</Link>}
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
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  )
}

export function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
