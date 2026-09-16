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
  if (items.length === 0) return Array.from(dt.files ?? [])

  const out: File[] = []
  for (const item of items) {
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }
    ).webkitGetAsEntry?.()
    if (entry) await walkEntry(entry, out)
  }
  // 目录递归失败时至少别把拖进来的东西丢了
  return out.length > 0 ? out : Array.from(dt.files ?? [])
}

/** 剪贴板粘贴。和拖拽一样是入口之一，不走另一条上传路径。 */
export function filesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return []
  return Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/'))
}

export type PickedFile = {
  file: File
  /** 本地就能判定的错误：格式不像图片、体积为 0。服务端仍会再判一次。 */
  localProblem: 'not_image' | 'empty' | null
}

export function classify(files: File[]): PickedFile[] {
  return files.map((file) => {
    const looksImage = file.type.startsWith('image/') || EXT_RE.test(file.name)
    let localProblem: PickedFile['localProblem'] = null
    if (!looksImage) localProblem = 'not_image'
    else if (file.size === 0) localProblem = 'empty'
    return { file, localProblem }
  })
}

/** 同名同大小视作同一份，避免同一个文件在拖拽和粘贴里各出现一次就传两遍。 */
export function dedupe(picked: PickedFile[], existingKeys: Set<string>): PickedFile[] {
  const seen = new Set(existingKeys)
  const out: PickedFile[] = []
  for (const p of picked) {
    const key = fileKey(p.file)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

export function fileKey(f: File): string {
  return `${f.name}:${f.size}`
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
 * （SPEC §6.2.2），前端只保证标识唯一。
 */
export function uniqueName(name: string, taken: Set<string>): string {
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
