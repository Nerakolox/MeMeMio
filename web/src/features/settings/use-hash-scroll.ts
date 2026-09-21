import { useEffect } from 'react'

/**
 * 把视口滚到 URL hash 指向的元素。
 *
 * 为什么不能只滚一次：客户端路由跳转（`/admin/invites` → `/settings#invites`）浏览器不会
 * 自己滚，得手动来；而设置页的每一段各自异步拉数据，**上面的段落数据回来之后会把锚点往下推**，
 * 先滚的那一下就停在了半路。实测（1280×900）落点偏差 498px，等于没滚。
 *
 * 所以盯着页面高度：还在变就重新对齐，停止变化或用户自己动手之后撒手。
 * 3 秒是上限——接口再慢也不能在用户读页面的时候把他拽走。
 */
export function useHashScroll(hash: string, rootSelector: string) {
  useEffect(() => {
    if (!hash) return
    const id = hash.slice(1)
    const scroll = () => document.getElementById(id)?.scrollIntoView()
    scroll()

    const root = document.querySelector(rootSelector)
    if (!root) return

    const observer = new ResizeObserver(scroll)
    observer.observe(root)

    // 用户一旦自己滚 / 按键，后面的重新对齐就成了打扰
    const stop = () => observer.disconnect()
    const timer = setTimeout(stop, 3000)
    window.addEventListener('wheel', stop, { passive: true })
    window.addEventListener('touchmove', stop, { passive: true })
    window.addEventListener('keydown', stop)
    /*
     * 点击也算「用户自己动手」（2026-09-21 加）。
     * 侧边栏折叠会改内容列宽，`.settings-page` 跟着变宽变窄，观察者当作「页面还在长」
     * 又把人拽回锚点——而触发折叠的那一下正是点击。pointerdown 早于 click 生效，
     * 鼠标 / 触摸 / 笔一支就够，不用分别监听。
     */
    window.addEventListener('pointerdown', stop, { passive: true })

    return () => {
      stop()
      clearTimeout(timer)
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchmove', stop)
      window.removeEventListener('keydown', stop)
      window.removeEventListener('pointerdown', stop)
    }
  }, [hash, rootSelector])
}
