import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { LoaderCircle } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { type ApiError, login, toStateError } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { useAuth } from '../../contexts/auth'
import { AuthError, PasswordField } from './auth-fields'

/**
 * 只在 `next` 确实是**站内路径**时回跳（state-navigation.md §5 要的那次回跳）。
 *
 * ⚠️ **`next` 是攻击者可控的，不能直接交给 `navigate()`。** `history.pushState` 对
 * 跨源 URL 抛 `SecurityError`，而 `@remix-run/router` 的 `push` 只对 `DataCloneError`
 * 往外抛，其余一律退回 `window.location.assign(url)`（`router.cjs.js` 的 `push`）。
 * 于是 `/login?next=//evil.com` 会在**登录成功之后**把人送到外站——一个刚好在
 * 「刚输完密码、最不设防」那一刻出现的仿冒页。
 *
 * 正则同时挡掉 `/\`：浏览器会把反斜杠归一成斜杠，`/\evil.com` 与 `//evil.com` 等价。
 * 判据是「以单个 `/` 开头」，因为**要保住的是站内那次跳转，不是信任这个参数**。
 */
function safeNext(raw: string | null): string {
  return raw && /^\/(?![/\\])/.test(raw) ? raw : '/'
}

export function LoginForm() {
  const { setUser } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  // 「打开就能打字」，但**只在精确指针上**（styling.md「自动聚焦」）：
  // 手机上抢焦点会直接弹起软键盘，把下半屏连同提交按钮一起盖住。
  // 用 effect 而不是 `autoFocus` 属性——属性带不了条件。
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) nameRef.current?.focus()
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      setUser(await login(name, password))
      navigate(safeNext(searchParams.get('next')), { replace: true })
    } catch (err) {
      // 走 `toStateError` 而不是自己分支：断网 / 代理挂掉时也要能读出「连不上服务端」
      // 而不是白屏，那是 `lib/api.ts` 已经收好的一份（http.md §4），别各写各的。
      setError(toStateError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    /*
     * `noValidate` 是有意的：校验的真相在服务端（SPEC §2 的错误信封，文案是中文且
     * 面向用户），浏览器原生气泡的措辞与样式都跟我们这一套对不上；把校验分成两份，
     * 「服务端说密码错了、浏览器说必填」这类矛盾迟早出现。
     *
     * `required` 仍然留着——它不带 `noValidate` 下的拦截行为，但**读屏会念出「必填」**。
     */
    <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
      <h1 className="font-heading text-2xl font-medium">登录</h1>

      <div className="grid gap-2">
        <Label htmlFor="login-name">用户名</Label>
        <Input
          id="login-name"
          ref={nameRef}
          type="text"
          autoComplete="username"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={TOUCH}
        />
      </div>

      <PasswordField
        id="login-password"
        label="密码"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
      />

      {error && <AuthError title="登录失败" error={error} />}

      <div className="grid gap-4">
        <Button type="submit" size="lg" className={cn(TOUCH, 'w-full')} disabled={submitting}>
          {/* 转圈与文案二选一不变：单改文案的话，慢网络下按钮看着像没反应 */}
          {submitting && <LoaderCircle className="animate-spin" />}
          {submitting ? '登录中…' : '登录'}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          没有账号？{' '}
          <Link to="/register" className="text-foreground underline underline-offset-4">
            注册
          </Link>
        </p>
      </div>
    </form>
  )
}
