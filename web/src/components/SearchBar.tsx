import { useEffect, useRef } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { TOUCH } from '../lib/touch'
import { cn } from '../lib/utils'

/**
 * 搜索框。**受控**：值在调用点的 `draft` 里，提交走 `onSubmit`；这里不碰 URL，也不取数。
 *
 * 两个页面共用（`project-structure.md` 的复用标准：被两个以上 feature 用到，所以放
 * `components/`）：
 *
 * | 谁 | 提交之后 |
 * |---|---|
 * | 首页 | `navigate('/browse?q=…')` —— **交棒，自己不搜**（SPEC §9.30） |
 * | 浏览页 | `useBrowseFilters.commitQuery` → `/browse?q=…`，就地搜 |
 *
 * 2026-09-26 从 `features/search/` 搬过来：合流之后浏览页也要一个搜索框（没有它
 * `/browse?q=` 只能靠手打地址进），而「同一个控件两处各写一份」正是这一端最忌讳的漂移。
 *
 * ## 自动聚焦只在精确指针设备上做，而且**要显式要求**
 *
 * 旧实现是 input 上的 `autoFocus`，**手机上会弹键盘，把下半屏的随机图墙整个盖住**
 * ——而图墙正是「不知道要找什么」时唯一的入口（SPEC §6.3.2）；手机又是这个产品
 * 体验最好的一端（styling.md）。这条一直挂在任务板的遗留项里，理由是「弹不弹键盘
 * 只有真机能回答」，所以当时没敢动。
 *
 * 现在按输入方式分流而不是按屏幕宽度：桌面保留「打开就能打字」（这是搜索页存在的理由），
 * 触摸设备不抢焦点、不弹键盘（要搜的时候手指本来就在屏幕上）。判据用 `(pointer: fine)`
 * 与 `MemeCard` 的浮层操作器一致——问的都是「有没有一个精确指针」。
 *
 * ⚠️ **`autoFocus` 默认 `true` 是首页那一支的行为；浏览页要显式传 `false`。**
 * 浏览页是「翻着看」的页面，用户进来多半是点筛选或直接滚，抢走焦点会让键盘先弹出来
 * 盖住半屏——而且那里的查询词通常是从 URL 进来的（分享链接），不是现打的。
 * 写成 prop 而不是「按页面判断」：判据是**这个页面进来是干嘛的**，不是屏幕宽度。
 *
 * 用 effect 而不是 `autoFocus` 属性：属性没法带条件。**必须先给 `Input` 加
 * `forwardRef`**（见 `components/ui/input.tsx`），否则 React 18 会把 ref 静默丢掉，
 * 这段聚焦代码一行都不生效。
 *
 * ## 失焦提交：**浏览页要，首页不要**（2026-09-26 改）
 *
 * 在浏览页，失焦提交是对的：输入完直接去点下面那些结果是最常见的动作，不该要求先回车。
 *
 * 但首页改版之后这一条**不再成立**：首页不渲染结果，下面的图墙、两条 rail、
 * 「换一批」全是能点的东西，**鼠标往下一按就会触发 blur**——用户只是想去点一张图，
 * 却被送到 `/browse` 去了。搜索框在这一页现在只有一个出口：回车或那枚「搜索」。
 *
 * ⚠️ 这是对 `state-navigation.md §6`「失焦也提交，两支不再有差异」那条的**明写改口**：
 * 那条的前提是「首页的搜索结果就在这一页上」，前提没了，结论跟着改。
 * 与 `autoFocus` 一样，判据是**这个页面进来是干嘛的**，不是屏幕宽度。
 */
export function SearchBar({
  value,
  onChange,
  onSubmit,
  autoFocus = true,
  submitOnBlur = true,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  /** 见文件头：首页 `true`，浏览页 `false`。 */
  autoFocus?: boolean
  /** 失焦时也提交一次。见文件头：浏览页 `true`（默认），首页 `false`。 */
  submitOnBlur?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!autoFocus) return
    if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus()
  }, [autoFocus])

  return (
    <form
      className="flex items-stretch gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      role="search"
    >
      <Input
        ref={inputRef}
        // `md:text-base` 是**对注册表的唯一一处偏离**：它默认 `text-base md:text-sm`，
        // 桌面档 14px，而 iPad 竖屏正好 768px，落在这个档里 —— 输入框小于 16px 时
        // iOS 一聚焦就放大整个页面。旧的 `.search__input` 是全宽度 1rem，这里保持原样。
        className={cn(TOUCH, 'flex-1 md:text-base')}
        type="search"
        name="q"
        value={value}
        placeholder="用一句话描述你要找的图"
        aria-label="搜索表情包"
        onChange={(e) => onChange(e.target.value)}
        // 失焦也提交一次：输入完直接去点结果是最常见的动作，不该要求先回车。
        // 首页关掉它（理由见文件头「失焦提交」）——`undefined` 才是「没挂这个 handler」。
        onBlur={submitOnBlur ? onSubmit : undefined}
      />
      {/* min-w-18 = 4.5rem = 72px，接的是旧 `.search__submit` 的 `min-width`
          （中文两个字加内边距不到这个宽，按钮会比输入框窄一截） */}
      <Button type="submit" className={cn(TOUCH, 'min-w-18')}>
        搜索
      </Button>
    </form>
  )
}
