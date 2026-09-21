import { useEffect, useRef } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'

/**
 * 首页搜索框。受控：值在 `useSearch` 的 `draft` 里，提交走 `commit`。
 *
 * ## 自动聚焦只在精确指针设备上做
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
 * 用 effect 而不是 `autoFocus` 属性：属性没法带条件。**必须先给 `Input` 加
 * `forwardRef`**（见 `components/ui/input.tsx`），否则 React 18 会把 ref 静默丢掉，
 * 这段聚焦代码一行都不生效。
 */
export function SearchBar({
  value,
  onChange,
  onSubmit,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus()
  }, [])

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
        // 失焦也提交一次：输入完直接去点结果是最常见的动作，不该要求先回车
        onBlur={onSubmit}
      />
      {/* min-w-18 = 4.5rem = 72px，接的是旧 `.search__submit` 的 `min-width`
          （中文两个字加内边距不到这个宽，按钮会比输入框窄一截） */}
      <Button type="submit" className={cn(TOUCH, 'min-w-18')}>
        搜索
      </Button>
    </form>
  )
}
