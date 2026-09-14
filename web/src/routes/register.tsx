import { type FormEvent, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ApiError, register } from '../lib/api'
import { useAuth } from '../contexts/auth'

export function RegisterPage() {
  const { user, setUser } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
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
      const u = await register(name, password, inviteCode)
      setUser(u)
      navigate('/', { replace: true })
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
        <h1 className="auth-form__title">注册</h1>
        <label htmlFor="reg-name">用户名</label>
        <input
          id="reg-name"
          type="text"
          autoComplete="username"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="reg-password">密码</label>
        <input
          id="reg-password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label htmlFor="reg-invite">邀请码</label>
        <input
          id="reg-invite"
          type="text"
          autoComplete="off"
          required
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
        />
        {error && (
          <p className="auth-form__error" role="alert">
            {error}
            {requestId && <span className="auth-form__request-id">（requestId：{requestId}）</span>}
          </p>
        )}
        <button type="submit" disabled={submitting}>
          {submitting ? '注册中…' : '注册'}
        </button>
        <p className="auth-form__footer">
          已有账号？<Link to="/login">登录</Link>
        </p>
      </form>
    </div>
  )
}
