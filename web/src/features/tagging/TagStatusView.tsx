import { useCallback, useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { ApiError, fetchTagStatus, type TagStatusSummary } from '../../lib/api'
import { tagStatusLabel } from '../../lib/tag-status'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { FailureBreakdown } from './FailureBreakdown'
import { TaggingList } from './TaggingList'
import { TaggingSummary } from './TaggingSummary'

/**
 * 这一页只列两个状态。
 *
 * `ok` 不列：它是绝大多数，要看全部去浏览页。
 * `refused` 不列：它要求主副通道都被拒绝，而副通道尚未接入（SPEC §6.6.2 仍是 `proposed`），
 * 所有终局失败都落 `needs_manual`——文案仍按四个取值全量映射（卡片角标），
 * 但**不为一个当前不可达的状态做单独的交互**。
 */
const LIST_STATUSES = ['pending', 'needs_manual']
const DEFAULT_STATUS = 'pending'

/** `/import?tab=tag` 的页签内容。子筛选放 URL，与页签本身一样可以被直接链接到。 */
export function TagStatusView() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('tagStatus') ?? ''
  const status = LIST_STATUSES.includes(requested) ? requested : DEFAULT_STATUS

  const [summary, setSummary] = useState<TagStatusSummary | null>(null)
  const [summaryError, setSummaryError] = useState<{ message: string; requestId: string } | null>(null)

  const loadSummary = useCallback(async () => {
    setSummaryError(null)
    try {
      setSummary(await fetchTagStatus())
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null
      setSummaryError({
        message: apiErr?.message ?? '加载汇总失败',
        requestId: apiErr?.requestId ?? '未知',
      })
    }
  }, [])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  function setStatus(next: string) {
    const p = new URLSearchParams(searchParams)
    p.set('tagStatus', next)
    setSearchParams(p, { replace: true })
  }

  /**
   * 子筛选上的数字。**列表自己的条数不能拿来当这个数**——列表是游标分页的，
   * 只加载了第一页，那个数只会比真实值小。汇总归汇总接口（SPEC §6.6.1）。
   */
  function countFor(s: string): number | null {
    if (!summary) return null
    return s === 'pending' ? summary.counts.pending : summary.counts.needsManual
  }

  return (
    <section className="flex flex-col gap-4">
      {summary && <TaggingSummary summary={summary} />}

      {/* 汇总是**附加**信息：它挂了不影响下面的列表，所以错误只报这一块，
          不把整个页签换成错误页（http.md「降级不是错误」的同一个思路）。 */}
      {summaryError && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>汇总加载失败：{summaryError.message}</AlertTitle>
          <AlertDescription>
            <p className="font-mono text-xs">requestId：{summaryError.requestId}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(TOUCH, 'mt-2')}
              onClick={() => void loadSummary()}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* 与页面顶部那三个页签是同一套组件、同一条约定：值由 URL 给（`?tagStatus=`），
          `onValueChange` 只把新值写回地址栏。`pointer-coarse:h-auto!` 的理由见
          `routes/import.tsx`——注册表给列表写死 `h-9`，只有 `!` 压得住。 */}
      <Tabs value={status} onValueChange={setStatus} className="gap-4">
        <TabsList className="pointer-coarse:h-auto!">
          {LIST_STATUSES.map((s) => {
            const n = countFor(s)
            return (
              <TabsTrigger key={s} value={s} className={TOUCH}>
                {tagStatusLabel(s)}
                {n !== null && n > 0 ? (
                  <Badge variant="secondary" className="tabular-nums">
                    {n}
                  </Badge>
                ) : null}
              </TabsTrigger>
            )
          })}
        </TabsList>

        <TabsContent value="pending">
          <TaggingList status="pending" />
        </TabsContent>

        <TabsContent value="needs_manual">
          <div className="flex flex-col gap-4">
            {summary && <FailureBreakdown failures={summary.failures} />}
            <TaggingList status="needs_manual" />
          </div>
        </TabsContent>
      </Tabs>
    </section>
  )
}
