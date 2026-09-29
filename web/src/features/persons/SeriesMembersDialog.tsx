import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { fetchPersons, patchSeries, type Person, type Series } from '../../lib/api-persons'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { Checkbox } from '../../components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Shimmer } from '../../components/ui/shimmer'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { CoverThumb } from './CoverThumb'
import { fetchSeriesMemberIds } from './members'
import { usePagedList } from './use-paged-list'

/**
 * 「编辑成员」：勾选哪些人物属于这个系列（任务 §5.2）。
 *
 * ## 整份提交，不是增量
 *
 * `PATCH /series/{id}` 的 `personIds` 是**完整成员名单**（§6.7.4）。所以这个对话框
 * 的语义是「把勾着的这一份交上去」，而不是「把新勾上的加进去」——取消勾选一个人物
 * 会真的把他移出系列。当成增量写的话，取消勾选**什么都不发生**，不报错。
 *
 * ## 成员名单必须先在别处取全
 *
 * ⚠️ **不能拿「已经滚出来的那几页里 `seriesId === 这个系列` 的人」当成员名单。**
 *    这个对话框的人物列表是分页滚动的，只提交看得见的那一部分等于把**没滚到的成员
 *    静默移出系列**。所以成员 id 由 `fetchSeriesMemberIds` 一次取全（见那个文件），
 *    取不全就**拒绝保存并说出来**，不猜。
 *
 * ## 勾选状态住在本地
 *
 * 它是一份**草稿**（state-navigation.md §2：编辑中的副本不写回真源），保存成功才由
 * 父组件把新的 Series 换上去。中途关掉对话框 = 丢弃，符合用户对「取消」的预期。
 */

/** 候选人物的每页条数。100 是 `GET /persons` 的 `limit`，服务端只要正整数即可。 */
const PAGE_LIMIT = 100

