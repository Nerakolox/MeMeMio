import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { isUuid } from '../lib/uuid.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import {
  addFavorite,
  listMemes,
  getMemeById,
  removeFavorite,
  softDeleteMeme,
  updateMemeContent,
  TAG_STATUSES,
  type Actor,
  type MemeContentPatch,
  type MemeFilter,
} from '../data/memes.js'
import { db } from '../data/db.js'
import type { VocabField } from '../lib/vision-output.js'
import { VOCAB_FIELDS, vocabAdapter } from '../vocab.js'
import { getTagStatusSummary } from '../services/tag-status.js'
import { retagMemes, type RetagInput } from '../services/retag.js'
import { searchFirstPage, searchNextPage } from '../services/search-snapshot.js'
import { serializeMeme } from '../serialize/meme.js'

// 序列化器搬到了 `serialize/meme.ts`：搜索接口要输出同一批字段，
// 两份实现迟早会在「不返回 storageKey」这类保证上分叉。见该文件顶部注释。

/**
 * 整条路由**要求登录**（SPEC §3.3：搜索 / 浏览 / 使用，所有登录用户）。
 *
 * 「未登录也能浏览」曾经在这里挂过 `optionalAuth`，那等于把全库和部署方的 AI 额度
 * 对外开放（匿名搜索走部署方的 embedding）——SPEC §3.3 从来没有给过这个选项。
 * 权限只有一个来源：`requireAuth` 判「登录」，`assertCanMutate` 判「归属」
 * （AGENTS.md §5），handler 里不自己拼任何一条。
 */
type Vars = AuthVariables

/**
 * `:id` 路径参数的 uuid 形状校验。
 *
 * ⚠️ **不挡的话 `eq(memes.id, 'abc')` 会撞 Postgres 的 `invalid input syntax for type uuid`**，
 *    那是 500，不是 404 ——「服务器内部错误」回应了一个错字。
 *
 * 报 **404 而不是 400**：路径上的资源不存在，前端对 `/memes/xxx` 一律渲染空状态。
 * 形状合法但不存在的 uuid 走的是同一条 `NOT_FOUND`，**这两种情况对客户端是同一件事**，
 * 分开报只会让人以为「格式对了就查得到」。查询参数上的 uuid（`?uploader=`）相反，
 * 那一个是「参数写错了」，报 `VALIDATION_FAILED`（见 `GET /` 里那段）。
 */
function requireUuidId(raw: string | undefined): string {
  if (raw === undefined || !isUuid(raw)) throw new AppError('NOT_FOUND', '这张表情不存在')
  return raw
}

// ── PATCH /memes/:id 的请求体（SPEC §6.4.1） ───────────────────────
//
// 校验写在这里而不是通用中间件：字段少，而「缺字段就当空」那种写法会让
// 不传 / `null` / `[]` 三种传法混成一种，那正是本节要区分的。

/**
 * 可编辑字段。**`ocrText` 不在里面**——它是模型对图像的读数，人工改它会让
 * 文本和图不再对应，而 `search_text` 会忠实转发这个错（SPEC §6.4.1）。
 */
const EDITABLE_FIELDS = ['description', ...VOCAB_FIELDS] as const

/**
 * 七个数组字段的元素校验。**按维度校验**——一个词只属于一个维度（SPEC §4.3.2），
 * 把 `微笑` 传进 `emotions` 和传一个不存在的词一样会被拒，这正是拆维度要挡住的错误。
 * **走 `vocab.ts` 的 `vocabAdapter`**（`alias()` 归一化 →
 * `isKnownLabel()` 判定），和打标写回同一套——另写一份的表现是模型输出过得去、
 * 人工编辑过不去（或反过来）。`vocab.ts` 顶部写着「全进程只有这一份」。
 *
 * 词表外返回 **`VALIDATION_FAILED`（400）**，不是 `AI_INVALID_OUTPUT`：后者描述的是
 * 模型输出的失败，会走重试与降级。人工编辑是一次普通请求，客户端要展示的是
 * 「这个词不在词表里，请从列表里选」。用错的表现是编辑失败时前端去等一个**永远不会来的**
 * AI 降级——没有报错，只是屏幕上什么都没有（SPEC §4.5 / §6.4.1）。
 *
 * 空串和重复项都不特殊对待：空串不在词表里，走同一条拒绝路径（**不静默丢掉**，
 * 丢了前端会以为存上了）；重复项归一化后去重，与 `lib/vision-output.ts` 的过滤同口径。
 */
