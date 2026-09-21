import { useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '../../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { OVERLAY_BTN } from '../../components/MemeCard'
import { cn } from '../../lib/utils'
import { TOUCH } from '../../lib/touch'
import { SEND_LABELS, detectSendPath, type SendTarget } from '../../lib/clipboard'

/**
 * 卡片右上角的「⋯」操作入口。**入口不是右键菜单。**
 *
 * 右键是桌面专属交互，手机上等于没有入口，而移动端是这个产品的主场
 * （styling.md「移动端不是适配，是主场」）。按钮两端都能用，位置固定、可键盘聚焦，
 * 也不和浏览器的原生右键菜单抢。理由见 joint-tasks/2026-09-19-browse-meme-actions.md。
 *
 * ## 2026-09-21：手写弹层换成 `DropdownMenu` + `AlertDialog`
 *
 * 上一版是手写的（自己管点外关闭、Escape、焦点进出），而它解决的问题正是 Radix 已经做对的
 * 那些。换掉之后有**两处必须显式写**，都属于「不写不报错、只是用起来不对」：
 *
 * ### 一、菜单关闭后**约 100ms** 才发生的焦点恢复，会被确认框 / 侧边栏抵消掉
 *
 * 不是同一个 tick 的问题，所以「打开就测」看不出来。`react-menu` 把关闭后的焦点恢复挂在
 * 菜单 FocusScope 的 `onUnmountAutoFocus` 上，而 `react-focus-scope` 是在
 * `setTimeout(…, 0)` 里才发那个事件的；内容又是在退场动画（`duration-100`）跑完后才卸载。
 * 于是：点删除 → 确认框挂载、焦点落到「取消」（正确）→ **约 100ms 后**菜单卸载，
 * Radix 把焦点还回「⋯」——那时确认框已经开着，焦点回到了它背后的卡片上。
 *
 * 这次实测把因果查清了，**结论和一开始的猜测不一样**，写下来免得下一个人重查一遍：
 * 模态框的焦点陷阱**会**把它拽回去（`handleFocusIn` 对容器外的 `focusin` 直接
 * `focus(lastFocusedElement)`），所以**打开确认框这条路最终状态是对的**——
 * 实测：把 `preventDefault()` 删掉重跑，「点删除 → 300ms 后焦点在取消上」照样通过。
 * 也就是说那条断言**不判别**这句代码，别拿它当回归保护。
 *
 * `preventDefault()` 真正兜住的是**点外部关闭**那条路：那里没有任何模态陷阱，
 * 用户点的是别处，Radix 却会在约 100ms 后把焦点拉回这张卡的「⋯」上。
 * 实测：删掉它，这条必挂（重跑加回即过）。
 *
 * 顺带（这两条是**推理、不是实测**，别当结论引用）：不挡的话焦点还会在模态框背后闪一次，
 * 且那次 `focus()` 带 `select: true`。
 *
 * 所以下面 `onCloseAutoFocus` 里那句 `preventDefault()` 是在**取消整个恢复动作**，
 * 让焦点归属由我们决定：默认不抢（点外部关闭、以及打开对话框 / 侧边栏时由那一层接管），
 * 只有 Escape 和「执行了发送」才交回「⋯」。
 *
 * （确认框和侧边栏自己那一次恢复由它们的 `onCloseAutoFocus` 负责——它们都没有
 * `Trigger`，Radix 内部那句 `triggerRef.current?.focus()` 里是 null，什么都不会做。）
 *
 * ### 二、`Tab` 在菜单里**不移动焦点**
 *
 * `react-menu` 对 Tab 直接 `preventDefault`（这是 WAI-ARIA 对 `role="menu"` 的规定：
 * 菜单是方向键的天下，Tab 用来离开整个组件）。上一版手写弹层时验收里那条
 * 「Tab 能依次走完并走得出去」的断言，**由这次设计变更取代**：方向键选择、Enter 执行、
 * Esc 退出并把焦点交回「⋯」。写在这里是为了下一个人不要把它当回归来「修」。
 *
 * ## 删除的二次确认在同一个组件里
 *
 * 不可逆操作的确认需要一个焦点管理正确的层。`AlertDialog` 就是那个层，而且它**自带**
 * 打开时聚焦「取消」、Esc 退出——比上一版自己写的更完整。它跟着「⋯」走，
 * 整条删除链路因此不依赖页面。
 */
export function MemeActions({
  target,
  canDelete,
  deleteDeniedReason,
  onSend,
  onEdit,
  onDelete,
}: {
  target: SendTarget
  /** 上传者本人或 admin（SPEC §6.4.2）。**这只是体验**——服务端仍是唯一权威。 */
  canDelete: boolean
  /** 不能删除时显示的原因。**不隐藏删除项**，见下方注释。 */
  deleteDeniedReason: string
  onSend: (target: SendTarget) => void
  onEdit: () => void
  /**
   * 删除这张图。**失败由调用方讲给用户**（浏览页写在页面级 note 里，带 requestId），
   * 所以这里只等它落定，不看结果。
   */
  onDelete: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const triggerRef = useRef<HTMLButtonElement>(null)
  /** 菜单关掉之后焦点归谁。见文件头「一」。 */
  const focusAfterClose = useRef<'trigger' | 'keep'>('keep')

  /**
   * 文案在**渲染时**就定下来，不是点击后才发现（clipboard-share.md §5）。
   * 动图那一档这里是「下载」，用户点之前就知道拿不到剪贴板。
   */
  const path = detectSendPath(target.isAnimated)

  /** 菜单关闭后要回到「⋯」的两条路：Esc，以及执行了发送（那条路上没有别的层接管焦点）。 */
  function closeToTrigger() {
    focusAfterClose.current = 'trigger'
  }

  async function confirmDelete() {
    setDeleting(true)
    try {
      await onDelete()
    } catch {
      // **有意吞掉**：删除失败的原因不由这个弹层讲——它背后的页面顶部有一条带 requestId 的
      // 提示，那条提示在图已经消失之后还得看得见，放这里会随弹层一起被关掉。
    } finally {
      setDeleting(false)
      setConfirmOpen(false)
    }
  }

  return (
    // data-actions-for 是给「编辑侧边栏关闭后把焦点交回来」用的查询目标，
    // 和搜索页用 [data-index] 找回卡片是同一种做法。见 features/browse/use-browse-actions.ts 的 closeEditor。
    <div data-actions-for={target.id}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          {/*
            Button 是 forwardRef（button.tsx 专门为此加过）。React 18 里不 forwardRef 的组件
            当 asChild 子节点会**静默丢掉** Radix 给的触发器 ref —— popper 拿不到锚点就没有锚点，
            弹层永远停在 translate(0,-200%) 跑到视口外，且生产构建不报错（styling.md）。

            OVERLAY_BTN 里那几行 `hover:` / `aria-expanded:` / `dark:hover:` 覆盖不是装饰：
            `ghost` 变体自带 `hover:bg-muted` 与 `aria-expanded:bg-muted`，而 Radix 打开菜单时
            正好会给触发器挂 `aria-expanded` —— 不覆盖的话，菜单一打开按钮就变浅色底深色图标，
            压在深色照片上直接消失。
          */}
          <Button
            ref={triggerRef}
            variant="ghost"
            size="icon"
            data-actions-trigger
            aria-label="图片操作"
            // 鼠标 32 / 手指 44，与 MemeCard 的收藏按钮同一条闸门（`pointer-coarse`，
            // 不是 `max-sm`：那个把「窄窗口」当成「手机」，两种都判错）。
            className={cn(OVERLAY_BTN, 'size-8 pointer-coarse:size-11')}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          sideOffset={4}
          // w-52 盖掉注册表的 w-(--radix-dropdown-menu-trigger-width)：触发器只有 32px 宽，
          // 那个变量在这里没有意义。
          className="w-52"
          onEscapeKeyDown={closeToTrigger}
          onCloseAutoFocus={(e) => {
            // ⚠️ `preventDefault()` 是给**点外部关闭**兜底的，见文件头「一」——
            // 打开确认框那条路删了它照样对（有模态陷阱），别照那条测试判断它有没有用。
            e.preventDefault()
            if (focusAfterClose.current === 'trigger') triggerRef.current?.focus()
            focusAfterClose.current = 'keep'
          }}
        >
          {/*
            用 onSelect 不用 onClick：`onSelect` 同步跑在点击 / 回车的调用栈里，
            剪贴板写入与 `navigator.share` 的用户激活要求才成立（clipboard-share.md §4.1）。
          */}
          <DropdownMenuItem
            className={TOUCH}
            onSelect={() => {
              closeToTrigger()
              onSend(target)
            }}
          >
            {SEND_LABELS[path]}
          </DropdownMenuItem>

          <DropdownMenuItem className={TOUCH} onSelect={onEdit}>
            编辑
          </DropdownMenuItem>

          {/*
            「删除」**保留但禁用**，不隐藏——藏起来会让用户以为没有这个功能，
            而「编辑全员、删除限本人」正是共享库最重要的一条规则（SPEC §9.1）。
            禁用只是体验：真正拦住越权的是服务端的 assertCanMutate，403 要能显示出来。

            ⚠️ 用 `aria-disabled` 不用 `disabled`：Radix 的菜单项在 `disabled` 时
            `focusable: false`，方向键**选不中它**——而「为什么不能删」正是要给键盘用户读的。
            上一版把原因放在菜单外面、靠 `aria-describedby` 指过去，那是一条死链：
            读屏永远走不到那个节点。现在原因就在这一项内部，被方向键选中时连着读出来。
            代价是它看起来仍然可点，靠 `aria-disabled:opacity-60` 说清。
          */}
          <DropdownMenuItem
            variant="destructive"
            aria-disabled={!canDelete || undefined}
            className={cn(TOUCH, 'items-start aria-disabled:opacity-60')}
            onSelect={(e) => {
              if (!canDelete) {
                // 不关菜单：关掉等于把「为什么不能删」这句话一起收走
                e.preventDefault()
                return
              }
              // 能删就照常关闭，确认框接管
              setConfirmOpen(true)
            }}
          >
            <span className="flex flex-col gap-0.5">
              <span>删除</span>
              {!canDelete && (
                <span className="text-xs font-normal text-muted-foreground">
                  {deleteDeniedReason}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent
          // 确认框自己也会在关闭时把 triggerRef 交还，而这里**没有 AlertDialogTrigger**
          // → Radix 拿不到触发器，什么都不会做（`triggerRef.current?.focus()` 里是 null），
          // 焦点会掉在 body 上。所以显式交回「⋯」。
          onCloseAutoFocus={() => triggerRef.current?.focus()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>删除这张图？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后这张图会从库里消失，不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* 默认焦点落在「取消」上（AlertDialogContent 自带 onOpenAutoFocus）：
                删除不可逆，一次误触的回车不该把图删掉。 */}
            <AlertDialogCancel className={TOUCH}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className={TOUCH}
              disabled={deleting}
              // AlertDialogAction 本身就是 DialogPrimitive.Close，点了会关。
              // 要保住「删除中…」这段反馈（请求回来才关），只能先挡掉它的默认行为。
              onClick={(e) => {
                e.preventDefault()
                void confirmDelete()
              }}
            >
              {deleting ? '删除中…' : '确定删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
