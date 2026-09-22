import { useEffect, useRef, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { ScrollArea } from '../../components/ui/scroll-area'
import { formatBytes } from '../../lib/format'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
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
 * 列表里那一枚「移除」。
 *
 * 用 `size-8 pointer-coarse:size-11` 而**不是** `TOUCH`：`TOUCH` 那半句 `min-h-11`
 * 只抬高度，一个方形图标按钮会被拉成 32 宽 × 44 高的长条。这条与卡片上的「⋯」「收藏」
 * 是同一个配方（`styling.md`「浮层按钮照 pointer-coarse 抄」），区别只在这里不是浮层
 * ——判据是形状：**方形按钮要长两个方向一起长**。
 */
const ROW_REMOVE = 'size-8 shrink-0 pointer-coarse:size-11'

/**
 * 选文件区。点击、拖拽（含文件夹递归）、Ctrl+V 粘贴三个入口**汇入同一个列表**，
 * 不为某个入口另做一套流程（import-ux.md §1）。
 *
 * 手机端「从相册选择」不需要单独实现——移动端的 `<input type="file">` 本来就是相册选择器。
 *
 * ## 待上传列表限高 + 内部滚动（2026-09-22 迁移时加）
 *
 * 一千张图时这个列表原来把页面拉成几万像素，而「开始导入」按钮在**最下面**——
 * 用户选完文件要滚很久才够得着那个按钮。现在限高 `h-72`（288px）、列表自己滚，
 * 按钮就在列表下面一屏之内。条目本身仍然全渲染（虚拟化不在这件事的范围里）。
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
    <section className="flex flex-col gap-4">
      {/*
        拖拽区是一个 `role="button"` 的 div，不是一个 `<Button>`：它要接 `dragenter/over/
        leave/drop` 四个事件，而且内容是多行文字加一个图标。键盘可达性靠 `tabIndex` +
        下面那个 Enter/Space 处理，与原来一致。
      */}
      <div
        className={cn(
          // `cursor-pointer` 得自己写（Tailwind v4 起 `<button>` 都没有默认指针，
          // 何况这里是个 div）：不写的话鼠标划过来仍是箭头，而这一整块都是可点的。
          'flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2',
          'rounded-4xl border-2 border-dashed p-6 text-center transition-colors',
          'focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none',
          dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/30 hover:bg-muted/50',
          disabled && 'pointer-events-none opacity-50',
        )}
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
        <Upload className="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">点击选择图片，或把文件 / 文件夹拖到这里</p>
        <p className="text-xs text-muted-foreground">
          也可以直接 Ctrl+V 粘贴剪贴板里的图
        </p>
        <input
          ref={inputRef}
          className="hidden"
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

      {/* 三个入口汇入同一份列表，所以这条反馈要说清是**哪一个入口**加进来的。
          `role="status"`：它是异步（拖文件夹要递归扫描）回来的结果，读屏要念。 */}
      {note && (
        <p role="status" className="text-sm text-muted-foreground">
          {note}
        </p>
      )}

      {picked.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">
              待上传 {picked.length} 个，共 {formatBytes(totalBytes)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={TOUCH}
              onClick={() => {
                setPicked([])
                setNote(null)
              }}
              disabled={disabled}
            >
              清空
            </Button>
          </div>

          {/* 不报错，也不拦提交：本地只能看出「不像图片」，最终判定在服务端（import-ux.md §7）。
              所以是低调的一行小字，不是警告色。 */}
          {problemCount > 0 && (
            <p className="text-xs text-muted-foreground">
              其中 {problemCount} 个不像图片，仍会提交，由服务端给出最终判定
            </p>
          )}

          <ScrollArea className="h-72 rounded-2xl border">
            <ul className="divide-y">
              {picked.map((p) => (
                <li key={fileKey(p.file)} className="flex items-center gap-3 px-3 py-2">
                  {/* `truncate` + `title`：文件名可能很长，而一行一个文件才是这个列表的用途。
                      换行（旧写法 `overflow-wrap: anywhere`）会让行高参差、几十个文件就翻不到底。 */}
                  <span className="min-w-0 flex-1 truncate text-sm" title={p.file.name}>
                    {p.file.name}
                  </span>
                  {p.localProblem && (
                    <Badge variant="outline" className="shrink-0 text-muted-foreground">
                      {LOCAL_PROBLEM_TEXT[p.localProblem]}
                    </Badge>
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatBytes(p.file.size)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={ROW_REMOVE}
                    onClick={() => setPicked((prev) => prev.filter((x) => x.file !== p.file))}
                    disabled={disabled}
                    aria-label={`移除 ${p.file.name}`}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>

          <Button
            type="button"
            size="lg"
            className={cn(TOUCH, 'min-w-30 self-start')}
            disabled={disabled}
            onClick={() => onStart(picked)}
          >
            开始导入
          </Button>
        </div>
      )}

      {disabled && disabledReason && (
        <p className="text-sm text-muted-foreground">{disabledReason}</p>
      )}
    </section>
  )
}
