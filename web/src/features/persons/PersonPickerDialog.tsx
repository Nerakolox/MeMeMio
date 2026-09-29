import { useState, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { createSeries, fetchPersons, fetchSeries } from '../../lib/api-persons'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Switch } from '../../components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { EmptyCells, PersonCell, SeriesCell } from './Cells'
import { usePagedList } from './use-paged-list'

/**
 * 「按人物 / 系列浏览」的居中大 modal（任务 §2 第 8 条、§5.2）。
 *
 * ## 只挂一份，由 `routes/browse.tsx` 持有
 *
 * 桌面筛选列与手机抽屉**都渲染 `BrowseFilters`**（`BrowseFilterSheet` 是一层壳），
 * modal 若长在那个组件里就会挂两个 Radix 对话框——先例与后果写在
 * `components/ImageViewer.tsx` 的文件头。所以开合状态在路由那层，按钮只负责回调。
 *
 * ## 默认 `minCount=2`
 *
 * SPEC §6.7.3 **没有服务端默认值**（不传 = 全返，任务 §10.6.3），所以「默认隐藏只有一张的」
 * 是**这一端的**默认值，由这里显式传 `minCount: 2` 实现。不给的话第一次打开会铺满
 * 只有一张图的碎片人物，而那些正是最需要被合并掉的一批。
 *
 * ## 不开新窗口、不记历史
 *
 * 开合是**纯 UI state**（state-navigation.md §3 第一类）。点一格 = 加筛选 + 关 modal，
 * 加筛选那一步走 `setString`（`replace`），不占历史——「点进去再点回来」不该让用户
 * 按三次返回才回到上一页。
 */

/** 名字过滤与「已隐藏」之外，剩下两个开关。它们都是**这一端**的默认，不是契约。 */
const DEFAULT_MIN_COUNT = 2
const ALL_MIN_COUNT = 1

type Tab = 'persons' | 'series'

export function PersonPickerDialog({
  open,
  onOpenChange,
  onPickPerson,
  onPickSeries,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPickPerson: (id: string) => void
  onPickSeries: (id: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        内容只在打开时挂载（Radix 不 forceMount），所以里面的取数与搜索词每次开都是新的
        ——「上次搜到一半的词」不该在下次打开时还留着，那会让人以为库里就这么多人。

        `grid-rows-[auto_minmax(0,1fr)]` 是这一层的全部机关：第一行是标题（按内容高），
        第二行是内容区（吃掉剩下的高、**可以矮过内容**，`minmax(0,…)` 那个 0 就是
        「允许被压缩」）。没有它的话内容区按内容高排，`max-h` 一压，滚的不是列表而是
        整个对话框——标题和底部的开关会跟着滚走。`max-h` 用 `svh`：移动端浏览器 UI
        收起时 `vh` 会把底部推出屏幕（styling.md）。
      */}
      <DialogContent className="grid max-h-[85svh] w-full max-w-3xl grid-rows-[auto_minmax(0,1fr)] gap-4">
        <DialogHeader>
          <DialogTitle>按人物浏览</DialogTitle>
          <DialogDescription>
            图入库之后会自动按人物归类，够两张才会出现在这里。系列是你自己挑人物组成的。
          </DialogDescription>
        </DialogHeader>
        <PickerBody onPickPerson={onPickPerson} onPickSeries={onPickSeries} />
      </DialogContent>
    </Dialog>
  )
}

