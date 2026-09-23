/**
 * 复制 / 下载 / 分享的分流。**本端最重要的一条路径**
 * （web/agents/rules/clipboard-share.md），首页搜索结果、浏览页的操作菜单都走这里。
 *
 * ## 三条路径
 *
 * | 场景 | 做法 |
 * |---|---|
 * | 触屏（手机 / 平板） | `navigator.share({ files })` —— 动图也能直接发进微信 |
 * | 桌面 · 静图 | `fetch` 原图 → 转 PNG → `ClipboardItem` 写剪贴板 |
 * | 桌面 · 动图 | 下载（动图写不进剪贴板，SPEC §9.2） |
 *
 * ⚠️ **两条路都要落在用户手势的同步调用栈里**，而它们各自的办法不同：剪贴板那条
 * 把取图的 Promise 交给 `ClipboardItem`（§4.1），分享那条在**渲染时预取**原图
 * （`prefetchShareFile` + `usePrefetchShare`）。两条都不能写成「先 await 取图、
 * 再调浏览器 API」。
 *
 * ⚠️ **分流唯一依据是 `isAnimated`，不是 `mime`。** WebP 和 APNG 都可能是动图也可能是静图，
 * `image/webp` 说明不了任何事；服务端已经真的解析过容器了，用它给的答案（SPEC §5.2.2）。
 *
 * ⚠️ **能力探测在渲染时就决定按钮文案**（`detectSendPath` + `SEND_LABELS`），不是点击后才发现。
 * 一个按钮两种行为是最糟糕的设计：用户会形成「点这个能复制」的预期，然后在 GIF 上落空，
 * 而且不知道为什么（clipboard-share.md §3）。
 */

/** 一次「发送」实际走哪条路。由 `detectSendPath` 在渲染时定下来，点击时不再改。 */
export type SendPath = 'clipboard' | 'share' | 'download'

/** 菜单项 / 按钮的文案。**动图那一档必须写「下载」，不能写「复制」**（clipboard-share.md §3）。 */
export const SEND_LABELS: Record<SendPath, string> = {
  clipboard: '复制',
  share: '分享',
  download: '下载',
}

/**
 * 发送一张图需要知道的全部信息。
 *
 * 故意只用这几个字段（而不是整个 `Meme`），这样首页的 `SearchResult`、浏览页的 `Meme`
 * 都能直接传进来，而这个文件不必依赖接口类型。
 */
export type SendTarget = {
  id: string
  url: string
  isAnimated: boolean
  originalFilename: string | null
  mime: string
}

/** 一次发送的结果。**失败不会以异常形式冒出来**——降级到下载也是一次成功，只是带说明。 */
export type SendOutcome =
  | { kind: 'copied' }
  | { kind: 'shared' }
  /** 用户自己关掉了系统分享面板。**不是失败**，不要因此塞一个下载给他。 */
  | { kind: 'cancelled' }
  | {
      kind: 'downloaded'
      note: string
      /**
       * 没能下载、只剩一个地址时给的原图链接。渲染成**可点的链接**，别指望
       * `window.open`：取图是异步的，等它失败时用户手势早就没了，弹窗会被拦掉，
       * 而文案还写着「已在新标签页打开」——那句话是假的（见 `saveFile`）。
       */
      fallbackUrl?: string
    }

/** 给用户看的那句话。`fallbackUrl` 由调用方渲染成一个可点的链接。 */
export type SendNote = {
  text: string
  fallbackUrl?: string
}

/** 一次剪贴板写入的结果。失败带的是**能直接展示的原因**，不是异常对象。 */
type CopyAttempt = { ok: true } | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// 能力探测
// ---------------------------------------------------------------------------

