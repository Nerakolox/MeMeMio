import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../../lib/api'
import {
  fetchEmbedConfig,
  putEmbedConfig,
  testEmbedConfig,
  type EmbedConfig,
} from '../../lib/api-config'
import { formatDate } from '../../lib/format'
import { ConfigFields } from './ConfigFields'
import { TestResultPanel } from './TestResultPanel'
import { describeSaveError, loginRedirectPath } from './save-error'
import { EMBED_NOTICE } from './settings-copy'
import { embedNotes, embedProbes } from './test-probes'
import { useConfigForm } from './use-config-form'

/**
 * 管理页的全站 Embedding 配置（SPEC §6.5、§9.6）。
 *
 * **不收进折叠区**：和视觉通道相反，这一组是管理员特意进来改的，藏起来没有意义；
 * 需要多一道手的地方在换模型的二次确认上。
 *
 * 换模型且库里已有数据时服务端返回 `EMBED_MODEL_CHANGED`（409），这不是错误，
 * 是要求确认。确认后带 `confirmReindex: true` 重发，服务端自动排全站重算。
 */

export function EmbedSettings({ onReindexTriggered }: { onReindexTriggered: () => void }) {
  const navigate = useNavigate()
  const form = useConfigForm(testEmbedConfig)

  const [config, setConfig] = useState<EmbedConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  /** 服务端要求确认换模型，等用户点确认后带 confirmReindex 重发 */
  const [needsConfirm, setNeedsConfirm] = useState(false)

  useEffect(() => {
    let alive = true
    fetchEmbedConfig()
      .then((cfg) => {
        if (!alive) return
        setConfig(cfg)
        form.load({
          baseUrl: cfg.baseUrl ?? '',
          model: cfg.model ?? '',
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

  async function save(confirmReindex: boolean) {
    setSaveError(null)
    setSaved(false)
    setSaving(true)
    try {
      const updated = await putEmbedConfig(form.fields, confirmReindex)
      setConfig(updated)
      form.load({
        baseUrl: updated.baseUrl ?? '',
        model: updated.model ?? '',
        apiKey: updated.apiKey ?? '',
      })
      setNeedsConfirm(false)
      setSaved(true)
      // 确认换模型的那一次保存会在服务端排队重算，让进度区立刻去拉一次状态
      if (confirmReindex) onReindexTriggered()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMBED_MODEL_CHANGED') {
        // 不是失败，是要求确认（SPEC §6.5.2）
        setNeedsConfirm(true)
        return
      }
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
      <h2>Embedding 模型（全站）</h2>

      <p className="settings-section__source">
        当前生效：{config.source === 'user' ? '管理员配置的' : '部署方环境变量里的'}
        {config.model && <>（{config.model}）</>}
      </p>
      <p className="settings-section__verified">
        {config.verifiedAt
          ? `上次测试通过：${formatDate(config.verifiedAt)}`
          : '这组配置还没通过过测试'}
        {config.nativeDim !== null && <>　实测维度 {config.nativeDim}</>}
      </p>

      {/* 契约文案，逐字（SPEC §9.9） */}
      <pre className="settings-notice">{EMBED_NOTICE}</pre>

      <ConfigFields
        idPrefix="embed"
        fields={form.fields}
        maskedApiKey={config.apiKey}
        disabled={busy}
        onChange={form.setField}
      />

      <div className="settings-section__actions">
        <button type="button" onClick={form.test} disabled={busy}>
          {form.phase.kind === 'testing' ? '测试中…' : '测试连接'}
        </button>
        <button type="button" onClick={() => save(false)} disabled={!form.tested || busy}>
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
          probes={embedProbes(form.phase.result)}
          notes={embedNotes(form.phase.result)}
          rawResponse={form.phase.result.rawResponse}
          rawError={form.phase.result.rawError}
        />
      )}

      {needsConfirm && (
        <div className="settings-confirm" role="alertdialog" aria-label="确认更换 Embedding 模型">
          <p>
            换掉 Embedding 模型会触发<strong>全站重新索引</strong>：库里已有的向量属于旧模型，
            要按新模型全部重算一遍。
          </p>
          <p>重算期间搜索降级为 OCR + 标签，结果会带「可能不全」的提示，但服务不中断。</p>
          <div className="settings-confirm__actions">
            <button type="button" onClick={() => save(true)} disabled={saving}>
              {saving ? '提交中…' : '确认更换并开始重建'}
            </button>
            <button type="button" onClick={() => setNeedsConfirm(false)} disabled={saving}>
              取消
            </button>
          </div>
        </div>
      )}

      {saveError && (
        <p className="error" role="alert">
          {saveError}
        </p>
      )}
      {saved && <p role="status">已保存</p>}
    </section>
  )
}
