import { type FormEvent, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, login } from '../lib/api'
import { useAuth } from '../contexts/auth'

export function LoginPage() {
  const { user, setUser } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (user) return <Navigate to="/" replace />

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setRequestId(null)
    setSubmitting(true)
    try {
      const u = await login(name, password)
      setUser(u)
      navigate(searchParams.get('next') ?? '/', { replace: true })
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setRequestId(err.requestId)
      } else {
        setError('连不上服务端，确认 api 是否已启动')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <h1 className="auth-form__title">登录</h1>
        <label htmlFor="login-name">用户名</label>
        <input
          id="login-name"
          type="text"
          autoComplete="username"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="login-password">密码</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="auth-form__error" role="alert">
            {error}
            {requestId && <span className="auth-form__request-id">（requestId：{requestId}）</span>}
          </p>
        )}
        <button type="submit" disabled={submitting}>
          {submitting ? '登录中…' : '登录'}
        </button>
        <p className="auth-form__footer">
          没有账号？<Link to="/register">注册</Link>
        </p>
      </form>
    </div>
  )
}
