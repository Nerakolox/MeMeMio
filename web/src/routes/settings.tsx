import { VisionSettings } from '../features/settings/VisionSettings'

/**
 * 用户设置页（所有人）。
 *
 * **这里没有 Embedding。** 不是权限隐藏，是根本不属于这一页——它全站一份，
 * 在管理页（settings-ux.md §2、SPEC §9.6）。
 *
 * 统计面板（settings-ux.md §9）本任务不做，它要另外的端点。
 */
export function SettingsPage() {
  return (
    <div className="settings-page">
      <h1>设置</h1>
      <VisionSettings />
    </div>
  )
}