function parseLabels(field: VocabField, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AppError('VALIDATION_FAILED', `${field} 必须是数组`)
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new AppError('VALIDATION_FAILED', `${field} 的每一项必须是字符串`)
    }
    const canonical = vocabAdapter.alias(item.trim())
    if (!vocabAdapter.isKnown(field, canonical)) {
      throw new AppError('VALIDATION_FAILED', `不在词表里：${item}`)
    }
    if (seen.has(canonical)) continue
    seen.add(canonical)
    out.push(canonical)
  }
  return out
}

function parseEditBody(raw: unknown): MemeContentPatch {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象')
  }
  const body = raw as Record<string, unknown>

  // 未知字段一律拒绝，**包括 `ocrText`**。静默忽略看起来更宽容，但前端会以为改成功了，
  // 而 `ocrText` 是只读字段——那个「成功」是假的。
  for (const key of Object.keys(body)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) {
      throw new AppError('VALIDATION_FAILED', `不可编辑的字段：${key}`)
    }
  }

  const patch: MemeContentPatch = {}

  if (body['description'] !== undefined) {
    const value = body['description']
    if (value !== null && typeof value !== 'string') {
      throw new AppError('VALIDATION_FAILED', 'description 必须是字符串或 null')
    }
    // `null` 是「清空描述」，与「不传」不同（§6.4.1 的表）。空串照存，它只是空描述。
    patch.description = value === null ? null : value.trim()
  }

  for (const field of VOCAB_FIELDS) {
    const value = body[field]
    if (value !== undefined) patch[field] = parseLabels(field, value)
  }

  return patch
}

// ── POST /memes/retag 的请求体（SPEC §6.4.3） ──────────────────────

/**
 * `{ memeIds: [...] }` 或 `{ filter: {...} }`——**恰好给一个**（SPEC §6.4.3）。
 *
 * 未知键一律拒绝，与 `parseEditBody` 同一条规则。**这包括 `useDefaultConfig`**：
 * 契约里那个参数在 v1 不实现（配置按上传者解析，见 §6.4.3），而接受一个不生效的
 * 参数比拒绝它更坏——管理员会以为「用部署方通道重打」生效了。拒绝的写法让它立刻可见。
 *
 * ⚠️ **`memeIds: []` 是合法的空集，不是「没给」。** 把它当缺省会让
 *    「想重打一张、结果全库付了一遍钱」——而这两个在客户端看起来一模一样
 *    （都是「这个字段没内容」）。所以判的是字段**在不在**，不是数组**空不空**。
 *
 * ⚠️ **uuid 形状要在这里挡掉。** 不挡的话 `inArray(memes.id, ['abc'])` 会撞
 *    Postgres 的 `invalid input syntax for type uuid`，那是 500 而不是 400
 *    （`app.onError` 把非 `AppError` 一律当 `INTERNAL`）。客户端传了个错字，
 *    得到的是「服务器内部错误」。判定走 `lib/uuid.ts`，全端一份。
 */
