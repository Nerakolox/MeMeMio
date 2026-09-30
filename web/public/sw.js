/*
 * MeMeMio 的 service worker。**手写，只做运行时缓存。**
 *
 * 放在 `public/` 是因为 Vite 把这里的文件原样复制到产物**根目录**，于是这个脚本的
 * 作用域正好是 `/`（`/sw.js` 的 scope 默认是它所在的目录）——正是需要的样子。
 * 参数化路径、构建期预缓存清单都不需要，所以没有 `vite-plugin-pwa` / Workbox 这类依赖。
 *
 * ## 它为什么存在
 *
 * 手机端装到主屏（`manifest.webmanifest` 与本文件同在一处）之后，**独立窗口里的
 * 冷启动要能直接进首页**；顺带「有过一次访问之后，静态资源不重复走网络」。
 * 不做离线数据、不做离线写、不做后台同步、不做推送——见任务
 * 《2026-10-01-手机PWA》§2 与 §7。
 *
 * ## 没有预缓存清单，理由是这个
 *
 * 产物里的 `assets/*` 文件名**带内容哈希**，一个 URL 的字节永远不会变——第一次取到
 * 就可以永久缓存，不需要在构建时列清单。反过来说，加一个预缓存清单要引入一个构建期
 * 插件、一份每次发版都变的清单文件，换来的只是「第一次打开就多缓存几个文件」。
 *
 * ## 缓存策略（任务 §5，改动前先读那一节）
 *
 * ```
 * 导航请求（mode: 'navigate'）  网络优先 → 成功则更新缓存里的 index.html
 *                                       → 失败（离线）则回缓存里的 index.html
 * /api/*  /auth/*               一律放行：不缓存、不读缓存、不拦截
 * /assets/*                     缓存优先（内容哈希，不可变）；未命中走网络
 * manifest / 图标 / 品牌 SVG     缓存优先，带后台更新（下一次打开自动拿到新版）
 * 其余同源 GET                   网络优先，成功则缓存
 * 非 GET、跨域                   一律放行
 * ```
 *
 * ## 四条硬要求，每一条错了都不报错
 *
 * 1. **`/api/*` 与 `/auth/*` 一个字节都不进缓存。** 一旦缓存，用户拿到的是别的会话下
 *    的响应或者过期数据——这是安全边界，不是性能取舍。SSE（导入进度）就靠这条不被拦截、
 *    不被缓冲。
 * 2. **只缓存「该有的东西」。** 服务端的 SPA 回退对任何未命中路径都回 `index.html`
 *    且状态 200，所以光看 `response.ok` 会把一份 HTML 当 JS 缓存下来；写漏这一条的表现是
 *    「某个资源坏了，而且一直坏」——`isCacheable()` 里的 `text/html` 那半句就是它。
 * 3. **版本号是手改的常量。** 运行时缓存没有版本，`SW_VERSION` 不换，`activate` 就无从上手，
 *    缓存会随每次发版一直涨。**已知放宽**：bump 之前旧资源不会被清（表现为占用增长，
 *    不影响正确性）。
 * 4. **只在生产注册**（`src/lib/pwa.ts`）。开发态注册会把 Vite 的 HMR 挡在缓存后面，
 *    症状是「改了代码页面不动」。
 *
 * ## 改了这里，`scripts/verify-pwa.mjs` 的哪些断言会先红
 *
 * 导航那条 → 断网导航仍能起来；`/api/` 那条 → 遍历 cache 找 `/api/`、`/auth/` 条目；
 * `/assets/` 那条 → 二次访问不再发网络请求。那个脚本与其余 `verify-*.mjs` 一样
 * **不进版本库**（根 `.gitignore`），所以保障在这份注释里，不在「它会一直有人跑」上。
 */

/**
 * 缓存版本。**手改这一个常量就是发版协议**：换了它，`activate` 会删掉其它所有 cache。
 *
 * 改它的时机是「这次发版想让老用户丢掉旧产物」。改了不报错、不改也不报错，所以没有
 * 自动判断的依据——产物哈希能让**同一个** URL 不变，但 `index.html` 与那几个固定名字的
 * 图标（`/manifest.webmanifest`、`/icon-*.png`）是会被覆盖的，它们靠版本号翻篇。
 */
