/**
 * 选文件：多选、拖拽文件夹（递归）、剪贴板粘贴。
 *
 * 三个入口全部汇入同一个 `File[]`，**不为某个入口另做一套流程**（import-ux.md §1）。
 * 这里只负责「把入口变成 File[]」，不含任何请求——见 `use-import-queue.ts`。
 */

/** 输入框的 accept。真正的判定在服务端（magic bytes，不信扩展名），这里只是少让用户白传。 */
export const IMAGE_ACCEPT = 'image/*,.gif,.webp,.png,.jpg,.jpeg,.avif'

const EXT_RE = /\.(gif|webp|png|jpe?g|avif|bmp|tiff?)$/i

/**
 * 拖拽目录时浏览器不展开目录，要自己递归。
 * `webkitGetAsEntry` 是当前唯一能拿到目录结构的 API，非标准但全主流浏览器都实现。
 */
type FileSystemEntryLike = {
  isFile: boolean
  isDirectory: boolean
  fullPath: string
}

type FileSystemFileEntryLike = FileSystemEntryLike & {
  file: (cb: (f: File) => void, err: () => void) => void
}

type FileSystemDirectoryEntryLike = FileSystemEntryLike & {
  createReader: () => {
    readEntries: (cb: (entries: FileSystemEntryLike[]) => void, err: () => void) => void
  }
}

function readFileEntry(entry: FileSystemFileEntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (f) => resolve(f),
      () => resolve(null),
    )
  })
}

/** `readEntries` 一次最多返回 100 条，要循环读到空为止，否则大目录会丢文件。 */
function readAllEntries(dir: FileSystemDirectoryEntryLike): Promise<FileSystemEntryLike[]> {
  const reader = dir.createReader()
  const all: FileSystemEntryLike[] = []
  return new Promise((resolve) => {
    const step = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all)
            return
          }
          all.push(...batch)
          step()
        },
        () => resolve(all),
      )
    }
    step()
  })
}

async function walkEntry(entry: FileSystemEntryLike, out: File[]): Promise<void> {
  if (entry.isFile) {
    const f = await readFileEntry(entry as FileSystemFileEntryLike)
    if (f) out.push(f)
    return
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(entry as FileSystemDirectoryEntryLike)
    for (const c of children) await walkEntry(c, out)
  }
}

/** 从拖放事件里递归取出所有文件。不支持 `webkitGetAsEntry` 时退回 `dataTransfer.files`。 */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file')
  // 同样必须在同步区抓：一旦 await 过，dt.files 也已经是空的（原来第 89 行那个兜底
  // 读的就是它，所以形同虚设）。
  const flat = Array.from(dt.files ?? [])
  if (items.length === 0) return flat

  // protected mode：这一整个 map 必须在 drop 事件的同步派发区里跑完。
  // 处理函数一旦交出控制权（哪怕只是 await 一个已 resolve 的 Promise），拖拽数据存储
  // 就被清空，之后每次 webkitGetAsEntry() 都返回 null。
  //
  // 原来这行写在 for 循环体里：第一次迭代还在同步区、拿得到 entry，紧接着的 await
  // 就交出了控制权，从第二次迭代起全是 null —— 于是无论拖几张都只认第一张。
  const entries = items.map(
    (i) =>
      (
        i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }
      ).webkitGetAsEntry?.() ?? null,
  )

  // 没有目录就不必递归：FileList 本身就是完整的，一条 await 都不用等。
  // 散图是绝大多数情况，走这条路顺带把「递归中途失败只回半截」也排除了。
  if (!entries.some((e) => e && e.isDirectory)) return flat

  // 到这里才第一次 await。entry.file() / readEntries() 不受 protected mode 限制，
  // 慢慢递归。
  const out: File[] = []
  for (const entry of entries) {
    if (entry) await walkEntry(entry, out)
  }
  // 目录递归失败时至少别把拖进来的东西丢了
  return out.length > 0 ? out : flat
}

/** 剪贴板粘贴。和拖拽一样是入口之一，不走另一条上传路径。 */
export function filesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return []
  return Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/'))
}