function parseRetagBody(raw: unknown, actor: Actor): RetagInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 JSON 对象')
  }
  const body = raw as Record<string, unknown>

  for (const key of Object.keys(body)) {
    if (key !== 'memeIds' && key !== 'filter') {
      throw new AppError('VALIDATION_FAILED', `无法识别的字段：${key}`)
    }
  }

  const hasIds = body['memeIds'] !== undefined
  const hasFilter = body['filter'] !== undefined
  if (hasIds === hasFilter) {
    throw new AppError('VALIDATION_FAILED', 'memeIds 与 filter 必须恰好给一个')
  }

  if (hasIds) {
    const value = body['memeIds']
    if (!Array.isArray(value)) {
      throw new AppError('VALIDATION_FAILED', 'memeIds 必须是数组')
    }
    // 去重放在服务层（它要拿去重后的数量比对查回来的行数），这里只校验形状
    for (const item of value) {
      if (typeof item !== 'string' || !isUuid(item)) {
        throw new AppError('VALIDATION_FAILED', 'memeIds 的每一项必须是 uuid')
      }
    }
    return { kind: 'ids', memeIds: value }
  }

  const rawFilter = body['filter']
  if (typeof rawFilter !== 'object' || rawFilter === null || Array.isArray(rawFilter)) {
    throw new AppError('VALIDATION_FAILED', 'filter 必须是 JSON 对象')
  }
  const filter = rawFilter as Record<string, unknown>
  for (const key of Object.keys(filter)) {
    if (key !== 'uploader' && key !== 'tagStatus') {
      throw new AppError('VALIDATION_FAILED', `filter 里无法识别的字段：${key}`)
    }
  }

  const rawUploader = filter['uploader']
  if (rawUploader !== undefined && typeof rawUploader !== 'string') {
    throw new AppError('VALIDATION_FAILED', 'filter.uploader 必须是字符串')
  }

  /*
   * ⚠️ **枚举校验必须在角色判断之前。** 顺序反了的话 `tagStatus: 'foo'` 对
   *    非管理员会掉进「不是 all」那一支、对管理员会掉进「没有这个条件」那一支，
   *    两种都变成「静默放宽」——`GET /tag-status` 的 `scope=foo` 就是同一个坑
   *    （routes/memes.ts 里那段注释）。非法输入不论谁传都是 400。
   */
  const rawTagStatus = filter['tagStatus']
  if (rawTagStatus !== undefined) {
    if (typeof rawTagStatus !== 'string') {
      throw new AppError('VALIDATION_FAILED', 'filter.tagStatus 必须是字符串')
    }
    if (!(TAG_STATUSES as readonly string[]).includes(rawTagStatus)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `filter.tagStatus 只能是 ${TAG_STATUSES.join(' / ')}`,
      )
    }
  }

  /*
   * 收窄到调用者自己，是**本接口与 `GET /memes?tagStatus=` 的一处刻意不同**。
   *
   * 那个接口在缺 `uploader` 时 `tagStatus` 是**全库**过滤，所以非管理员必须被
   * 挡成 `FORBIDDEN`（否则能查到别人的待处理图）。这里反过来：**缺省就收窄**，
   * 于是根本不存在「查到了别人的」这个中间状态，也就不需要那条 403。
   * 两种写法都对，差别是这里可以更宽——用户会自然地传 `filter: {}` 说
   * 「重打我的图」，为此报 403 只会让他去猜参数。
   *
   * 显式指向**别人**仍然 `FORBIDDEN`，**不是静默收窄**：静默收窄的表现是
   * 「请求成功了，但只重打了自己的」——那个人以为别人的图也重打了。
   */
  let uploaderId: string | null
  if (rawUploader === undefined) {
    // 不传 = 「我管得着的那些」：管理员是全库，其他人是自己的图
    uploaderId = actor.role === 'admin' ? null : actor.id
  } else if (rawUploader === 'me') {
    uploaderId = actor.id
  } else {
    // 形状先于角色，和上面 tagStatus 那条同一个道理：`uploader: 'everyone'` 是
    // **参数写错了**，不是「权限不够」。判成 403 会把用户送去要管理员权限，
    // 而他要改的是一个错字。
    if (!isUuid(rawUploader)) {
      throw new AppError('VALIDATION_FAILED', 'filter.uploader 必须是 "me" 或 uuid')
    }
    if (actor.role !== 'admin') {
      throw new AppError('FORBIDDEN', '只有管理员能重打别人的图')
    }
    uploaderId = rawUploader
  }

  return { kind: 'filter', uploaderId, tagStatus: rawTagStatus ?? null }
}

