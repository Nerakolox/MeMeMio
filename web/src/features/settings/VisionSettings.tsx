import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../../lib/api'
import {
  fetchVisionConfig,
  putVisionConfig,
  testVisionConfig,
  type VisionConfig,
} from '../../lib/api-config'
import { formatDate } from '../../lib/format'
import { ConfigFields } from './ConfigFields'
import { TestResultPanel } from './TestResultPanel'
import { describeSaveError, loginRedirectPath } from './save-error'
import { VISION_NOTICE } from './settings-copy'
import { visionProbes } from './test-probes'
import { useConfigForm } from './use-config-form'

/**
 * 用户设置页的视觉通道配置（SPEC §6.5、§9.3）。
 *
 * **整组收进默认折叠的「高级选项」，这个折叠是有意的**：改错了会污染所有人的搜索结果，
 * 所以要多一个动作才能碰到它（settings-ux.md §3）。
 *
 * 「当前生效」那一行放在折叠区外面——用户不展开也该知道自己用的是哪一套。
 *
 * 本任务不做**副通道**的表单（任务「明确不做」）。VISION_NOTICE 里提到副通道的那一句
 * 按契约逐字保留，未自行删改。
 */

function sourceLabel(source: VisionConfig['source']): string {
  return source === 'user' ? '你自己的配置' : '部署方的默认配置'
}

export function VisionSettings() {
  const navigate = useNavigate()
  const form = useConfigForm(testVisionConfig)

  const [config, setConfig] = useState<VisionConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    fetchVisionConfig()
      .then((cfg) => {
        if (!alive) return
        setConfig(cfg)
        form.load({
          baseUrl: cfg.baseUrl ?? '',
          model: cfg.model ?? '',
          // 脱敏串原样留在表单里就等于「不修改」（SPEC §3.5）
          apiKey: cfg.apiKey ?? '',
        })
      })
      .catch((err) => {
        if (!alive) return
        setLoadError(
          err instanceof ApiError ? `${err.message}（requestId：${err.requestId}）` : '加载失败',
        )
      })
    return () => {
      alive = false
    }
    // 只在挂载时拉一次：form 的 setter 每次渲染都是新函数，进依赖数组会变成无限循环
  }, [])

  async function handleSave() {
    setSaveError(null)
    setSaved(false)
    setSaving(true)
    try {
      const updated = await putVisionConfig(form.fields)
      setConfig(updated)
      form.load({
        baseUrl: updated.baseUrl ?? '',
        model: updated.model ?? '',
        apiKey: updated.apiKey ?? '',
      })
      setSaved(true)
    } catch (err) {
      const view = describeSaveError(err)
      if (view.needsLogin) {
        navigate(loginRedirectPath(), { replace: true })
        return
      }
      if (view.retest) form.resetTest()
      setSaveError(view.text)
    } finally {
      setSaving(false)
    }
  }

  if (loadError) return <p className="error">{loadError}</p>
  if (!config) return <p>加载中…</p>

  const busy = saving || form.phase.kind === 'testing'

  return (
    <section className="settings-section">
      <h2>视觉打标模型</h2>

      <p className="settings-section__source">
        当前生效：{sourceLabel(config.source)}
        {config.model && <>（{config.model}）</>}
      </p>
      <p className="settings-section__verified">
        {config.verifiedAt
          ? `上次测试通过：${formatDate(config.verifiedAt)}`
          : '这组配置还没通过过测试'}
      </p>

      {/* 默认折叠，且这个折叠是有意的（settings-ux.md §3） */}
      <details className="settings-section__advanced">
        <summary>高级选项：换成我自己的视觉模型</summary>

        {/* 契约文案，逐字（SPEC §9.9）。渲染成 <pre> 以保留它的分段结构 */}
        <pre className="settings-notice">{VISION_NOTICE}</pre>

        <ConfigFields
          idPrefix="vision"
          fields={form.fields}
          maskedApiKey={config.apiKey}
          disabled={busy}
          onChange={form.setField}
        />

        <div className="settings-section__actions">
          <button type="button" onClick={form.test} disabled={busy}>
            {form.phase.kind === 'testing' ? '测试中…' : '测试连接'}
          </button>
          <button type="button" onClick={handleSave} disabled={!form.tested || busy}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>

        {!form.tested && (
          <p className="settings-section__hint">测试通过后才能保存。改了任一字段都要重新测。</p>
        )}

        {form.phase.kind === 'failed' && (
          <p className="error" role="alert">
            {form.phase.message}
            {form.phase.requestId && `（requestId：${form.phase.requestId}）`}
          </p>
        )}

        {form.phase.kind === 'done' && (
          <TestResultPanel
            ok={form.phase.result.ok}
            probes={visionProbes(form.phase.result)}
            rawResponse={form.phase.result.rawResponse}
            rawError={form.phase.result.rawError}
          />
        )}

        {saveError && (
          <p className="error" role="alert">
            {saveError}
          </p>
        )}
        {saved && <p role="status">已保存</p>}
      </details>
    </section>
  )
}
