import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/api'
import { fetchReindexStatus, startReindex, type ReindexStatus } from '../../lib/api-config'
import { Alert, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Progress } from '../../components/ui/progress'
import { SettingsCard } from './SettingsCard'
import { TOUCH } from './settings-ui'

/**
 * 全站重建索引的进度与手动触发（SPEC §6.5.4）。
 *
 * **不做成模态阻塞**：它要跑几分钟，管理员应该能去干别的（settings-ux.md §8）。
 * 所以这是 Embedding 那张卡**下面并列的另一张卡**，不挡住配置表单。
 *
 * 计数来自服务端对库的真实统计，前端只显示，不自己累加——进程重启后内存计数会归零，
 * 那样的进度条是假的。
 */

type Props = {
  /** 父组件确认换模型后自增，用来立刻重新拉一次状态，不等下一轮轮询 */
  refreshToken: number
}

/** 一格统计。三个格子的结构一样，抽出来免得写三遍。 */
function Count({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-heading text-xl tabular-nums">{value}</dd>
    </div>
  )
}

export function ReindexPanel({ refreshToken }: Props) {
  const [status, setStatus] = useState<ReindexStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [manualTick, setManualTick] = useState(0)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      try {
        const next = await fetchReindexStatus()
        if (!alive) return
        setStatus(next)
        setError(null)
        // 只在跑着的时候接着轮询：空转时每 5 秒打一次接口没有意义
        if (next.running) timer = setTimeout(poll, 5000)
      } catch (err) {
        if (!alive) return
        setError(
          err instanceof ApiError
            ? `${err.message}（requestId：${err.requestId}）`
            : '重建状态读取失败',
        )
      }
    }

    void poll()
    // 清理函数必须写，否则切走路由后这个轮询还在跑（code-style.md）
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [refreshToken, manualTick])

  async function handleStart() {
    setStartError(null)
    setStarting(true)
    try {
      await startReindex()
      setManualTick((n) => n + 1)
    } catch (err) {
      setStartError(
        err instanceof ApiError ? `${err.message}（requestId：${err.requestId}）` : '触发失败',
      )
    } finally {
      setStarting(false)
    }
  }

  // total 为 0（库是空的）时不能除：0/0 会算出 NaN，进度条变成一条空轨
  const percent = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0

  return (
    <SettingsCard
      title="重建索引"
      description="换 Embedding 模型后要按新模型把全库的向量重算一遍。这里能看进度，也能手动补触发。"
      action={
        status && (
          <Badge variant={status.running ? 'default' : 'secondary'}>
            {status.running ? '进行中' : '空闲'}
          </Badge>
        )
      }
    >
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}

      {status && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Progress value={percent} aria-label="重建进度" />
            <p className="text-sm text-muted-foreground">
              {status.running ? '重建进行中' : '当前没有进行中的重建'}
              {'，'}
              已完成 {percent}%。期间搜索降级为 OCR + 标签，结果带「可能不全」提示，但不中断服务。
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Count label="已是当前模型" value={`${status.done} / ${status.total}`} />
            <Count label="待重算" value={String(status.stale)} />
            <Count label="重试耗尽" value={String(status.failed)} />
          </dl>

          {status.failed > 0 && (
            <Alert variant="destructive">
              <AlertTitle>
                有 {status.failed} 条重试耗尽，不做断点续传，需要看服务端日志。
              </AlertTitle>
            </Alert>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className={TOUCH} onClick={handleStart} disabled={starting}>
          {starting ? '触发中…' : '重建索引'}
        </Button>
      </div>
      {/* 幂等，重复点不会让同一条记录重算两遍（SPEC §6.5.4），所以跑着的时候也不禁用 */}
      <p className="text-sm text-muted-foreground">重复触发是安全的：服务端幂等，不会重复排队。</p>

      {startError && (
        <Alert variant="destructive">
          <AlertTitle>{startError}</AlertTitle>
        </Alert>
      )}
    </SettingsCard>
  )
}