/**
 * 列表响应里的一条：`Meme` 加一个 `matchedBy`。
 *
 * 两个分支（有 `q` / 无 `q`）返回的是同一个形状（SPEC §6.3「响应形状恒定」），所以这个
 * 类型要**显式写出来**而不是让两个 `map` 各推一个：无 `q` 时恒为 `[]` 的那种写法会被
 * TS 推成 `never[]`，而它正好是 Hono RPC 推给前端的那个类型。
 */
type ListItem = ReturnType<typeof serializeMeme> & { matchedBy: string[] }

export const memesRoutes = new Hono<{ Variables: Vars }>()
  .use('*', requireAuth)

  /**
   * GET /api/v1/memes —— **唯一的列表端点**（SPEC §6.3）。
   *
   * 按请求里有没有 `q` 分派：
   *
   * | | 无 `q` | 有 `q` |
   * |---|---|---|
   * | 召回 | 按条件筛（§6.3.2） | **在筛后的候选集里**三路召回 + RRF 融合（§6.3.1） |
   * | 排序 | `created_at desc, id desc` | 融合分 `desc`（`id` 兜底） |
   * | 游标 | `(created_at, id)` 全序上的位置 | 一次检索快照里的位置（`services/search-snapshot.ts`） |
   *
   * **响应形状恒定**：两种请求都给 `items` / `nextCursor` / `degraded` / `rewritten`，
   * 每条 item 都带 `matchedBy`（无 `q` 时恒为 `[]`）。不按模式变字段——Hono RPC 推出来的
   * 类型是两端唯一的同步手段，两种形状会让前端每个消费点都要分支。
   *
   * 参数校验（七个维度、`isAnimated`、`favorited`、`uploader`、`tagStatus`）**两种模式共用**，
   * 而且位置是「三路召回之前」（§6.3.1「先过滤后召回」）。
   */
  .get('/', async (c) => {
    const actor = c.get('currentUser')

    // 七个维度各自可重复，所有值之间都是 AND（SPEC §6.3.2）。
    // 这里**不校验词表**：浏览筛选传了词表外的词，结果就是搜不到，不是请求错误。
    const labels: MemeFilter = {}
    for (const field of VOCAB_FIELDS) {
      const values = c.req.queries(field)
      if (values !== undefined) labels[field] = values
    }

    const isAnimatedRaw = c.req.query('isAnimated')
    let isAnimated: boolean | undefined
    if (isAnimatedRaw === 'true') isAnimated = true
    else if (isAnimatedRaw === 'false') isAnimated = false

    const favoritedRaw = c.req.query('favorited')
    const favorited = favoritedRaw === 'true' ? true : undefined

    const uploader = c.req.query('uploader') ?? undefined

    /*
     * `uploader` 只有两个合法形态：`me` 或一个 uuid。
     *
     * ⚠️ **形状要在这里挡掉。** 不挡的话 `eq(memes.uploader_id, 'abc')` 会撞 Postgres 的
     *    `invalid input syntax for type uuid` —— 那是 500，不是「查不到」。这里是查询参数，
     *    所以报 `VALIDATION_FAILED`（路径参数上的 id 报 `NOT_FOUND`，见下面 `/:id`）。
     */
    if (uploader !== undefined && uploader !== 'me' && !isUuid(uploader)) {
      throw new AppError('VALIDATION_FAILED', 'uploader 必须是 "me" 或 uuid')
    }

    const tagStatus = c.req.query('tagStatus') ?? undefined

    // tagStatus 仅本人或 admin 可用。SPEC §3.3
    if (tagStatus !== undefined) {
      // 只有 admin，或只查自己的图时，才能传 tagStatus
      const queryingOwn = uploader === 'me' || uploader === actor.id
      if (actor.role !== 'admin' && !queryingOwn) {
        throw new AppError('FORBIDDEN', 'tagStatus 参数只能用于查询自己的图或由管理员使用')
      }
    }

    const cursor = c.req.query('cursor') ?? undefined

    // 非 `true` 一律当 false，与 isAnimated / favorited 同一个口径。
    const random = c.req.query('random') === 'true'

    const limitRaw = c.req.query('limit')
    let limit: number | undefined
    if (limitRaw !== undefined) {
      limit = Number(limitRaw)
      if (!Number.isInteger(limit) || limit < 1) {
        throw new AppError('VALIDATION_FAILED', 'limit 必须是正整数')
      }
    }

    const filter: MemeFilter = { ...labels, isAnimated, favorited, uploader, tagStatus }

    /*
     * ⚠️ **`q` 去空白后为空走「无 `q`」分支，不报错。** 用户清空搜索框是常规操作，
     *    不是非法请求（SPEC §6.3.1）。`GET /search` 那边相反——缺 `q` 就报错，
     *    因为它的语义是「一次检索」，没有查询词就没有请求的对象（§6.3.3）。
     *    **两条相反是故意的**，别顺手对齐。
     */
    const q = (c.req.query('q') ?? '').trim()

    if (q !== '') {
      // `q` 与 `random` 互斥（SPEC §6.3.1）。理由同 `random` + `cursor`：
      // 忽略哪一个都是客户端看不出错的错误结果
      if (random) throw new AppError('VALIDATION_FAILED', 'q 与 random 不能同时使用')

      const requestId = c.get('requestId')
      const page =
        cursor === undefined
          ? await searchFirstPage({ query: q, filter, actorId: actor.id, requestId, limit, db })
          : await searchNextPage({ cursor, actorId: actor.id, requestId, limit, db })

      const items: ListItem[] = page.items.map((item) => ({
        ...serializeMeme(item),
        matchedBy: item.matchedBy,
      }))

      return c.json({
        items,
        nextCursor: page.nextCursor,
        degraded: page.degraded,
        rewritten: page.rewritten,
      })
    }

    // `random` 与 `cursor` 互斥（SPEC §6.3.2）。**不静默忽略其中一个**：
    // 忽略 cursor 会悄悄回到第一页，忽略 random 会把一次随机抽样当成可翻页的列表
    // 的第一页——两种都让客户端看不出自己传错了。
    if (random && cursor !== undefined) {
      throw new AppError('VALIDATION_FAILED', 'random 与 cursor 不能同时使用')
    }

    const { items, nextCursor } = await listMemes({ ...filter, cursor, limit, random }, actor.id)
    const serialized: ListItem[] = items.map((item) => ({ ...serializeMeme(item), matchedBy: [] }))

    return c.json({
      // 无 `q` 时的三个检索字段是**常量**，不是缺省：形状恒定才有一个类型（SPEC §6.3）
      items: serialized,
      nextCursor,
      degraded: false,
      rewritten: null,
    })
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
   * POST /api/v1/memes/retag —— 批量重打标。SPEC §6.4.3
   *
   * 用途：让已有的图按**当前**的提示词与词表重跑一遍视觉模型。改提示词或词表之后
   * 存量图不会自己更新，没有这个接口就只能人工逐张 `PATCH`。
   *
   * ⚠️ **它不幂等。** 再点一次就是再花一遍全库的视觉调用，花的是**图片上传者**的预算
   *    （配置按 `uploader_id` 解析）。`enqueuedCount: 0` 只说明「没有新排上的」——
   *    上一轮跑完之后再点，全库会重新排上。**不要照抄 `/admin/reindex` 的
   *    「重复触发是安全的」**：那条幂等且免费，这条不是。
   *
   * 进度**不在这里报**：重打没有自己的任务表，跑完库里也没有痕迹。界面轮询
   * `GET /memes/tag-status?scope=all`（§6.6.2：「不另做接口」）。
   *
   * 权限是「上传者或 admin」，逐行判在 `services/retag.ts` 里走 `assertCanMutate`
   * ——**handler 不自己拼归属条件**（AGENTS.md §5）。这里只判登录。
   *
   * ⚠️ **路由顺序在这里不是承重的。** Hono 按注册顺序匹配，但那条只对**同方法**
   *    的路由成立：`/retag` 与 `GET /:id` 方法不同，注册在它后面照样命中。
   *    （`/tag-status` 上面那段警告说的是 GET 之间的事，别照抄过来。）
   *    所以这里不靠顺序，靠一条**请求级测试**盯着它别变成 404。
   */
  .post('/retag', async (c) => {
    const actor = c.get('currentUser')

    const raw: unknown = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON')
    })

    return c.json(await retagMemes(parseRetagBody(raw, actor), actor))
  })

  /**
   * GET /api/v1/memes/:id
   *
   * 软删记录返回 NOT_FOUND。含 favorited 字段。SPEC §6.3.2
   */
  .get('/:id', async (c) => {
    const id = requireUuidId(c.req.param('id'))
    const actor = c.get('currentUser')

    const row = await getMemeById(id, actor.id)
    if (row === null) throw new AppError('NOT_FOUND', '这张表情不存在')

    return c.json(serializeMeme(row))
  })

  /**
   * PATCH /api/v1/memes/:id —— 人工改 description 与三个标签数组。SPEC §6.4.1
   *
   * **权限是「所有人」**：非上传者改别人的图必须成功。这是 SPEC §9.1 有意的不对称，
   * 而归属判定**只在 `assertCanMutate` 一处**（AGENTS.md §5）——handler 里
   * **不要「顺手补一个归属检查」**，哪怕写对了也是错的：下一个人会照着它再写一遍。
   *
   * 响应是**更新后的完整 Meme**，与 `GET /:id` 同形，客户端据此就地更新列表、不再拉一次。
   */
  .patch('/:id', async (c) => {
    const actor = c.get('currentUser')
    const id = requireUuidId(c.req.param('id'))

    const raw: unknown = await c.req.json().catch(() => {
      throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON')
    })

    const updated = await updateMemeContent(id, actor, parseEditBody(raw))
    return c.json(serializeMeme(updated))
  })

  /**
   * DELETE /api/v1/memes/:id —— 软删，204。SPEC §6.4.2
   *
   * **不幂等**：对一条已软删的记录再调一次是 `NOT_FOUND`，不是 204。与收藏那两条刻意
   * 不同——那两条幂等是因为前端会重发（双击、断网重试、乐观更新回滚），而**删除不做
   * 乐观更新**，客户端不会在没看到结果的情况下再发一次。剩下的重复调用只可能来自
   * 「这张图已经不在列表里了」，此时 404 比 204 诚实，客户端把它当成功处理即可。
   *
   * 归属判定在 `softDeleteMeme` 里的 `assertCanMutate(meme, actor, 'delete')`，
   * **这里不重复判一遍**；软删过滤也在那一层（先查 `deleted_at is null` 再判权限）。
   */
  .delete('/:id', async (c) => {
    const actor = c.get('currentUser')

    await softDeleteMeme(requireUuidId(c.req.param('id')), actor)
    return c.body(null, 204)
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

    await addFavorite(actor.id, requireUuidId(c.req.param('id')))
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

    await removeFavorite(actor.id, requireUuidId(c.req.param('id')))
    return c.body(null, 204)
  })
