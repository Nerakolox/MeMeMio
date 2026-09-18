import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/api'
import { fetchReindexStatus, startReindex, type ReindexStatus } from '../../lib/api-config'

/**
 * 全站重建索引的进度与手动触发（SPEC §6.5.4）。
 *
 * **不做成模态阻塞**：它要跑几分钟，管理员应该能去干别的（settings-ux.md §8）。
 * 所以这是管理页上的一块普通区域，不挡住 Embedding 表单。
 *
 * 计数来自服务端对库的真实统计，前端只显示，不自己累加——进程重启后内存计数会归零，
 * 那样的进度条是假的。
 */

type Props = {
  /** 父组件确认换模型后自增，用来立刻重新拉一次状态，不等下一轮轮询 */
  refreshToken: number
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

  return (
    <section className="settings-section">
      <h2>重建索引</h2>

      {error && <p className="error">{error}</p>}

      {status && (
        <>
          <p className="reindex__state">
            {status.running ? '重建进行中' : '当前没有进行中的重建'}
          </p>
          <p className="reindex__hint">
            重建期间搜索降级为 OCR + 标签，结果带「可能不全」提示，但不中断服务。
          </p>
          <dl className="reindex__counts">
            <div className="reindex__count">
              <dt>已是当前模型</dt>
              <dd>
                {status.done} / {status.total}
              </dd>
            </div>
            <div className="reindex__count">
              <dt>待重算</dt>
              <dd>{status.stale}</dd>
            </div>
            <div className="reindex__count">
              <dt>重试耗尽</dt>
              <dd>{status.failed}</dd>
            </div>
          </dl>
          {status.failed > 0 && (
            <p className="reindex__failed">
              有 {status.failed} 条重试耗尽，不做断点续传，需要看服务端日志。
            </p>
          )}
        </>
      )}

      <div className="settings-section__actions">
        <button type="button" onClick={handleStart} disabled={starting}>
          {starting ? '触发中…' : '重建索引'}
        </button>
      </div>
      {/* 幂等，重复点不会让同一条记录重算两遍（SPEC §6.5.4），所以跑着的时候也不禁用 */}
      <p className="settings-section__hint">重复触发是安全的：服务端幂等，不会重复排队。</p>

      {startError && (
        <p className="error" role="alert">
          {startError}
        </p>
      )}
    </section>
  )
}
