import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { AuthLayout } from '../features/auth/AuthLayout'
import { RegisterForm } from '../features/auth/RegisterForm'

/** 注册页。同 `routes/login.tsx`：路由只做编排，表单在 `features/auth/`。 */
export function RegisterPage() {
  const { user } = useAuth()
  if (user) return <Navigate to="/" replace />

  return (
    <AuthLayout>
      <RegisterForm />
    </AuthLayout>
  )
}
