import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { EmbedSettings } from '../features/settings/EmbedSettings'
import { InviteSettings } from '../features/settings/InviteSettings'
import { ReindexPanel } from '../features/settings/ReindexPanel'
import { UsersSettings } from '../features/settings/UsersSettings'
import { useHashScroll } from '../features/settings/use-hash-scroll'
import { VisionSettings } from '../features/settings/VisionSettings'

/**
 * 设置页：所有设置项都在这一页，管理员比普通用户多看到三段。
 *
 * **原来的 `/admin/invites`、`/admin/embedding`、`/admin/users` 三页并进来了**，旧地址
 * 重定向到对应锚点（App.tsx）。合并的是**呈现**，不是权限：管理员分段对普通用户根本不渲染，
 * 而真正的权限在服务端（state-navigation.md §4）。
 *
 * ⚠️ Embedding **仍然是全站一份、仅管理员可改**（SPEC §9.6）——这条没有因为并页而变。
 * 它现在是设置页里的一个管理员分段，不是每人一份的用户设置。settings-ux.md §2 的
 * 「两个页面」和 SPEC §9.9 的「分成两个页面」是按旧结构写的，见
 * `joint-tasks/2026-09-18-settings-merge.md`。
 *
 * 统计面板（settings-ux.md §9）本次仍不做，它要另外的端点。
 */

/** 锚点目录。`id` 挂在外层 div 上而不是各组件内部：组件加载中时锚点也要在。 */
const SECTIONS = [
  { id: 'vision', label: '视觉模型', adminOnly: false },
  { id: 'invites', label: '邀请码', adminOnly: true },
  { id: 'embedding', label: 'Embedding', adminOnly: true },
  { id: 'users', label: '用户', adminOnly: true },
]

export function SettingsPage() {
  const { user } = useAuth()
  const { hash } = useLocation()
  const isAdmin = user?.role === 'admin'

  // 确认换模型后服务端会自动排重算，让重建进度区立刻重拉一次，不干等轮询
  const [reindexToken, setReindexToken] = useState(0)

  // 从 /admin/* 重定向进来带着 #锚点：客户端路由跳转浏览器不会自己滚，要手动滚
  useHashScroll(hash, '.settings-page')

  return (
    <div className="settings-page">
      <h1>设置</h1>

      <nav className="settings-page__toc" aria-label="设置分区">
        {SECTIONS.filter((s) => !s.adminOnly || isAdmin).map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.label}
          </a>
        ))}
      </nav>

      <div className="settings-page__block" id="vision">
        <VisionSettings />
      </div>

      {isAdmin && (
        <>
          <p className="settings-page__admin-note">以下分段仅管理员可见。</p>

          <div className="settings-page__block" id="invites">
            <InviteSettings />
          </div>

          <div className="settings-page__block" id="embedding">
            <EmbedSettings onReindexTriggered={() => setReindexToken((n) => n + 1)} />
            {/*
              重建进度和配置是**并列**的两块，不是弹窗套弹窗：换模型触发的重算要跑几分钟，
              管理员看着进度还能继续干别的（settings-ux.md §8）。
            */}
            <ReindexPanel refreshToken={reindexToken} />
          </div>

          <div className="settings-page__block" id="users">
            <UsersSettings />
          </div>
        </>
      )}
    </div>
  )
}
