import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * `GET /memes` 的分派、响应形状与游标（SPEC §6.3 / §6.3.1 / §6.3.2 / §6.3.3）。
 *
 * 四件事在这里被钉住：
 *
 *   1. **两种模式一个形状**：`items` / `nextCursor` / `degraded` / `rewritten`，外加每条
 *      item 的 `matchedBy`。前端只按 Hono RPC 推出来的那一个类型消费，形状随模式变就会让
 *      每个消费点都长出分支（`routes/memes.ts` 的 `ListItem`）。
 *   2. **检索靠快照翻页**（`services/search-snapshot.ts`）：不重复、不遗漏，重放同一个游标
 *      得到同一页；池子不够时深度翻倍重扫，新 id 只**追加**在旧名单后面。
 *   3. **中途上传的新图不出现在后续页里**（裁定 2）——靠 `asOf` 冻住时点，不靠排序碰巧。
 *   4. **坏游标是一个明确的 400**，不是静默回第一页（SPEC §1.3）。
 *
 * 这里**故意不配任何 AI 通道**：降级态下整条翻页链路照样得跑通。配了 embedding 之后
 * 「翻页不重跑 HyDE、不重新编码」那件事在 `search-vector.test.ts` 里测——那边有假服务，
 * 能数调用次数；这边数不出来，只能断言 `degraded` / `rewritten` 前后一致。
 */
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''

const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')
const { eq } = await import('drizzle-orm')

/** 同 `search.test.ts`：走真路由就得让默认连接指向测试库，否则会去清开发库的表。 */
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { encodeCursor } = await import('../src/data/memes.js')
const { searchSnapshots } = await import('../src/data/schema.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { searchRoutes } = await import('../src/routes/search.js')

const { sql, db } = createTestDb()

// 两个端点挂在同一个 app 上：`q` 的分派是「一个端点两种模式」，
// 分成两个 app 的话，「两边的形状对不上」在测试里看不出来
const testApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/memes', memesRoutes)
  .route('/api/v1/search', searchRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

type Actor = { id: string; cookie: string }

async function signIn(): Promise<Actor> {
  const user = await createUser(db)
  const session = await createSession(user.id, db)
  return { id: user.id, cookie: `sid=${session.id}` }
}

async function as(actor: Actor, path: string): Promise<Response> {
  return await testApp.request(path, { headers: { cookie: actor.cookie } })
}

type ListBody = {
  items: { id: string; matchedBy: string[] }[]
  nextCursor: string | null
  degraded: boolean
  rewritten: string | null
}

async function bodyOf(res: Response): Promise<ListBody> {
  expect(res.status).toBe(200)
  return (await res.json()) as ListBody
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } }
  return body.error.code
}

/** 建 `count` 张都带「猫」标签的图，返回它们的 id。标签路是唯一不需要 AI 通道的一路。 */
async function seedTagged(actor: Actor, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const meme = await makeMeme(db, { uploaderId: actor.id, tags: ['猫'] })
    ids.push(meme.id)
  }
  return ids
}

/** 快照表里现在有几行。`GET /search` 与「没有下一页」的检索都不该往里写。 */
async function snapshotCount(): Promise<number> {
  const rows = await db.select({ id: searchSnapshots.id }).from(searchSnapshots)
  return rows.length
}

const UNKNOWN_UUID = '2f4a1c9e-6b3d-4a17-9f0c-8c2b5d7e1a44'

describe('GET /memes 无 q（浏览）', () => {
  it('形状与检索分支一致：degraded false、rewritten null、matchedBy 恒为空数组', async () => {
    const alice = await signIn()
    await seedTagged(alice, 3)

    const body = await bodyOf(await as(alice, '/api/v1/memes?limit=2'))

    expect(body.items).toHaveLength(2)
    expect(body.nextCursor).not.toBeNull()
    // 这三个是**常量不是缺省**：形状恒定才有一个类型（`routes/memes.ts` 的 `ListItem`）。
    // 少一个字段的话，Hono RPC 给前端的类型在两种模式下不是同一个
    expect(body.degraded).toBe(false)
    expect(body.rewritten).toBeNull()
    for (const item of body.items) expect(item.matchedBy).toEqual([])
  })

  it('q 全空白按「没有 q」处理，不是 400', async () => {
    const alice = await signIn()
    const [memeId] = await seedTagged(alice, 1)

    // 清空搜索框是常规操作，不是非法请求（SPEC §6.3.1）。`GET /search` 那边相反，
    // 缺 q 就报错——**两条相反是故意的**，谁被顺手对齐都会坏掉一边
    const body = await bodyOf(await as(alice, '/api/v1/memes?q=%20%20'))
    expect(body.items.map((i) => i.id)).toContain(memeId)
    expect(body.degraded).toBe(false)
  })
})