function PickerBody({
  onPickPerson,
  onPickSeries,
}: {
  onPickPerson: (id: string) => void
  onPickSeries: (id: string) => void
}) {
  const [tab, setTab] = useState<Tab>('persons')
  /** 名字过滤。**两个 tab 共用一个词**——用户心里想的是「叫这个名字的东西」，不分 tab。 */
  const [q, setQ] = useState('')
  /** 关掉它就回到「只看两张以上的」（`DEFAULT_MIN_COUNT`）。 */
  const [showSingles, setShowSingles] = useState(false)
  /** 「已隐藏」是**另一个视图**而不是一个开关：`hidden=true` 时只看隐藏的，不是「也看隐藏的」。 */
  const [hiddenOnly, setHiddenOnly] = useState(false)

  const minCount = showSingles ? ALL_MIN_COUNT : DEFAULT_MIN_COUNT

  const persons = usePagedList(
    (cursor) => fetchPersons({ q, minCount, hidden: hiddenOnly || undefined, cursor }),
    `${q}|${minCount}|${hiddenOnly}`,
  )
  const series = usePagedList((cursor) => fetchSeries({ q, cursor }), q)

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as Tab)}
      className="flex min-h-0 flex-col gap-3"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {/*
          `pointer-coarse:h-auto!` 不能省：注册表把 `TabsList` 钉死在 `h-9`（36px），
          低于 44 的触摸目标（styling.md）。给高之后触发器那行的 `h-[calc(100%-1px)]`
          跟着长——它本来就是按父高算的，不用另给。
        */}
        <TabsList className="pointer-coarse:h-auto!">
          <TabsTrigger value="persons" className="pointer-coarse:min-h-11">
            人物
          </TabsTrigger>
          <TabsTrigger value="series" className="pointer-coarse:min-h-11">
            系列
          </TabsTrigger>
        </TabsList>

        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          // 不给 `type="search"`：它会带上浏览器自己的清除按钮，那个按钮只有 16px、
          // 又不受我们控制（44 触摸目标的例外只有浮层按钮，见 touch.ts 的文件头）
          placeholder={tab === 'persons' ? '按名字找人物' : '按名字找系列'}
          aria-label={tab === 'persons' ? '按名字找人物' : '按名字找系列'}
          className={cn(TOUCH, 'min-w-0 flex-1')}
        />
      </div>

      <TabsContent
        value="persons"
        // `min-h-0` 让它在 flex 列里可以被压缩，`flex-1` 吃掉剩余高度，滚动才落在这里
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <CellGrid
          loading={persons.loading}
          initialDone={persons.initialDone}
          error={persons.error}
          count={persons.items.length}
          onRetry={persons.retry}
          emptyText={personsEmptyText({ q, hiddenOnly, showSingles })}
        >
          {persons.items.map((person) => (
            <PersonCell key={person.id} person={person} onClick={() => onPickPerson(person.id)} />
          ))}
        </CellGrid>
        <Sentinel list={persons} />
      </TabsContent>

      <TabsContent
        value="series"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <CellGrid
          loading={series.loading}
          initialDone={series.initialDone}
          error={series.error}
          count={series.items.length}
          onRetry={series.retry}
          emptyText={q.trim() ? '没有叫这个名字的系列' : '还没有系列'}
        >
          {series.items.map((item) => (
            <SeriesCell key={item.id} series={item} onClick={() => onPickSeries(item.id)} />
          ))}
        </CellGrid>
        <Sentinel list={series} />
      </TabsContent>

      {/*
        底部那一条：两个 tab 各自的东西。**放在滚动区外面**（是 Tabs 的兄弟而不是
        TabsContent 的孩子），否则滚到底才看得见「也显示只有一张的」——而它正是
        用户面对一屏碎片人物时要找的那个开关。
      */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t pt-3">
        {tab === 'persons' ? (
          <>
            {/*
              整行是 label 包住 Switch，与 `BrowseFilters` 的两个开关同一套写法：
              点文字由浏览器把点击转发给 Radix 的 Switch。不写 `htmlFor` + id——
              这一份内容在窄屏抽屉与桌面列里都在 DOM 里，id 必然撞。
            */}
            <label className="flex min-h-11 flex-1 items-center gap-2 text-sm pointer-fine:min-h-8">
              <Switch checked={showSingles} onCheckedChange={setShowSingles} />
              也显示只有一张的
            </label>
            <Button
              type="button"
              variant={hiddenOnly ? 'secondary' : 'ghost'}
              className={TOUCH}
              aria-pressed={hiddenOnly}
              onClick={() => setHiddenOnly((v) => !v)}
            >
              {hiddenOnly ? '返回全部人物' : '已隐藏'}
            </Button>
          </>
        ) : (
          <NewSeriesForm
            onCreated={() => {
              // 库里多了一个系列，就地把列表重拉一次。**不做「建完自动切过去」**：
              // 刚建好的系列是空的（§6.7.3），切过去只会看到一屏空白，
              // 而用户的下一步本来就是从「人物」那一边挑人过来。
              series.reload()
              setTab('series')
            }}
          />
        )}
      </div>
    </Tabs>
  )
}