const SW_VERSION = 'v1'

const CACHE_NAME = `mememio-static-${SW_VERSION}`

/** 导航请求缓存 index.html 用的键。**不带查询串**——`/browse?q=…` 与 `/` 共用同一份外壳。 */
const SHELL_KEY = '/index.html'

self.addEventListener('install', () => {
  // 没有预缓存要等，直接进 activate。见文件头「没有预缓存清单」。
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 版本号换掉之后，其余 cache 全是上一个版本留下的，整个删掉（硬要求 3）。
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      )
      // 让已经开着的标签页立刻用上这个版本，不然要等下一次导航才生效。
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request

  // Chrome 对「只在缓存里找」这种内部请求会抛错，放行让它自己处理。
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return

  // 写请求（上传、编辑、删除）与跨域请求一律放行。**跨域里包括对象存储的原图**
  // （媒体地址是绝对 URL，见 `api/src/storage/r2.ts`），它的缓存头由 CDN 管。
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // 硬要求 1：安全边界。这里**直接 return**——不 respondWith、不碰 cache，
  // 请求就按浏览器本来的样子走。
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request))
    return
  }
  if (isShellAsset(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, event))
    return
  }
  event.respondWith(networkFirst(request))
})

/**
 * 导航：网络优先。
 *
 * 拿到新外壳就顺手更新缓存里那一份——**不这么做，装到主屏的图标会永远停在旧产物上**
 * （任务 §3 第 7 条）。取不到网络（离线）才回缓存，那是这个 worker 存在的一半理由。
 */
async function navigation(request) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    // ⚠️ **这里不能调 `isCacheable()`**：外壳本身就是一份 `text/html`，
    // 而那个函数的第一条就是「HTML 不入库」（那是给 `/assets/*` 用的）。
    if (response.ok && response.type === 'basic') {
      await cache.put(SHELL_KEY, response.clone())
    }
    return response
  } catch {
    const cached = await cache.match(SHELL_KEY)
    if (cached !== undefined) return cached
    // 一次都没成功打开过就离线了：缓存里真的什么都没有。给一句话而不是让浏览器
    // 甩一张断网页——**这是本文件唯一一处自己造响应**，不新增别的。
    return OFFLINE_SHELL
  }
}

/**
 * `/assets/*`：缓存优先。
 *
 * 文件名带内容哈希，同一个 URL 的字节永远不变，所以命中就返回、不问网络
 * （任务 §3 第 5 条那条「不重复走网络」）。
 *
 * ⚠️ **入库前要检查扩展名与 `Content-Type` 对不对得上。** 服务端的 SPA 回退对
 * `/assets/nonexistent.js` 也回一份 200 的 `index.html`，只看 `response.ok` 会把它
 * 当 JS 存下来——硬要求 2。**不缓存不等于不返回**：这里照原样把网络那份给它，
 * 坏的是产品包本身，不是缓存策略；要治的是「坏了还一直坏」。
 *
 * 这里**不做后台更新**（与下面那条的区别）：文件名带内容哈希，同一个 URL 的字节不会变，
 * 没有需要更新的东西。
 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached !== undefined) return cached

  const response = await fetch(request)
  const path = new URL(request.url).pathname
  if (isCacheable(response) && contentTypeMatches(path, response)) {
    await cache.put(request, response.clone())
  }
  return response
}

/**
 * manifest / 图标 / 品牌 SVG：缓存优先 + 后台更新。
 *
 * 这几个文件名是固定的（不带哈希），内容会随发版变——所以**必须带一次后台更新**：
 * 只做缓存优先的话，换了图标的老用户永远拿到旧的那张（它不像 `index.html`，
 * 每次导航都会问一次网络）。
 *
 * 更新挂在 `event.waitUntil` 上，浏览器才知道还有活在跑、别把 worker 收掉；
 * 更新失败**什么都不做**（缓存里那份照用），界面这一次拿到的还是旧版，下次再来。
 */
