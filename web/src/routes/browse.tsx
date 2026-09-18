import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  type Meme,
  type FetchMemesParams,
  fetchMemes,
  toggleFavorite,
  deleteMeme,
  ApiError,
} from '../lib/api'
import { sendMeme, sendNote, type SendTarget } from '../lib/clipboard'
import { useAuth } from '../contexts/auth'
import { MemeCard } from '../components/MemeCard'
import { MemeActions } from '../features/manage/MemeActions'
import { MemeEditPanel } from '../features/manage/MemeEditPanel'
import { TAG_STATUS_LABELS } from '../lib/tag-status'
import { emotionOptions, sceneOptions, tagOptions } from '../lib/vocab'

/** 操作反馈：复制/下载的结果、删除失败等。一条就够，不堆历史。 */
type Note = { text: string; error?: boolean; requestId?: string }

/** 把当前 URL query string 解析为接口参数，游标在外部传入，不放 URL（SPEC §6.3.2）。 */
function buildParams(sp: URLSearchParams): FetchMemesParams {
  const p: FetchMemesParams = {}
  const emotions = sp.getAll('emotions')
  if (emotions.length) p.emotions = emotions
  const scenes = sp.getAll('scenes')
  if (scenes.length) p.scenes = scenes
  const tags = sp.getAll('tags')
  if (tags.length) p.tags = tags
  const ia = sp.get('isAnimated')
  if (ia !== null) p.isAnimated = ia === 'true'
  if (sp.get('favorited') === 'true') p.favorited = true
  const upl = sp.get('uploader')
  if (upl) p.uploader = upl
  const ts = sp.get('tagStatus')
  if (ts) p.tagStatus = ts
  return p
}

