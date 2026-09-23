/**
 * 浏览页上的动作：发送、删除、编辑侧边栏。
 *
 * 列表数据的本地变更新在 `use-browse-list`——这里只调它，不改它。
 *
 * **反馈一律走 `@/lib/toast`（右上角提示），这里不再持有任何 `note` state。**
 * 此前是「页级一条 `note`，谁都得能写」，渲染在 `BrowseResults` 的结果列顶部；
 * 2026-09-24 收进 toast，理由有三条：
 *
 * - 同一件事（复制 / 删除的结果）在首页与浏览页各渲染一行自己的裸文字，改一处就漂；
 * - 删除失败那条**必须带 `requestId`**（`http.md §3`），而它在结果列里要用户往下找；
 * - 编辑面板保存成功写的那句「已保存」，正好被模态侧边栏盖住——就此彻底看不见。
 *
 * 编辑面板自己那句「已保存」现在留在面板里（`MemeEditPanel`），不走 toast：
 * 它是表单确认，且模态开着时 toast 对读屏是 `aria-hidden`，见 `feedback.md`。
 */

import { useState } from 'react'
import { ApiError, deleteMeme, type Meme } from '../../lib/api'
import { sendMeme, sendNote, type SendTarget } from '../../lib/clipboard'
import { notifyFailure, notifySend, notifySuccess } from '../../lib/toast'
import type { BrowseList } from './use-browse-list'

export function useBrowseActions(list: BrowseList) {
  /**
   * 打开编辑侧边栏的那条**只存 id**，面板再从列表里取当前那一条。
   *
   * 存整个对象会变成一份影子副本：保存成功后列表里换了新的，而面板还指着旧的
   * （state-navigation.md §2「不维护第二份可编辑副本」）。
   */
  const [editingId, setEditingId] = useState<string | null>(null)

  const editingMeme = editingId === null ? null : (list.items.find((m) => m.id === editingId) ?? null)

  /**
   * 发送这张图。路径由 `lib/clipboard.ts` 按 `isAnimated` 和能力探测决定，
   * 菜单上的文案也是它给的——**同一个动作在首页和浏览页不能有两套行为**
   * （clipboard-share.md §3，那一节把这件事列为本端最不能犯的错）。
   *
   * ⚠️ 这个函数由点击事件直接调起，中间不要先 await 别的请求：
   * 剪贴板写入要落在用户手势的同步调用栈里，否则 Safari 会拒（§4.1）。
   */
  async function send(target: SendTarget) {
    const note = sendNote(await sendMeme(target))
    if (note !== null) notifySend(note)
  }

  /**
   * 关掉编辑侧边栏。
   *
   * ⚠️ **这里的焦点交回是必须的，Radix 不会代劳**：侧边栏是受控打开、没有
   * `SheetTrigger`，而 `DialogContentModal` 的关闭逻辑是
   * `triggerRef.current?.focus()`——没有触发器就是 null，什么都不会做，焦点会掉在 body 上。
   * （`AlertDialog` 那条路同理，它的交回写在 `MemeActions` 自己里面。）
   *
   * 选择器带 `[data-actions-trigger]` 而不是随便挑一个 `button`：卡片上还有收藏按钮，
   * 挑错了就把焦点交给收藏，用户按回车会莫名其妙地取消收藏。
   *
   * 它可靠的前提是**侧边栏是模态的**（打开期间页面滚不动），那个 meme 的格子不会被
   * masonic 回收掉——格子还在，`querySelector` 才找得到。
   *
   * 已知缺口（不是这次引入的）：那张卡在编辑中被删掉时两者都查不到，焦点掉在 body 上。
   */
  function closeEditor() {
    const id = editingId
    setEditingId(null)
    if (id !== null) {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-actions-for="${id}"] [data-actions-trigger]`)
          ?.focus()
      })
    }
  }

  /** 编辑保存成功后就地换掉列表里那一条。**「已保存」由面板自己说**（见文件头）。 */
  function handleSaved(updated: Meme) {
    list.applyUpdate(updated)
  }

  /**
   * 删除一张图。**「删除中」那段反馈归 `MemeActions` 自己管**（它的确认框要等这个
   * Promise 落定才关），所以这里不需要 `deletingId` 那种「告诉菜单谁在忙」的状态。
   *
   * 失败**不往外抛**：这条一直是「原因得在图消失之后还看得见」——从前的页级 note 与
   * 现在的常驻 toast 都满足，而 `MemeActions` 的确认框**不满足**（它会关掉）。
   * 所以弹层只负责等它落定，讲原因的是这一层。
   */
  async function remove(meme: Meme) {
    try {
      // 404 在 deleteMeme 里已经当成功处理（SPEC §6.4.2）：那张图本来就要消失
      await deleteMeme(meme.id)
      list.applyRemoval(meme.id)
      // 面板开着的那张正好被删了就先关掉——列表里已经没有它，面板再留着就是空壳
      if (editingId === meme.id) setEditingId(null)
      notifySuccess('已删除')
    } catch (err) {
      // 服务端仍是唯一权威：前端隐藏入口只是体验，403 / FORBIDDEN 要能显示出来（SPEC §6.4.2）
      const apiErr = err instanceof ApiError ? err : null
      notifyFailure(`删除失败：${apiErr?.message ?? '请稍后重试'}`, apiErr?.requestId ?? '未知')
    }
  }

  return {
    send,
    remove,
    editingId,
    editingMeme,
    openEditor: (id: string) => setEditingId(id),
    closeEditor,
    handleSaved,
  }
}
