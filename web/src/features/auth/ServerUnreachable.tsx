import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { cn } from 'cn'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import type { ApiError } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { AuthLayout } from './AuthLayout'

/**
 * 启动时**连不上服务器**：`GET /auth/me` 不是 401，而是断网 / 反代挂了 / 5xx。
 *
 * ## 为什么不跳登录页
 *
 * 这一屏的全部意义就是**不把「连不上」显示成「未登录」**。踢回登录页的话，用户会照着
 * 提示重新输一遍密码，然后在同一个错误里循环——问题在网络上，不在凭据上，重登一百次
 * 也不会好。所以给的是「重试」。
 *
 * 401 走的是另一条路：那是真的没会话，`RequireAuth` 跳登录页并带上回跳地址
 * （SPEC §2.2），和这里不重叠。
 *
 * 外壳用 `AuthLayout` 而不是 `AppLayout`：此刻还没有会话，侧边栏那些入口一个都进不去。
 * 借它的第二个理由是品牌区——连不上服务器时最该出现的就是「你确实在自己家的站上」。
 */
export function ServerUnreachable({
  error,
  retrying,
  onRetry,
}: {
  error: ApiError
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <AuthLayout>
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>连不上服务器</AlertTitle>
        <AlertDescription>
          <p>{error.message}</p>
          {/* requestId 必须露出来（http.md §3）：这一屏的另一半用途就是给部署方报障 */}
          <p className="font-mono text-xs">requestId: {error.requestId}</p>
          <Button
            variant="outline"
            size="sm"
            className={cn(TOUCH, 'mt-2')}
            onClick={onRetry}
            disabled={retrying}
          >
            {/* 转圈与文案二选一，同两个表单：光换文案的话，慢网络下按钮看着像没反应 */}
            {retrying && <LoaderCircle className="animate-spin" />}
            {retrying ? '重试中…' : '重试'}
          </Button>
        </AlertDescription>
      </Alert>
    </AuthLayout>
  )
}