/**
 * 主输入是不是触摸（手机 / 平板）。
 *
 * **这不是 UA 判断**：`pointer: coarse` 是与 `prefers-color-scheme` 同类的平台能力查询，
 * 而 UA 字符串永远追不上现实（clipboard-share.md §5）。
 *
 * 为什么不能只靠 `canShare` 分桌面和手机：桌面 Chrome（Windows）上
 * `navigator.canShare({ files })` 也返回 true，但那是系统分享面板，
 * 不是这个产品的主路径——桌面端的主路径是「点一下，切回微信 Ctrl+V」（SPEC §9.2）。
 */
function touchPrimary(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches === true
}

/**
 * `navigator.canShare({ files })` 的结果。
 *
 * 它要求传一个真的 `File`，所以拿一个 1 字节的替身探一下——这个判断与文件内容无关。
 * 缓存是因为每个卡片每次渲染都要问一次，而构造 `File` 不是免费的。
 */
let shareProbe: boolean | null = null

function canShareFiles(): boolean {
  if (shareProbe !== null) return shareProbe
  shareProbe = false
  try {
    if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return shareProbe
    shareProbe = navigator.canShare({
      files: [new File([new Uint8Array(1)], 'probe.png', { type: 'image/png' })],
    })
  } catch {
    // 有些浏览器实现了 canShare 但只认部分字段，抛异常就是「不支持」
    shareProbe = false
  }
  return shareProbe
}

/**
 * 能不能把**图片**写进剪贴板。
 *
 * 两个条件都要：`clipboard.write` 在 http 下不存在（非安全上下文），
 * 而 `ClipboardItem` 并不是所有实现了 `clipboard.write` 的浏览器都有。
 */
function canWriteClipboardImage(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function' &&
    typeof ClipboardItem === 'function'
  )
}

/**
 * 这张图在**当前环境**下该走哪条路。渲染时调用，结果直接决定按钮上写「复制」还是「下载」。
 *
 * 顺序不是随手排的：
 *   1. 触屏优先系统分享——它是唯一能把**动图**也发进微信的路径，而手机是这个产品
 *      体验最好的一端（styling.md「移动端不是适配，是主场」）；
 *   2. 静图写剪贴板，这是桌面端的主路径；
 *   3. 其余（动图、能力缺失）落到下载。**下载是最终兜底**，不会出现「点了没反应」。
 */
export function detectSendPath(isAnimated: boolean): SendPath {
  if (touchPrimary() && canShareFiles()) return 'share'
  if (!isAnimated && canWriteClipboardImage()) return 'clipboard'
  return 'download'
}

// ---------------------------------------------------------------------------
// 三条路径的实现
// ---------------------------------------------------------------------------

/**
 * 取原图失败。**单独一个类型**，是为了让上面那层能把它和「浏览器拒绝写入」分开报——
 * 两者的处理办法毫无关系（一个是 R2 的 CORS，一个是剪贴板权限）。
 */
class FetchOriginalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchOriginalError'
  }
}

/**
 * 取原图。两种失败分开说：HTTP 状态码是地址/权限问题，网络层拒绝在**这个产品里**
 * 最常见的是原图域名没放行本站（R2 的 CORS，deployment.md §8.3）——
 * 而 `fetch` 对此只给一句英文的 "Failed to fetch"，原样展示等于没说。
 */
function fetchOriginal(url: string): Promise<Blob> {
  return fetch(url).then(
    (res) => {
      if (!res.ok) throw new FetchOriginalError(`原图返回 HTTP ${res.status}`)
      return res.blob()
    },
    () => {
      throw new FetchOriginalError('取不到原图（可能是 R2 的 CORS 没放行 GET）')
    },
  )
}

/**
 * 规范只保证 `image/png`（SPEC §9.2），JPG / WebP 静图必须先过一道 canvas。
 *
 * 这里按**拿到的字节的 Content-Type** 判断要不要转，而不是按库里的 `mime`：
 * 已经落到手上的就是这份 blob，它是什么类型由它自己说。
 */
