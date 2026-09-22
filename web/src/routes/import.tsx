import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Badge } from '../components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { useImport } from '../contexts/import'
import { FilePicker } from '../features/import/FilePicker'
import { ImportProgress } from '../features/import/ImportProgress'
import { ReviewQueue } from '../features/import/ReviewQueue'
import { TagStatusView } from '../features/tagging/TagStatusView'
import { fetchTagStatus } from '../lib/api'
import { fetchReviews } from '../lib/api-imports'
import { TOUCH } from '../lib/touch'

type Tab = 'upload' | 'review' | 'tag'

/**
 * `/import`。只做布局与三个页签的切换，具体 UI 在 `features/import/` 与 `features/tagging/`。
 *
 * 页签放 URL（`?tab=review`）不放组件 state——理由和搜索词一样：
 * 用户会把链接发给别人，而且「去看待确认」「去看打标」这两个动作值得被直接链接到
 * （state-navigation.md §1、import-ux.md §4）。所以 `Tabs` 是**受控**的：值由地址栏给，
 * `onValueChange` 只是把新值写回地址栏，`replace: true` 保证点页签不产生历史记录。
 *
 * ## 三个页签是 shadcn `Tabs`，但**受控源仍然是 URL**
 *
 * Radix 的 `Tabs` 自带键盘路径（左右方向键换页签、`role=tablist` / `aria-controls` 那套），
 * 这些正是原来那三个裸 `<button>` 缺的。它内部那份 state 不被使用——值从 `tab` 来，
 * 变化从 `setTab` 走，所以「地址栏是唯一真源」这条没有被组件库换掉。
 *
 * ⚠️ `TabsList` 的 `pointer-coarse:h-auto!` **不能省**：注册表给列表写死 `h-9`（36px）、
 * 给触发器写 `h-[calc(100%-1px)]`，而 44 的触摸目标要的是触发器自己撑起来。
 * 那个 `h-9` 带 `group-data-horizontal/tabs:` 变体、特异性更高，只有 `!` 压得住；
 * 少了它的表现是**手指那一档的触发器被 36px 的胶囊裁掉**（不报错，只是矮）。
 * 细指针那一档不写，列表仍是注册表自己的 36（`TOUCH` 里那半句 `pointer-fine:min-h-8`
 * 只把触发器收到 32，高度由列表的 `h-9` 决定）。
 */
export function ImportPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: Tab = tabParam === 'review' ? 'review' : tabParam === 'tag' ? 'tag' : 'upload'
  const queue = useImport()

  /** 待确认队列的条数，用来在「待确认」页签上显示数字。 */
  const [reviewCount, setReviewCount] = useState<number | null>(null)
  /**
   * 需人工的张数。**只数 `needs_manual`，不数 `pending`**：pending 是正常的中间态，
   * 给它挂个数字只会天天报警；而 `needs_manual` 是终局失败、不会自己好，
   * 没人知道有 7 张卡着就不会去看那个列表（SPEC §6.6）。
   */
  const [needsManualCount, setNeedsManualCount] = useState<number | null>(null)

  // 导入页自己拉一次计数：导入刚跑完时用户需要知道「有没有东西要看」，
  // 而不是先点进队列才发现是空的。不计入任何服务端数据副本，只存条数。
  useEffect(() => {
    let alive = true
    fetchReviews()
      .then((items) => {
        if (alive) setReviewCount(items.length)
      })
      .catch(() => {
        // 计数失败不影响导入本身，静默即可——用户点进页签会看到具体错误
        if (alive) setReviewCount(null)
      })
    return () => {
      alive = false
    }
  }, [])

  // 同理：打标页签上挂一个数，用户才知道有图卡着。取不到就不显示数字，
  // 不弹错误——真正的错误在页签里（summaryError）。
  useEffect(() => {
    let alive = true
    fetchTagStatus()
      .then((s) => {
        if (alive) setNeedsManualCount(s.counts.needsManual)
      })
      .catch(() => {
        if (alive) setNeedsManualCount(null)
      })
    return () => {
      alive = false
    }
  }, [])

  function setTab(next: Tab) {
    const p = new URLSearchParams(searchParams)
    if (next === 'upload') p.delete('tab')
    else p.set('tab', next)
    setSearchParams(p, { replace: true })
  }

  return (
    // `max-w-6xl` 对齐设置页与首页：外壳只给 `p-6`，这一页的待确认卡片是左右并排的，
    // 不加约束时在 2560px 上两张预览图会拉到一千多像素宽各一张。
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-4">
        <TabsList className="pointer-coarse:h-auto!">
          <TabsTrigger value="upload" className={TOUCH}>
            导入
          </TabsTrigger>
          <TabsTrigger value="review" className={TOUCH}>
            待确认
            {/* 数字为 0 时不显示——一个「待确认 0」的徽标只会让人多点一次进去确认它是空的 */}
            {reviewCount ? <CountBadge count={reviewCount} /> : null}
          </TabsTrigger>
          <TabsTrigger value="tag" className={TOUCH}>
            打标
            {needsManualCount ? <CountBadge count={needsManualCount} /> : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="upload">
          {/* 导入期间队列在应用级活着，切走再回来还在（contexts/import.tsx） */}
          {queue.phase === 'idle' ? (
            <FilePicker onStart={queue.start} disabled={false} disabledReason={undefined} />
          ) : (
            <ImportProgress
              queue={queue}
              onReset={queue.reset}
              onOpenReview={() => setTab('review')}
              onOpenTagging={() => setTab('tag')}
              needsReviewCount={queue.done?.needsReview ?? reviewCount ?? 0}
            />
          )}
        </TabsContent>

        <TabsContent value="review">
          <ReviewQueue onCountChange={setReviewCount} />
        </TabsContent>

        <TabsContent value="tag">
          <TagStatusView />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** 页签上的计数。数字本身是唯一的重点，所以用 `tabular-nums` 定宽，换值时不抖。 */
function CountBadge({ count }: { count: number }) {
  return (
    <Badge variant="secondary" className="tabular-nums">
      {count}
    </Badge>
  )
}
