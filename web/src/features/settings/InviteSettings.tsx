import { type FormEvent, useEffect, useState } from 'react'
import { ApiError, createInvite, fetchInvites, type InviteCode } from '../../lib/api'
import { formatDate } from '../../lib/format'

/**
 * 设置页 · 邀请码（仅管理员可见的分段，原 `/admin/invites` 整页）。
 *
 * 加载态和错误态渲染在 `<section>` 里面而不是整块替换掉它：这一段挂着锚点 `#invites`，
 * 从 `/admin/invites` 跳过来时标题要立刻在，不能等表格拉回来才出现。
 *
 * 前端只管呈现，权限在服务端（state-navigation.md §4）。
 */

function statusLabel(status: InviteCode['status']): string {
  if (status === 'used') return '已使用'
  if (status === 'expired') return '已过期'
  return '未使用'
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
    <section className="settings-section">
      <h2>邀请码</h2>

      {loading && <p>加载中…</p>}
      {error && (
        <p className="error">
          {error}
          {requestId && `（requestId：${requestId}）`}
        </p>
      )}

      {!loading && !error && (
        <>
          <form className="settings-invite-form" onSubmit={handleCreate}>
            <label htmlFor="expires-at">过期时间（可选，留空为永久）</label>
            <input
              id="expires-at"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            {formError && <p className="error" role="alert">{formError}</p>}
            <button type="submit" disabled={submitting}>
              {submitting ? '生成中…' : '生成邀请码'}
            </button>
          </form>

          <table className="settings-table">
            <thead>
              <tr>
                <th>邀请码</th>
                <th>状态</th>
                {/* 这一列渲染的是 createdBy，不是 createdAt —— 表头按实际渲染的东西写 */}
                <th>创建者</th>
                <th>过期时间</th>
                <th>使用者</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invites.length === 0 && (
                <tr><td colSpan={6}>暂无邀请码</td></tr>
              )}
              {invites.map((inv) => (
                <tr key={inv.code}>
                  <td className="settings-table__code">{inv.code}</td>
                  <td>{statusLabel(inv.status)}</td>
                  <td>{inv.createdBy}</td>
                  <td>{inv.expiresAt ? formatDate(inv.expiresAt) : '永久'}</td>
                  <td>{inv.usedBy ?? '—'}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => handleCopy(inv.code)}
                      aria-label={`复制邀请码 ${inv.code}`}
                    >
                      {copiedCode === inv.code ? '已复制' : '复制'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
