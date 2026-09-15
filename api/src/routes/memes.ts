import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { requireAuth, optionalAuth, type AuthVariables, type OptionalAuthVariables } from '../middleware/auth.js'
import type { RequestIdVariables } from '../middleware/request-id.js'
import { listMemes, getMemeById } from '../data/memes.js'
import { env } from '../env.js'

/** ISO 8601 UTC 精确到秒。SPEC §1.2 */
function toIsoSeconds(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`
}

function toIsoSecondsOrNull(d: Date | null): string | null {
  if (d === null) return null
  return toIsoSeconds(d)
}

/**
 * storageKey → 公开访问 URL。图片地址由 storageKey 派生，不返回 storageKey 本身。SPEC §5.2.6
 *
 * thumbUrl 使用 `/thumb/` 前缀，约定缩略图由 CDN 或图像管线写在该路径下。
 * 如果缩略图管线尚未实现，前端会拿到一个暂时 404 的 URL，而不是拿到原图地址——
 * 这样联调时缺图一目了然，不会静默地把原图当缩略图传出去。
 */
function storageKeyToUrls(storageKey: string): { url: string; thumbUrl: string } {
  const base = env.r2PublicBaseUrl
  return {
    url: `${base}/${storageKey}`,
    thumbUrl: `${base}/thumb/${storageKey}`,
  }
}

function serializeMeme(row: {
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
  emotions: string[] | null
  scenes: string[] | null
  tags: string[] | null
  tagStatus: string
  visionModel: string | null
  editedBy: string | null
  editedAt: Date | null
  createdAt: Date
  favorited: boolean
}) {
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
    sizeBytes: row.sizeBytes.toString(),
    isAnimated: row.isAnimated,
    originalFilename: row.originalFilename,
    ocrText: row.ocrText,
    description: row.description,
    emotions: row.emotions ?? [],
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

// GET /memes 用 optionalAuth——未登录可能仍能浏览（取决于部署方，但接口本身不强制登录；
// tagStatus 参数在内部做权限检查）。GET /memes/:id 同理。
type Vars = OptionalAuthVariables

export const memesRoutes = new Hono<{ Variables: Vars }>()
  .use('*', optionalAuth)

  /**
   * GET /api/v1/memes
   *
   * 参数见 SPEC §6.3.2。tagStatus 仅本人或 admin 可用（§3.3），否则抛 FORBIDDEN。
   * 软删记录由数据层统一过滤（§3.4）。
   */
  .get('/', async (c) => {
    const actor = c.get('currentUser')

    const emotions = c.req.queries('emotions')
    const scenes = c.req.queries('scenes')
    const tags = c.req.queries('tags')

    const isAnimatedRaw = c.req.query('isAnimated')
    let isAnimated: boolean | undefined
    if (isAnimatedRaw === 'true') isAnimated = true
    else if (isAnimatedRaw === 'false') isAnimated = false

    const favoritedRaw = c.req.query('favorited')
    const favorited = favoritedRaw === 'true' ? true : undefined

    const uploader = c.req.query('uploader') ?? undefined

    const tagStatus = c.req.query('tagStatus') ?? undefined

    // tagStatus 仅本人或 admin 可用。SPEC §3.3
    if (tagStatus !== undefined) {
      if (actor === null) throw new AppError('UNAUTHENTICATED', '请先登录')
      // 只有 admin，或只查自己的图时，才能传 tagStatus
      const queryingOwn = uploader === 'me' || uploader === actor.id
      if (actor.role !== 'admin' && !queryingOwn) {
        throw new AppError('FORBIDDEN', 'tagStatus 参数只能用于查询自己的图或由管理员使用')
      }
    }

    const cursor = c.req.query('cursor') ?? undefined

    const limitRaw = c.req.query('limit')
    let limit: number | undefined
    if (limitRaw !== undefined) {
      limit = Number(limitRaw)
      if (!Number.isInteger(limit) || limit < 1) {
        throw new AppError('VALIDATION_FAILED', 'limit 必须是正整数')
      }
    }

    const { items, nextCursor } = await listMemes(
      { emotions, scenes, tags, isAnimated, favorited, uploader, tagStatus, cursor, limit },
      actor?.id ?? null,
    )

    return c.json({ items: items.map(serializeMeme), nextCursor })
  })

  /**
   * GET /api/v1/memes/:id
   *
   * 软删记录返回 NOT_FOUND。含 favorited 字段。SPEC §6.3.2
   */
  .get('/:id', async (c) => {
    const id = c.req.param('id')
    const actor = c.get('currentUser')

    const row = await getMemeById(id, actor?.id ?? null)
    if (row === null) throw new AppError('NOT_FOUND', '这张表情不存在')

    return c.json(serializeMeme(row))
  })
