import { useEffect, useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { deleteSeries, patchSeries, type Series } from '../../lib/api-persons'
import { useAuth } from '../../contexts/auth'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { CoverThumb } from './CoverThumb'
import { SeriesMembersDialog } from './SeriesMembersDialog'
import type { Entity } from './use-entity'

/**
 * 按系列筛时，浏览页结果列上方那一条（任务 §5.2）。
 *
 * 三件事：**改名、编辑成员、删除**。三条都要单独守一处：
 *
 * - **改名不能清空。** 系列名是它的标识，`name: null` 是 400（§6.7.4，与人物刻意不同）。
 *   所以这里的空输入**不发请求**，就地提示——发出去只会拿回一个 400，而用户要做的
 *   只是别清空。
 * - **成员是整份提交**，不是增量。全部理由在 `SeriesMembersDialog` 的文件头。
 * - **删除只对创建者与 admin 显示**，二次确认里要说「人物不会被删」——不说的话没人敢点，
 *   而删掉的确实只是系列这一行（§5.7.3：其下人物的 `seriesId` 置空）。
 */

export function SeriesFilterBar({
  entity,
  onClear,
  onMembersChanged,
}: {
  /**
   * 当前这一份系列数据与它的写入口。**由 `routes/browse.tsx` 持有、传进来**：
   * 筛选区那个「人物」按钮也要显示同一个名字，理由与 `PersonFilterBar` 同。
   */
  entity: Entity<Series>
  /**
   * 一键清掉这个筛选（按钮上那个 ×），**删除之后也走它**：留在 `?series=<已删的 id>`
   * 上只会拿到 `NOT_FOUND`，而那时用户看到的是「这个系列不存在」——他刚删的，
   * 那句话读起来像出错了。清掉筛选会改 URL，列表自己会重拉，不用另外通知。
   */
  onClear: () => void
  /** 成员变了，这一组内容跟着变，但 URL 没动，所以要显式说一声让列表重拉。 */
  onMembersChanged: () => void
}) {
  const { user } = useAuth()
  const series = entity
  const [membersOpen, setMembersOpen] = useState(false)

  if (series.state.kind === 'loading' || series.state.kind === 'idle') {
    return <Bar><p className="text-sm text-muted-foreground">加载中…</p></Bar>
  }

  if (series.state.kind === 'missing') {
    return (
      <Bar>
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          这个系列不存在，可能它已经被删了。
        </p>
        <Button variant="ghost" className={TOUCH} onClick={onClear}>
          取消筛选
        </Button>
      </Bar>
    )
  }

  if (series.state.kind === 'error') {
    const { error } = series.state
    return (
      <Bar>
        <Alert variant="destructive" className="min-w-0 flex-1">
          <TriangleAlert />
          <AlertTitle>{error.message}</AlertTitle>
          <AlertDescription>
            <p className="font-mono text-xs">requestId: {error.requestId}</p>
            <Button variant="outline" size="sm" className={cn(TOUCH, 'mt-2')} onClick={series.reload}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
        <Button variant="ghost" className={TOUCH} onClick={onClear}>
          取消筛选
        </Button>
      </Bar>
    )
  }

  const current = series.state.value
  /*
    删除限**创建者或 admin**（§6.7.1），与删图同一个不对称：删掉的是别人挑选人物的劳动，
    而且不可撤销。**这里只是体验**——真正拦住越权的是服务端的判定，403 要能显示出来。
  */
  const canDelete = user?.role === 'admin' || current.createdBy === user?.id

  return (
    <div className="flex flex-col gap-3">
      <Bar>
        <CoverThumb src={current.cover?.thumbUrl ?? null} className="w-10 shrink-0 rounded-lg" />
        <SeriesNameField series={current} onSaved={series.apply} />
        <span className="shrink-0 text-sm text-muted-foreground">
          {current.personCount} 人 · {current.memeCount} 张
        </span>

        <Button variant="outline" className={TOUCH} onClick={() => setMembersOpen(true)}>
          编辑成员
        </Button>

        {/* 删掉之后清筛选，理由见 `onClear` 那一段 */}
        {canDelete && <DeleteSeriesButton series={current} onDeleted={onClear} />}

        <Button
          variant="ghost"
          size="icon"
          className={cn(TOUCH, 'shrink-0')}
          aria-label="取消系列筛选"
          onClick={onClear}
        >
          <X className="size-4" />
        </Button>
      </Bar>

      {membersOpen && (
        <SeriesMembersDialog
          series={current}
          open={membersOpen}
          onOpenChange={setMembersOpen}
          onSaved={(next) => {
            series.apply(next)
            onMembersChanged()
          }}
        />
      )}
    </div>
  )
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-muted/30 px-3 py-2">
      {children}
    </div>
  )
}

/**
 * 系列改名。
 *
 * ⚠️ **空输入不发请求**（`name: null` 是 400，§6.7.4）：就地提示「系列名不能清空」。
 *    发出去的话用户拿回的是一个 400 的 message，而这里能说得更直接。
 *
 * ⚠️ **同名是 `CONFLICT`**，要就地提示「这个名字已经有了」——这正是用户下一步要做的
 *    那件事（换一个名字）。通用错误里没有这句话。
 */
function SeriesNameField({ series, onSaved }: { series: Series; onSaved: (next: Series) => void }) {
  const [draft, setDraft] = useState(series.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = draft !== series.name
  useEffect(() => {
    setDraft(series.name)
    setError(null)
  }, [series.id, series.name])

  async function commit() {
    if (!dirty || saving) return
    const trimmed = draft.trim()
    if (trimmed === '') {
      setDraft(series.name)
      setError('系列名不能清空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      onSaved(await patchSeries(series.id, { name: trimmed }))
    } catch (err) {
      setDraft(series.name)
      setError(
        err instanceof ApiError
          ? err.code === 'CONFLICT'
            ? '这个名字已经有了，换一个。'
            : err.message
          : '改名失败',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(series.name)
        }}
        aria-label="这个系列叫什么"
        disabled={saving}
        className={cn(TOUCH, 'min-w-0')}
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  )
}

/**
 * 删系列。**二次确认里必须说「人物不会被删」**（任务 §5.2）。
 *
 * 不说的话没人敢按：界面上「删系列」看起来就是「把这一组人和他们的图一起删掉」，
 * 而实际发生的是 `series` 那一行没了、其下人物的 `seriesId` 置空（§5.7.3）。
 */
function DeleteSeriesButton({ series, onDeleted }: { series: Series; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await deleteSeries(series.id)
      setOpen(false)
      onDeleted()
    } catch (err) {
      // 403（不是创建者也不是 admin）要走这一条，不能吞（SPEC §6.7.1）
      setError(
        err instanceof ApiError
          ? `${err.message}（requestId：${err.requestId}）`
          : '删除失败，请求没能发出去',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="outline" className={TOUCH} onClick={() => setOpen(true)}>
        删除系列
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{series.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {/* 这一句是必须的，见函数上那段 */}
              <strong>里面的人物不会被删</strong>
              {'，他们的图也都在，只是不再属于任何一个系列。'}
              <br />
              {'这个系列有 '}
              <strong>{series.personCount}</strong>
              {' 个人物。删除后把自己再建一次是可以的，但名字之外的东西不会回来。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            {/* 默认焦点落在「取消」上：删除不可逆，一次误触的回车不该把它删掉 */}
            <AlertDialogCancel className={TOUCH} disabled={busy}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className={TOUCH}
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                void confirm()
              }}
            >
              {busy ? '删除中…' : '确定删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
