import { useEffect, useRef, type ReactNode } from 'react'
import type { Meme } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { tagStatusLabel } from '../../lib/tag-status'
import { emotionOptions, sceneOptions, tagOptions } from '../../lib/vocab'
import { VocabPicker } from '../../components/VocabPicker'
import { useMemeEdit } from './use-meme-edit'

/**
 * 图片详情 / 编辑侧边栏。
 *
 * ## 显示哪些字段
 *
 * SPEC §5.2.6 那份清单就是**上限**，这里照着它列。`contentHash` / `phash` / `embedding` /
 * `searchText` / `embedModel` / `deletedAt` / `storageKey` **不在响应里，也没有用户可读的含义**，
 * 所以这里既拿不到、也不该显示——**不要为了把面板填满去让 api 加字段**。
 *
 * ## 数据从哪来
 *
 * 用列表里那一条，**不再拉一次**。并发编辑是最后写入者赢、不做冲突检测（§6.4.1），
 * 所以「打开面板时再 GET 一次」并不能消除竞态，只是把同一个问题挪了个位置。
 */
export function MemeEditPanel({
  meme,
  currentUserId,
  onClose,
  onSaved,
}: {
  meme: Meme
  currentUserId: string | null
  onClose: () => void
  onSaved: (updated: Meme) => void
}) {
  const { draft, update, reset, save, saving, error, dirty } = useMemeEdit(meme, onSaved)
  const panelRef = useRef<HTMLDivElement>(null)

  // 打开时把焦点收进面板，读屏用户才知道自己进了一个新层
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Esc 关闭是硬要求（clipboard-share.md / 任务文件）：搜索页的键盘路径是核心体验，
      // 弹层不响应键盘在这个项目里是硬伤
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <>
      {/*
        点外部关闭。这层没有视觉，只有位置与点击面——它是遮罩的**结构**部分，
        着色留给之后那次视觉定稿（web/AGENTS.md §5）。
      */}
      <div className="manage-panel__scrim" onClick={onClose} aria-hidden="true" />

      <aside
        className="manage-panel"
        role="dialog"
        aria-modal="true"
        aria-label="图片信息"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="manage-panel__header">
          <h2 className="manage-panel__title">图片信息</h2>
          <button type="button" className="manage-panel__close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="manage-panel__body">
          <img
            className="manage-panel__preview"
            src={meme.url}
            alt={meme.description ?? meme.originalFilename ?? meme.id}
          />

          <dl className="manage-panel__fields">
            <Field label="文件名">{meme.originalFilename ?? '—'}</Field>
            <Field label="格式">{meme.mime}</Field>
            <Field label="尺寸">
              {meme.width !== null && meme.height !== null
                ? `${meme.width} × ${meme.height}`
                : '未知'}
            </Field>
            <Field label="大小">{formatBytes(meme.sizeBytes)}</Field>
            {/* 是否动图决定复制能不能用，用户要知道自己看到的「下载」是为什么（SPEC §5.2.2） */}
            <Field label="动图">{meme.isAnimated ? '是，写不进剪贴板' : '否'}</Field>
            <Field label="上传者">{meme.uploaderName}</Field>
            <Field label="上传时间">{formatDate(meme.createdAt)}</Field>
            <Field label="打标状态">{tagStatusLabel(meme.tagStatus)}</Field>
            <Field label="视觉模型">{meme.visionModel ?? '—'}</Field>
            <Field label="收藏">{meme.favorited ? '已收藏' : '未收藏'}</Field>
            <Field label="图片 ID">
              <span className="manage-panel__mono">{meme.id}</span>
            </Field>
            <Field label="上传者 ID">
              <span className="manage-panel__mono">{meme.uploaderId}</span>
            </Field>
            {/*
              编辑痕迹：首期只有这两个字段，没有完整修改历史（SPEC §3.3）。
              名字解析不出来——接口只给 uuid，所以只区分「你」和「别人」，
              uuid 放在 title 里备查，不占版面。
            */}
            <Field label="最近编辑">
              {meme.editedAt === null ? (
                '没有人工编辑过'
              ) : (
                <>
                  {formatDate(meme.editedAt)} ·{' '}
                  <span title={meme.editedBy ?? undefined}>
                    {meme.editedBy !== null && meme.editedBy === currentUserId ? '你' : '其他用户'}
                  </span>
                </>
              )}
            </Field>
          </dl>

          {/*
            OCR 文本**只读**，不给输入框（SPEC §6.4.1）：它是模型对图像的读数，
            手改会让文本和图不再对应，而 search_text 会忠实转发这个错，没有任何地方会报错。
          */}
          <section className="manage-panel__section">
            <h3 className="manage-panel__section-title">OCR 文本（只读）</h3>
            <p className="manage-panel__ocr">
              {meme.ocrText === null || meme.ocrText.trim() === '' ? '（这张图没有识别出文字）' : meme.ocrText}
            </p>
            <p className="manage-panel__hint">OCR 文本只能由重新打标产生，不能手改。</p>
          </section>

          <section className="manage-panel__section">
            <h3 className="manage-panel__section-title">描述</h3>
            <textarea
              className="manage-panel__description"
              value={draft.description}
              rows={4}
              disabled={saving}
              placeholder="这张图是什么？"
              onChange={(e) => update('description', e.target.value)}
            />
          </section>

          <VocabPicker
            title="情绪"
            options={emotionOptions}
            selected={draft.emotions}
            onChange={(next) => update('emotions', next)}
            disabled={saving}
          />
          <VocabPicker
            title="场景"
            options={sceneOptions}
            selected={draft.scenes}
            onChange={(next) => update('scenes', next)}
            disabled={saving}
          />
          <VocabPicker
            title="标签"
            options={tagOptions}
            selected={draft.tags}
            onChange={(next) => update('tags', next)}
            disabled={saving}
          />

          {error !== null && (
            <div className="manage-panel__error" role="alert">
              {/* message 直接展示：词表外标签那句话是给用户看的（SPEC §4.5），不解析它的措辞 */}
              <p>{error.message}</p>
              {/* requestId 必须露出来，报问题时它是唯一能对上服务端日志的东西（http.md §3） */}
              <p className="manage-panel__request-id">requestId: {error.requestId}</p>
            </div>
          )}
        </div>

        <footer className="manage-panel__footer">
          {/* 不做乐观更新：等服务端确认再改本地（state-navigation.md §8） */}
          <button
            type="button"
            className="manage-panel__save"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="manage-panel__reset"
            disabled={saving || !dirty}
            onClick={reset}
          >
            放弃修改
          </button>
        </footer>
      </aside>
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="manage-panel__field">
      <dt className="manage-panel__field-label">{label}</dt>
      <dd className="manage-panel__field-value">{children}</dd>
    </div>
  )
}
