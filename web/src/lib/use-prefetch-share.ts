import { useEffect } from 'react'
import { detectSendPath, prefetchShareFile, type SendTarget } from './clipboard'

/**
 * 渲染这张卡时就把系统分享要用的原图取到手。**只有触屏那一档会真的取**
 * （其余两条路不需要提前拿字节，见 `lib/clipboard.ts` 的分流）。
 *
 * 为什么非得提前：`navigator.share` 要落在用户手势的同步调用栈里，而大 GIF 取完
 * 用户激活多半已经过期——表现是手机上点「分享」变成「下载」。完整推导在
 * `clipboard.ts` 的 `SharePrefetch` 上，改之前先读那一段。
 *
 * 一次取到的字节**和网格里那张缩略图无关**，是原图，所以代价真实存在：只在
 * `detectSendPath` 说这条路是分享时才取，取过的地址由 `prefetchShareFile` 自己兜住。
 */
export function usePrefetchShare(target: SendTarget | undefined): void {
  useEffect(() => {
    // `undefined` 是「此刻没有可发送的那一张」——全屏阅览器关着的时候。hook 不能条件调用，
    // 所以这一档由它自己认下（`LightboxViewer` 的当前那一张就可能是 undefined）。
    if (target !== undefined && detectSendPath(target.isAnimated) === 'share') {
      prefetchShareFile(target)
    }
  }, [target])
}
