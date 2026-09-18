import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { optionalAuth, type OptionalAuthVariables } from '../middleware/auth.js'
import { addFavorite, listMemes, getMemeById, removeFavorite } from '../data/memes.js'
import { getTagStatusSummary } from '../services/tag-status.js'
import { serializeMeme } from '../serialize/meme.js'

// 序列化器搬到了 `serialize/meme.ts`：搜索接口要输出同一批字段，
// 两份实现迟早会在「不返回 storageKey」这类保证上分叉。见该文件顶部注释。

// GET /memes 用 optionalAuth——未登录可能仍能浏览（取决于部署方，但接口本身不强制登录；
// tagStatus 参数在内部做权限检查）。GET /memes/:id 同理。
//
// ⚠️ 整条路由只挂 optionalAuth，**收藏那两个端点不另挂 requireAuth**：两种中间件对
//    `currentUser` 的类型要求相反（AuthUser vs AuthUser | null），同一个 Hono 实例上
//    混挂会让整条路由的 Variables 退化。所以那两个 handler 自己判 `currentUser === null`
//    并抛 UNAUTHENTICATED——错误码与 requireAuth 完全一致（SPEC §2.4）。
//    这是登录判定，不是归属判定；归属判定仍然只在 `assertCanMutate` 一处（AGENTS.md §5）。
type Vars = OptionalAuthVariables

export const memesRoutes = new Hono<{ Variables: Vars }>()
  .use('*', optionalAuth)

  /**
   * GET /api/v1/memes
   *
   * 参数见 SPEC §6.3.2。tagStatus 仅本人或 admin 可用（§3.3），否则抛 FORBIDDEN。
   * 软删记录由数据层统一过滤（§3.4）。
   *
   * `random=true` 时改为在**筛选之后**做全库随机抽样，`nextCursor` 恒为 `null`；
   * 抽样怎么实现是数据层的事，本层只负责参数解析与互斥校验。
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

    // 非 `true` 一律当 false，与 isAnimated / favorited 同一个口径。
    const random = c.req.query('random') === 'true'

    // `random` 与 `cursor` 互斥（SPEC §6.3.2）。**不静默忽略其中一个**：
    // 忽略 cursor 会悄悄回到第一页，忽略 random 会把一次随机抽样当成可翻页的列表
    // 的第一页——两种都让客户端看不出自己传错了。
    if (random && cursor !== undefined) {
      throw new AppError('VALIDATION_FAILED', 'random 与 cursor 不能同时使用')
    }

    const limitRaw = c.req.query('limit')
    let limit: number | undefined
    if (limitRaw !== undefined) {
      limit = Number(limitRaw)
      if (!Number.isInteger(limit) || limit < 1) {
        throw new AppError('VALIDATION_FAILED', 'limit 必须是正整数')
      }
    }

    const { items, nextCursor } = await listMemes(
      { emotions, scenes, tags, isAnimated, favorited, uploader, tagStatus, cursor, limit, random },
      actor?.id ?? null,
    )

    return c.json({ items: items.map(serializeMeme), nextCursor })
  })

  /**
   * GET /api/v1/memes/tag-status —— 打标状态汇总。SPEC §6.6.1
   *
   * ⚠️ **必须注册在 `/:id` 之前。** Hono 按注册顺序匹配，`tag-status` 会先被
   *    `/:id` 吃掉，表现是这个接口永远返回 NOT_FOUND——**不报错、不告警**，
   *    只是「卡着的图有多少张」永远查不到。同一个坑 `GET /imports/reviews`
   *    已经踩过并解决了（routes/imports.ts），照那条的写法来。
   *
   * 只读。列表那一半复用 `GET /memes?tagStatus=`，本接口不做列表（§6.6.2）。
   */
  .get('/tag-status', async (c) => {
    const actor = c.get('currentUser')
    if (actor === null) throw new AppError('UNAUTHENTICATED', '请先登录')

    // ⚠️ **取值必须在下面那个判断之前挡掉。** 漏了校验的话 `scope=foo` 会掉进
    //    「不是 mine」那一支，等于给非管理员开了 `all` 的口子——静默越权。
    const rawScope = c.req.query('scope')
    if (rawScope !== undefined && rawScope !== 'mine' && rawScope !== 'all') {
      throw new AppError('VALIDATION_FAILED', 'scope 只能是 mine 或 all')
    }
    const scope = rawScope ?? 'mine'

    if (scope === 'all' && actor.role !== 'admin') {
      throw new AppError('FORBIDDEN', 'scope=all 仅管理员可用')
    }

    return c.json(await getTagStatusSummary(scope, actor.id))
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

  /**
   * PUT /api/v1/memes/:id/favorite —— 收藏。SPEC §6.4
   *
   * **幂等**：已收藏再调一次仍返回 204。PUT 是幂等动词，而前端会重发——
   * 双击、断网重试、乐观更新回滚后重来，都会来第二次。
   *
   * **收藏是人和图的关系，不是图的属性**（SPEC §5.4）：只写 `user_favorites`，
   * 不动 `memes`，因此也不走 `assertCanMutate`——收藏别人的图是共享库的正常用法，
   * 不是对那张图的改动。软删过滤与 NOT_FOUND 在数据层，handler 不自己拼条件。
   */
  .put('/:id/favorite', async (c) => {
    const actor = c.get('currentUser')
    if (actor === null) throw new AppError('UNAUTHENTICATED', '请先登录')

    await addFavorite(actor.id, c.req.param('id'))
    return c.body(null, 204)
  })

  /**
   * DELETE /api/v1/memes/:id/favorite —— 取消收藏。SPEC §6.4
   *
   * **幂等**：没收藏过也返回 204。和 PUT 是一对，行为必须对称，
   * 否则前端的乐观更新会在「重复取消」时莫名其妙地回滚。
   */
  .delete('/:id/favorite', async (c) => {
    const actor = c.get('currentUser')
    if (actor === null) throw new AppError('UNAUTHENTICATED', '请先登录')

    await removeFavorite(actor.id, c.req.param('id'))
    return c.body(null, 204)
  })
