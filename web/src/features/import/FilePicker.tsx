import { useEffect, useRef, useState } from 'react'
import { formatBytes } from '../../lib/format'
import {
  IMAGE_ACCEPT,
  classify,
  dedupe,
  fileKey,
  filesFromClipboard,
  filesFromDataTransfer,
  uniqueName,
  type PickedFile,
} from './file-picker'

const LOCAL_PROBLEM_TEXT: Record<NonNullable<PickedFile['localProblem']>, string> = {
  not_image: '不是图片，会被服务端拒绝',
  empty: '文件是空的',
}

/**
 * 选文件区。点击、拖拽（含文件夹递归）、Ctrl+V 粘贴三个入口**汇入同一个列表**，
 * 不为某个入口另做一套流程（import-ux.md §1）。
 *
 * 手机端「从相册选择」不需要单独实现——移动端的 `<input type="file">` 本来就是相册选择器。
 */
export function FilePicker({
  onStart,
  disabled,
  disabledReason,
}: {
  onStart: (files: PickedFile[]) => void
  disabled: boolean
  disabledReason?: string
}) {
  const [picked, setPicked] = useState<PickedFile[]>([])
  const [dragging, setDragging] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  function addFiles(files: File[], sourceLabel: string) {
    if (files.length === 0) return
    // 文件名在批次内是条目标识（commit / SSE item / reviews 决策都用它），
    // 所以同名文件在**加入队列时**就改名，而不是等对不上再回退。见 file-picker.ts
    setPicked((prev) => {
      const taken = new Set(prev.map((p) => p.file.name))
      const fresh: PickedFile[] = []
      for (const raw of classify(files)) {
        const candidate = { ...raw, file: raw.file }
        if (taken.has(raw.file.name)) {
          candidate.file = new File([raw.file], uniqueName(raw.file.name, taken), {
            type: raw.file.type,
          })
        }
        taken.add(candidate.file.name)
        fresh.push(candidate)
      }
      const deduped = dedupe(fresh, new Set(prev.map((p) => fileKey(p.file))))
      const skipped = fresh.length - deduped.length
      setNote(
        skipped > 0
          ? `${sourceLabel}：加入 ${deduped.length} 个，跳过 ${skipped} 个重复项`
          : `${sourceLabel}：加入 ${deduped.length} 个文件`,
      )
      return [...prev, ...deduped]
    })
  }

  // Ctrl+V 粘贴：入口之一，走同一条流程
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (disabled) return
      const files = filesFromClipboard(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      addFiles(files, '粘贴')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (disabled) return
    const files = await filesFromDataTransfer(e.dataTransfer)
    addFiles(files, '拖入')
  }

  const totalBytes = picked.reduce((sum, p) => sum + p.file.size, 0)
  const problemCount = picked.filter((p) => p.localProblem !== null).length

  return (
    <section className="import__picker">
      <div
        className={`import__dropzone${dragging ? ' import__dropzone--active' : ''}`}
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault()
          dragDepth.current -= 1
          if (dragDepth.current <= 0) setDragging(false)
        }}
        onDrop={handleDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (!disabled) inputRef.current?.click()
          }
        }}
        aria-disabled={disabled}
      >
        <p>点击选择图片，或把文件 / 文件夹拖到这里</p>
        <p className="import__dropzone-hint">也可以直接 Ctrl+V 粘贴剪贴板里的图</p>
        <input
          ref={inputRef}
          className="import__file-input"
          type="file"
          multiple
          accept={IMAGE_ACCEPT}
          disabled={disabled}
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []), '选择')
            // 允许再次选同一个文件：不清空的话 change 不会触发
            e.target.value = ''
          }}
        />
      </div>

      {note && <p className="import__note">{note}</p>}

      {picked.length > 0 && (
        <>
          <div className="import__picked-head">
            <span>
              待上传 {picked.length} 个，共 {formatBytes(totalBytes)}
            </span>
            <button
              type="button"
              className="import__clear"
              onClick={() => {
                setPicked([])
                setNote(null)
              }}
              disabled={disabled}
            >
              清空
            </button>
          </div>

          {problemCount > 0 && (
            <p className="import__note">
              其中 {problemCount} 个不像图片，仍会提交，由服务端给出最终判定
            </p>
          )}

          <ul className="import__picked-list">
            {picked.map((p) => (
              <li key={fileKey(p.file)} className="import__picked-item">
                <span className="import__picked-name">{p.file.name}</span>
                <span className="import__picked-size">{formatBytes(p.file.size)}</span>
                {p.localProblem && (
                  <span className="import__picked-warn">{LOCAL_PROBLEM_TEXT[p.localProblem]}</span>
                )}
                <button
                  type="button"
                  className="import__picked-remove"
                  onClick={() => setPicked((prev) => prev.filter((x) => x.file !== p.file))}
                  disabled={disabled}
                  aria-label={`移除 ${p.file.name}`}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="import__start"
            disabled={disabled}
            onClick={() => onStart(picked)}
          >
            开始导入
          </button>
        </>
      )}

      {disabled && disabledReason && <p className="import__note">{disabledReason}</p>}
    </section>
  )
}
