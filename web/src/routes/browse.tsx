import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Masonry, type RenderComponentProps } from 'masonic'
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
  const [note, setNote] = useState<Note | null>(null)

  /**
   * 瀑布流的「重挂代际」。删除会让 `items` 缩短，而 masonic 按 index 缓存位置，
   * items 缩短会错位甚至越界抛错，所以删除成功后 bump 一次、换 key 强制重挂，
   * 位置器从零重建。筛选切换走的是 `items → [] → 新 items`，中间那次空态已经把
   * `<Masonry>` 整个卸载了，不需要这里参与。
   */
  const [masonryEpoch, setMasonryEpoch] = useState(0)

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

  /**
   * 关掉编辑侧边栏。
   *
   * ⚠️ **这里的焦点交回是必须的，Radix 不会代劳**：侧边栏是受控打开、没有
   * `SheetTrigger`，而 `DialogContentModal` 的关闭逻辑是
   * `triggerRef.current?.focus()`——没有触发器就是 null，什么都不会做，焦点会掉在 body 上。
   * （`AlertDialog` 那条路同理，它的交回写在 `MemeActions` 自己里面。）
   *
   * 选择器带 `[data-actions-trigger]` 而不是随便挑一个 `button`：卡片上还有收藏按钮，
   * 挑错了就把焦点交给收藏，用户按回车会莫名其妙地取消收藏。
   *
   * 它可靠的前提是**侧边栏是模态的**（打开期间页面滚不动），那个 meme 的格子不会被
   * masonic 回收掉——格子还在，`querySelector` 才找得到。
   */
  function closeEditor() {
    const id = editingId
    setEditingId(null)
    if (id !== null) {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-actions-for="${id}"] [data-actions-trigger]`)
          ?.focus()
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

  /**
   * 删除一张图。**「删除中」那段反馈现在归 `MemeActions` 自己管**（它的确认框要等这个
   * Promise 落定才关），所以这里不再需要 `deletingId` 那种「告诉菜单谁在忙」的状态。
   *
   * 失败**不往外抛**：原因是页面顶部那条带 requestId 的提示（它得在图消失之后还看得见），
   * 弹层只负责等它落定。
   */
  async function handleDelete(meme: Meme) {
    setNote(null)
    try {
      // 404 在 deleteMeme 里已经当成功处理（SPEC §6.4.2）：那张图本来就要消失
      await deleteMeme(meme.id)
      setItems((prev) => prev.filter((m) => m.id !== meme.id))
      if (editingId === meme.id) setEditingId(null)
      setNote({ text: '已删除' })
      setMasonryEpoch((e) => e + 1)
    } catch (err) {
      // 服务端仍是唯一权威：前端禁用只是体验，403 / FORBIDDEN 要能显示出来（SPEC §6.4.2）
      const apiErr = err instanceof ApiError ? err : null
      setNote({
        text: `删除失败：${apiErr?.message ?? '请稍后重试'}`,
        error: true,
        requestId: apiErr?.requestId ?? '未知',
      })
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
              <div
                key={i}
                aria-hidden="true"
                className="aspect-square animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
              />
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
          <Masonry
            key={masonryEpoch}
            items={items.map((meme) => ({
              meme,
              favorite: () => handleFavorite(meme),
              send: (t: SendTarget) => void handleSend(t),
              edit: () => setEditingId(meme.id),
              remove: () => handleDelete(meme),
              // 编辑对所有人开放，删除只限上传者与 admin（SPEC §6.4 / §9.1）。
              // 前端判断只是体验，服务端仍会独立判一次。
              canDelete: user?.role === 'admin' || meme.uploaderId === user?.id,
            }))}
            columnWidth={160}
            columnGutter={12}
            overscanBy={3}
            itemHeightEstimate={220}
            itemKey={(item) => item.meme.id}
            render={BrowseMasonryCell}
          />
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

/**
 * 瀑布流单元格的载体：一条 meme + 页面注入的回调。
 *
 * 回调要跟着数据走，是因为 masonic 的 `render` 组件必须是**稳定引用**（模块级）——
 * 如果每次渲染都现写一个箭头函数，masonic 会把「render prop 换了新函数」当成换组件，
 * 所有可见卡片重挂，收藏、删除、编辑弹层这些交互的本地状态全被打断。
 * 所以把会变的回调放进 `data`（每帧重算没关系，key 是 meme.id，React 不会重挂）。
 *
 * 卡片本身（图片承载、角标、收藏按钮、比例占位）全在 `components/MemeCard.tsx`，
 * 四页共用；这一层只剩「瀑布流要的回调怎么接上去」。浏览页是四处里**唯一**带「⋯」的。
 */
type BrowseMasonryItem = {
  meme: Meme
  favorite: () => void
  send: (target: SendTarget) => void
  edit: () => void
  remove: () => Promise<void>
  canDelete: boolean
}

function BrowseMasonryCell({ data }: RenderComponentProps<BrowseMasonryItem>) {
  const { meme } = data

  return (
    <MemeCard
      // natural：按 width/height 整张展示、不裁方——表情包的信息常在边缘，
      // 裁掉之后用户认不出这是哪张（styling.md「图片网格」）。
      shape="natural"
      meme={meme}
      actions={
        /*
          「⋯」是浏览页唯一的删除 / 编辑 / 发送入口。它是绝对定位的浮层，不占布局，
          弹层因此能探出图片边界（菜单本身走 portal，更不受裁剪影响）。
        */
        <MemeActions
          target={meme}
          canDelete={data.canDelete}
          deleteDeniedReason="只有上传这张图的人或管理员可以删除"
          onSend={(t) => void data.send(t)}
          onEdit={data.edit}
          onDelete={data.remove}
        />
      }
      onFavorite={data.favorite}
    />
  )
}

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