export type PickedFile = {
  /** 可能已被 `uniqueName` 改过名。批次内的条目标识是它的 `name`。 */
  file: File
  /**
   * 去重用的来源身份：进列表**那一刻**、改名**之前**的 `fileKey`。
   * 改名之后 `file.name` 就变了，不能再拿 `file` 去比——见 `mergePicked`。
   */
  sourceKey: string
  /** 本地就能判定的错误：格式不像图片、体积为 0。服务端仍会再判一次。 */
  localProblem: 'not_image' | 'empty' | null
}

function classify(file: File): PickedFile {
  const looksImage = file.type.startsWith('image/') || EXT_RE.test(file.name)
  let localProblem: PickedFile['localProblem'] = null
  if (!looksImage) localProblem = 'not_image'
  else if (file.size === 0) localProblem = 'empty'
  return { file, sourceKey: fileKey(file), localProblem }
}

/**
 * 同一个文件的身份：名字 + 字节数 + 修改时间。
 *
 * 带上 `lastModified` 是有意偏向「宁可漏判」：两份不同的图恰好同名同大小（导出工具
 * 生成的一批 `1.png`）并不罕见，误判成重复就会被**静默丢掉**，用户以为传了；
 * 而漏判的代价只是多传一份，服务端按 SHA-256 判成 `exact_dup` 跳过（SPEC §6.2.2）。
 * 同一个文件被选两次、拖两次，这三样都一样，照样判得出。
 */
function fileKey(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`
}

/**
 * 把新来的一批文件并进待上传列表：**先去重，再改名**，顺序不能反。
 *
 * 反过来就是 2026-09-29 之前的写法（issue #1）：同一张 `a.png` 第二次进来，先因为
 * 重名被改成 `a(1).png`，再拿改名后的身份去和已有的 `a.png` 比——永远对不上，于是
 * 去重从来没生效过，「跳过 N 个重复项」那句提示也从来没出现过。同一次拖入里带着两份
 * 同一个文件，也是一样被改名后双双留下。
 *
 * 所以去重比 `sourceKey`（改名前的原始身份），改名只作用于**去重之后留下的**文件。
 */
export function mergePicked(
  prev: PickedFile[],
  files: File[],
): { next: PickedFile[]; added: number; skipped: number } {
  const seen = new Set(prev.map((p) => p.sourceKey))
  const taken = new Set(prev.map((p) => p.file.name))
  const added: PickedFile[] = []
  let skipped = 0
  for (const file of files) {
    const p = classify(file)
    if (seen.has(p.sourceKey)) {
      skipped += 1
      continue
    }
    seen.add(p.sourceKey)
    const name = uniqueName(file.name, taken)
    taken.add(name)
    added.push(name === file.name ? p : { ...p, file: renamed(file, name) })
  }
  return { next: [...prev, ...added], added: added.length, skipped }
}

/** 只换名字。`lastModified` 要带过去，不然默认成「现在」，和原文件对不上。 */
function renamed(f: File, name: string): File {
  return new File([f], name, { type: f.type, lastModified: f.lastModified })
}

/**
 * 文件名在批次内必须唯一。
 *
 * 不是洁癖：commit、SSE `item`、待确认决策（`POST /imports/reviews/{batchId}/{fileName}`）
 * 全部以 **fileName 作为批次内的条目标识**（SPEC §6.2）。两个不同目录下的 `1.png`
 * 同名进同一批次，进度和决策就会串到一起去。所以在**加入队列时**就改名，
 * 而不是等 SSE 回来发现对不上。
 *
 * 这里不做内容哈希去重——同一张图换个名字传两次，精确去重交给服务端的 SHA-256
 * （SPEC §6.2.2），前端只保证标识唯一。只经 `mergePicked` 调用，它保证先去重再改名。
 */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let n = 1
  let candidate = `${stem}(${n})${ext}`
  while (taken.has(candidate)) {
    n += 1
    candidate = `${stem}(${n})${ext}`
  }
  return candidate
}