describe('GET /memes?q= 首屏', () => {
  it('按融合顺序出结果，每条带 matchedBy', async () => {
    const alice = await signIn()
    const both = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '无语 猫 的表情',
      tags: ['猫'],
    })
    const tagOnly = await makeMeme(db, { uploaderId: alice.id, tags: ['猫'], ocrText: '别的正文' })

    const body = await bodyOf(await as(alice, '/api/v1/memes?q=%E6%97%A0%E8%AF%AD%20%E7%8C%AB'))

    const ids = body.items.map((i) => i.id)
    expect(ids).toContain(both.id)
    expect(ids).toContain(tagOnly.id)
    expect(body.items.find((i) => i.id === both.id)?.matchedBy).toEqual(
      expect.arrayContaining(['ocr', 'tags']),
    )
    expect(body.items.find((i) => i.id === tagOnly.id)?.matchedBy).toEqual(['tags'])
  })

  it('没有下一页时 nextCursor 为 null，且不落快照行', async () => {
    const alice = await signIn()
    await seedTagged(alice, 3)

    const body = await bodyOf(await as(alice, '/api/v1/memes?q=%E7%8C%AB'))
    expect(body.items).toHaveLength(3)
    expect(body.nextCursor).toBeNull()

    // 没有游标就没有任何人引用这份快照，落进去只是让清理任务多删一条。
    // 首屏每天被请求无数次，这一条挡的是「快照表一直在涨」而没人发现
    expect(await snapshotCount()).toBe(0)
  })
})

describe('检索翻页', () => {
  it('池子不够时深度翻倍：不重复、不遗漏，翻到底给空页而不是报错', async () => {
    const alice = await signIn()
    // 60 > `PATH_LIMIT`（每路 50 条）：首屏的池子只装得下 50 条，
    // 第二页要凑满 30 条就必须翻倍重扫，新 id 才接得上来
    const created = new Set(await seedTagged(alice, 60))

    const first = await bodyOf(await as(alice, '/api/v1/memes?q=%E7%8C%AB&limit=30'))
    expect(first.items).toHaveLength(30)
    expect(first.nextCursor).not.toBeNull()
    expect(first.degraded).toBe(true)
    expect(first.rewritten).toBeNull()

    const second = await bodyOf(
      await as(alice, `/api/v1/memes?q=%E7%8C%AB&limit=30&cursor=${first.nextCursor ?? ''}`),
    )
    expect(second.items).toHaveLength(30)
    expect(second.nextCursor).not.toBeNull()
    // 首屏的降级判定是**冻住**的：一页页翻着翻着提示语变了，用户会以为出了什么事
    expect(second.degraded).toBe(true)
    expect(second.rewritten).toBeNull()

    const third = await bodyOf(
      await as(alice, `/api/v1/memes?q=%E7%8C%AB&limit=30&cursor=${second.nextCursor ?? ''}`),
    )
    // 到头的表现是**空页 + nextCursor null**，不是 404 也不是 400：
    // 筛得越窄越早到底，那不是错误（SPEC §6.3.1）
    expect(third.items).toHaveLength(0)
    expect(third.nextCursor).toBeNull()

    const seen = [...first.items, ...second.items].map((i) => i.id)
    expect(new Set(seen).size).toBe(60)
    expect(new Set(seen)).toEqual(created)
  })

  it('重放同一个游标得到同一页', async () => {
    const alice = await signIn()
    await seedTagged(alice, 5)

    const first = await bodyOf(await as(alice, '/api/v1/memes?q=%E7%8C%AB&limit=2'))
    const cursor = first.nextCursor ?? ''

    const once = await bodyOf(await as(alice, `/api/v1/memes?q=%E7%8C%AB&limit=2&cursor=${cursor}`))
    const twice = await bodyOf(
      await as(alice, `/api/v1/memes?q=%E7%8C%AB&limit=2&cursor=${cursor}`),
    )

    // 客户端在响应丢失后重试同一个游标：**不能跳页**，也不能少给一条。
    // 所以页是「发出去就不再变」的，重放照着存下来的那一页原样再给一次
    expect(twice.items.map((i) => i.id)).toEqual(once.items.map((i) => i.id))
    expect(twice.nextCursor).toBe(once.nextCursor)
  })

  it('翻页途中上传的新图不出现在后续页里', async () => {
    const alice = await signIn()
    await seedTagged(alice, 30)

    const first = await bodyOf(await as(alice, '/api/v1/memes?q=%E7%8C%AB&limit=20'))
    expect(first.items).toHaveLength(20)
    expect(first.nextCursor).not.toBeNull()

    // 排在最前面的新图（标签路按 created_at desc 排）。时点要真的晚于首屏那一刻，
    // 否则这条用例在不同的毫秒上会有两种结果
    await new Promise((resolve) => setTimeout(resolve, 20))
    const fresh = await makeMeme(db, { uploaderId: alice.id, tags: ['猫'] })

    const second = await bodyOf(
      await as(alice, `/api/v1/memes?q=%E7%8C%AB&limit=20&cursor=${first.nextCursor ?? ''}`),
    )

    // 一次检索是一个快照：翻倍重扫时 `asOf` 是快照的创建时刻，新图进不了候选名单。
    // 不这么做的话它会从第二页里冒出来——用户看到的是「我搜完之后上传的图出现在
    // 搜索结果里」，而那既不报错也没有任何地方能解释
    expect(second.items.map((i) => i.id)).not.toContain(fresh.id)
    expect(second.items).toHaveLength(10)
    expect(second.nextCursor).toBeNull()
  })
})

