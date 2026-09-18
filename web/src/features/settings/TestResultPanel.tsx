import { useState } from 'react'

/**
 * 测试连接的结果展示。**这是这一页最重要的控件**（settings-ux.md §5）。
 *
 * 两件事不能妥协：
 *   1. **逐项列出探测到了什么**，不是一个成功 / 失败的红绿灯——用户需要知道哪一项不行，
 *      才能判断要不要换模型
 *   2. `rawResponse` / `rawError` **原样展示**：不截断、不包装成友好文案。用户面对的是
 *      中转服务，只有看到原始返回才能分清「模型能力不行」和「配置填错了」
 *
 * 结论只用 ✓ / ✗ / — 这三个字符表达，不靠颜色（web/AGENTS.md §5 当前只写布局样式）。
 */

export type Probe = {
  /** **三态**：`null` 是「这次没探测出结论」，不是「不支持」（任务 §web E）。 */
  value: boolean | null
  /** value === true 时的说法，例：能接收图片 */
  yes: string
  /** value === false 时的说法，例：不支持多图输入 */
  no: string
  /** value === false 时的后果，例：动图将使用拼图模式 */
  note?: string
  /** value === null 时的说法，例：多图输入未探测 */
  unknown: string
}

function ProbeLine({ probe }: { probe: Probe }) {
  if (probe.value === null) {
    return <li className="test-result__probe">— {probe.unknown}</li>
  }
  if (probe.value) {
    return <li className="test-result__probe">✓ {probe.yes}</li>
  }
  return (
    <li className="test-result__probe">
      ✗ {probe.no}
      {probe.note && <> —— {probe.note}</>}
    </li>
  )
}

function RawOutput({ label, text, open }: { label: string; text: string; open: boolean }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <details className="test-result__raw" open={open}>
      <summary>{label}</summary>
      <div className="test-result__raw-actions">
        <button type="button" onClick={handleCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {/* <pre> 保证等宽与原样换行。**不截断、不包装**（settings-ux.md §5） */}
      <pre className="test-result__raw-text">{text}</pre>
    </details>
  )
}

type Props = {
  ok: boolean
  probes: Probe[]
  /** 探到了但不该判成对错的事实（例如「向量会截断到 1024 维」），单独列，不进 ✓ / ✗ */
  notes?: string[]
  rawResponse: string | null
  rawError: string | null
}

export function TestResultPanel({ ok, probes, notes, rawResponse, rawError }: Props) {
  return (
    <div className="test-result" role="status">
      <p className="test-result__verdict">{ok ? '测试通过，可以保存' : '测试未通过，暂不能保存'}</p>
      <ul className="test-result__probes">
        {probes.map((probe) => (
          <ProbeLine key={probe.yes} probe={probe} />
        ))}
      </ul>
      {notes?.map((note) => (
        <p className="test-result__note" key={note}>
          {note}
        </p>
      ))}
      {rawError !== null && <RawOutput label="rawError（原始错误）" text={rawError} open={!ok} />}
      {rawResponse !== null && (
        <RawOutput label="rawResponse（模型原始返回）" text={rawResponse} open={!ok} />
      )}
    </div>
  )
}
