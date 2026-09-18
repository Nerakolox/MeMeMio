import { Link } from 'react-router-dom'
import type { TagStatusSummary } from '../../lib/api'

/**
 * 汇总区：四个状态各多少张 + 正在打标几张（SPEC §6.6.1）。
 *
 * `counts.pending` **必须和 `visionConfigured` 一起看才有意义**：前者是「多少张还没标」，
 * 后者回答「它们会不会自己好」。通道不可用时任务不消费、也不计失败重试
 * （[SPEC §2.4](../../../spec/02-errors.md) 的 `AI_NOT_CONFIGURED`），一大批 `pending`
 * 看起来就是卡死了，所以这句话必须说出来。
 *
 * 但它**不是错误态**：不用红色、不阻断任何操作。没配模型照样能导入，这是产品明确要的
 * （import-ux.md §10、styling.md「状态的视觉表达」）。
 */
export function TaggingSummary({ summary }: { summary: TagStatusSummary }) {
  const { counts, running, visionConfigured } = summary

  return (
    <section className="tagging__summary" aria-label="打标汇总">
      {/* 四个数全给，没有的写 0：缺一格会让人以为是没查到而不是真的没有 */}
      <dl className="tagging__counts">
        <Count label="已完成" value={counts.ok} />
        <Count label="待打标" value={counts.pending} />
        <Count label="需人工" value={counts.needsManual} />
        <Count label="已拒绝" value={counts.refused} />
        {running > 0 && <Count label="正在打标" value={running} />}
      </dl>

      {!visionConfigured && (
        <p className="tagging__note">
          还没有可用的视觉模型，所以打标不会开始，图会停在「待打标」。
          <strong>配好之后会自动补打标，不需要手动操作。</strong>
          <Link to="/settings">去设置页配置</Link>
        </p>
      )}
    </section>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="tagging__count">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
