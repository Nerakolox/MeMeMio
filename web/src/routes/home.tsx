import { CornerDownLeft } from 'lucide-react'
import { DiscoverWall } from '../features/discover/DiscoverWall'
import { SearchBar } from '../components/SearchBar'
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
    trimmedDraft,
    commit,
    retry,
    handleKeyDown,
    handleFavorite,
  } = useSearch()

  return (
    // 键盘路径（↑↓ 选择、Enter 打开全屏阅览、Esc 取消）挂在整页上：
    // 输入框和结果区都要走同一套
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-3"
      onKeyDown={handleKeyDown}
    >
      <SearchBar value={draft} onChange={setDraft} onSubmit={() => commit(draft)} />

      <SearchResults
        state={state}
        selectedIndex={selectedIndex}
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
          {/*
            输入了但还没提交（还没回车、也没失焦）时才提示，正常情况下用户看的是图。

            **提示要有承载物**（2026-09-24）：这一行此前是裸 `<p>`，直接铺在页面底色上。
            现在是一枚吃到键帽的胶囊——它是**说明不是按钮**，所以不给边框色以外的任何
            交互态（没有 hover、没有 pointer、不放进 tab 序）：能点的样子会让人去点它。
            形状用 `rounded-full` 与结果区的说明面板（`NOTICE`）区分开。
          */}
          {trimmedDraft && (
            <p className="flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
              <CornerDownLeft className="size-3" aria-hidden="true" />
              按回车搜索
            </p>
          )}
          <DiscoverWall />
        </>
      )}
    </section>
  )
}
