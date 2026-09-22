import type { TagStatusSummary } from '../../lib/api'
import { tagFailureLabel } from '../../lib/tag-status'

/**
 * 失败原因分布，跟在「需人工」那一段列表上面（SPEC §6.6.1）。
 *
 * 显示的是**类别**，不是服务端的原始错误串——那个字符串刻意没有返回（§6.6.1），
 * 中文文案在 `lib/tag-status.ts` 里映射。
 */
export function FailureBreakdown({ failures }: { failures: TagStatusSummary['failures'] }) {
  if (failures.length === 0) return null

  // ⚠️ `embed_failed` 的图 `tag_status` 是 `ok`，**不在 counts.needsManual 里**：
  // 打标成功了，只是没算出向量，所以它能被文字搜到、进不了向量路。
  // 「需人工 7 张」旁边列出十来个失败时，这一句是唯一能解释差额的地方。
  const embedFailed = failures.find((f) => f.reason === 'embed_failed')?.count ?? 0

  return (
    <section className="flex flex-col gap-2 rounded-2xl border bg-muted/30 px-4 py-3">
      <ul className="flex flex-col gap-1 text-sm">
        {failures.map((f) => (
          <li key={f.reason}>
            {f.count} 张{tagFailureLabel(f.reason)}
          </li>
        ))}
      </ul>
      {embedFailed > 0 && (
        <p className="text-xs text-muted-foreground">
          其中 {embedFailed} 张已经打标成功，只是没算出向量——它们能被文字搜到，
          但不会出现在按意思找的那一路结果里。这类不占「需人工」的张数。
        </p>
      )}
    </section>
  )
}
