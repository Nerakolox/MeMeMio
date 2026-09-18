import { useState } from 'react'
import { EmbedSettings } from '../features/settings/EmbedSettings'
import { ReindexPanel } from '../features/settings/ReindexPanel'

/**
 * 管理页 · Embedding（仅管理员，走 App.tsx 里已有的 RequireAdmin 守卫，
 * 和 /admin/invites、/admin/users 一致）。
 *
 * 配置区和重建进度区是**并列**的两块，不是弹窗套弹窗：换模型触发的重算要跑几分钟，
 * 管理员看着进度还能继续干别的（settings-ux.md §8）。
 *
 * 前端守卫只是体验，真正的权限在服务端（state-navigation.md §4）。
 */
export function AdminEmbeddingPage() {
  // 确认换模型后服务端会自动排重算，让下面的进度区立刻重拉一次，不干等轮询
  const [reindexToken, setReindexToken] = useState(0)

  return (
    <div className="admin-page">
      <h1>Embedding 配置</h1>
      <EmbedSettings onReindexTriggered={() => setReindexToken((n) => n + 1)} />
      <ReindexPanel refreshToken={reindexToken} />
    </div>
  )
}