async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob

  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('canvas 不可用')
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('转 PNG 失败'))), 'image/png')
    })
  } finally {
    bitmap.close()
  }
}

/**
 * 写剪贴板。**必须在用户手势的同步调用栈里发起**——Safari 对剪贴板写入的用户激活要求
 * 最严格，`await fetch` 之后再 `write` 会失败（clipboard-share.md §4.1）。
 *
 * 所以这里不 await 取图，而是把 **Promise 交给 `ClipboardItem`**，
 * 再把 `write` 同步调出去。整个函数体在第一个 await 之前执行完。
 *
 * 代价是**两种失败在这里长得一样**：取图失败会经那条 Promise 冒到 `write` 的 rejection 上，
 * 和「写剪贴板被拒」无从区分。不分开的话，CORS 漏配会报成「浏览器拒绝了剪贴板权限」，
 * 读的人去翻权限设置，而真正要改的是部署配置。所以取图那条链自己记一笔。
 */
async function copyImageToClipboard(url: string): Promise<CopyAttempt> {
  let fetchFailure: unknown = null
  const png = fetchOriginal(url)
    .then(toPngBlob)
    .catch((err: unknown) => {
      fetchFailure = err
      throw err
    })
  // write 可能在 png 落定之前就失败，挂一个空 catch：那条 rejection 已经由 write 的结果表达了，
  // 不挂的话控制台会多一条没人处理的 unhandled rejection。
  png.catch(() => {})

  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    return { ok: true }
  } catch (err) {
    // 优先用记下来的取图错误，而不是去猜 `write` 抛出来的那个是什么：
    // Chrome 会把原来那个错误对象原样透传，别的浏览器不保证。
    if (fetchFailure instanceof Error) return { ok: false, reason: fetchFailure.message }
    return { ok: false, reason: describeFailure(err) }
  }
}

function toShareFile(target: SendTarget, blob: Blob): File {
  return new File([blob], targetFilename(target), { type: blob.type || target.mime })
}

/**
 * 系统分享面板要用的那份文件，**在渲染或 hover 时就取好**。
 *
 * 为什么必须提前取：`navigator.share` 要求**调用落在用户手势的同步调用栈里**，
 * 而取一张大 GIF 要几百毫秒到几秒——等取完再调，iOS 的用户激活早就过期了，
 * 抛 `NotAllowedError`，于是「分享」变成「下载」（原实现就是这个表现）。
 * 手机正是主路径（clipboard-share.md §1），不能靠运气。
 *
 * 存的是**已经落定的 `File`**（`file` 那一格）与进行中的 Promise 两份：
 * 点击时若已落定就同步 `share`，一次 await 都不会让出去（`await` 一个已 resolve
 * 的 promise 也会让出一个微任务，而用户激活判定看的就是这个栈）。
 *
 * 失败的那份**从缓存里删掉**：它只说明这一次没取到，用户在点击时值得重试一次。
 */
type SharePrefetch = { file: File | null; promise: Promise<File> }

const sharePrefetches = new Map<string, SharePrefetch>()

/**
 * 同时留几份。超出就整个清掉重来——留着的是**已经解码好的 Blob**，浏览器缓存管不到它，
 * 而图墙一屏能滚出几百张。清掉之后正在看的那几张会在用到时重新取（那时走的就是
 * `shareFile` 的兜底分支）。
 */
const SHARE_PREFETCH_MAX = 12

/** 渲染时调用（见 `usePrefetchShare`）。同一个地址只取一次，重复调用是空操作。 */
export function prefetchShareFile(target: SendTarget): void {
  if (sharePrefetches.has(target.url)) return
  if (sharePrefetches.size >= SHARE_PREFETCH_MAX) sharePrefetches.clear()

  const promise = fetchOriginal(target.url).then((blob) => toShareFile(target, blob))
  const entry: SharePrefetch = { file: null, promise }
  // 失败在这里就处理掉：不挂这个 rejection handler，控制台会多一条没人处理的
  // unhandled rejection（同 `copyImageToClipboard` 里那个空 catch）。
  promise.then(
    (file) => {
      entry.file = file
    },
    () => {
      sharePrefetches.delete(target.url)
    },
  )
  sharePrefetches.set(target.url, entry)
}

