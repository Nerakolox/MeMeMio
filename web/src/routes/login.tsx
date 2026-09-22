import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { AuthLayout } from '../features/auth/AuthLayout'
import { LoginForm } from '../features/auth/LoginForm'

/**
 * 登录页。**只做一件事**：已经登录的人不该再看见它。
 * 表单本体在 `features/auth/`（project-structure.md「路由文件只做布局和数据编排」）。
 */
export function LoginPage() {
  const { user } = useAuth()
  if (user) return <Navigate to="/" replace />

  return (
    <AuthLayout>
      <LoginForm />
    </AuthLayout>
  )
}
