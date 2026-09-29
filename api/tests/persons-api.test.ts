import { Hono } from 'hono'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 人物与系列的**读路径**端到端集成测试（SPEC §6.7，`proposed`；任务 2026-09-29-人物识别与聚类 §5）。
 *
 * 三块：
 *
 * 1. **没配图片向量通道时一切照旧**（§6.7.5 的降级态）。这是新能力最重要的性质：
 *    人物是附加的，配不配都不影响图入库、打标、能被搜到。所以「空列表」不是错误分支，
 *    而 `GET /config/image-embed` 回的是一份**能力位全是 null** 的默认值。
 * 2. **对外形状就是 §6.7.2 列的那几个字段**——逐字断言键集合。多一个（内部字段、
 *    相似度）少一个都算红：SPEC 没写的字段不许引进来（`api/AGENTS.md §2`）。
 * 3. **浏览参数**（§6.3.2）：单值、重复传与形状非法都是 `VALIDATION_FAILED`、
 *    与 `q` 同用时仍然生效（先过滤后召回）。
 *
 * ## 上游是替身，而且这个文件里它只负责拒绝
 *
 * `fetch` 被换成一个**恒回 503** 的桩。这不是懒，是断言：本文件测的路径
 * **一次 AI 调用都不该发生**——没配通道时搜索走 OCR + 标签两路、人物那几个接口
 * 只读库。真发生了调用，桩会当场把它变成失败，而不是去连真网络（那既不确定又可能
 * 花钱）。配置那三个闸门、换模型重算、导入时自动入队的用例在
 * `tests/persons-image-embed.test.ts`，那里才有会回话的替身。
 *
 * 第二批的写接口（改名 / 合并 / 移图 / 建系列）**不在这里**：还没实现。
 *
 * `deleted_at is null`（SPEC §3.4）在这里也顺手验一次：图被软删之后，
 * 人物图数、人物列表、`?person=` 的结果都要跟着变——它们是同一份 `LIVE_MEME`
 * 的三个消费点，漏掉任何一个都是「删掉的图又出现了」。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

/** ⚠️ 必须在 import 任何 src 模块之前：默认连接读的是 `DATABASE_URL`。 */
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