/**
 * 系统分享面板。**先 canShare 再 share**——不检查会直接抛异常（clipboard-share.md §4.3）。
 *
 * 预取到的那份已落定时这条路**是同步的**（理由见 `SharePrefetch`）；没落定就在
 * 这里等一次——那是兜底，等完可能已经拿不到用户激活，于是降级到下载并说明原因（§6）。
 */
async function shareFile(target: SendTarget): Promise<void> {
  const prefetched = sharePrefetches.get(target.url)
  const ready = prefetched?.file ?? null
  if (ready !== null) {
    await navigator.share({ files: [ready] })
    return
  }
  const file =
    prefetched !== undefined
      ? await prefetched.promise
      : toShareFile(target, await fetchOriginal(target.url))
  await navigator.share({ files: [file] })
}

/** 一次保存的结果：落到本地了，或者只剩一个能点的地址。 */
type SaveResult = { via: 'saved' } | { via: 'fetch-failed'; url: string }

/**
 * 保存到本地。取图失败时**给回一个能点的原图地址**，而不是报一句失败就结束——
 * 用户的目标是把图发出去，手段失败了就给另一个手段（clipboard-share.md §6）。
 *
 * 取图失败多半是 CORS 没配好（deployment.md §8.3）。跨域地址上 `a[download]` 会被浏览器
 * 忽略，「直接点链接下载」那条路本来就走不通，所以只能让用户自己打开原图手动存。
 *
 * ⚠️ **这里不 `window.open`。** 走到这一步时已经 await 过一次取图，用户手势多半没了，
 * 弹窗会被浏览器拦掉——什么都打不开，而文案还写着「已在新标签页打开」。
 * 把地址交回界面渲染成 `<a target="_blank">`：那一下是用户自己的手势，永远拦不掉。
 */
async function saveFile(target: SendTarget): Promise<SaveResult> {
  let objectUrl: string
  try {
    objectUrl = URL.createObjectURL(await fetchOriginal(target.url))
  } catch {
    return { via: 'fetch-failed', url: target.url }
  }

  const a = document.createElement('a')
  a.href = objectUrl
  a.download = targetFilename(target)
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器上的下载中断，交给浏览器、过一会儿再回收
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
  return { via: 'saved' }
}

async function downloadFlow(target: SendTarget, because: string | null): Promise<SendOutcome> {
  const result = await saveFile(target)
  if (result.via === 'saved') {
    return { kind: 'downloaded', note: because === null ? '已开始下载' : `${because}，已开始下载` }
  }
  return {
    kind: 'downloaded',
    note: `${
      because === null ? '' : `${because}，`
    }取不到原图（可能是 R2 的 CORS 没放行 GET），请点下面的链接手动保存`,
    fallbackUrl: result.url,
  }
}

/**
 * 「浏览器不让写」那一类失败的原因说明。**取图失败不走这里**——它有准确的 message
 * （`FetchOriginalError`），上面两条路径都会优先用它，不拿这一句去盖。
 *
 * `NotAllowedError` 是最常见的一类：权限被拒、非安全上下文、Safari 的用户激活判定没过。
 * 剩下的**不假装知道原因**，只说「拒绝了写入」。
 */
function describeFailure(err: unknown): string {
  if (err instanceof FetchOriginalError) return err.message
  return err instanceof DOMException && err.name === 'NotAllowedError'
    ? '浏览器拒绝了剪贴板权限'
    : '浏览器拒绝了写入'
}

