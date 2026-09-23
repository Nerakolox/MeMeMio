import { useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { Meme } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { tagStatusLabel } from '../../lib/tag-status'
import { notifySuccess } from '../../lib/toast'
import { TOUCH } from '../../lib/touch'
import { VocabSections } from '../../components/VocabSections'
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
  const { draft, update, reset, save, saving, error, dirty, saved } = useMemeEdit(meme, onSaved)
  const bodyRef = useRef<HTMLDivElement>(null)

  /**
   * 放弃修改。**这一处走 toast，与保存相反**（2026-09-24）。
   *
   * 判据不是「在不在抽屉里」，是**成功态看不看得见**：保存的结果在面板里没有落点
   * （草稿是原文、按钮变灰，两件都可能是「我还没改」的样子），所以要说一句；
   * 而放弃修改**本身**就是一次可见的回退——草稿当场变回原样，两个按钮一起变灰。
   * 走 toast 是因为这次点击有**破坏性**：它扔掉的是用户刚打进去的字，
   * 「刚才那下是不是真扔了」值得一句回执，而不是让用户对着变灰的按钮猜。
   *
   * 它同时也回答了「我点错了吗」——面板不关、草稿还在，用户接着改就行。
   */
  function handleReset() {
    reset()
    notifySuccess('已放弃修改')
  }

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

          ⚠️ **`[&>*]:shrink-0` 不是装饰，是这一栏能不能看见东西的前提。** 这是一个
          **高度确定**的 flex 列（`flex-1` + `min-h-0`，父级 `inset-y-0`），而 flex 子项
          默认 `flex-shrink: 1`：内容比它高时，子项按比例被压缩而不是溢出滚动。
          绝大多数子项缩不动——它们的 `min-height: auto` 等于内容高（img / dl / section 都是），
          但**带 `overflow-hidden` 的子项自动最小尺寸是 0**，于是全部负空间落在它身上。
          2026-09-22 就是这个形态：六个词表维度那一块（注册表 accordion 根自带
          `overflow-hidden`）被压成 **2px**（自身内容 329px，全被剪掉），
          「描述以下什么都没有」，不报错、不告警。定高 flex 列里的 `overflow-hidden` 组件
          都会被这样吃掉，所以修在容器上而不是某一个子组件上——将来往这里加 `Card`
          （同样自带 `overflow-hidden`）不用再想一遍。实测数字见
          joint-tasks/2026-09-22-语义维度拆分.md 的 web 端验收。
        */}
        <div
          ref={bodyRef}
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 py-4 outline-none [&>*]:shrink-0"
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

          {/*
            六个词表维度（SPEC §4.3）。折叠、**有值的默认展开**，所以打开面板第一眼
            看到的就是模型给这张图打了什么，空的那几维收着不占版面。
            分区清单在 `lib/vocab.ts`，这里不重复一遍维度名。
          */}
          <VocabSections
            values={draft}
            onChange={(field, next) => update(field, next)}
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

        <SheetFooter className="flex-row items-center gap-2 border-t px-6 py-4">
          {/*
            保存成功的确认**在面板里说**，不弹 toast（2026-09-24 改）。改之前它写进
            `use-browse-actions` 的页级 note，而那行文字渲染在 `BrowseResults` 里——
            **正好被这个抽屉盖住**：用户点完保存，屏幕上什么都不变。

            不弹 toast 的两条理由都在 `feedback.md`：抽屉是从右上角推出来的，会和那一角
            叠在一起；而 Radix 模态给 `#root` 挂了 `aria-hidden`，弹出去的提示读屏听不见。
            行内这句在 Sheet 自己的 portal 里，不受这两条影响。

            `role="status"` 让读屏在保存完成时报一句；它在抽屉内部，`aria-hidden` 管不到。
          */}
          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              已保存
            </p>
          )}
          {/* 不做乐观更新：等服务端确认再改本地（state-navigation.md §8） */}
          <Button className={TOUCH} disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button
            variant="outline"
            className={TOUCH}
            disabled={saving || !dirty}
            onClick={handleReset}
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
