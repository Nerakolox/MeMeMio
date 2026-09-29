import { ApiError, type Meme } from '../../lib/api'
import { assignMemes, patchPerson, type Person } from '../../lib/api-persons'
import { notifyFailure, notifySuccess } from '../../lib/toast'
import type { BrowseList } from '../browse/use-browse-list'
import type { Entity } from './use-entity'

/**
 * 卡片「⋯」里那两项**只在按人物筛时出现**的操作（任务 §5.2）：
 * 「不是 X」（`none: true`）与「设为封面」（`coverMemeId`）。
 *
 * ## 为什么它们只长在按人物筛的页面上
 *
 * Meme 的对外表示里**没有**「属于哪个人物」（§6.7.2 明说不加），所以离开人物语境就无从
 * 知道「把这张移出哪个人物」「让这张当谁的脸」。按人物筛的时候客户端已经知道是谁，
 * 两个操作都能直接带上那个 id——这也是服务端不把它塞进 `Meme` 的理由（§5.2.6）。
 *
 * ## 反馈走 toast
 *
 * 与 `use-browse-actions` 同一套（原因写在那个文件头）：这两条都会改数据，
 * 失败必须带 `requestId` 露出来（`http.md §3`）。成功也各说一句——两者在界面上都
 * **不一定看得出来**：「设为封面」改的是头部那张小图，而「不是 X」之后那张卡片会消失，
 * 消失与「被删了」在视觉上分不开。
 *
 * ## 那两条失败路径特意不做乐观更新
 *
 * 请求回来之前不动界面。理由与 `PersonFilterBar` 里那条相同：先动再回滚会让卡片
 * 闪一下再回来，而用户会以为「点了两下都成功了」。
 */

/** 失败时统一那一句。**原因与 `requestId` 都要露**，不然用户没法把它对上服务端日志。 */
function failureNote(what: string, err: unknown): [string, string | undefined] {
  const apiErr = err instanceof ApiError ? err : null
  return [`${what}失败：${apiErr?.message ?? '请稍后重试'}`, apiErr?.requestId]
}

export function usePersonMemeActions(
  list: BrowseList,
  entity: Entity<Person>,
  personId: string | null,
) {
  /**
   * 「不是 X」：把这张图移出当前人物（`none: true`，§6.7.4）。
   *
   * ⚠️ **移出之后这张图就不在「这个人物」的列表里了**，所以要把它从当前列表摘掉
   *    （`applyRemoval`）——不摘的话它会一直留在屏幕上，点一下消失一张，像是没生效。
   *    同时 `entity.reload()` 把头部那个图数拉准；那个数是用户判断合并与拆分的依据。
   */
  async function removeFromPerson(meme: Meme) {
    if (personId === null) return
    try {
      await assignMemes({ memeIds: [meme.id], none: true })
      list.applyRemoval(meme.id)
      entity.reload()
      notifySuccess('已移出这个人物')
    } catch (err) {
      const [note, requestId] = failureNote('移出', err)
      notifyFailure(note, requestId)
    }
  }

  /**
   * 「设为封面」（`coverMemeId`，§6.7.4）。
   *
   * 响应就是更新后的 Person，所以 `apply` 就行——**不 `reload`**：多跑一趟是白花，
   * 而且中间会闪回旧封面（`use-entity` 的文件头把这条写死了）。
   */
  async function setCover(meme: Meme) {
    if (personId === null) return
    try {
      entity.apply(await patchPerson(personId, { coverMemeId: meme.id }))
      notifySuccess('已设为封面')
    } catch (err) {
      const [note, requestId] = failureNote('设为封面', err)
      notifyFailure(note, requestId)
    }
  }

  return { removeFromPerson, setCover }
}
