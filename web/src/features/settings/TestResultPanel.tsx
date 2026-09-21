import { useState } from 'react'
import { CheckIcon, CircleCheckIcon, MinusIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../components/ui/accordion'
import { Alert, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { TOUCH } from './settings-ui'

/**
 * 测试连接的结果展示。**这是这一页最重要的控件**（settings-ux.md §5）。
 *
 * 两件事不能妥协：
 *   1. **逐项列出探测到了什么**，不是一个成功 / 失败的红绿灯——用户需要知道哪一项不行，
 *      才能判断要不要换模型
 *   2. `rawResponse` / `rawError` **原样展示**：不截断、不包装成友好文案。用户面对的是
 *      中转服务，只有看到原始返回才能分清「模型能力不行」和「配置填错了」
 *
 * 结论用**图标 + 文字**两路表达，不只靠颜色：✓ 是 Check、✗ 是 X、— 是 Minus。
 * 颜色只做加强——`text-destructive` 是有语义 token 的（✗ 那一项），
 * 而 ✓ 用前景色而不是绿色：主题里没有 success token，硬套一个 Tailwind 调色板
 * 就等于绕过 token 体系（styling.md），而「通过」本来也不需要被染成什么颜色。
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
  const Icon = probe.value === null ? MinusIcon : probe.value ? CheckIcon : XIcon
  const tone =
    probe.value === null ? 'text-muted-foreground' : probe.value ? '' : 'text-destructive'
  const text = probe.value === null ? probe.unknown : probe.value ? probe.yes : probe.no

  return (
    <li className="flex gap-2">
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', tone)} />
      <span className="wrap-anywhere">
        {text}
        {probe.value === false && probe.note && <> —— {probe.note}</>}
      </span>
    </li>
  )
}

/**
 * 原始输出。**内容不截断、不包装**（settings-ux.md §5）。
 *
 * 折叠用 `Accordion`，但它里面装的东西**必须是静态的**：radix 的高度变量是
 * **展开那一刻量一次的快照**（`useLayoutEffect` 依赖 `[open, present]`，没有
 * ResizeObserver），而 `AccordionContent` 的内层 div 是 `h-(--radix-accordion-content-height)`。
 * 展开后再往里塞内容，外层是 `overflow-hidden` —— **多出来的部分被裁掉，且不报错**。
 * 这里装的是已经拿到的字符串，渲染完不再变，所以安全。
 *
 * 这是实测过的，不是从源码推的：展开后往内容里塞一块 200px 高的 div，
 * 内层 `scrollHeight` 108 → 292，而 `height` 仍是写死的 `108px`、外层仍是 `overflow: hidden`，
 * 那块内容只露出 16px（就是它自己的 padding）——**高度不跟、也不报错**。
 * 所以下面那个限高的 `<pre>` 自带滚动是必要的：几百行返回靠它自己滚，
 * 而不是指望 Accordion 跟着长。
 */
function RawOutput({ label, text, open }: { label: string; text: string; open: boolean }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={open ? 'raw' : undefined}
      className="bg-background"
    >
      <AccordionItem value="raw">
        <AccordionTrigger className={TOUCH}>{label}</AccordionTrigger>
        <AccordionContent>
          <div className="mb-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={TOUCH}
              onClick={handleCopy}
            >
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
          {/* 限高只是给它一个滚动区，免得几百行返回把整页顶走；全文都在 DOM 里，复制拿到的也是全文 */}
          <pre className="max-h-80 overflow-auto rounded-xl bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {text}
          </pre>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

type Props = {
  ok: boolean
  probes: Probe[]
  /** 探到了但不该判成对错的事实（例如「向量会截断到 1024 维」），单独列，不进 ✓ / ✗ */
  notes?: string[]
  /**
   * 两路原始输出**不对称**，所以都是可选的：视觉测试只回 `rawResponse`，
   * embedding 测试只回 `rawError`（SPEC §6.5.1 的两段示例）。缺的那一个不渲染空壳。
   */
  rawResponse?: string | null
  rawError?: string | null
}

export function TestResultPanel({ ok, probes, notes, rawResponse, rawError }: Props) {
  return (
    <div className="flex flex-col gap-3">
      {/*
        结论那一行用 Alert：它自带 role="alert"，测完立刻被读屏念出来。
        **探针清单不在 Alert 里面**——`destructive` 变体会把整块染红，
        而「测试没过」时清单里通常仍有几项是 ✓，一色红会把它们一起说成故障。
      */}
      <Alert variant={ok ? 'default' : 'destructive'}>
        {ok ? <CircleCheckIcon aria-hidden="true" /> : <TriangleAlertIcon aria-hidden="true" />}
        <AlertTitle>{ok ? '测试通过，可以保存' : '测试未通过，暂不能保存'}</AlertTitle>
      </Alert>

      <ul className="flex flex-col gap-2 text-sm">
        {probes.map((probe) => (
          <ProbeLine key={probe.yes} probe={probe} />
        ))}
      </ul>

      {notes?.map((note) => (
        <p key={note} className="text-sm text-muted-foreground wrap-anywhere">
          {note}
        </p>
      ))}

      {/*
        `key` 跟着 ok 变：`Accordion` 的 `defaultValue` 只在挂载时生效，而两次测试之间
        组件是复用的（同一个 `form.phase.kind === 'done'` 分支）。不加 key 的话，
        「先失败（自动展开）→ 改配置 → 再测通过」会留着上一次展开的原始返回。
        旧实现是 `<details open={!ok}>`，React 每次渲染都会去改那个属性，行为是跟着变的——
        key 是把同一个行为找回来。用户自己点开的那次不受影响：ok 没变就不重挂载。
      */}
      {rawError != null && (
        <RawOutput key={`err-${ok}`} label="rawError（原始错误）" text={rawError} open={!ok} />
      )}
      {rawResponse != null && (
        <RawOutput
          key={`res-${ok}`}
          label="rawResponse（模型原始返回）"
          text={rawResponse}
          open={!ok}
        />
      )}
    </div>
  )
}