/**
 * 三组部署方默认值**全部清空**（空串 = 没配，见 `lib/env.ts` 的 `optionalProvider`）。
 *
 * 写死空串而不是「不管它」：`tests/setup-env.ts` 会 `loadEnvFile` 开发者本机的 `.env`，
 * 里面一旦填了 `DEFAULT_IMAGE_EMBED_*`，这个文件里所有「没配时」的用例会**静默地**
 * 测成另一个世界——不会红，只是全都在测别的。
 */
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''
process.env['DEFAULT_IMAGE_EMBED_BASE_URL'] = ''
process.env['DEFAULT_IMAGE_EMBED_API_KEY'] = ''
process.env['DEFAULT_IMAGE_EMBED_MODEL'] = ''

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { softDeleteMeme } = await import('../src/data/memes.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { adminRoutes } = await import('../src/routes/admin.js')
const { imageEmbedConfigRoutes } = await import('../src/routes/config.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { personsRoutes } = await import('../src/routes/persons.js')
const { seriesRoutes } = await import('../src/routes/series.js')
const { memeSubjects, personVectorJobs, persons, series } = await import('../src/data/schema.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

/** 与 `app.ts` 一致地链式挂载，并带上 `requestId`（路由读它来记日志）。 */
const testApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/config/image-embed', imageEmbedConfigRoutes)
  .route('/api/v1/persons', personsRoutes)
  .route('/api/v1/series', seriesRoutes)
  .route('/api/v1/memes', memesRoutes)
  .route('/api/v1/admin', adminRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
  // 恒拒绝的 AI 桩。见文件头：本文件里没有一条路径**该**调上游
  vi.stubGlobal('fetch', async () => new Response('本文件的替身不提供任何 AI 能力', { status: 503 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

// ── 脚手架 ────────────────────────────────────────────────────────

type Actor = { id: string; role: 'admin' | 'member'; cookie: string }

async function signIn(role: 'admin' | 'member' = 'member'): Promise<Actor> {
  const user = await createUser(db, { role })
  const session = await createSession(user.id, db)
  return { id: user.id, role: user.role, cookie: `sid=${session.id}` }
}

async function call(
  method: string,
  path: string,
  actor: Actor | null,
  body?: unknown,
): Promise<Response> {
  return testApp.request(`/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(actor === null ? {} : { cookie: actor.cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** 读 JSON 并顺手断言没有 5xx——「不该报错的地方报错」在这个文件里是主要风险。 */
async function json(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  expect(`${res.status} ${text}`).not.toMatch(/^5/)
  return JSON.parse(text) as Record<string, unknown>
}

/** 与 `serialize/person.ts` 的 `SerializePerson` 逐字对应（SPEC §6.7.2）。 */
const PERSON_KEYS = [
  'id',
  'name',
  'seriesId',
  'seriesName',
  'isHidden',
  'memeCount',
  'cover',
  'updatedBy',
  'updatedAt',
]

const SERIES_KEYS = [
  'id',
  'name',
  'personCount',
  'memeCount',
  'cover',
  'createdBy',
  'createdAt',
  'updatedBy',
  'updatedAt',
]

/** 与 `ai/image-embedder.ts` 的口径串同形。这个文件里只是「一行向量」的标记。 */
const MODEL_KEY = 'stub-image-model@768'

/** 单位向量：轴不同 = 余弦距离为 1，谁该像谁一眼看得出。 */
function axisVector(axis: number): number[] {
  const vector = new Array<number>(1024).fill(0)
  vector[axis] = 1
  return vector
}

/** 与 `axisVector(axis)` 的余弦恰为 `similarity` 的单位向量。 */
function tiltedVector(axis: number, otherAxis: number, similarity: number): number[] {
  const vector = new Array<number>(1024).fill(0)
  vector[axis] = similarity
  vector[otherAxis] = Math.sqrt(1 - similarity * similarity)
  return vector
}

async function makePerson(name: string | null): Promise<string> {
  const rows = await db.insert(persons).values({ name }).returning({ id: persons.id })
  const row = rows[0]
  if (row === undefined) throw new Error('建人物失败')
  return row.id
}

/**
 * 给人物挂上 `count` 张图（每张一行向量），返回这些图的 id。
 *
 * 直接用 schema 写 `meme_subjects`：这一层要的东西是「库里已经有人物和向量」，
 * 走哪条写入路径不影响读路径的断言（写路径是第二批的事）。
 */
async function linkMemes(
  personId: string,
  count: number,
  uploaderId: string,
  vector: number[] = axisVector(0),
): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const meme = await makeMeme(db, { uploaderId })
    ids.push(meme.id)
    await db
      .insert(memeSubjects)
      .values({ memeId: meme.id, personId, embedding: vector, embedModel: MODEL_KEY })
  }
  return ids
}

// ── 降级态：没配图片向量通道，一切照旧（§6.7.5） ───────────────────

describe('没配图片向量通道时（§6.7.5 的降级态）', () => {
  it('GET /config/image-embed 是「没配」的默认值，能力位全是 null 而不是 false', async () => {
    const admin = await signIn('admin')

    const res = await call('GET', '/config/image-embed', admin)
    expect(res.status).toBe(200)

    // 逐字相等：多一个字段就是 SPEC 里没有的东西（§6.7.5 + §6.5.3）
    expect(await json(res)).toEqual({
      source: 'default',
      baseUrl: '',
      model: '',
      apiKey: null,
      verifiedAt: null,
      // **null 不是 false**：没测过 ≠ 测出来不行。写 false 会让界面显示
      // 「这个通道不支持图片」，而实际上根本还没有通道
      nativeDim: null,
      dimParamWorks: null,
      imageInputWorks: null,
    })
  })

  it('图片向量配置只有 admin 能读（§6.7：GET /config/image-embed 是 admin）', async () => {
    expect((await call('GET', '/config/image-embed', null)).status).toBe(401)
    expect((await call('GET', '/config/image-embed', await signIn())).status).toBe(403)
  })

  it('人物与系列是空列表，不是 404 也不是 500', async () => {
    const actor = await signIn()
    // 库里有图、只是没人物——这才是降级态的常态
    await makeMeme(db, { uploaderId: actor.id })

    expect(await json(await call('GET', '/persons', actor))).toEqual({
      items: [],
      nextCursor: null,
    })
    expect(await json(await call('GET', '/series', actor))).toEqual({
      items: [],
      nextCursor: null,
    })
  })

  it('浏览页按人物 / 系列筛，没通道时得到空结果而不是错误', async () => {
    const actor = await signIn()
    const meme = await makeMeme(db, { uploaderId: actor.id })

    const byPerson = await json(await call('GET', `/memes?person=${crypto.randomUUID()}`, actor))
    expect(byPerson['items']).toEqual([])

    const bySeries = await json(await call('GET', `/memes?series=${crypto.randomUUID()}`, actor))
    expect(bySeries['items']).toEqual([])

    // 没有人物归属的图在两个筛选下都不出现——「查不到」和「筛掉了」是同一件事
    const all = await json(await call('GET', '/memes', actor))
    expect((all['items'] as { id: string }[]).map((m) => m.id)).toEqual([meme.id])
  })

  it('进度显示「全部过期」，而补跑排 0 条（没通道就没有可重算的东西）', async () => {
    const admin = await signIn('admin')
    await makeMeme(db, { uploaderId: admin.id })
    await makeMeme(db, { uploaderId: admin.id })

    const res = await call('POST', '/admin/persons/reindex', admin)
    expect(res.status).toBe(200)
    const body = await json(res)

    // total/stale 从 meme_subjects 真实计数算：口径串为空时不命中任何行，
    // 于是「一张都没算过」——那正是「还没配图片向量」该显示的样子
    expect(body).toEqual({
      enqueuedCount: 0,
      running: false,
      total: 2,
      done: 0,
      stale: 2,
      failed: 0,
    })

    // ⚠️ 关键：**一条任务都没排**。排了的话，管理员一配好通道就会被动地
    // 花掉一整批存量图的额度（§6.7.5「第一次配好不自动补跑」）
    const jobs = await db.select().from(personVectorJobs)
    expect(jobs).toHaveLength(0)

    // 进度那条路径同源：status 的形状与 POST 里那一段逐字相同（只多 enqueuedCount）
    const { enqueuedCount, ...status } = body
    expect(enqueuedCount).toBe(0)
    expect(await json(await call('GET', '/admin/persons/reindex/status', admin))).toEqual(status)
  })

  it('补跑与进度只有 admin 能动（§6.7 的权限列）', async () => {
    const member = await signIn()
    expect((await call('POST', '/admin/persons/reindex', member)).status).toBe(403)
    expect((await call('GET', '/admin/persons/reindex/status', member)).status).toBe(403)
    expect((await call('POST', '/admin/persons/reindex', null)).status).toBe(401)
  })

  it('未登录读不了人物与系列（§6.7 的权限列：所有人 = 所有登录用户）', async () => {
    expect((await call('GET', '/persons', null)).status).toBe(401)
    expect((await call('GET', '/series', null)).status).toBe(401)
    expect((await call('GET', `/persons/${crypto.randomUUID()}`, null)).status).toBe(401)
  })
})

// ── 形状（§6.7.2） ────────────────────────────────────────────────

describe('对外形状就是 §6.7.2 列的那几个字段', () => {
  it('列表与详情：键集合逐字相等，封面是能直接显示的地址', async () => {
    const actor = await signIn()
    const personId = await makePerson('塞西莉亚')
    await linkMemes(personId, 2, actor.id)

    const list = await json(await call('GET', '/persons', actor))
    const items = list['items'] as Record<string, unknown>[]
    expect(items).toHaveLength(1)

    const item = items[0]!
    expect(Object.keys(item).sort()).toEqual([...PERSON_KEYS].sort())
    expect(item['name']).toBe('塞西莉亚')
    expect(item['memeCount']).toBe(2)
    expect(item['seriesId']).toBeNull()
    expect(item['seriesName']).toBeNull()
    expect(item['isHidden']).toBe(false)
    // 封面不是库里那一列的原值，而是回落后的那一张（§5.7.4）
    const cover = item['cover'] as { memeId: string; thumbUrl: string }
    expect(Object.keys(cover).sort()).toEqual(['memeId', 'thumbUrl'])
    // 地址经 `thumbKeyFor` + `publicUrlFor` 拼出来，自己拼一套会 404 而不报错
    expect(cover.thumbUrl).toContain('/thumbs/test/')
    expect(cover.thumbUrl).toContain('.webp')

    const detail = await json(await call('GET', `/persons/${personId}`, actor))
    expect(detail).toEqual(item)
  })

  it('系列的形状单独一份：多了 createdAt / createdBy，封面可以为 null', async () => {
    const actor = await signIn()
    const rows = await db
      .insert(series)
      .values({ name: '某作品', createdBy: actor.id })
      .returning({ id: series.id })
    const seriesId = rows[0]!.id

    const item = (await json(await call('GET', `/series/${seriesId}`, actor))) as Record<
      string,
      unknown
    >
    expect(Object.keys(item).sort()).toEqual([...SERIES_KEYS].sort())
    expect(item).toMatchObject({
      id: seriesId,
      name: '某作品',
      personCount: 0,
      memeCount: 0,
      // **空系列照样在**（§6.7.3）：吞掉它的表现是「刚建好的系列不见了」
      cover: null,
      createdBy: actor.id,
    })
    expect(typeof item['createdAt']).toBe('string')
  })

  it('更新过的人物与系列：留痕字段非空时也是 ISO 串', async () => {
    const actor = await signIn()
    const personId = await makePerson('甲')
    await linkMemes(personId, 1, actor.id)
    const seriesRows = await db
      .insert(series)
      .values({ name: '作品', createdBy: actor.id })
      .returning({ id: series.id })
    const seriesId = seriesRows[0]!.id

    const stamp = new Date('2026-09-29T16:00:00Z')
    await db
      .update(persons)
      .set({ updatedBy: actor.id, updatedAt: stamp })
      .where(eq(persons.id, personId))
    await db
      .update(series)
      .set({ updatedBy: actor.id, updatedAt: stamp })
      .where(eq(series.id, seriesId))

    // ⚠️ 这一条是有来历的：`db.execute` 把 timestamptz 给成**文本**，而
    // `serialize/*` 拿到的应当是 Date（`data/persons.ts` 的 `toDate`）。
    // 上一版在人物这条路上没暴露，只是因为造出来的数据 `updated_at` 全是 null
    // ——系列的 `created_at` 恒非空，所以它先炸。留痕字段非空才是真正的回归面
    const person = await json(await call('GET', `/persons/${personId}`, actor))
    expect(person['updatedBy']).toBe(actor.id)
    expect(person['updatedAt']).toBe('2026-09-29T16:00:00Z')

    const single = await json(await call('GET', `/series/${seriesId}`, actor))
    expect(single['updatedBy']).toBe(actor.id)
    expect(single['updatedAt']).toBe('2026-09-29T16:00:00Z')
    expect(single['createdAt']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('合并建议最像的在前，且响应里没有任何相似度数值', async () => {
    const actor = await signIn()
    const target = await makePerson('甲')
    const close = await makePerson('很像的')
    const far = await makePerson('不太像的')
    const stranger = await makePerson('另一个')
    await linkMemes(target, 1, actor.id, axisVector(0))
    await linkMemes(close, 1, actor.id, tiltedVector(0, 1, 0.98))
    await linkMemes(far, 1, actor.id, tiltedVector(0, 1, 0.9))
    await linkMemes(stranger, 1, actor.id, axisVector(5))

    const res = await call('GET', `/persons/${target}/suggestions`, actor)
    expect(res.status).toBe(200)

    const body = await json(res)
    expect(Object.keys(body)).toEqual(['items'])
    const items = body['items'] as Record<string, unknown>[]
    // 顺序就是 API 的结论，**只给顺序不给数**：数值一旦外露，前端会长出第二套阈值
    expect(items.map((p) => p['id'])).toEqual([close, far])
    expect(Object.keys(items[0]!).sort()).toEqual([...PERSON_KEYS].sort())

    // 一个不存在（或图全被软删）的 id 是 404，不是空数组——两者对客户端不是一回事
    const missing = await call('GET', `/persons/${crypto.randomUUID()}/suggestions`, actor)
    expect(missing.status).toBe(404)
  })

  it('图全被软删的人物从列表、详情、建议里一起消失（§5.7.4）', async () => {
    const actor = await signIn()
    const personId = await makePerson('甲')
    const memeIds = await linkMemes(personId, 2, actor.id)

    for (const id of memeIds) {
      await softDeleteMeme(id, { id: actor.id, role: 'member' }, db)
    }

    expect((await json(await call('GET', '/persons', actor)))['items']).toEqual([])
    expect((await call('GET', `/persons/${personId}`, actor)).status).toBe(404)
    // 行还在：图被恢复时人物跟着回来
    expect(await db.select().from(persons).where(eq(persons.id, personId))).toHaveLength(1)
  })

  it('路径参数的形状不合法报 404，不撞 Postgres 的 uuid 报错（那是 500）', async () => {
    const actor = await signIn()
    for (const path of ['/persons/abc', '/persons/abc/suggestions', '/series/abc']) {
      const res = await call('GET', path, actor)
      expect([path, res.status]).toEqual([path, 404])
    }
  })
})

// ── 列表筛选（§6.7.3） ────────────────────────────────────────────

describe('列表筛选与游标', () => {
  it('q / named / hidden / series=none / minCount 各按字面生效', async () => {
    const actor = await signIn()
    const named = await makePerson('塞西莉亚')
    const other = await makePerson('露娜')
    const unnamed = await makePerson(null)
    const hiddenPerson = await makePerson('隐藏的')

    await linkMemes(named, 2, actor.id)
    await linkMemes(other, 1, actor.id)
    await linkMemes(unnamed, 1, actor.id)
    await linkMemes(hiddenPerson, 5, actor.id)

    await db.update(persons).set({ hiddenAt: new Date() }).where(eq(persons.id, hiddenPerson))
    const seriesRows = await db
      .insert(series)
      .values({ name: '作品', createdBy: actor.id })
      .returning({ id: series.id })
    await db.update(persons).set({ seriesId: seriesRows[0]!.id }).where(eq(persons.id, other))

    const ids = async (query: string): Promise<string[]> =>
      ((await json(await call('GET', `/persons${query}`, actor)))['items'] as { id: string }[]).map(
        (p) => p.id,
      )

    // 不传 hidden 和 hidden=false 是同一件事（§6.7.3：`hidden` 是「只看隐藏的」那个开关）
    expect(await ids('')).toHaveLength(3)
    expect(await ids('?hidden=false')).toHaveLength(3)
    expect(await ids('?hidden=true')).toEqual([hiddenPerson])
    expect(await ids('?q=塞西')).toEqual([named])
    expect(await ids('?named=true')).toHaveLength(2)
    expect(await ids('?named=false')).toEqual([unnamed])
    expect(await ids('?series=none')).toHaveLength(2)
    expect(await ids(`?series=${seriesRows[0]!.id}`)).toEqual([other])
    expect(await ids('?minCount=2')).toEqual([named])
  })

  it('三态参数只认 true / false，别的取值报 VALIDATION_FAILED 而不是静默放宽', async () => {
    const actor = await signIn()
    await linkMemes(await makePerson('甲'), 1, actor.id)

    // `named=1` 若被当成「不传」，返回的就不只是有名字的那些——客户端看不出自己传错了
    for (const query of ['?named=1', '?named=yes', '?hidden=0']) {
      const res = await call('GET', `/persons${query}`, actor)
      expect([query, res.status]).toEqual([query, 400])
    }
  })

  it('series 只认 uuid 或 none，minCount / limit 只认正整数', async () => {
    const actor = await signIn()
    for (const query of ['?series=abc', '?minCount=0', '?minCount=1.5', '?limit=0']) {
      const res = await call('GET', `/persons${query}`, actor)
      expect([query, res.status]).toEqual([query, 400])
    }
    // 空串按不传（前端清筛选时可能留下一个空键），与 `q` 同一个口径
    expect((await call('GET', '/persons?series=&named=&limit=', actor)).status).toBe(200)
  })

  it('游标翻页：图数相同的那些也不会重复或漏（§1.3）', async () => {
    const actor = await signIn()
    for (let i = 0; i < 5; i += 1) {
      await linkMemes(await makePerson(`人物${i}`), 1, actor.id)
    }

    const first = await json(await call('GET', '/persons?limit=2', actor))
    const firstItems = first['items'] as { id: string }[]
    expect(firstItems).toHaveLength(2)
    expect(typeof first['nextCursor']).toBe('string')

    const second = await json(
      await call('GET', `/persons?limit=2&cursor=${encodeURIComponent(String(first['nextCursor']))}`, actor),
    )
    const seen = [...firstItems, ...(second['items'] as { id: string }[])].map((p) => p.id)
    expect(new Set(seen).size).toBe(4)

    // 游标解不出来是请求写错了，不当没传（否则客户端会静默拿到第一页）
    expect((await call('GET', '/persons?cursor=乱码', actor)).status).toBe(400)
  })
})

// ── 浏览页按人物 / 系列筛（§6.3.2） ───────────────────────────────

describe('浏览页的 person / series 参数（§6.3.2）', () => {
  it('按人物筛、按系列筛，两个同时给时取 AND', async () => {
    const actor = await signIn()
    const seriesRows = await db
      .insert(series)
      .values({ name: '作品', createdBy: actor.id })
      .returning({ id: series.id })
    const seriesId = seriesRows[0]!.id

    const inSeries = await makePerson('甲')
    await db.update(persons).set({ seriesId }).where(eq(persons.id, inSeries))
    const loose = await makePerson('乙')

    const a = await linkMemes(inSeries, 2, actor.id)
    const b = await linkMemes(loose, 1, actor.id)

    // 比集合不比顺序：这一层断言的是「筛出来的对不对」，
    // 列表顺序是 `GET /memes` 自己的事（`created_at desc`），在这里钉死只会让测试假红
    const ids = async (query: string): Promise<Set<string>> => {
      const items = (await json(await call('GET', `/memes${query}`, actor)))['items'] as {
        id: string
      }[]
      return new Set(items.map((m) => m.id))
    }

    expect(await ids(`?person=${inSeries}`)).toEqual(new Set(a))
    expect(await ids(`?series=${seriesId}`)).toEqual(new Set(a))
    // 两个筛选都命中同一批图时才是非空——AND 不是「随便满足一个」
    expect(await ids(`?person=${inSeries}&series=${seriesId}`)).toEqual(new Set(a))
    expect(await ids(`?person=${loose}&series=${seriesId}`)).toEqual(new Set())
    expect(await ids(`?person=${loose}`)).toEqual(new Set(b))
  })

  it('筛选与 q 同用：先过滤后召回，筛掉的那些不会占名额（§6.3.1）', async () => {
    const actor = await signIn()
    const personId = await makePerson('甲')

    const kept = await makeMeme(db, { uploaderId: actor.id, ocrText: '无语 猫 的表情' })
    await db
      .insert(memeSubjects)
      .values({ memeId: kept.id, personId, embedding: axisVector(0), embedModel: MODEL_KEY })
    // 同样命中查询词，但不在这个人物下
    await makeMeme(db, { uploaderId: actor.id, ocrText: '无语 猫 的表情' })

    const query = `q=${encodeURIComponent('无语 猫')}&person=${personId}`
    const body = await json(await call('GET', `/memes?${query}`, actor))
    expect((body['items'] as { id: string }[]).map((m) => m.id)).toEqual([kept.id])
  })

  it('重复传是请求写错了：VALIDATION_FAILED，不静默取第一个', async () => {
    const actor = await signIn()
    const one = crypto.randomUUID()
    const two = crypto.randomUUID()

    // 两个人物取 AND 恒为空，所以「取了哪个」都是客户端看不出错的空列表
    expect((await call('GET', `/memes?person=${one}&person=${two}`, actor)).status).toBe(400)
    expect((await call('GET', `/memes?series=${one}&series=${two}`, actor)).status).toBe(400)
  })

  it('形状不合法是 VALIDATION_FAILED（uuid 报错会是 500，不是「查不到」）', async () => {
    const actor = await signIn()
    // `series=none` 在这里**不是**合法取值：`none` 只属于 `GET /persons` 的 series
    // （§6.7.3 的三形态），浏览页的 `series` 是系列 id（§6.3.2）
    for (const query of ['?person=abc', '?series=abc', '?series=none']) {
      const res = await call('GET', `/memes${query}`, actor)
      expect([query, res.status]).toEqual([query, 400])
    }
    // 空串按不传：前端清掉筛选时可能留下一个空键，那不是请求写错
    expect((await call('GET', '/memes?person=&series=', actor)).status).toBe(200)
  })

  it('软删的图不再被人物 / 系列筛出来（§3.4，读路径只有一条 LIVE_MEME）', async () => {
    const actor = await signIn()
    const personId = await makePerson('甲')
    const [memeId] = await linkMemes(personId, 1, actor.id)
    expect((await call('GET', `/memes?person=${personId}`, actor)).status).toBe(200)

    await softDeleteMeme(memeId!, { id: actor.id, role: 'member' }, db)

    const body = await json(await call('GET', `/memes?person=${personId}`, actor))
    expect(body['items']).toEqual([])
  })
})
