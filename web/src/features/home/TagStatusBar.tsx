import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { type ApiError, type TagStatusSummary, fetchTagStatus, toStateError } from '../../lib/api'
import { tagStatusLabel } from '../../lib/tag-status'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { FailureLine } from './FailureLine'

/**
 * 「去处理 →」的去向：导入页的打标页签，并且**预置好那一档筛选**
 * （`TagStatusView` 读 `?tagStatus=`）。不预置的话用户点进去还要自己再选一次
 * 「需人工」——而这一条之所以出现，说的正是「有 N 张得你手工看」。
 */
const NEEDS_MANUAL_HREF = '/import?tab=tag&tagStatus=needs_manual'

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; summary: TagStatusSummary }
  | { kind: 'error'; error: ApiError }

/**
 * 首页底部的待处理状态条（2026-09-26 首页改版 §3）。
 *
 * ## 只在真有货时出现
 *
 * `needsManual > 0` 才渲染。**`pending` 一个数都不露**，`visionConfigured` 也不在这里说：
 * `pending` 只在没配视觉模型时才有意义（[SPEC §6.6.1](../../../../spec/06-endpoints.md)），
 * 单独摆一句「待打标 n 张」会把正常的流水线说成卡住了——那是**打标页**要讲的事
 * （`features/tagging/TaggingSummary.tsx` 把 `pending` 和「配好之后会自动补打标」
 * 那句话放在一起，所以那边露它是对的）。首页只回答一件事：**有没有活要人干。**
 *
 * `running > 0` 时附一句「正在打标 n 张」：它是「为什么现在不催你」的解释，
 * 和待处理条一起看才读得懂——没有它，用户看到 3 张需人工会以为流水线停了。
 *
 * 文案里的「需人工」**取自 `lib/tag-status.ts`**，不在这里再写一遍中文：那份映射是
 * `tag_status` 四个取值的唯一落点（SPEC §5.2.3），抄一份就会和打标页的词漂开。
 *
 * ## `scope` 缺省就是 `mine`，这里不传
 *
 * 服务端默认 `mine`（只看自己上传的），`all` 仅管理员可用（`lib/api.ts` 的
 * `fetchTagStatus`）。这里要的正是「我自己的活」，而**去向那个页面也不传 scope**
 * ——两边口径必须一致，否则状态条说 3 张、点进去看到的是另一个数。
 *
 * ## 三种态
 *
 * loading 与「没有待处理」都渲染 `null`：这一条是**条件出现**的，不是常驻容器，
 * 为它铺一个骨架等于给一个通常不存在的东西占位，而它一出现就说明有货——闪一下更像出错。
 * 但**失败必须说出来**（[code-style.md「异步与加载态」](../agents/rules/code-style.md)）：
 * 静默失败在这一条上格外糟，因为「没有状态条」和「没能查出有没有待处理」在界面上
 * 长得一模一样，用户会以为没事。
 */
export function TagStatusBar() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [round, setRound] = useState(0)

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    fetchTagStatus()
      .then((summary) => {
        if (alive) setState({ kind: 'ok', summary })
      })
      .catch((err: unknown) => {
        if (alive) setState({ kind: 'error', error: toStateError(err) })
      })
    return () => {
      alive = false
    }
  }, [round])

  if (state.kind === 'loading') return null
  if (state.kind === 'error') {
    return <FailureLine error={state.error} onRetry={() => setRound((n) => n + 1)} />
  }

  const { counts, running } = state.summary
  if (counts.needsManual === 0) return null

  return (
    /*
      `role="status"`：它不是警报（没有出错、没阻断任何操作），但**是「有事要告诉你」**，
      这一条又是异步冒出来的，读屏用户需要被告知一次（同 `Notice` 的降级那条）。

      外壳的形状与 `components/Notice.tsx` 那块横幅同源（`rounded-2xl border bg-card px-3 py-2`），
      但**不是同一个东西**：Notice 讲的是「这一屏的结果是怎么来的」，这一条是「有活要你干」，
      而它带着一个去向。共用那个组件会让那句注释里「三块状态说明」的清单变成四块。
    */
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border bg-card px-3 py-2 text-sm"
    >
      <span className="font-medium">
        {tagStatusLabel('needs_manual')} {counts.needsManual} 张
      </span>
      {running > 0 && <span className="text-muted-foreground">正在打标 {running} 张</span>}
      <Button variant="link" size="sm" className={cn(TOUCH, 'px-0')} asChild>
        <Link to={NEEDS_MANUAL_HREF}>去处理 →</Link>
      </Button>
    </div>
  )
}
