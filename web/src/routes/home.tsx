import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SearchBar } from '../components/SearchBar'
import { DiscoverWall } from '../features/discover/DiscoverWall'
import { MemeRail } from '../features/home/MemeRail'
import { TagStatusBar } from '../features/home/TagStatusBar'

/**
 * 首页 = **入口页**（2026-09-26 首页改版，SPEC §9.30）。
 *
 * 四块，从上到下：搜索框 → 随便看看 → 两条 rail → 待处理状态条。
 * **首页自己不渲染任何结果**——搜索框只做入口，提交即导航到 `/browse?q=`，
 * 那里才是那条能筛、能翻的列表（[state-navigation.md §6](../agents/rules/state-navigation.md)）。
 *
 * ## 为什么把结果区砍掉，而不是留着
 *
 * 合流之后首页那段结果是一条**更差的重复列表**：同一句话，在 `/` 上不能筛、不能翻页，
 * 在 `/browse` 上能筛能翻。它存在只是因为 `/search` 还没死。首页要继续留着它，
 * 就得回答「为什么同一件事有两个入口、其中一个残」——答不上来（任务文件 §1）。
 *
 * ## 这一层只有布局
 *
 * 三块内容的取数、三态与文案都在各自的组件里（`features/home/`、`features/discover/`）；
 * 这一页唯一的状态是**搜索框里那个还没提交的字符串**——纯 UI state，
 * 而且用完就没了（提交之后它就变成 `/browse` 的 `q`）。
 * 老链接 `/?q=…` 的重定向在 `App.tsx` 的布局路由里，不在这里。
 *
 * ## 三条键盘路径随结果区一起退场
 *
 * 此前这里挂着一个整页的 `onKeyDown`（↑↓ 选结果、Enter 打开阅览、Esc 取消）。
 * 它是为结果区写的，首页不渲染结果之后没有落点；搬到 `/browse` 是另一个量级的改动
 * （网格里要做二维方向键），产品负责人 2026-09-26 明确选了不做（任务文件 §5.2）。
 * **代价要认下**：首页不能有「只有键盘到得了」或「只有键盘到不了」的入口。
 *
 * ## `max-w-6xl` 对齐设置页
 *
 * 应用外壳只给 `p-6`，没有宽度约束时 2560px 屏上图墙是 5 列 × 每格约 460px 的大图
 * ——而 5 列是按小格子设计的（见 `DiscoverWall`），容器查询那两档也才真的是按图墙
 * 自己的宽度在分档。
 *
 * `gap-6` 是**这一页唯一的块间距旋钮**：四块之间一律 24px，`DiscoverWall` 自己那个
 * `mt-6` 随这次改版删掉了（它当时是在补「提示胶囊 + 图墙」那种兄弟关系，现在间距归容器管）。
 */
export function HomePage() {
  const navigate = useNavigate()
  const [draft, setDraft] = useState('')

  /**
   * 提交即交棒：首页不搜，**把查询词交给那条真的能搜的列表**。
   *
   * 空词不导航：把人送到一个空搜索的 `/browse` 上，他看到的是一屏「没有符合条件的图片」
   * ——明明什么都没输入，却被告知没结果（任务文件 §3）。
   *
   * `URLSearchParams` 而不是手拼 `?q=`：查询词里 `&` `#` 空格都是常事。
   */
  function submit() {
    const q = draft.trim()
    if (q === '') return
    navigate(`/browse?${new URLSearchParams({ q })}`)
  }

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      {/*
        `autoFocus` 保持默认（`true`，且只在 `(pointer: fine)` 上生效）：
        首页仍是搜索的入口，桌面进来就能打字，手机上不会弹键盘盖住图墙
        （闸门与理由写在 `components/SearchBar.tsx`）。

        ⚠️ **`submitOnBlur={false}`**：失焦提交在浏览页是对的（输入完就去点结果），
        在这一页是**把人带走**——输入框下面全是能点的东西（图、换一批、查看全部），
        鼠标往下一按就会触发 blur，用户还没按回车就被送到 `/browse` 去了。
        理由写在 `SearchBar` 那个 prop 上。
      */}
      <SearchBar
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        submitOnBlur={false}
      />

      {/* 第一屏给「翻」：不知道要找什么的时候只有这一条路能见到老图（SPEC §6.3.2） */}
      <DiscoverWall />

      {/* 两条 rail：各按自己的条件取 8 张，空的时候整条不渲染 */}
      <MemeRail title="我的收藏" params={{ favorited: true }} moreHref="/browse?favorited=true" />
      <MemeRail title="最近上传" params={{}} moreHref="/browse" />

      {/* 只在真有「需人工」的图时出现；失败时说一句，不静默 */}
      <TagStatusBar />
    </section>
  )
}
