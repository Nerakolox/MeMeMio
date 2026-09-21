import { DiscoverWall } from '../features/discover/DiscoverWall'
import { SearchBar } from '../features/search/SearchBar'
import { SearchResults } from '../features/search/SearchResults'
import { useSearch } from '../features/search/use-search'

/**
 * 首页，搜索为主入口。
 *
 * **这一层只做布局**：状态机、键盘路径和发送都在 `features/search/`（2026-09-21 拆出去，
 * 在此之前这个文件 326 行，装着全部业务逻辑，`code-style.md` 的上限是 150）。
 *
 * 搜索词放 URL 不放组件 state——用户会把一次搜索的链接发给别人
 * （「你搜这个，第三张」），放 state 里就分享不了、刷新也丢（state-navigation.md §1）。
 * 这条规则本身在 `use-search.ts` 里落实。
 *
 * `max-w-6xl` 对齐设置页：**这里不是可有可无的装饰**。应用外壳只给 `p-6`，
 * 没有宽度约束时 2560px 屏上图墙是 5 列 × 每格约 460px 的大图——而 5 列是按小格子
 * 设计的（见 `DiscoverWall`），容器查询那两档也才真的是按图墙自己的宽度在分档。
 */
export function HomePage() {
  const {
    draft,
    setDraft,
    state,
    selectedIndex,
    copyNote,
    trimmedDraft,
    commit,
    retry,
    handleKeyDown,
    handleActivate,
    handleFavorite,
  } = useSearch()

  return (
    // 键盘路径（↑↓ 选择、Enter 发送、Esc 取消）挂在整页上：输入框和结果区都要走同一套
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-3"
      onKeyDown={handleKeyDown}
    >
      <SearchBar value={draft} onChange={setDraft} onSubmit={() => commit(draft)} />

      <SearchResults
        state={state}
        selectedIndex={selectedIndex}
        copyNote={copyNote}
        onActivate={handleActivate}
        onFavorite={handleFavorite}
        onRetry={retry}
      />

      {/*
        没有提交搜索词时，下半屏是随机图墙（SPEC §6.3.2 的 random）——
        「不知道要找什么」是最常见的开场，之前这个页面在这种时候只有一句提示。
        提交了搜索词就换成结果：两个列表不同时堆在一页上，否则没人知道该看哪个。
      */}
      {state.kind === 'idle' && (
        <>
          {/* 输入了但还没提交（还没回车、也没失焦）时才提示，正常情况下用户看的是图 */}
          {trimmedDraft && <p className="text-sm text-muted-foreground">按回车搜索</p>}
          <DiscoverWall />
        </>
      )}
    </section>
  )
}