async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)

  const fresh = fetch(request).then(async (response) => {
    const path = new URL(request.url).pathname
    if (isCacheable(response) && contentTypeMatches(path, response)) {
      await cache.put(request, response.clone())
    }
    return response
  })

  if (cached !== undefined) {
    event.waitUntil(fresh.catch(() => undefined))
    return cached
  }
  // 第一次取：没有旧的可给，只能等这一次网络，失败就让它失败——
  // 图标裂了是看得见的，比悄悄给一个空响应好。
  return fresh
}

/**
 * 其余同源 GET：网络优先，成功则缓存。
 *
 * 这一档故意保守——未知路径拿到的可能是任何东西，而上面两条已经盖住了外壳的全部构件。
 * 失败时回缓存（有就比没有强），没有就把失败原样抛回去。
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (isCacheable(response)) await cache.put(request, response.clone())
    return response
  } catch (err) {
    const cached = await cache.match(request)
    if (cached !== undefined) return cached
    throw err
  }
}

/** manifest、图标、品牌 SVG——文件名固定、内容随发版变的那几个（见缓存策略那张表）。 */
function isShellAsset(pathname) {
  return (
    pathname === '/manifest.webmanifest' ||
    pathname === '/apple-touch-icon.png' ||
    /^\/icon-[a-z0-9-]+\.png$/.test(pathname) ||
    /^\/mememio-[a-z-]+\.svg$/.test(pathname)
  )
}

/**
 * **资源**能不能入库：同源、成功、且不是 HTML。
 *
 * ⚠️ 导航那一档**故意不调它**（外壳就是 HTML，理由写在 `navigation()`）。这一份是给
 * `/assets/*`、manifest 图标、以及「其余同源 GET」用的。
 *
 * `text/html` 与 `text/event-stream` 两条都不是「性能取舍」：前者是硬要求 2（SPA 回退
 * 会把任何未命中路径写成一份 200 的 HTML），后者是 SSE —— 就算它出现在 `/api/` 之外，
 * 缓存一条永不结束的流也没有意义。
 */
function isCacheable(response) {
  if (response.type !== 'basic' || !response.ok) return false
  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase()
  return !contentType.startsWith('text/html') && !contentType.startsWith('text/event-stream')
}

/**
 * 扩展名与 `Content-Type` 对不对得上。只认产物里真会出现的几类——**不认识的不缓存**，
 * 这条比「认得越多越好」重要：多认一个就多一个可以把 HTML 存成资源的入口。
 *
 * 值取自产物（`npm run build` 之后 `dist/assets/` 下的扩展名）：js / css / woff2，
 * 加上 `public/` 里那几样直接落在根上的 png / svg / webmanifest。
 * `sourcemap` 也在产物里（`.map`），但它只有开发者工具会取，不在缓存策略的目标里，
 * 所以没列——列了的代价只是多一份可能要清理的东西。
 */
const CONTENT_TYPE_BY_EXT = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

function contentTypeMatches(pathname, response) {
  const dot = pathname.lastIndexOf('.')
  if (dot < 0) return false
  const expected = CONTENT_TYPE_BY_EXT[pathname.slice(dot)]
  if (expected === undefined) return false
  const actual = (response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()
  return actual === expected
}

/**
 * 一次都没打开过就离线了时的兜底页。**本文件唯一自己造的响应**。
 *
 * 不是「离线也能用」的承诺——缓存里真的一份外壳都没有，能给的就是一句话。
 * 之所以不给 `Response.error()`：那会甩出浏览器自己的断网页，用户看到的是一张
 * 与本产品无关的图，而这句至少说明白「是离线，不是坏了」。
 */
const OFFLINE_SHELL = new Response(
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>MeMeMio</title>' +
    '<body style="margin:0;display:grid;place-items:center;height:100vh;' +
    'font:16px/1.6 system-ui,sans-serif">' +
    '<p>离线，而且这台设备上还没有可用的缓存。连上网络再打开一次。</p>',
  { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
)
