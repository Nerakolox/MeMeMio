import { useState } from 'react'
import { ApiError, patchMeme, type Meme, type MemePatch } from '../../lib/api'
import { VOCAB_FIELDS, type VocabField } from '../../lib/vocab'

/**
 * 编辑草稿：**描述 + 七个词表维度**（SPEC §6.4.1）。
 *
 * `ocrText` 不在这里，而且不该来——它是模型对图像的读数，人工改会让文本和图不再对应，
 * 而 `search_text` 会忠实转发这个错，没有任何地方会报错（SPEC §6.4.1）。想改它只能重新打标。
 *
 * 这七维写成 `Record<VocabField, …>` 而不是逐个手写字段：v0.2.0 拆维度时这个文件里
 * 有四处要同步改（初始化、比较、生成 patch、类型），少改一处的表现是那一维**永远发不出去**
 * ——用户改了标签、点了保存、界面没报错，而服务端根本没收到那个字段。
 */
export type MemeEditDraft = { description: string } & Record<VocabField, string[]>

function draftFrom(meme: Meme): MemeEditDraft {
  const draft = { description: meme.description ?? '' } as MemeEditDraft
  // 复制一份，不要让草稿和列表里那个对象共享同一个数组引用
  for (const field of VOCAB_FIELDS) draft[field] = [...meme[field]]
  return draft
}

/**
 * 全空白按「清空描述」处理——textarea 清干净之后剩下的空格不是描述。
 * 其余情况**原样发送**，不在保存时顺手替用户改他的文字。
 */
function normalizeDescription(text: string): string | null {
  return text.trim() === '' ? null : text
}

/**
 * 按集合比较，不按顺序。
 *
 * 顺序在这里不重要（服务端不保证数组序），而「取消了又选上」之后顺序会变——
 * 用 `!==` 比数组会以为改了，于是白发一次 PATCH。
 */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((v) => set.has(v))
}

function sameDraft(a: MemeEditDraft, b: MemeEditDraft): boolean {
  return (
    a.description === b.description &&
    VOCAB_FIELDS.every((field) => sameSet(a[field], b[field]))
  )
}

/**
 * 只发**真正改过**的字段。没出现的字段不动，这是 SPEC §6.4.1 三种传法里的第一种。
 *
 * 把没改的字段也一起发，不只是浪费一次比较：那等于用我们手上这份（可能已经陈旧的）
 * 副本覆盖掉别人的并发修改。共享库里所有人都有编辑权，并发编辑是常态不是边缘情况（§9.1）。
 */
function buildPatch(draft: MemeEditDraft, meme: Meme): MemePatch {
  const patch: MemePatch = {}

  const description = normalizeDescription(draft.description)
  if (description !== (meme.description ?? null)) patch.description = description

  for (const field of VOCAB_FIELDS) {
    if (!sameSet(draft[field], meme[field])) patch[field] = draft[field]
  }

  return patch
}

/**
 * 编辑一张图的草稿与保存。
 *
 * ⚠️ **不做乐观更新**（state-navigation.md §8）：等服务端确认之后再改本地。
 * 编辑要等服务端的词表校验结果——先改本地再回滚会闪一下，
 * 而失败的常见原因（词表外标签）会让用户看到自己刚打的标签消失又出现。
 */
export function useMemeEdit(meme: Meme, onSaved: (updated: Meme) => void) {
  const [draft, setDraft] = useState<MemeEditDraft>(() => draftFrom(meme))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ message: string; requestId: string } | null>(null)
  /**
   * 「刚保存过」——给面板内那行行内「已保存」用（2026-09-24）。
   *
   * 它**不是** `!dirty` 的同义词，虽然此刻两者同时为真：保存成功后草稿被服务端返回的对象
   * 覆盖，`dirty` 自然回落；而用户随后再动一下，`dirty` 与 `saved` 就一起没了下文。
   * 分成两个值是因为**只有 `saved` 能说「这一次保存成了」**：`!dirty` 在刚打开面板、
   * 什么都没做的时候也为真，那时说「已保存」是彻头彻尾的谎话。
   *
   * 不住在 toast 里：面板是从右侧推出来的抽屉，而 `feedback.md` 记着 Radix 模态会给
   * `#root` 挂 `aria-hidden`，弹出去的那句读屏听不见——而「保存完不知道成没成」
   * 正是这次要修的那个问题。
   */
  const [saved, setSaved] = useState(false)

  // 只有用户真的改了才为 true。草稿是纯 UI state（state-navigation.md §3），
  // 不是服务端数据的第二份副本——保存成功后它立刻被服务端返回的对象覆盖掉。
  const dirty = !sameDraft(draft, draftFrom(meme))

  function update<K extends keyof MemeEditDraft>(key: K, value: MemeEditDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
    // 又改了一笔，「已保存」立刻失效——留着它会让用户以为新改的也存进去了
    setSaved(false)
  }

  function reset() {
    setDraft(draftFrom(meme))
    setError(null)
    setSaved(false)
  }

  async function save(): Promise<void> {
    const patch = buildPatch(draft, meme)
    // 一个字段都没改就什么都不发：空 PATCH 会在服务端留下「有人编辑过」的痕迹
    // （edited_by / edited_at），而那是一次没有内容的编辑（SPEC §6.4.1）。
    if (Object.keys(patch).length === 0) return

    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const updated = await patchMeme(meme.id, patch)
      /*
       * ⚠️ **`matchedBy` 要保留列表里这一条原有的值**（SPEC §6.3.1）：它是**这一次检索的
       * 性质，不是这张图的属性**，所以单资源响应（`PATCH` 的返回）不带它——§5.2.6 的对外
       * 表示里就没有这个字段。编辑不会改变这张图是被哪几路召回的，服务端也不会为一次编辑
       * 重跑检索，**旧值就是对的**。
       *
       * 不许改成让 api 回 `matchedBy: []`：那是把一个检索元字段塞进资源形状，症状是
       * 「编辑过的图凭空少了一个角标」，而且下一次查不出来。无 `q` 的浏览列表里这一条本来
       * 就是 `[]`（§6.3「额外字段」那一行），所以这次合并对它等于什么都没做。
       */
      const merged: Meme = { ...updated, matchedBy: meme.matchedBy }
      onSaved(merged)
      // 服务端返回的就是新的真相，草稿跟着它走——**不维护影子副本**（state-navigation.md §2）
      setDraft(draftFrom(merged))
      setSaved(true)
    } catch (err) {
      // 按 code 分支，不解析 message（http.md §3）。词表外标签是 VALIDATION_FAILED，
      // 不是 AI_INVALID_OUTPUT——后者会让前端去等一个永远不会来的 AI 降级（SPEC §4.5）。
      // 这里不需要对 code 分别处理：两种情况都是「把服务端那句话展示给用户」。
      const apiErr = err instanceof ApiError ? err : null
      setError({
        message: apiErr?.message ?? '保存失败，请稍后重试',
        requestId: apiErr?.requestId ?? '未知',
      })
    } finally {
      setSaving(false)
    }
  }

  return { draft, update, reset, save, saving, error, dirty, saved }
}
