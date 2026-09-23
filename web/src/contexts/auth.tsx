import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  type ApiError,
  type User,
  fetchMe,
  loginPath,
  setUnauthenticatedHandler,
  toStateError,
} from '../lib/api'
import { ServerUnreachable } from '../features/auth/ServerUnreachable'

type AuthContextValue = {
  user: User | null
  setUser: (user: User | null) => void
}

/**
 * 启动探测的三态。
 *
 * **没有「未登录」这一态**：未登录是 `ready` + `user === null`，跳登录页是路由层
 * `RequireAuth` 的事（App.tsx）。这里只分「还没查完」和「查不动」——
 * 后者尤其不能和未登录混为一谈，见 `probe` 里的注释。
 */
type CheckState =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'unreachable'; error: ApiError; retrying: boolean }

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [check, setCheck] = useState<CheckState>({ kind: 'checking' })
  const navigate = useNavigate()

  /**
   * 会话过期的统一落地（SPEC §2.2）。注册给 `lib/api.ts`：那边是唯一发请求的地方，
   * 十几条读路径的 401 都从它那儿过（`toApiError`），在这里只需要处理一次。
   *
   * 注册而不是在 api.ts 里直接 import：那个模块不是 React 组件，拿不到 `useNavigate`。
   */
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setUser(null)
      // 已经在登录页就只清 user。否则 `next` 会指到 `/login` 自己身上，
      // 登录成功后又跳回 `/login`（那一页会把已登录的人转到首页），白绕一圈。
      if (window.location.pathname !== '/login') {
        navigate(loginPath(window.location.pathname + window.location.search), { replace: true })
      }
    })
    return () => setUnauthenticatedHandler(null)
  }, [navigate])

  /** `GET /auth/me`（SPEC §6.1）。启动时第一个请求，重试按钮也走它。 */
  const probe = useCallback(async () => {
    try {
      setUser(await fetchMe())
      setCheck({ kind: 'ready' })
    } catch (err) {
      const apiErr = toStateError(err)

      // 401 = 没有会话/已过期，**这是「未登录」**：放行，让 RequireAuth 去跳登录页。
      if (apiErr.code === 'UNAUTHENTICATED') {
        setUser(null)
        setCheck({ kind: 'ready' })
        return
      }

      // 其余（断网、反代挂了、5xx）**不能当成未登录**：那会显示成「你被登出了」，
      // 而事实只是连不上——用户会去重新登录，然后在同样的错误里循环。给一块能重试的提示。
      setCheck({ kind: 'unreachable', error: apiErr, retrying: false })
    }
  }, [])

  useEffect(() => {
    void probe()
  }, [probe])

  function retry() {
    // 保留错误块、只在按钮上转圈：清成 `checking` 的话整页会先空一屏
    setCheck((prev) =>
      prev.kind === 'unreachable' ? { ...prev, retrying: true } : { kind: 'checking' },
    )
    void probe()
  }

  // 查完之前不渲染——不能先亮一下受保护界面再把人踢走
  if (check.kind === 'checking') return null
  if (check.kind === 'unreachable') {
    return <ServerUnreachable error={check.error} retrying={check.retrying} onRetry={retry} />
  }

  return <AuthContext.Provider value={{ user, setUser }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
