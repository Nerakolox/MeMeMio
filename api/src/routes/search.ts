import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import { db as defaultDb } from '../data/db.js'
import { MAX_LIST_LIMIT } from '../data/memes.js'
import { DEFAULT_SEARCH_LIMIT, searchMemes } from '../services/search.js'
import { serializeMeme } from '../serialize/meme.js'

/**
 * GET /api/v1/search —— **冻结的兼容入口**（SPEC §6.3.3）。
 *
 * 它 ≡ `GET /memes?q=` 的一个子集，**同一个实现，不再演进**：内部复用
 * `services/search.ts` 的 `runSearch` / `fetchHits`，与 `GET /memes?q=` 共用召回与融合。
 *
 * | | 这个入口 | `GET /memes?q=` |
 * |---|---|---|
 * | 认哪些参数 | 只有 `q` 与 `limit` | `q` + 全部筛选 + `cursor` + `random` |
 * | `q` 缺省 | **报错** | 空串按「无 `q`」处理 |
 * | 分页 | 不分页，`nextCursor` 恒为 `null` | 快照游标 |
 * | `limit` 缺省 | **50**（冻结） | 40（SPEC §1.3） |
 *
 * 前两行两条相反是**故意的**：这里的语义是「一次检索」，没有查询词就没有请求的对象；
 * 而清空搜索框是一个常规操作，不是非法请求。
 *
 * **为什么留着它**：首页那条路径走的就是它（`web/src/lib/api.ts` 的 `fetchSearch`），
 * 而首页的去向还没定（[页面地图](../../joint-tasks/2026-09-25-web-page-map.md)）。
 * **新能力一律只加在 `GET /memes` 上。**
 *
 * ⚠️ **`limit` 的缺省冻结在 50，不要顺手对齐到 40。** 首页不传 `limit`，默认值由服务端
 *    说了算——对齐过去等于**静默改掉首页看到的条数**，而首页本轮一行不动
 *    （[检索与筛选合流](../../joint-tasks/2026-09-26-检索筛选合一.md) 裁定 3）。
 *    §6.3.3 的「同一个实现」说的是**代码路径**，不是参数默认值。
 */

/**
 * 这个入口认的参数，**只有这两个**（SPEC §6.3.3）。
 *
 * 其余参数一律 `VALIDATION_FAILED` 而不是静默忽略：忽略会让 `/search?tags=猫` 悄悄
 * 变成一次浏览——一个叫 `/search` 的地址给出不搜的结果，是本项目最忌讳的
 * 「客户端看不出错的错误结果」。这也与 SPEC §0.4「请求未知字段返回 `VALIDATION_FAILED`」
 * 同一条规则。
 */
const ALLOWED_PARAMS = ['q', 'limit']

/**
 * **要求登录**（SPEC §3.3：搜索 / 浏览 / 使用，所有登录用户）。
 *
 * 曾经挂的是 `optionalAuth`，理由是「未登录也能搜，favorited 恒为 false」——
 * 那是把 §3.3 读成了「匿名可用」。实际代价有两层：全库内容对未登录者开放，
 * 以及每次匿名搜索都会走**部署方**的 embedding 通道（用户没带自己的配置时
 * 按部署方解析），等于把部署方的 AI 额度挂在公网上。SPEC 里从来没有这个选项。
 *
 * 于是 `favorited` 不再需要一个「匿名就是 false」的分支：`actor` 一定存在。
 */
type Vars = AuthVariables

export const searchRoutes = new Hono<{ Variables: Vars }>()
  .use('*', requireAuth)

  .get('/', async (c) => {
    for (const key of Object.keys(c.req.query())) {
      if (!ALLOWED_PARAMS.includes(key)) {
        throw new AppError('VALIDATION_FAILED', `这个入口只认 q 与 limit，不认识：${key}`)
      }
    }

    const q = (c.req.query('q') ?? '').trim()
    if (q === '') {
      // 缺 q 和 q 是空白串对客户端是同一件事：没有查询词。都给 400，不要返回全库
      throw new AppError('VALIDATION_FAILED', '缺少查询参数 q')
    }

    const limitRaw = c.req.query('limit')
    let limit = DEFAULT_SEARCH_LIMIT
    if (limitRaw !== undefined) {
      limit = Number(limitRaw)
      if (!Number.isInteger(limit) || limit < 1) {
        throw new AppError('VALIDATION_FAILED', 'limit 必须是正整数')
      }
      // 超过上限时**截断而不是报错**：这是上限，不是校验规则
      if (limit > MAX_LIST_LIMIT) limit = MAX_LIST_LIMIT
    }

    const actor = c.get('currentUser')
    const requestId = c.get('requestId')

    const outcome = await searchMemes(q, limit, actor.id, requestId, defaultDb)

    return c.json({
      items: outcome.items.map((item) => ({ ...serializeMeme(item), matchedBy: item.matchedBy })),
      // 它不分页（SPEC §6.3.3）。恒为 null 而不是「没有下一页」——
      // 客户端看到 null 就该停止，而这里确实永远没有下一页
      nextCursor: null,
      degraded: outcome.degraded,
      rewritten: outcome.rewritten,
    })
  })