describe('游标的各种坏法', () => {
  it('浏览游标用在检索请求上 → 400', async () => {
    const alice = await signIn()
    await seedTagged(alice, 1)

    // 两个分支的游标是两种格式（`(created_at, id)` vs `s1|<快照 id>|<页号>`）。
    // 混用必须报错而不是「解不出来就当没传」——后者会让客户端以为翻成功了
    const browseCursor = encodeCursor(new Date('2026-01-01T00:00:00.000Z'), alice.id)
    const res = await as(alice, `/api/v1/memes?q=%E7%8C%AB&cursor=${browseCursor}`)

    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('检索游标用在浏览请求上 → 400', async () => {
    const alice = await signIn()
    await seedTagged(alice, 3)

    const first = await bodyOf(await as(alice, '/api/v1/memes?q=%E7%8C%AB&limit=1'))
    const res = await as(alice, `/api/v1/memes?cursor=${first.nextCursor ?? ''}`)

    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('版本号不认识、快照不存在、快照过期 —— 三种都是同一个 400', async () => {
    const alice = await signIn()
    await seedTagged(alice, 3)

    const first = await bodyOf(await as(alice, '/api/v1/memes?q=%E7%8C%AB&limit=1'))
    const cursor = first.nextCursor ?? ''

    // 版本号是**故意的断路**：存进去的形状一改就 +1，旧游标一律解析失败。
    // 解析器只读它认识的字段，多出来的静默丢掉——丢掉的若是筛选条件，
    // 表现是「结果里混进了我筛掉的东西」，不报错（retrieval.md §6）
    const unknownVersion = Buffer.from(`s9|${UNKNOWN_UUID}|1`).toString('base64url')
    const missing = Buffer.from(`s1|${UNKNOWN_UUID}|1`).toString('base64url')

    // 过期：按「快照的主人是谁」无关，只把时间推过去
    await db
      .update(searchSnapshots)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(searchSnapshots.id, decodeSnapshotId(cursor)))

    for (const bad of [unknownVersion, missing, cursor]) {
      const res = await as(alice, `/api/v1/memes?q=%E7%8C%AB&limit=1&cursor=${bad}`)
      expect([bad, res.status]).toEqual([bad, 400])
      expect([bad, await errorCode(res)]).toEqual([bad, 'VALIDATION_FAILED'])
    }
  })

  it('别人的游标也不能用', async () => {
    const alice = await signIn()
    const bob = await signIn()
    await seedTagged(alice, 3)

    const first = await bodyOf(await as(alice, '/api/v1/memes?q=%E7%8C%AB&limit=1'))
    const cursor = first.nextCursor ?? ''

    // 快照里冻着 `actorId`（`favorited` / `uploader=me` 都要它）。拿别人的游标翻页
    // 不是「读到别人的图」，而是**按别人的筛选条件**查——客户端看不出错。
    // 对客户端这仍然是「这个游标不能用」，所以码与过期相同，不是 FORBIDDEN
    const stolen = await as(bob, `/api/v1/memes?q=%E7%8C%AB&limit=1&cursor=${cursor}`)
    expect(stolen.status).toBe(400)
    expect(await errorCode(stolen)).toBe('VALIDATION_FAILED')

    // 本人重放同一个游标是好的 —— 上面的 400 是归属检查给的，不是游标本身坏了
    const own = await bodyOf(await as(alice, `/api/v1/memes?q=%E7%8C%AB&limit=1&cursor=${cursor}`))
    expect(own.items).toHaveLength(1)
  })

  it('q 与 random 同时给 → 400', async () => {
    const alice = await signIn()
    await seedTagged(alice, 1)

    // 忽略哪一个都是客户端看不出错的错误结果：忽略 q 会把它当成一次随机抽样
    const res = await as(alice, '/api/v1/memes?q=%E7%8C%AB&random=true')
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })
})

describe('GET /search（冻结的兼容入口）', () => {
  it('只认 q 与 limit，别的参数一律 400', async () => {
    const alice = await signIn()

    // 静默忽略会让 `/search?tags=猫` 悄悄变成一次浏览——一个叫 /search 的地址
    // 给出不搜的结果，是本项目最忌讳的「客户端看不出错的错误结果」
    for (const qs of ['?q=%E7%8C%AB&tags=%E7%8C%AB', '?q=%E7%8C%AB&cursor=x']) {
      const res = await as(alice, `/api/v1/search${qs}`)
      expect([qs, res.status]).toEqual([qs, 400])
      expect([qs, await errorCode(res)]).toEqual([qs, 'VALIDATION_FAILED'])
    }
  })

  it('nextCursor 恒为 null，且缺省 limit 是 50（不是 /memes 的 40）', async () => {
    const alice = await signIn()
    await seedTagged(alice, 45)

    const body = await bodyOf(await as(alice, '/api/v1/search?q=%E7%8C%AB'))
    // 45 条全部出来：缺省若被对齐成 40，首页会**静默**少 5 条（SPEC §6.3.3、裁定 3）
    expect(body.items).toHaveLength(45)
    // 它不分页。恒 null 而不是「没有下一页」——客户端看到 null 就该停止
    expect(body.nextCursor).toBeNull()
    expect(await snapshotCount()).toBe(0)

    // 同一个实现的**跨端证据**：同样的查询，两个入口给同一串顺序。
    // 顺序对不上就说明有人把召回或融合抄了第二份（retrieval.md §6）
    const viaMemes = await bodyOf(await as(alice, '/api/v1/memes?q=%E7%8C%AB&limit=50'))
    expect(viaMemes.items.map((i) => i.id)).toEqual(body.items.map((i) => i.id))
  })
})

describe('快照过期清理', () => {
  it('定时清理删掉过期的快照，没过期的不动', async () => {
    const alice = await signIn()
    // 一页只装 1 条、库里有 3 条 → 一定有下一页 → 落了一行快照
    await seedTagged(alice, 3)
    const first = await bodyOf(await as(alice, '/api/v1/memes?q=%E7%8C%AB&limit=1'))
    expect(first.nextCursor).not.toBeNull()

    const { countExpiredSearchSnapshots } = await import('../src/data/search-snapshots.js')
    const { startCleanupJob, stopCleanupJob } = await import('../src/queue/cleanup.js')

    startCleanupJob({ intervalMs: 50 })
    try {
      // 还没过期：清理任务跑几轮也不该动它
      await sleep(150)
      expect(await snapshotCount()).toBe(1)

      // 手动推成过期（TTL 的判据是 `expires_at`，这里不用真的等 30 分钟）
      await db
        .update(searchSnapshots)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(searchSnapshots.id, decodeSnapshotId(first.nextCursor ?? '')))
      expect(await countExpiredSearchSnapshots()).toBe(1)

      await waitFor(async () => (await snapshotCount()) === 0, '过期快照被定时任务删掉')
    } finally {
      // 定时器是模块级单例：不收掉它会漏进别的用例
      await stopCleanupJob()
    }
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await sleep(20)
  }
}

/** 从 `s1|<快照 id>|<页号>` 里取出快照 id。测试要按 id 把那一行改成过期。 */
function decodeSnapshotId(cursor: string): string {
  const [version, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  expect(version).toBe('s1')
  if (id === undefined) throw new Error('游标里没有快照 id')
  return id
}
