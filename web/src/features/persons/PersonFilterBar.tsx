import { useEffect, useState, type ReactNode } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { ApiError } from '../../lib/api'
import {
  fetchSeries,
  mergePersons,
  patchPerson,
  rejectPerson,
  type Person,
} from '../../lib/api-persons'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
import { Switch } from '../../components/ui/switch'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { CoverThumb } from './CoverThumb'
import { type Entity, usePersonSuggestions } from './use-entity'

/**
 * 按人物筛时，浏览页结果列上方那一条（任务 §5.2）。
 *
 * 四件事：**改名、归系列、隐藏**，以及**「可能是同一个」**。它们都长在
 * 「当前正是这一个人物」的语境里——这正是 §2 第 6 条说的那个前提：
 * 「不是他」「设为封面」这类逐图的操作只出现在按人物筛的时候，
 * 因为那时客户端已经知道是谁，不必把「属于哪个人物」放进 Meme 的对外表示。
 *
 * ## 不显示任何相似度数字
 *
 * 「可能是同一个」给的是**顺序**，不是分数（§6.7.2）。接口也不给分数——
 * 数值一旦外露，前端就会长出第二套阈值，和服务端判重的口径对不上。
 *
 * ## 合并的方向
 *
 * 目标永远是**当前这个人**：头部顶端写着它的名字，点某一格的「合并」就是把那一格
 * 并进当前这个。所以「谁当目标就留谁的名字」在界面上是看得出来的（§5.1 第 7 条）。
 * 反过来的方向由「先切到那个人再合并」完成，不做「选一个当目标」的第二套交互。
 */

/** 建议最多三格（§6.7.3）。**不截断也不承诺更多**：排成一张全站清单时收全碎片要点掉 68 条错的（§9.34）。 */
const MAX_SUGGESTIONS = 3

