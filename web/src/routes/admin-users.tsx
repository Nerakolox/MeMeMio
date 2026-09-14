import { useEffect, useState } from 'react'
import { ApiError, fetchAdminUsers, patchAdminUser, type AdminUser } from '../lib/api'
import { formatBytes, formatDate } from '../lib/format'
import { useAuth } from '../contexts/auth'

type RowState = {
  role: 'admin' | 'member'
  quotaInput: string
  saving: boolean
  error: string | null
}

export function AdminUsersPage() {
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

  if (loading) return <p>加载中…</p>
  if (error) return <p className="error">{error}{requestId && `（requestId：${requestId}）`}</p>

  return (
    <div className="admin-page">
      <h1>用户管理</h1>
      <table className="admin-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>用户名</th>
            <th>角色</th>
            <th>存储配额</th>
            <th>已用空间</th>
            <th>注册时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const row = rows[u.id]
            const isSelf = u.id === currentUser?.id
            const willLoseSelf = isSelf && row?.role === 'member'
            return (
              <tr key={u.id}>
                <td className="admin-table__mono">{u.id}</td>
                <td>{u.name}</td>
                <td>
                  <select
                    aria-label={`${u.name} 的角色`}
                    value={row?.role ?? u.role}
                    onChange={(e) =>
                      setRow(u.id, { role: e.target.value as 'admin' | 'member' })
                    }
                  >
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                  </select>
                  {willLoseSelf && (
                    <span className="admin-table__warn"> 降为 member 后将失去管理权限</span>
                  )}
                </td>
                <td>
                  <input
                    type="number"
                    aria-label={`${u.name} 的存储配额（字节）`}
                    min={0}
                    value={row?.quotaInput ?? String(u.storageQuotaBytes)}
                    onChange={(e) => setRow(u.id, { quotaInput: e.target.value })}
                    className="admin-table__quota-input"
                  />
                </td>
                <td>{formatBytes(u.storageUsedBytes)}</td>
                <td>{formatDate(u.createdAt)}</td>
                <td>
                  <button
                    type="button"
                    disabled={row?.saving}
                    onClick={() => handleSave(u.id)}
                  >
                    {row?.saving ? '保存中…' : '保存'}
                  </button>
                  {row?.error && (
                    <p className="error admin-table__row-error" role="alert">{row.error}</p>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