/** 用户自己关掉系统分享面板 = `AbortError`。 */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/**
 * 发送一张图。**调用点必须在用户手势里**（`onClick` / `onKeyDown` 直接调，不要先 await 别的东西），
 * 否则剪贴板那条路会因为拿不到用户激活而失败。
 */
export async function sendMeme(target: SendTarget): Promise<SendOutcome> {
  switch (detectSendPath(target.isAnimated)) {
    case 'clipboard': {
      const attempt = await copyImageToClipboard(target.url)
      if (attempt.ok) return { kind: 'copied' }
      // 剪贴板写失败**自动降级到下载**，并说明发生了什么（clipboard-share.md §6）
      return downloadFlow(target, `复制失败：${attempt.reason}`)
    }

    case 'share':
      try {
        await shareFile(target)
        return { kind: 'shared' }
      } catch (err) {
        // 用户取消不是失败：不能因为他关掉了面板就往下载目录里塞一个文件
        if (isAbortError(err)) return { kind: 'cancelled' }
        return downloadFlow(target, `分享失败：${describeFailure(err)}`)
      }

    case 'download':
      // 动图写不进剪贴板，这不是降级，是这条路的正常形态（SPEC §5.2.2）
      return downloadFlow(target, target.isAnimated ? '动图写不进剪贴板' : null)
  }
}

/**
 * 成功后的反馈。**没有反馈的复制等于没复制**——剪贴板是不可见的（clipboard-share.md §4.1）。
 *
 * 返回 `null` 表示不需要反馈：系统分享面板本身就是反馈，用户取消更不该提示。
 * 文案集中在这里，是为了首页和浏览页对同一个动作说同一句话。
 *
 * 返回对象而不是字符串，是因为「取不到原图」那条路要**给一个能点的链接**：
 * 那时并没有失败到无事可做，缺的只是一次用户自己的手势（见 `saveFile`）。
 *
 * ⚠️ **这个函数只管文案，不管怎么显示。** 呈现走 `lib/toast.tsx` 的 `notifySend`
 * （右上角提示），调用点在 `use-search.ts` / `use-browse-actions.ts`——
 * 那两个页面此前各渲染一行自己的裸文字，两页会漂，2026-09-24 一并收进 toast。
 */
export function sendNote(outcome: SendOutcome): SendNote | null {
  switch (outcome.kind) {
    case 'copied':
      // 只说「已复制」：剪贴板是不可见的，用户要的是「这一下成了」。
      // 后半句原本是「去微信 Ctrl+V」——桌面端主路径提示（SPEC §9.2），
      // 但它把一句状态说明写成了操作说明，而按钮本身已经按能力探测分过流了。
      return { text: '已复制' }
    case 'downloaded':
      return { text: outcome.note, fallbackUrl: outcome.fallbackUrl }
    case 'shared':
    case 'cancelled':
      return null
  }
}

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

function extForMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/apng':
      return 'apng'
    default:
      return 'img'
  }
}

/**
 * 下载 / 分享时用的文件名。
 *
 * `originalFilename` 是**用户提供的字符串**（SPEC §5.2.3），这里只防两件事：
 * 控制字符（会把下载名弄成乱码）和路径分隔符。它只是 `a[download]` 的名字、
 * 不是文件系统路径，所以不做完整转义，也不据此判断格式。
 *
 * 逐字符判断而不是写正则，是因为控制字符的正则转义在源码里容易变成真的控制字节。
 */
function sanitizeFilename(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    if (ch === '/' || ch === '\\') continue
    out += ch
  }
  return out.trim()
}

function targetFilename(target: SendTarget): string {
  const name = sanitizeFilename(target.originalFilename ?? '')
  if (name === '') return `mememio-${target.id.slice(0, 8)}.${extForMime(target.mime)}`
  // 没有扩展名的（「猫」「微信图片」）补一个，否则下载下来双击打不开
  return /\.[a-z0-9]{1,5}$/i.test(name) ? name : `${name}.${extForMime(target.mime)}`
}