export function BrowsePage() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [items, setItems] = useState<Meme[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [initialDone, setInitialDone] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  /**
   * 打开编辑侧边栏的那条**只存 id**，面板再从列表里取当前那一条。
   *
   * 存整个对象会变成一份影子副本：保存成功后列表里换了新的，而面板还指着旧的
   * （state-navigation.md §2「不维护第二份可编辑副本」）。
   */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)

  const editingMeme = editingId === null ? null : (items.find((m) => m.id === editingId) ?? null)

  // Changes only when filter params change — used as dep key for effects below
  const filtersKey = searchParams.toString()

  async function doLoad(params: FetchMemesParams, cursor?: string) {
    setLoading(true)
    setError(null)
    try {
      const page = await fetchMemes({ ...params, cursor })
      setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
      setNextCursor(page.nextCursor)
      if (!cursor) setInitialDone(true)
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setLoading(false)
    }
  }
  // Reset and reload when filter params change
  useEffect(() => {
    setItems([])
    setNextCursor(null)
    setInitialDone(false)
    doLoad(buildParams(searchParams))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey])

  // Infinite scroll: observe the sentinel div and load the next page
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loading && nextCursor) {
          doLoad(buildParams(searchParams), nextCursor)
        }
      },
      { threshold: 0.1 },
    )
    obs.observe(el)
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, nextCursor, filtersKey])

  // --- filter helpers ---

  function toggleMultiParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    const existing = next.getAll(key)
    if (existing.includes(value)) {
      next.delete(key)
      existing.filter((v) => v !== value).forEach((v) => next.append(key, v))
    } else {
      next.append(key, value)
    }
    setSearchParams(next, { replace: true })
  }

  function toggleBoolParam(key: string) {
    const next = new URLSearchParams(searchParams)
    if (next.get(key) === 'true') next.delete(key)
    else next.set(key, 'true')
    setSearchParams(next, { replace: true })
  }

  function setStringParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    setSearchParams(next, { replace: true })
  }

  function clearFilters() {
    setSearchParams(new URLSearchParams(), { replace: true })
  }

  // tagStatus is shown only to admin or when filtering own uploads (SPEC §6.3.2 + §3.3)
  const canUseTagStatus =
    user?.role === 'admin' || searchParams.get('uploader') === 'me'

  const activeEmotions = searchParams.getAll('emotions')
  const activeScenes = searchParams.getAll('scenes')
  const activeTags = searchParams.getAll('tags')

  // --- handle favorite toggle with optimistic update (SPEC §5.4) ---
  async function handleFavorite(meme: Meme) {
    const next = !meme.favorited
    // optimistic: flip immediately
    setItems((prev) => prev.map((m) => (m.id === meme.id ? { ...m, favorited: next } : m)))
    try {
      await toggleFavorite(meme.id, next)
    } catch {
      // rollback
      setItems((prev) => prev.map((m) => (m.id === meme.id ? { ...m, favorited: !next } : m)))
    }
  }

  // --- 图片操作：复制 / 下载 / 编辑 / 删除 ---

  /**
   * 发送这张图。路径由 `lib/clipboard.ts` 按 `isAnimated` 和能力探测决定，
   * 菜单上的文案也是它给的——**同一个动作在首页和浏览页不能有两套行为**
   * （clipboard-share.md §3，那一节把这件事列为本端最不能犯的错）。
   *
   * ⚠️ 这个函数由点击事件直接调起，中间不要先 await 别的请求：
   * 剪贴板写入要落在用户手势的同步调用栈里，否则 Safari 会拒（§4.1）。
   */
  async function handleSend(target: SendTarget) {
    setNote(null)
    const text = sendNote(await sendMeme(target))
    if (text !== null) setNote({ text })
  }

  function closeEditor() {
    const id = editingId
    setEditingId(null)
    // 面板是覆盖层，关掉之后焦点不能掉在地上（body），交回给打开它的那个「⋯」。
    // 和搜索页用 [data-index] 找回卡片是同一种做法。
    if (id !== null) {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-actions-for="${id}"] button`)?.focus()
      })
    }
  }

  /**
   * 编辑保存成功后就地换掉列表里那一条——响应就是新的完整 Meme，**不再拉一次**
   * （SPEC §6.4.1）。
   */
  function handleSaved(updated: Meme) {
    setItems((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
    setNote({ text: '已保存' })
  }

  async function handleDelete(meme: Meme) {
    setDeletingId(meme.id)
    setNote(null)
    try {
      // 404 在 deleteMeme 里已经当成功处理（SPEC §6.4.2）：那张图本来就要消失
      await deleteMeme(meme.id)
      setItems((prev) => prev.filter((m) => m.id !== meme.id))
      if (editingId === meme.id) setEditingId(null)
      setNote({ text: '已删除' })
    } catch (err) {
      // 服务端仍是唯一权威：前端禁用只是体验，403 / FORBIDDEN 要能显示出来（SPEC §6.4.2）
      const apiErr = err instanceof ApiError ? err : null
      setNote({
        text: `删除失败：${apiErr?.message ?? '请稍后重试'}`,
        error: true,
        requestId: apiErr?.requestId ?? '未知',
      })
    } finally {
      setDeletingId(null)
    }
  }

  const hasFilters = searchParams.toString() !== ''

  return (
    <div className="browse">
      {/* ---- sidebar filter panel ---- */}
      <aside className="browse__sidebar">
        <div className="browse__filter-group">
          <div className="browse__filter-header">
            <span>筛选</span>
            {hasFilters && (
              <button className="browse__clear-btn" onClick={clearFilters}>
                清除
              </button>
            )}
          </div>

          <label className="browse__filter-label">
            <input
              type="checkbox"
              checked={searchParams.get('isAnimated') === 'true'}
              onChange={() => toggleBoolParam('isAnimated')}
            />
            只看动图
          </label>

          <label className="browse__filter-label">
            <input
              type="checkbox"
              checked={searchParams.get('favorited') === 'true'}
              onChange={() => toggleBoolParam('favorited')}
            />
            只看收藏
          </label>

          <div className="browse__filter-row">
            <span>上传者</span>
            <select
              value={searchParams.get('uploader') ?? ''}
              onChange={(e) => setStringParam('uploader', e.target.value || null)}
            >
              <option value="">全部</option>
              <option value="me">只看我的</option>
            </select>
          </div>

          {canUseTagStatus && (
            <div className="browse__filter-row">
              <span>标注状态</span>
              <select
                value={searchParams.get('tagStatus') ?? ''}
                onChange={(e) => setStringParam('tagStatus', e.target.value || null)}
              >
                <option value="">全部</option>
                {/* 值与文案都取自 tag-status.ts 那一份表：选项顺序就是表里的顺序。
                    枚举直出英文会让用户对着一堆 tag_status 猜自己该选哪个。 */}
                {Object.entries(TAG_STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <FilterGroup
          title="情绪"
          options={emotionOptions}
          active={activeEmotions}
          onToggle={(v) => toggleMultiParam('emotions', v)}
        />
        <FilterGroup
          title="场景"
          options={sceneOptions}
          active={activeScenes}
          onToggle={(v) => toggleMultiParam('scenes', v)}
        />
        <FilterGroup
          title="标签"
          options={tagOptions}
          active={activeTags}
          onToggle={(v) => toggleMultiParam('tags', v)}
        />
      </aside>

      {/* ---- main grid ---- */}
      <div className="browse__content">
        {!initialDone && loading && (
          <div className="browse__grid">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="meme-card meme-card--skeleton" aria-hidden="true" />
            ))}
          </div>
        )}

        {initialDone && items.length === 0 && !loading && !error && (
          <p className="browse__empty">没有符合条件的图片</p>
        )}

        {error && (
          <div className="browse__error" role="alert">
            <p>加载失败：{error.message}</p>
            <p className="browse__request-id">requestId: {error.requestId}</p>
            <button onClick={() => doLoad(buildParams(searchParams))}>重试</button>
          </div>
        )}

        {/* 复制 / 下载的结果在这里说一句：剪贴板是不可见的，**没有反馈的复制等于没复制**
            （clipboard-share.md §4.1）。 */}
        {note !== null && (
          <p className={`browse__note${note.error === true ? ' browse__note--error' : ''}`} role={note.error === true ? 'alert' : 'status'}>
            {note.text}
            {note.requestId !== undefined && (
              <span className="browse__request-id">requestId: {note.requestId}</span>
            )}
          </p>
        )}

        {items.length > 0 && (
          <div className="browse__grid">
            {items.map((meme) => (
              <MemeCard
                key={meme.id}
                meme={meme}
                onFavorite={handleFavorite}
                actions={
                  <MemeActions
                    target={meme}
                    // 编辑对所有人开放，删除只限上传者与 admin（SPEC §6.4 / §9.1）。
                    // 前端判断只是体验，服务端仍会独立判一次。
                    canDelete={user?.role === 'admin' || meme.uploaderId === user?.id}
                    deleteDeniedReason="只有上传这张图的人或管理员可以删除"
                    busy={deletingId === meme.id}
                    onSend={(t) => void handleSend(t)}
                    onEdit={() => setEditingId(meme.id)}
                    onDelete={() => void handleDelete(meme)}
                  />
                }
              />
            ))}
          </div>
        )}

        {/* sentinel — observed for infinite scroll */}
        <div ref={sentinelRef} className="browse__sentinel" aria-hidden="true" />

        {loading && initialDone && (
          <p className="browse__loading">加载中…</p>
        )}
      </div>

      {/*
        编辑侧边栏。key 用 meme.id：换一张图时组件要重挂，草稿才有正确的初始值——
        同一个组件实例上换 props 会让草稿停留在上一张图的标签上。
      */}
      {editingMeme !== null && (
        <MemeEditPanel
          key={editingMeme.id}
          meme={editingMeme}
          currentUserId={user?.id ?? null}
          onClose={closeEditor}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}

// ---- sub-components ----

function FilterGroup({
  title,
  options,
  active,
  onToggle,
}: {
  title: string
  options: string[]
  active: string[]
  onToggle: (v: string) => void
}) {
  return (
    <div className="browse__filter-group">
      <p className="browse__filter-section-title">{title}</p>
      <div className="browse__tag-list">
        {options.map((opt) => (
          <button
            key={opt}
            className={`browse__tag-btn${active.includes(opt) ? ' browse__tag-btn--active' : ''}`}
            onClick={() => onToggle(opt)}
            aria-pressed={active.includes(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )
}