export function SeriesMembersDialog({
  series,
  open,
  onOpenChange,
  onSaved,
}: {
  series: Series
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (next: Series) => void
}) {
  /*
    只在打开时挂载内层（与外层 modal 同一个手法）：关掉再打开要拿到一份**新的**
    成员名单，而 `useEffect` 的依赖里只有一个不动的 series.id，靠它自己不会重跑。
    Radix 的 Dialog 本来就不渲染未打开的内容，所以这里直接拆组件就够，不用 forceMount。
  */
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[85svh] w-full max-w-2xl grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-4">
        {open && <MembersBody series={series} onClose={() => onOpenChange(false)} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}

function MembersBody({
  series,
  onClose,
  onSaved,
}: {
  series: Series
  onClose: () => void
  onSaved: (next: Series) => void
}) {
  /** 勾选中的 id。**初始值是服务端那一份**，不是「空的然后逐个加」。 */
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [membersComplete, setMembersComplete] = useState(true)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const candidates = usePagedList(
    (cursor) => fetchPersons({ q, limit: PAGE_LIMIT, cursor }),
    q,
  )

  // 成员名单一次取全。失败或取不全都不允许保存——理由见文件头。
  useEffect(() => {
    let alive = true
    fetchSeriesMemberIds(series.id)
      .then(({ ids, complete }) => {
        if (!alive) return
        setSelected(new Set(ids))
        setMembersComplete(complete)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setMembersComplete(false)
        setMembersError(err instanceof ApiError ? err.message : '成员名单读取失败')
      })
    return () => {
      alive = false
    }
  }, [series.id])

  const ready = selected !== null
  const busy = saving

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      if (prev === null) return prev
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function save() {
    if (selected === null) return
    setSaving(true)
    setSaveError(null)
    try {
      const next = await patchSeries(series.id, { personIds: [...selected] })
      onSaved(next)
      onClose()
    } catch (err) {
      // 同名 CONFLICT 在这里不会出现（没提交 name），但未知错误码要能显示（http.md §3）
      setSaveError(
        err instanceof ApiError
          ? `${err.message}（requestId：${err.requestId}）`
          : '保存失败，请求没能发出去',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>「{series.name}」的成员</DialogTitle>
        <DialogDescription>
          勾选属于这个系列的人物。取消勾选会把那个人物移出系列——人物本身和图都不会被删。
        </DialogDescription>
      </DialogHeader>

      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="按名字找人物"
        aria-label="按名字找人物"
        className={cn(TOUCH, 'min-w-0')}
        disabled={busy}
      />

      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {membersError && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>读不到当前的成员名单</AlertTitle>
            <AlertDescription>
              <p>{membersError}</p>
              <p>此时保存会把没读到的人物移出系列，所以先不给保存。</p>
            </AlertDescription>
          </Alert>
        )}
        {!membersError && !membersComplete && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>这个系列的人物太多，一次读不完</AlertTitle>
            <AlertDescription>
              <p>读不全成员名单就没法整份提交——保存会把没读到的人物移出系列，所以先不给保存。</p>
            </AlertDescription>
          </Alert>
        )}

        {!ready && !membersError && (
          <div className="flex flex-col gap-2 py-4">
            <Shimmer className="h-6 w-40" />
            <Shimmer className="h-6 w-56" />
          </div>
        )}

        {ready && (
          <ul className="flex flex-col gap-1">
            {candidates.items.map((person) => (
              <MemberRow
                key={person.id}
                person={person}
                checked={selected.has(person.id)}
                disabled={busy}
                onToggle={(on) => toggle(person.id, on)}
              />
            ))}
          </ul>
        )}

        <div ref={candidates.sentinelRef} className="mt-4 h-px" aria-hidden="true" />
        {candidates.error && (
          <Alert variant="destructive">
            <AlertTitle>{candidates.error.message}</AlertTitle>
            <AlertDescription>
              <Button variant="outline" size="sm" className={cn(TOUCH, 'mt-2')} onClick={candidates.retry}>
                重试
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {candidates.initialDone && candidates.items.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">没有叫这个名字的人物</p>
        )}
      </div>

      <DialogFooter className="items-center gap-2">
        {saveError && (
          <p role="alert" className="mr-auto text-sm text-destructive">
            {saveError}
          </p>
        )}
        <span className="mr-auto text-sm text-muted-foreground">
          已选 {selected?.size ?? 0} 人
        </span>
        <Button variant="outline" className={TOUCH} onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          className={TOUCH}
          onClick={() => void save()}
          // 名单不全就不给保存：那一下会静默改掉没读到的人（见文件头）
          disabled={busy || !ready || !membersComplete}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
      </DialogFooter>
    </>
  )
}

/** 一行一个候选人物：封面小图 + 名字 + 勾选框。整行可点。 */
function MemberRow({
  person,
  checked,
  disabled,
  onToggle,
}: {
  person: Person
  checked: boolean
  disabled: boolean
  onToggle: (on: boolean) => void
}) {
  return (
    <li>
      {/*
        整行包在 label 里，点名字也能勾上——与 `BrowseFilters` 那两个开关同一套写法。
        复选框自己只有 16px，命中区靠这一行的 `min-h-11`（44px，styling.md）。
      */}
      <label
        className={cn(
          'flex min-h-11 items-center gap-3 rounded-2xl px-2 py-1',
          disabled ? 'opacity-60' : 'hover:bg-muted/60',
        )}
      >
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={(v) => onToggle(v === true)}
          // 读屏要能读出这一行是谁，否则听到的是一串没有主语的「复选框」
          aria-label={person.name ?? '未命名的人物'}
        />
        <CoverThumb src={person.cover.thumbUrl} className="w-10 shrink-0 rounded-lg" />
        <span className="flex min-w-0 flex-col">
          <span className={cn('truncate text-sm', person.name === null && 'text-muted-foreground italic')}>
            {person.name ?? '未命名'}
          </span>
          <span className="text-xs text-muted-foreground">{person.memeCount} 张</span>
        </span>
      </label>
    </li>
  )
}
