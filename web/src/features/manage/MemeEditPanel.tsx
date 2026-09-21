import { useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { Meme } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { tagStatusLabel } from '../../lib/tag-status'
import { emotionOptions, sceneOptions, tagOptions } from '../../lib/vocab'
import { TOUCH } from '../../lib/touch'
import { VocabPicker } from '../../components/VocabPicker'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet'
import { Textarea } from '../../components/ui/textarea'
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
 *
 * ## 2026-09-21：手写的 `aside` + 隐形 scrim 换成 `Sheet`
 *
 * 上一版自己实现了 `role="dialog"`、Esc 监听和一层没有视觉的 scrim。换掉之后有三处
 * **必须显式写**，都属于「不写不报错、只是用起来不对」：
 *
 * - **焦点进入**：`SheetContent` 不是 `forwardRef`（注册表按 React 19 的 ref-as-prop 写），
 *   传 `ref` 会被 React 18 静默丢掉，所以用 `onOpenAutoFocus` 把我们自己的 body 聚焦。
 * - **`SheetTitle` 不能省**：少了它 `aria-labelledby` 直接不输出，等于一个没有名字的对话框，
 *   而 Radix 那条开发期警告在本项目里被 stub 掉了，不会提示。
 * - **`min-h-0` 不能省**：body 是 flex 子项，默认 `min-height: auto`，不加这一句它会被内容
 *   撑高、把页脚的「保存」顶出视口。
 *
 * 遮罩也从**隐形变成可见**（`bg-black/30` + 模糊）。这是有意的一步：隐形 scrim 本来就是
 * 骨架期的占位（web/AGENTS.md §5 说的「视觉定稿那一次补」就是这一次）。
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
  const bodyRef = useRef<HTMLDivElement>(null)

  return (
    // 受控、无 SheetTrigger：面板由页面的 editingId 决定开不开。
    <Sheet
      open
      onOpenChange={(next) => {
        // 只处理「关」：开由页面驱动，这里再设一次会打架
        if (!next) onClose()
      }}
    >
      <SheetContent
        side="right"
        // 注册表那个关闭按钮是 size="icon-sm"（32px，低于 44）而且没有再传 className 的口子，
        // 所以关掉它、自己放一个（同 AppSidebar 对注册表缺陷的做法）。
        showCloseButton={false}
        // ⚠️ `w-full` 单独写没用：注册表是 `data-[side=right]:w-3/4`，不同变体不合并，
        // 必须带上同样的变体前缀才盖得住。宽度 420px 是上一版 `.manage-panel` 的值。
        //
        // 高度保持注册表的 `inset-y-0`（**全高**）：顶栏 `z-20` 在 Radix 这层（`z-50`）之下，
        // 面板与遮罩都盖得住它。曾经因为顶栏被抬到 `z-60` 而改成「从顶栏下沿开始」、
        // 于是这一格 `SheetHeader`（「图片信息」标题 + 右上关闭按钮）必须一起让位——
        // 顶栏收回 20 之后那段偏移连同它的三个类一起删掉了（`App.tsx` 有完整推导）。
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-[420px]"
        onOpenAutoFocus={(e) => {
          // 挡掉 Radix 的默认聚焦（它会挑第一个可聚焦元素，也就是关闭按钮），
          // 把焦点交给整个面板——读屏用户才知道自己进了一个新层。
          e.preventDefault()
          bodyRef.current?.focus()
        }}
      >
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b px-6 py-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <SheetTitle>图片信息</SheetTitle>
            <SheetDescription className="sr-only">
              查看并编辑这张图的描述与标签
            </SheetDescription>
          </div>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className={TOUCH} aria-label="关闭">
              <X className="size-4" />
            </Button>
          </SheetClose>
        </SheetHeader>

        {/*
          只让中间这段滚，头尾常驻——底部的「保存」在最长的字段清单下也要够得着。
          没用 `ScrollArea`：它的 viewport 内容层是 `display: table`，对表单布局是错工具，
          而原生滚动还白送 iOS 的惯性滚动与 `scrollIntoView`。
        */}
        <div
          ref={bodyRef}
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 py-4 outline-none"
        >
          <img
            className="mx-auto max-h-60 w-full rounded-2xl bg-white object-contain"
            src={meme.url}
            alt={meme.description ?? meme.originalFilename ?? meme.id}
          />

          <dl className="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-3 gap-y-2 text-sm">
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
            <Field label="打标状态">
              {/* pending / needs_manual 是正常的中间态，**不给错误色**（styling.md） */}
              <Badge variant={meme.tagStatus === 'ok' ? 'outline' : 'secondary'}>
                {tagStatusLabel(meme.tagStatus)}
              </Badge>
            </Field>
            <Field label="视觉模型">{meme.visionModel ?? '—'}</Field>
            <Field label="收藏">{meme.favorited ? '已收藏' : '未收藏'}</Field>
            <Field label="图片 ID">
              <span className="font-mono text-xs wrap-anywhere">{meme.id}</span>
            </Field>
            <Field label="上传者 ID">
              <span className="font-mono text-xs wrap-anywhere">{meme.uploaderId}</span>
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

          <section className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">OCR 文本（只读）</h3>
            {/*
              OCR 文本**只读**，不给输入框（SPEC §6.4.1）：它是模型对图像的读数，
              手改会让文本和图不再对应，而 search_text 会忠实转发这个错，没有任何地方会报错。
            */}
            <p className="max-h-40 overflow-y-auto rounded-2xl bg-muted/40 px-3 py-2 text-sm wrap-anywhere">
              {meme.ocrText === null || meme.ocrText.trim() === ''
                ? '（这张图没有识别出文字）'
                : meme.ocrText}
            </p>
            <p className="text-xs text-muted-foreground">OCR 文本只能由重新打标产生，不能手改。</p>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">描述</h3>
            <Textarea
              className="min-h-24"
              value={draft.description}
              disabled={saving}
              placeholder="这张图是什么？"
              aria-label="描述"
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
            <Alert variant="destructive">
              <AlertTitle>保存失败</AlertTitle>
              <AlertDescription>
                {/* message 直接展示：词表外标签那句话是给用户看的（SPEC §4.5），不解析它的措辞 */}
                <p>{error.message}</p>
                {/* requestId 必须露出来，报问题时它是唯一能对上服务端日志的东西（http.md §3） */}
                <p className="font-mono text-xs">requestId: {error.requestId}</p>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <SheetFooter className="flex-row gap-2 border-t px-6 py-4">
          {/* 不做乐观更新：等服务端确认再改本地（state-navigation.md §8） */}
          <Button className={TOUCH} disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button
            variant="outline"
            className={TOUCH}
            disabled={saving || !dirty}
            onClick={reset}
          >
            放弃修改
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/**
 * 一行字段。返回**两个兄弟节点**而不是包一层 `div`——`<dl>` 的栅格靠它们直接落在网格上，
 * 中间夹一层会让 `grid-template-columns` 失去作用。
 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 wrap-anywhere">{children}</dd>
    </>
  )
}
