import { publicUrlFor, thumbKeyFor } from '../storage/r2.js'

/**
 * `memes` 行的对外序列化。**浏览和搜索共用同一个函数** —— 两条路径各写一份的话，
 * 「不返回 storageKey」这类保证迟早只在其中一处成立。
 *
 * 字段清单见 SPEC §5.2.6。**不返回**：contentHash、phash、embedding、searchText、
 * embedModel、deletedAt、storageKey —— 它们是内部字段，客户端没有消费场景。
 *
 * 数据库 snake_case → 接口 camelCase 的转换只在这一层发生（SPEC §7.1）。
 */

/** ISO 8601 UTC 精确到秒。SPEC §1.2 */
export function toIsoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`
}

export function toIsoSecondsOrNull(date: Date | null): string | null {
  if (date === null) return null
  return toIsoSeconds(date)
}

/**
 * storageKey → 公开访问 URL。图片地址由 storageKey 派生，不返回 storageKey 本身（SPEC §5.2.6）。
 *
 * **两段推导各自只有一份实现**，这里一份都不重写：
 * 路径经 `thumbKeyFor`（与写缩略图共用），URL 经 `publicUrlFor`（与待确认队列的
 * `tempUrl` 共用，前缀在那里加）。
 *
 * 两份实现的代价这个函数付过两次：先是自己推过一套 `/thumb/<storageKey>`，与
 * `storage/r2.ts` 的 `thumbs/<...>.webp` 对不上；修掉之后路径统一了、URL 拼接没统一，
 * 于是又自己拼了一遍 base + key，漏掉 `R2_KEY_PREFIX`。**两次的表现都是不报错、只是图片 404。**
 */
function storageKeyToUrls(storageKey: string): { url: string; thumbUrl: string } {
  return {
    url: publicUrlFor(storageKey),
    thumbUrl: publicUrlFor(thumbKeyFor(storageKey)),
  }
}

/** 序列化需要的字段，显式写出而不是吃整个 row —— 多一个字段进不了响应。 */
export type SerializeMemeInput = {
  id: string
  uploaderId: string
  uploaderName: string
  storageKey: string
  originalFilename: string | null
  mime: string
  width: number | null
  height: number | null
  sizeBytes: bigint
  isAnimated: boolean
  ocrText: string | null
  description: string | null
  expressions: string[] | null
  emotions: string[] | null
  tones: string[] | null
  purposes: string[] | null
  scenes: string[] | null
  tags: string[] | null
  tagStatus: string
  visionModel: string | null
  editedBy: string | null
  editedAt: Date | null
  createdAt: Date
  favorited: boolean
}

export type SerializedMeme = ReturnType<typeof serializeMeme>

export function serializeMeme(row: SerializeMemeInput) {
  const { url, thumbUrl } = storageKeyToUrls(row.storageKey)
  return {
    id: row.id,
    uploaderId: row.uploaderId,
    uploaderName: row.uploaderName,
    url,
    thumbUrl,
    mime: row.mime,
    width: row.width,
    height: row.height,
    // bigint 不能进 JSON，转字符串；前端按需要 Number()（上一版接口如此，不在这里改契约）
    sizeBytes: row.sizeBytes.toString(),
    isAnimated: row.isAnimated,
    originalFilename: row.originalFilename,
    ocrText: row.ocrText,
    description: row.description,
    // 六个数组字段在库里可为 null，对外一律是数组。客户端不该处理 null 和 [] 两种空。
    // 顺序跟 SPEC §5.2.6 的清单一致：表情 → 情绪 → 语气 → 用途 → 情境 → 主体风格。
    expressions: row.expressions ?? [],
    emotions: row.emotions ?? [],
    tones: row.tones ?? [],
    purposes: row.purposes ?? [],
    scenes: row.scenes ?? [],
    tags: row.tags ?? [],
    tagStatus: row.tagStatus,
    visionModel: row.visionModel,
    favorited: row.favorited,
    editedBy: row.editedBy ?? null,
    editedAt: toIsoSecondsOrNull(row.editedAt),
    createdAt: toIsoSeconds(row.createdAt),
  }
}
