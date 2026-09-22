import { useState, type Ref } from 'react'
import { Eye, EyeOff, TriangleAlert } from 'lucide-react'
import { cn } from 'cn'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import type { ApiError } from '../../lib/api'
import { TOUCH } from '../../lib/touch'

/**
 * 两个表单（登录 / 注册）共用的输入件。
 *
 * 抽出来的是**会漂的那几处**，不是「看着重复」的那几处：密码框的显隐按钮是
 * 「相对定位 + 绝对定位 + 右侧留白」三件配套，自己写两遍必然有一遍的图标压住文字；
 * 错误面板里的 `requestId` 是**契约**（http.md §3 要求必须露出来），漏写的那一页
 * 不报错，只是哪天用户来报问题时少一条能对上服务端日志的线索。
 */

/**
 * 密码框 + 显隐切换。
 *
 * 显隐按钮不是装饰：手机键盘上打字很容易错一位，而密码框里打错了是**完全看不见**的
 * ——只能靠「提交后报密码错」反推。给一个能看一眼的开关，是这类表单的常规配置。
 *
 * `inputRef` 是给登录页的自动聚焦用的（`styling.md`「自动聚焦：只在精确指针设备上做」）：
 * `Input` 包了 `forwardRef` 才收得到，这点见 `components/ui/input.tsx` 头部。
 */
export function PasswordField({
  id,
  label,
  autoComplete,
  value,
  onChange,
  inputRef,
}: {
  id: string
  label: string
  autoComplete: string
  value: string
  onChange: (value: string) => void
  inputRef?: Ref<HTMLInputElement>
}) {
  const [revealed, setRevealed] = useState(false)

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          ref={inputRef}
          type={revealed ? 'text' : 'password'}
          autoComplete={autoComplete}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // `pr-11` 给右边的按钮让出位置。不让的表现是密码最后几位被图标压住，
          // 而那几位正是用户想看的那几位。
          className={cn('pr-11', TOUCH)}
        />
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          /*
           * 可访问名跟着状态变。**不写 `aria-pressed`**：那个属性要求名字保持稳定，
           * 两者同时变会让读屏念出「隐藏密码，已按下」这种自相矛盾的话。
           *
           * `w-11` 是手指那一档的宽度（44）；`inset-y-0` 让它跟着输入框的实际高度走，
           * 不必自己算——输入框在粗 / 细指针下是 44 / 36 两种高度（`lib/touch.ts`）。
           */
          aria-label={revealed ? '隐藏密码' : '显示密码'}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-3xl text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </div>
  )
}

/**
 * 错误面板。文案用服务端给的 `message`（中文、面向用户、可直接展示），
 * **`requestId` 必须一起露出来**。同 `BrowseResults` 那张错误卡。
 *
 * `Alert` 自带 `role="alert"`，读屏会在它出现的那一刻念出来，不用另加 `aria-live`。
 *
 * `requestId` 走一个 `block` 的 `<span>` 而不是第二个 `<p>`：`AlertDescription` 给
 * 子级 `<p>` 挂了 `mb-4`，两个 `<p>` 之间会拉开 16px，看起来像两块互不相干的信息。
 */
export function AuthError({ title, error }: { title: string; error: ApiError }) {
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>
          {error.message}
          <span className="mt-1 block font-mono text-xs">requestId: {error.requestId}</span>
        </p>
      </AlertDescription>
    </Alert>
  )
}
