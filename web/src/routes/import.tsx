import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useImport } from '../contexts/import'
import { FilePicker } from '../features/import/FilePicker'
import { ImportProgress } from '../features/import/ImportProgress'
import { ReviewQueue } from '../features/import/ReviewQueue'
import { TagStatusView } from '../features/tagging/TagStatusView'
import { fetchTagStatus } from '../lib/api'
import { fetchReviews } from '../lib/api-imports'

type Tab = 'upload' | 'review' | 'tag'

/**
 * `/import`。只做布局与三个页签的切换，具体 UI 在 `features/import/` 与 `features/tagging/`。
 *
 * 页签放 URL（`?tab=review`）不放组件 state——理由和搜索词一样：
 * 用户会把链接发给别人，而且「去看待确认」「去看打标」这两个动作值得被直接链接到
 * （state-navigation.md §1、import-ux.md §4）。
 */
export function ImportPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: Tab = tabParam === 'review' ? 'review' : tabParam === 'tag' ? 'tag' : 'upload'
  const queue = useImport()

  /** 待确认队列的条数，用来在「查看待确认」入口上显示数字。 */
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
    <div className="import">
      <nav className="import__tabs">
        <button
          type="button"
          className={`import__tab${tab === 'upload' ? ' import__tab--active' : ''}`}
          aria-current={tab === 'upload'}
          onClick={() => setTab('upload')}
        >
          导入
        </button>
        <button
          type="button"
          className={`import__tab${tab === 'review' ? ' import__tab--active' : ''}`}
          aria-current={tab === 'review'}
          onClick={() => setTab('review')}
        >
          待确认{reviewCount ? `（${reviewCount}）` : ''}
        </button>
        <button
          type="button"
          className={`import__tab${tab === 'tag' ? ' import__tab--active' : ''}`}
          aria-current={tab === 'tag'}
          onClick={() => setTab('tag')}
        >
          打标{needsManualCount ? `（${needsManualCount}）` : ''}
        </button>
      </nav>

      {tab === 'upload' && (
        <>
          {/* 导入期间队列在应用级活着，切走再回来还在（contexts/import.tsx） */}
          {queue.phase === 'idle' ? (
            <FilePicker
              onStart={queue.start}
              disabled={false}
              disabledReason={undefined}
            />
          ) : (
            <ImportProgress
              queue={queue}
              onReset={queue.reset}
              onOpenReview={() => setTab('review')}
              onOpenTagging={() => setTab('tag')}
              needsReviewCount={queue.done?.needsReview ?? reviewCount ?? 0}
            />
          )}
        </>
      )}

      {tab === 'review' && <ReviewQueue onCountChange={setReviewCount} />}

      {tab === 'tag' && <TagStatusView />}
    </div>
  )
}