export function PersonFilterBar({
  personId,
  entity,
  onClear,
  onMerged,
  onPickOther,
}: {
  /** URL 里那个 id。**与 `entity` 一起传**：建议要按 id 拉，而那个 id 在路由层就有。 */
  personId: string
  /**
   * 当前这一份人物数据与它的写入口。**由 `routes/browse.tsx` 持有、传进来**
   * （不是这里自己拉）：筛选区那个「人物」按钮也要显示同一个名字，
   * 两处各拉一次就会有两个真源——头部改完名之后按钮上还是旧名字。
   */
  entity: Entity<Person>
  /** 一键清掉这个筛选（按钮上那个 ×）。 */
  onClear: () => void
  /** 合并成功之后这一组内容变了，列表要重拉。 */
  onMerged: () => void
  /** 直接切到另一个人物（点「可能是同一个」那一格的封面）。**不重拉列表**：URL 一变它自己会换。 */
  onPickOther: (id: string) => void
}) {
  const person = entity
  // 建议只有这里用，所以它留在这儿：上提到路由只会多一个没人读的返回值
  const suggestions = usePersonSuggestions(personId)
  /** 等着确认的那一次合并：目标是当前这个，来源是它。 */
  const [pendingMerge, setPendingMerge] = useState<Person | null>(null)

  if (person.state.kind === 'loading' || person.state.kind === 'idle') {
    return <Bar><p className="text-sm text-muted-foreground">加载中…</p></Bar>
  }

  /*
    `NOT_FOUND` = 这个人物此刻对客户端不存在（图全被软删了，§5.7.4）。
    **不是错误**：这一页本来就该是空的。所以给的是空态加一句出路，不是红色报错。
  */
  if (person.state.kind === 'missing') {
    return (
      <Bar>
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          这个人物暂时没有图，可能它的图都被删了。
        </p>
        <Button variant="ghost" className={TOUCH} onClick={onClear}>
          取消筛选
        </Button>
      </Bar>
    )
  }

  if (person.state.kind === 'error') {
    const { error } = person.state
    return (
      <Bar>
        <Alert variant="destructive" className="min-w-0 flex-1">
          <TriangleAlert />
          <AlertTitle>{error.message}</AlertTitle>
          <AlertDescription>
            <p className="font-mono text-xs">requestId: {error.requestId}</p>
            <Button variant="outline" size="sm" className={cn(TOUCH, 'mt-2')} onClick={person.reload}>
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

  const current = person.state.value
  const shown = suggestions.items.slice(0, MAX_SUGGESTIONS)

  async function confirmMerge(source: Person) {
    try {
      const merged = await mergePersons(current.id, { sourceIds: [source.id] })
      person.apply(merged)
      suggestions.settle(merged, [source.id])
      onMerged()
      return null
    } catch (err) {
      return err instanceof ApiError
        ? `${err.message}（requestId：${err.requestId}）`
        : '合并失败，请求没能发出去'
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Bar>
        {/* 名字可改。`null` 是「未命名」，输入框留空即回到未命名（§6.7.4） */}
        <NameField person={current} onSaved={person.apply} />

        {/* 封面是这一条里唯一说明「这是谁」的图形线索 */}
        <CoverThumb src={current.cover.thumbUrl} className="w-10 shrink-0 rounded-lg" />

        <span className="shrink-0 text-sm text-muted-foreground">{current.memeCount} 张</span>

        {/*
          隐藏只是「在人物列表里默认不出现」，不是删除（§6.7.4）：图还在、这个筛选照常
          能筛出它们。文案要说清这一点，否则那个开关看起来像「删掉这个人物」。
        */}
        <label className="flex min-h-11 shrink-0 items-center gap-2 text-sm pointer-fine:min-h-8">
          <Switch
            checked={current.isHidden}
            onCheckedChange={(on) => void hideToggle(current, on, person.apply)}
          />
          隐藏
        </label>

        <Button
          variant="ghost"
          size="icon"
          className={cn(TOUCH, 'shrink-0')}
          aria-label="取消人物筛选"
          onClick={onClear}
        >
          <X className="size-4" />
        </Button>
      </Bar>

      <SeriesField person={current} onSaved={person.apply} />

      {/*
        「可能是同一个」。**空着就整段不出现**——一个写着「暂时没有可合并的」的空框
        在每一次按人物筛时都占一行高度，而它绝大多数时候都是空的。
      */}
      {shown.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">可能是同一个</p>
          <div className="flex flex-wrap gap-3">
            {shown.map((other) => (
              <div key={other.id} className="flex w-28 flex-col gap-1">
                <button
                  type="button"
                  className="rounded-2xl text-left outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  // 点封面 = 切到那个人物去看（不是合并）。合并要按下面那个「合并」，
                  // 因为它不可撤销，不该藏在一个「看起来像查看」的动作后面。
                  onClick={() => onPickOther(other.id)}
                >
                  <CoverThumb src={other.cover.thumbUrl} alt={other.name ?? '未命名的人物'} />
                  <span
                    className={cn(
                      'mt-1 block truncate px-1 text-xs',
                      other.name === null && 'text-muted-foreground italic',
                    )}
                  >
                    {other.name ?? '未命名'}
                  </span>
                  <span className="block px-1 text-xs text-muted-foreground">{other.memeCount} 张</span>
                </button>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(TOUCH, 'flex-1 px-2')}
                    onClick={() => setPendingMerge(other)}
                  >
                    合并
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(TOUCH, 'flex-1 px-2')}
                    onClick={() => void rejectOne(current.id, other, suggestions.drop)}
                  >
                    不是同一个
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <MergeConfirm
        target={current}
        source={pendingMerge}
        onCancel={() => setPendingMerge(null)}
        onConfirm={confirmMerge}
      />
    </div>
  )
}

/**
 * 合并的确认框。**必须写明不可撤销与涉及的图数**（§5.1 第 7 条、任务 §2 第 2 条）。
 *
 * 这两件事都不是客套：合错了的出路是把图逐张移出来（没有撤销），而「这次动了多少」
 * 是用户判断要不要按下去的唯一依据。目标是谁也写在标题里——留谁的名字由它决定。
 */
function MergeConfirm({
  target,
  source,
  onCancel,
  onConfirm,
}: {
  target: Person
  source: Person | null
  onCancel: () => void
  onConfirm: (source: Person) => Promise<string | null>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 换了来源就把上一次的失败清掉，免得它挂在下一个确认框里
  useEffect(() => setError(null), [source])

  if (source === null) return null

  const total = target.memeCount + source.memeCount

  return (
    <AlertDialog open onOpenChange={(next) => !next && !busy && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>把这两组并成一个人物？</AlertDialogTitle>
          <AlertDialogDescription>
            {'合并后留下的是'}
            <strong>{target.name ?? '未命名'}</strong>
            {'，'}
            {source.name ?? '未命名'}
            {'会消失，它名下的图都归到这边来。'}
            <br />
            {'两组一共 '}
            <strong>{total}</strong>
            {' 张图。'}
            <br />
            {/* 「不可撤销」是这一段里唯一必须逐字存在的话（任务 §2 第 2 条） */}
            <strong>这一步不可撤销。</strong>
            {'合错了只能把图一张张移出来。'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          {/* 默认焦点在「取消」上（AlertDialogContent 自带）：不可撤销的动作不该被一次回车触发 */}
          <AlertDialogCancel className={TOUCH} disabled={busy}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            className={TOUCH}
            disabled={busy}
            onClick={(e) => {
              // 要等请求落定才关：中途关掉的话，失败原因没地方显示
              e.preventDefault()
              setBusy(true)
              void onConfirm(source)
                .then((message) => {
                  if (message === null) onCancel()
                  else setError(message)
                })
                .finally(() => setBusy(false))
            }}
          >
            {busy ? '合并中…' : '确认合并'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** 一行通用的壳：结果列顶上那一条。窄屏允许换行，`min-w-0` 让长名字截断而不是撑破。 */
function Bar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-muted/30 px-3 py-2">
      {children}
    </div>
  )
}

/**
 * 名字就地编辑。提交时机是 **Enter 或失焦**，不是每敲一个字。
 *
 * ⚠️ **留空提交 = 回到未命名**（`name: null`），不是「不改」。这与「没动过这个字段」
 *    是两件事，靠 `dirty` 区分：没动过就一个请求都不发。
 */
function NameField({ person, onSaved }: { person: Person; onSaved: (next: Person) => void }) {
  const [draft, setDraft] = useState(person.name ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 服务端换了名字（合并、别人的改动）就跟着走。只在没有未提交的改动时覆盖，
  // 否则用户打了一半的字会被一次后台刷新吃掉。
  const dirty = draft !== (person.name ?? '')
  useEffect(() => {
    setDraft(person.name ?? '')
  }, [person.id, person.name])

  async function commit() {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      const trimmed = draft.trim()
      onSaved(await patchPerson(person.id, { name: trimmed === '' ? null : trimmed }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '改名失败')
      setDraft(person.name ?? '')
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
          // Esc 放弃改动：不还原的话它会一直挂在那儿，而失焦时才提交
          if (e.key === 'Escape') setDraft(person.name ?? '')
        }}
        placeholder="未命名"
        aria-label="这个人物叫什么"
        disabled={saving}
        className={cn(TOUCH, 'min-w-0')}
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  )
}

/**
 * 所属系列。**一个人物至多属于一个系列**（§5.7），所以这是一个单选，不是多选。
 *
 * ⚠️ 选项来自 `GET /series` 的**第一页**（`limit: 100`）。第一页装不下这个系列时，
 *    当前这一个会被手动补进选项里——不补的话 `Select` 的 `value` 指向一个不存在的
 *    选项，触发器会显示成空白，看起来像「不属于任何系列」，而那是错的。
 */
function SeriesField({ person, onSaved }: { person: Person; onSaved: (next: Person) => void }) {
  const [options, setOptions] = useState<{ id: string; name: string }[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchSeries({ limit: 100 })
      .then((page) => {
        if (alive) setOptions(page.items.map((s) => ({ id: s.id, name: s.name })))
      })
      .catch(() => {
        // 拉不到就只留「不属于任何系列」+ 当前那一个。**不报错**：这个下拉的默认态
        // 仍然是可用的（能取消归属），为一个附加功能挂横幅不划算。
        if (alive) setOptions([])
      })
    return () => {
      alive = false
    }
  }, [])

  const current = person.seriesId === null ? null : { id: person.seriesId, name: person.seriesName ?? '（读不到名字）' }
  const all = current !== null && !options.some((o) => o.id === current.id) ? [current, ...options] : options

  async function pick(value: string) {
    const nextId = value === '' ? null : value
    if (nextId === person.seriesId || saving) return
    setSaving(true)
    setError(null)
    try {
      onSaved(await patchPerson(person.id, { seriesId: nextId }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '改系列失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="shrink-0 text-sm text-muted-foreground">所属系列</span>
      <Select value={person.seriesId ?? ''} onValueChange={(v) => void pick(v)} disabled={saving}>
        <SelectTrigger size="sm" aria-label="所属系列" className={cn(TOUCH, 'min-w-40 flex-1')}>
          {/* 空串选项必须有 `placeholder`，否则触发器整片空白（理由见 BrowseFilters） */}
          <SelectValue placeholder="不属于任何系列" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="" className={TOUCH}>
            不属于任何系列
          </SelectItem>
          {all.map((option) => (
            <SelectItem key={option.id} value={option.id} className={TOUCH}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

/** 隐藏 / 取消隐藏。**只是「在人物列表里默认不出现」——图还在，筛选照常**。 */
async function hideToggle(person: Person, on: boolean, onSaved: (next: Person) => void) {
  try {
    onSaved(await patchPerson(person.id, { isHidden: on }))
  } catch {
    /*
      失败不弹错：这个开关是**受控**的（`checked` 读的一直是服务端那一份），
      请求失败时它自己会跳回去，看起来与「没点中」一样。
      弹一条 toast 在这里价值不大——用户立刻能看到开关没变，而真正的失败原因
      （403 之类）在人物列表那一层更容易看懂（那里有整块的地方说）。
    */
  }
}

/**
 * 「不是同一个」。**幂等**（§6.7.4），所以双击、重试都不该报错。
 *
 * ⚠️ 两个 id 的**位置不能弄反**：路径上的是当前人物，`otherId` 才是被否掉的那一个。
 *    反了的话记录的是「另一个人物与当前人物不是同一个」——而这一对本来就会被合并
 *    建议读到，方向反了等于把那条建议从**两边的**列表里都删掉，只是恰好也能用。
 */
async function rejectOne(personId: string, other: Person, drop: (id: string) => void) {
  try {
    await rejectPerson(personId, { otherId: other.id })
    drop(other.id)
  } catch {
    // 失败就不动界面。**不做乐观更新再回滚**——回滚会让那一格闪一下再回来，
    // 而这一格本来就不该消失得那么肯定。
  }
}
