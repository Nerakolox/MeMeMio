import { type FormEvent, useEffect, useState } from 'react'
import { ApiError, createInvite, fetchInvites, type InviteCode } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { Alert, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table'
import { SettingsCard } from './SettingsCard'
import { TOUCH } from './settings-ui'

/**
 * 设置页 · 邀请码（仅管理员可见的分段，原 `/admin/invites` 整页）。
 *
 * 加载态和错误态渲染在卡片**里面**而不是整块替换掉它：这一段挂着锚点 `#invites`，
 * 从 `/admin/invites` 跳过来时标题要立刻在，不能等表格拉回来才出现。
 *
 * 前端只管呈现，权限在服务端（state-navigation.md §4）。
 */

function statusLabel(status: InviteCode['status']): string {
  if (status === 'used') return '已使用'
  if (status === 'expired') return '已过期'
  return '未使用'
}

/**
 * 「未使用」是可用状态，给实心（唯一一个还能用的）；「已使用」是灰的；
 * 「已过期」用描边——它没坏，只是不再生效。**三个都不是错误态**，没有红色的份。
 */
function statusVariant(status: InviteCode['status']): 'default' | 'secondary' | 'outline' {
  if (status === 'used') return 'secondary'
  if (status === 'expired') return 'outline'
  return 'default'
}

export function InviteSettings() {
  const [invites, setInvites] = useState<InviteCode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)

  const [expiresAt, setExpiresAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [copiedCode, setCopiedCode] = useState<string | null>(null)

  useEffect(() => {
    fetchInvites()
      .then(setInvites)
      .catch((err) => {
        if (err instanceof ApiError) {
          setError(err.message)
          setRequestId(err.requestId)
        } else {
          setError('加载失败')
        }
      })
      .finally(() => setLoading(false))
  }, [])

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    setSubmitting(true)
    try {
      const invite = await createInvite(expiresAt || undefined)
      setInvites((prev) => [invite, ...prev])
      setExpiresAt('')
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(`${err.message}（requestId：${err.requestId}）`)
      } else {
        setFormError('生成失败')
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCopy(code: string) {
    await navigator.clipboard.writeText(code)
    setCopiedCode(code)
    setTimeout(() => setCopiedCode(null), 1500)
  }

  return (
    <SettingsCard
      id="invites"
      title="邀请码"
      description="生成注册用的邀请码，可以设过期时间。"
      action={!loading && !error && <Badge variant="secondary">{invites.length} 个</Badge>}
    >
      {loading && <p className="text-sm text-muted-foreground">加载中…</p>}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>
            {error}
            {requestId && `（requestId：${requestId}）`}
          </AlertTitle>
        </Alert>
      )}

      {!loading && !error && (
        <>
          <form className="flex w-full max-w-[30rem] flex-col gap-3" onSubmit={handleCreate}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expires-at">过期时间（可选，留空为永久）</Label>
              <Input
                id="expires-at"
                className={TOUCH}
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            {formError && (
              <Alert variant="destructive">
                <AlertTitle>{formError}</AlertTitle>
              </Alert>
            )}
            <div>
              <Button type="submit" className={TOUCH} disabled={submitting}>
                {submitting ? '生成中…' : '生成邀请码'}
              </Button>
            </div>
          </form>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>邀请码</TableHead>
                <TableHead>状态</TableHead>
                {/* 这一列渲染的是 createdBy，不是 createdAt —— 表头按实际渲染的东西写 */}
                <TableHead>创建者</TableHead>
                <TableHead>过期时间</TableHead>
                <TableHead>使用者</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    暂无邀请码
                  </TableCell>
                </TableRow>
              )}
              {invites.map((inv) => (
                <TableRow key={inv.code}>
                  <TableCell className="font-mono text-xs">{inv.code}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(inv.status)}>{statusLabel(inv.status)}</Badge>
                  </TableCell>
                  <TableCell>{inv.createdBy}</TableCell>
                  <TableCell>{inv.expiresAt ? formatDate(inv.expiresAt) : '永久'}</TableCell>
                  <TableCell>{inv.usedBy ?? '—'}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={TOUCH}
                      onClick={() => handleCopy(inv.code)}
                      aria-label={`复制邀请码 ${inv.code}`}
                    >
                      {copiedCode === inv.code ? '已复制' : '复制'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </SettingsCard>
  )
}
