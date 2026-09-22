import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { Button } from '../components/ui/button'
import { Separator } from '../components/ui/separator'
import { EmbedSettings } from '../features/settings/EmbedSettings'
import { InviteSettings } from '../features/settings/InviteSettings'
import { ReindexPanel } from '../features/settings/ReindexPanel'
import { RetagPanel } from '../features/settings/RetagPanel'
import { UsersSettings } from '../features/settings/UsersSettings'
import { TOUCH } from '../features/settings/settings-ui'
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
 * 统计面板（settings-ux.md §9）仍未做——**它要的端点已经有了**（`GET /memes/tag-status?scope=all`
 * 早就支持），只是没人把「全站：已完成 / 待处理 / 需人工 / 索引过期」这一行画出来。
 * 目前全站计数只在 `RetagPanel` 里露了三个（作为重打标的进度），索引过期那一个仍无从查看。
 * 待办留在 `joint-tasks/2026-09-19-tagging-status.md`。
 *
 * 2026-09-21：整页换成 shadcn 组件（原来是一套手写 BEM）。**结构一个字没动**——
 * 分段、顺序、锚点、折叠、管理员可见性都是契约，换的是它们长什么样。
 */

/** 锚点目录。`id` 落在各分段的卡片上（`SettingsCard`），加载中时锚点也要在。 */
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

  // 从 /admin/* 重定向进来带着 #锚点：客户端路由跳转浏览器不会自己滚，要手动滚。
  // 观察的根节点是页面本身（高度会随各段异步加载变化），以前按 `.settings-page` 找。
  useHashScroll(hash, '[data-settings-root]')

  return (
    <div data-settings-root className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold">设置</h1>
        <p className="text-sm text-muted-foreground">
          {isAdmin
            ? '视觉模型是你自己的一份；邀请码、Embedding 与用户是全站的。'
            : '视觉模型是你自己的一份，其余设置由管理员维护。'}
        </p>
      </header>

      {/* 分段目录：一跳到底（settings-ux.md §2）。锚点链接，不是页签——地址栏要能带上 #分段 */}
      <nav aria-label="设置分区" className="flex flex-wrap gap-2">
        {SECTIONS.filter((s) => !s.adminOnly || isAdmin).map((s) => (
          <Button key={s.id} variant="outline" size="sm" className={TOUCH} asChild>
            <a href={`#${s.id}`}>{s.label}</a>
          </Button>
        ))}
      </nav>

      <VisionSettings />

      {isAdmin && (
        <>
          {/*
            分隔线而不是原来那句「以下分段仅管理员可见。」的独段文字：
            它现在同时是**给管理员的提示**，也把这一组和上面那条所有人的分段分开。
          */}
          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">以下分段仅管理员可见</span>
            <Separator className="flex-1" />
          </div>

          <InviteSettings />

          <EmbedSettings onReindexTriggered={() => setReindexToken((n) => n + 1)} />

          {/*
            重建进度和配置是**并列**的两张卡，不是弹窗套弹窗：换模型触发的重算要跑几分钟，
            管理员看着进度还能继续干别的（settings-ux.md §8）。
          */}
          <ReindexPanel refreshToken={reindexToken} />

          {/*
            重打标与重建索引是**并列**的两件事，不是一件事的两个阶段：重建索引只重算
            向量、不调视觉；重打标反过来只调视觉、且不幂等（SPEC §6.4.3）。所以它们是
            两张卡，各有各的按钮和确认流程。
          */}
          <RetagPanel refreshToken={reindexToken} />

          <UsersSettings />
        </>
      )}
    </div>
  )
}
