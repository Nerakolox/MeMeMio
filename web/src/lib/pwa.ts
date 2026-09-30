/**
 * Service worker 的注册。**这里是全应用唯一碰 `navigator.serviceWorker` 的地方**——
 * 别处再写一次 `register()` 就会有两个 worker 抢同一个作用域，而症状（谁在处理请求）
 * 读代码看不出来。
 *
 * 注册逻辑这么短还单独一个文件，另一个理由是它**只在生产跑**（下面那句 `import.meta.env.PROD`），
 * 而这个条件藏在 `main.tsx` 里会很容易在后续改动里被顺手删掉。
 *
 * ## 只在生产注册（任务的 §5 第 4 条）
 *
 * 开发态注册会把 Vite 的 HMR 挡在缓存后面，症状是「改了代码，页面不动」——这种坑排查
 * 起来很贵，而且看起来像别的问题。从源头掐掉：`vite build` 的产物里这段代码还在，
 * `vite dev` 里整段是死代码。
 *
 * ## 它在做什么
 *
 * | 文件 | 内容 |
 * |---|---|
 * | `public/sw.js` | 缓存策略本体（**改缓存行为改那里**，这个文件只有注册） |
 * | `public/manifest.webmanifest` | 装到主屏用的清单：`display: standalone`、图标、`theme_color` |
 *
 * 两个文件都在 `public/`，Vite 原样复制到产物根目录，于是 `/sw.js` 的作用域与
 * `manifest` 里的 `scope: "/"` 正好都是整站。
 *
 * ## 为什么要等 `load`
 *
 * 注册本身要下 `sw.js`、装 worker、缓存产物——和首屏那些关键请求抢带宽没有好处，
 * 而这件事**早一秒晚一秒都不影响用户看到的东西**（它影响的是下一次打开）。等 `load`
 * 之后再开始，唯一的代价是「本次访问就断网」时没有缓存可回——那本来也是缓存里没有的东西。
 *
 * 已经在 `load` 之后才执行（`document.readyState === 'complete'`，比如模块被动态引入）
 * 时直接注册，否则挂一次性的 `load` 监听。
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  const register = (): void => {
    // 失败**不弹给用户**：它是「下次打开更快 / 离线能起来」的加速器，注册不上不影响
    // 这一次的任何功能（离线、无痕、浏览器策略都可能让它失败）。留一行给排查用。
    void navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
      console.warn('[pwa] service worker 注册失败，本次访问一切照旧', err)
    })
  }

  if (document.readyState === 'complete') {
    register()
    return
  }
  window.addEventListener('load', register, { once: true })
}
