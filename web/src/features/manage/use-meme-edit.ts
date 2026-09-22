import { useState } from 'react'
import { ApiError, patchMeme, type Meme, type MemePatch } from '../../lib/api'
import { VOCAB_FIELDS, type VocabField } from '../../lib/vocab'

/**
 * 编辑草稿：**描述 + 六个词表维度**（SPEC §6.4.1）。
 *
 * `ocrText` 不在这里，而且不该来——它是模型对图像的读数，人工改会让文本和图不再对应，
 * 而 `search_text` 会忠实转发这个错，没有任何地方会报错（SPEC §6.4.1）。想改它只能重新打标。
 *
 * 六个维度写成 `Record<VocabField, …>` 而不是六个手写字段：v0.2.0 拆维度时这个文件里
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

  // 只有用户真的改了才为 true。草稿是纯 UI state（state-navigation.md §3），
  // 不是服务端数据的第二份副本——保存成功后它立刻被服务端返回的对象覆盖掉。
  const dirty = !sameDraft(draft, draftFrom(meme))

  function update<K extends keyof MemeEditDraft>(key: K, value: MemeEditDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  function reset() {
    setDraft(draftFrom(meme))
    setError(null)
  }

  async function save(): Promise<void> {
    const patch = buildPatch(draft, meme)
    // 一个字段都没改就什么都不发：空 PATCH 会在服务端留下「有人编辑过」的痕迹
    // （edited_by / edited_at），而那是一次没有内容的编辑（SPEC §6.4.1）。
    if (Object.keys(patch).length === 0) return

    setSaving(true)
    setError(null)
    try {
      const updated = await patchMeme(meme.id, patch)
      onSaved(updated)
      // 服务端返回的就是新的真相，草稿跟着它走——**不维护影子副本**（state-navigation.md §2）
      setDraft(draftFrom(updated))
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

  return { draft, update, reset, save, saving, error, dirty }
}
