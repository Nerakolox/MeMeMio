import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { LoaderCircle } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { type ApiError, register, toStateError } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { useAuth } from '../../contexts/auth'
import { AuthError, PasswordField } from './auth-fields'

export function RegisterForm() {
  const { setUser } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  // 只在精确指针上抢焦点，理由同登录页（styling.md「自动聚焦」）。
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) nameRef.current?.focus()
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      setUser(await register(name, password, inviteCode))
      navigate('/', { replace: true })
    } catch (err) {
      setError(toStateError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // `noValidate` 与 `required` 的分工见 `LoginForm.tsx` 同一条注释。
    <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
      <h1 className="font-heading text-2xl font-medium">注册</h1>

      <div className="grid gap-2">
        <Label htmlFor="reg-name">用户名</Label>
        <Input
          id="reg-name"
          ref={nameRef}
          type="text"
          autoComplete="username"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={TOUCH}
        />
      </div>

      <div className="grid gap-2">
        <PasswordField
          id="reg-password"
          label="密码"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
        />
        {/* 8 位是服务端规则（`api/src/routes/auth.ts` 的 `password.length < 8`）。
            写在这里是为了让人**在打字前**就知道，而不是提交后吃一条报错。 */}
        <p className="text-xs text-muted-foreground">至少 8 位。</p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="reg-invite">邀请码</Label>
        {/*
          `aria-describedby` 把下面那行提示绑到输入框上：读屏念完「邀请码」会接着念它。
          少了它，那句提示对读屏用户等于不存在。
        */}
        <Input
          id="reg-invite"
          type="text"
          autoComplete="off"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          aria-describedby="reg-invite-hint"
          className={TOUCH}
        />
        {/*
          ⚠️ **这个框不能加 `required`。** 服务端对**第一个**注册的用户跳过邀请码校验
          （`api/src/routes/auth.ts` 的事务里有 `isFirst` 那一支：admin 还不存在时无处获取
          邀请码，留的引导口子）。加了 `required` 眼下不会出事——表单带 `noValidate`，
          浏览器不拦——但哪天真把 `noValidate` 去掉，首次部署就会被自己的前端挡在门外，
          而且到那时没有人会想到是这里。
        */}
        <p id="reg-invite-hint" className="text-xs text-muted-foreground">
          找已经在用的成员要一个。一码一人，用过即失效；首次部署留空即可。
        </p>
      </div>

      {error && <AuthError title="注册失败" error={error} />}

      <div className="grid gap-4">
        <Button type="submit" size="lg" className={cn(TOUCH, 'w-full')} disabled={submitting}>
          {submitting && <LoaderCircle className="animate-spin" />}
          {submitting ? '注册中…' : '注册'}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          已有账号？{' '}
          <Link to="/login" className="text-foreground underline underline-offset-4">
            登录
          </Link>
        </p>
      </div>
    </form>
  )
}
