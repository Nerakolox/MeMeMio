import { useEffect, useState } from 'react'
import { ApiError, fetchAdminUsers, patchAdminUser, type AdminUser } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { cn } from '../../lib/utils'
import { useAuth } from '../../contexts/auth'
import { Alert, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
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
 * 设置页 · 用户（仅管理员可见的分段，原 `/admin/users` 整页）。
 *
 * 和 [InviteSettings] 一样，加载态在卡片内部 —— 锚点 `#users` 要一直在。
 */

type RowState = {
  role: 'admin' | 'member'
  quotaInput: string
  saving: boolean
  error: string | null
}

export function UsersSettings() {
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, RowState>>({})

  useEffect(() => {
    fetchAdminUsers()
      .then((data) => {
        setUsers(data)
        const initial: Record<string, RowState> = {}
        for (const u of data) {
          initial[u.id] = {
            role: u.role,
            quotaInput: String(u.storageQuotaBytes),
            saving: false,
            error: null,
          }
        }
        setRows(initial)
      })
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

  function setRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } as RowState }))
  }

  async function handleSave(userId: string) {
    const row = rows[userId]
    if (!row) return
    const quota = parseInt(row.quotaInput, 10)
    if (isNaN(quota) || quota < 0) {
      setRow(userId, { error: '配额必须是非负整数' })
      return
    }
    setRow(userId, { saving: true, error: null })
    try {
      const updated = await patchAdminUser(userId, { role: row.role, storageQuotaBytes: quota })
      setUsers((prev) =>
        prev.map((u) =>
          u.id === userId ? { ...u, role: updated.role, storageQuotaBytes: updated.storageQuotaBytes } : u,
        ),
      )
      setRow(userId, { saving: false })
    } catch (err) {
      if (err instanceof ApiError) {
        setRow(userId, { saving: false, error: `${err.message}（requestId：${err.requestId}）` })
      } else {
        setRow(userId, { saving: false, error: '保存失败' })
      }
    }
  }

  return (
    <SettingsCard
      id="users"
      title="用户"
      description="角色决定权限，存储配额决定这个账号能占用多少空间。"
      action={!loading && !error && <Badge variant="secondary">{users.length} 人</Badge>}
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>用户名</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>存储配额</TableHead>
              <TableHead>已用空间</TableHead>
              <TableHead>注册时间</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const row = rows[u.id]
              const isSelf = u.id === currentUser?.id
              const willLoseSelf = isSelf && row?.role === 'member'
              return (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-xs">{u.id}</TableCell>
                  <TableCell>{u.name}</TableCell>
                  <TableCell>
                    <Select
                      value={row?.role ?? u.role}
                      disabled={row?.saving}
                      onValueChange={(value) =>
                        setRow(u.id, { role: value as 'admin' | 'member' })
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        className={cn(TOUCH, 'w-30')}
                        aria-label={`${u.name} 的角色`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin" className={TOUCH}>
                          admin
                        </SelectItem>
                        <SelectItem value="member" className={TOUCH}>
                          member
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {willLoseSelf && (
                      <p className="mt-1 text-xs text-destructive">降为 member 后将失去管理权限</p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      aria-label={`${u.name} 的存储配额（字节）`}
                      min={0}
                      value={row?.quotaInput ?? String(u.storageQuotaBytes)}
                      onChange={(e) => setRow(u.id, { quotaInput: e.target.value })}
                      className={cn(TOUCH, 'w-32')}
                    />
                  </TableCell>
                  <TableCell>{formatBytes(u.storageUsedBytes)}</TableCell>
                  <TableCell>{formatDate(u.createdAt)}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={TOUCH}
                      disabled={row?.saving}
                      onClick={() => handleSave(u.id)}
                    >
                      {row?.saving ? '保存中…' : '保存'}
                    </Button>
                    {/*
                      行内的错误用一行小字，不用 Alert：那颗组件是 `px-4 py-3` 的整块，
                      塞进单元格会把行撑成一张卡，而这里要说清的只有一句话。
                      role="alert" 保留——保存失败必须被读屏念出来。
                    */}
                    {row?.error && (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {row.error}
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </SettingsCard>
  )
}