/**
 * 空态的三句话（`CellGrid` 只在 `count === 0` 时用）。
 *
 * 三种成因给出路完全不同的三句话：词没匹配上要改词、已隐藏里没有要退回去、
 * 门槛挡住了要放开门槛。一句「没有数据」打发的话，用户只会以为这个功能是空的
 * ——而第一种情况下它明明是好的。
 */
function personsEmptyText({
  q,
  hiddenOnly,
  showSingles,
}: {
  q: string
  hiddenOnly: boolean
  showSingles: boolean
}): string {
  if (q.trim()) {
    return hiddenOnly ? '已隐藏里没有叫这个名字的人物' : '没有叫这个名字的人物'
  }
  if (hiddenOnly) return '没有已隐藏的人物'
  if (!showSingles) return '还没有够两张的人物。只有一张的碎片人物默认收起来了，可以在下面打开。'
  return '还没有识别出人物。图入库后会按人物自动归类，所以先导入几张。'
}

/**
 * 滚动加载的观察点。
 *
 * ⚠️ `h-px` 不能写成 0 高：`threshold: 0.1` 对**零面积**元素永远不触发，而且不报错，
 *    表现是「滚到底不再加载」（`use-browse-list` 的 sentinel 是同一条）。
 */
function Sentinel({
  list,
}: {
  list: Pick<ReturnType<typeof usePagedList<never>>, 'sentinelRef' | 'loading' | 'initialDone'>
}) {
  return (
    <>
      <div ref={list.sentinelRef} className="mt-4 h-px" aria-hidden="true" />
      {list.loading && list.initialDone && (
        <p className="py-3 text-center text-sm text-muted-foreground">加载中…</p>
      )}
      {/*
        到底了就不说话。**不写「没有更多了」**：这是一个可以刷新的浏览面，
        而且 `nextCursor` 只说明「这一刻取完了」（§6.7.3 不做快照）。
      */}
    </>
  )
}

/**
 * 格子的网格 + 三态。**空态只在第一页回来过之后渲染**，否则每次打开 modal 都会先闪
 * 一下「还没有识别出人物」。
 */
function CellGrid({
  loading,
  initialDone,
  error,
  count,
  emptyText,
  onRetry,
  children,
}: {
  loading: boolean
  initialDone: boolean
  error: ApiError | null
  count: number
  emptyText: string
  onRetry: () => void
  children: ReactNode
}) {
  if (error) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>加载失败</AlertTitle>
        <AlertDescription>
          <p>{error.message}</p>
          {/* requestId 要露出来，报问题时它是唯一能对上服务端日志的东西（http.md §3） */}
          <p className="font-mono text-xs">requestId: {error.requestId}</p>
          <Button variant="outline" size="sm" className={cn(TOUCH, 'mt-2')} onClick={onRetry}>
            重试
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (!initialDone && loading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>
  }
  if (count === 0) return <EmptyCells text={emptyText} />

  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">{children}</div>
}

/**
 * 新建系列。**长在 modal 里而不是另开一个对话框**：嵌套模态（抽屉里的对话框、对话框里的
 * 对话框）在 Radix 里是能跑，但焦点顺序与 Esc 的归属会变成「按下去关掉的是哪一层」
 * 这种要靠试才知道的问题——而这里只需要一行输入。
 *
 * ⚠️ **同名是 `CONFLICT`（409）**，要**就地**说「这个名字已经有了」（§6.7.4），
 *    不是弹一条通用错误：用户要做的是换一个名字，而通用错误里没有这句话。
 */
function NewSeriesForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function close() {
    setOpen(false)
    setName('')
    setError(null)
  }

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      await createSeries({ name: trimmed })
      close()
      onCreated()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === 'CONFLICT'
            ? '这个名字已经有了，换一个。'
            : `${err.message}（requestId：${err.requestId}）`
          : '创建失败，请求没能发出去',
      )
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" className={TOUCH} onClick={() => setOpen(true)}>
        新建系列
      </Button>
    )
  }

  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="系列名，比如「某部作品」"
          aria-label="新系列的名字"
          className={cn(TOUCH, 'min-w-0 flex-1')}
          autoFocus
        />
        <Button type="submit" className={TOUCH} disabled={busy || name.trim() === ''}>
          {busy ? '创建中…' : '创建'}
        </Button>
        <Button type="button" variant="ghost" className={TOUCH} onClick={close} disabled={busy}>
          取消
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
