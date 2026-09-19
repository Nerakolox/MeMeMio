import { useEffect, useId, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { SEND_LABELS, detectSendPath, type SendTarget } from '../../lib/clipboard'

/**
 * 卡片右上角的「⋯」操作入口。
 *
 * **入口不是右键菜单。** 右键是桌面专属交互，手机上等于没有入口，而移动端是这个产品的主场
 * （styling.md「移动端不是适配，是主场」）。按钮两端都能用，位置固定、可键盘聚焦，
 * 也不和浏览器的原生右键菜单抢。理由见 joint-tasks/2026-09-19-browse-meme-actions.md。
 *
 * ## 为什么不用 `role="menu"`
 *
 * `menu` 这个角色带一套硬性键盘要求（方向键在项之间移动、roving tabindex）。
 * 这里实现的是「打开 → 焦点落在第一项 → Tab 走完 → Esc 出来」，不是那套。
 * **声明一个没实现的角色比不声明更糟**：读屏用户会等方向键，而它不会响应。
 *
 * ## 为什么删除的二次确认在弹层里，而不是另开一个模态
 *
 * 不可逆操作的确认需要一个焦点管理正确的层。这个弹层已经有了（打开时聚焦、Esc 退出、
 * 焦点能出来），再叠一个模态就要把同一套再写一遍。确认框就地换掉菜单内容，
 * 焦点始终留在同一个盒子里。
 */
export function MemeActions({
  target,
  canDelete,
  deleteDeniedReason,
  busy = false,
  onSend,
  onEdit,
  onDelete,
}: {
  target: SendTarget
  /** 上传者本人或 admin（SPEC §6.4.2）。**这只是体验**——服务端仍是唯一权威。 */
  canDelete: boolean
  /** 不能删除时显示的原因。**不隐藏删除项**，见下方注释。 */
  deleteDeniedReason: string
  busy?: boolean
  onSend: (target: SendTarget) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const hintId = useId()

  /**
   * 文案在**渲染时**就定下来，不是点击后才发现（clipboard-share.md §5）。
   * 动图那一档这里是「下载」，用户点之前就知道拿不到剪贴板。
   */
  const path = detectSendPath(target.isAnimated)

  function close(restoreFocus: boolean) {
    setOpen(false)
    setConfirming(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  // 焦点进弹层。打开后直接按回车就能执行第一项，不用先 Tab 一圈。
  useEffect(() => {
    if (!open) return
    if (confirming) cancelRef.current?.focus()
    else firstItemRef.current?.focus()
  }, [open, confirming])

  useEffect(() => {
    if (!open) return

    // 点外部关闭。用 pointerdown 而不是 click：拖动选择文本时手指/鼠标会在别处抬起，
    // click 会在那时才关闭，看起来像「点了没反应」。
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) close(false)
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // 焦点回到「⋯」上，键盘路径不在这里断掉
      close(true)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  /** 执行一个动作：先把弹层收掉，再交给调用方。 */
  function run(action: () => void, restoreFocus: boolean) {
    close(restoreFocus)
    action()
  }

  return (
    // data-actions-for 是给「编辑面板关闭后把焦点交回来」用的查询目标，
    // 和搜索页用 [data-index] 找回卡片是同一种做法。
    <div className="meme-card__actions" data-actions-for={target.id} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="meme-card__actions-btn flex h-9 w-9 items-center justify-center rounded-full border bg-card text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={open ? '收起图片操作' : '图片操作'}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <div className="manage-popover rounded-md border bg-popover text-popover-foreground shadow-md">
          {confirming ? (
            // 确认框里默认聚焦「取消」：删除不可逆，一次误触的回车不该把图删掉。
            <>
              <p className="manage-popover__confirm-text">
                删除后这张图会从库里消失，不可撤销。确定删除？
              </p>
              <div className="manage-popover__row">
                <button
                  ref={cancelRef}
                  type="button"
                  className="manage-popover__item rounded-sm hover:bg-muted"
                  onClick={() => setConfirming(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="manage-popover__item manage-popover__item--danger rounded-sm text-destructive hover:bg-destructive/10"
                  disabled={busy}
                  onClick={() => run(onDelete, false)}
                >
                  {busy ? '删除中…' : '确定删除'}
                </button>
              </div>
            </>
          ) : (
            <div className="manage-popover__group" role="group" aria-label="图片操作">
              <button
                ref={firstItemRef}
                type="button"
                className="manage-popover__item rounded-sm hover:bg-muted"
                onClick={() => run(() => onSend(target), true)}
              >
                {SEND_LABELS[path]}
              </button>

              <button
                type="button"
                className="manage-popover__item rounded-sm hover:bg-muted"
                onClick={() => run(onEdit, false)}
              >
                编辑
              </button>

              {/*
                「删除」**保留但禁用**，不隐藏——藏起来会让用户以为没有这个功能，
                而「编辑全员、删除限本人」正是共享库最重要的一条规则（SPEC §9.1）。
                禁用只是体验：真正拦住越权的是服务端的 assertCanMutate，403 要能显示出来。
              */}
              <button
                type="button"
                className="manage-popover__item rounded-sm hover:bg-muted"
                disabled={!canDelete || busy}
                aria-describedby={canDelete ? undefined : hintId}
                onClick={() => setConfirming(true)}
              >
                删除
              </button>
            </div>
          )}

          {!confirming && !canDelete && (
            <p className="manage-popover__hint" id={hintId}>
              {deleteDeniedReason}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
