/**
 * 浏览页上的动作：发送、收藏、删除、编辑侧边栏，以及它们共用的那一条操作反馈。
 *
 * 单独一个 hook 的理由是**这些动作都要说一句话**（「已复制」「已删除」「删除失败：…」），
 * 而 `note` 只有一条、谁都得能写。列表数据的本地变更新在 `use-browse-list`——
 * 这里只调它，不改它。
 */

import { useState } from 'react'
import { ApiError, deleteMeme, type Meme } from '../../lib/api'
import { sendMeme, sendNote, type SendTarget } from '../../lib/clipboard'
import type { BrowseList } from './use-browse-list'

/** 操作反馈：复制 / 下载的结果、删除失败等。一条就够，不堆历史。 */
export type Note = {
  text: string
  error?: boolean
  requestId?: string
  /** 取不到原图时给的回退地址，渲染成可点的链接（`lib/clipboard.ts` 的 `saveFile`）。 */
  fallbackUrl?: string
}

export function useBrowseActions(list: BrowseList) {
  const [note, setNote] = useState<Note | null>(null)

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
    setNote(null)
    const note = sendNote(await sendMeme(target))
    if (note !== null) setNote({ text: note.text, fallbackUrl: note.fallbackUrl })
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

  /** 编辑保存成功后就地换掉列表里那一条，并说一句「已保存」。 */
  function handleSaved(updated: Meme) {
    list.applyUpdate(updated)
    setNote({ text: '已保存' })
  }

  /**
   * 删除一张图。**「删除中」那段反馈归 `MemeActions` 自己管**（它的确认框要等这个
   * Promise 落定才关），所以这里不需要 `deletingId` 那种「告诉菜单谁在忙」的状态。
   *
   * 失败**不往外抛**：原因是页面顶部那条带 requestId 的提示（它得在图消失之后还看得见），
   * 弹层只负责等它落定。
   */
  async function remove(meme: Meme) {
    setNote(null)
    try {
      // 404 在 deleteMeme 里已经当成功处理（SPEC §6.4.2）：那张图本来就要消失
      await deleteMeme(meme.id)
      list.applyRemoval(meme.id)
      // 面板开着的那张正好被删了就先关掉——列表里已经没有它，面板再留着就是空壳
      if (editingId === meme.id) setEditingId(null)
      setNote({ text: '已删除' })
    } catch (err) {
      // 服务端仍是唯一权威：前端隐藏入口只是体验，403 / FORBIDDEN 要能显示出来（SPEC §6.4.2）
      const apiErr = err instanceof ApiError ? err : null
      setNote({
        text: `删除失败：${apiErr?.message ?? '请稍后重试'}`,
        error: true,
        requestId: apiErr?.requestId ?? '未知',
      })
    }
  }

  return {
    note,
    send,
    remove,
    editingId,
    editingMeme,
    openEditor: (id: string) => setEditingId(id),
    closeEditor,
    handleSaved,
  }
}
