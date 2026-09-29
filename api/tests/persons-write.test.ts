import { Hono } from 'hono'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 人物与系列的**写路径**端到端集成测试（SPEC §6.7.4，`proposed`；任务 2026-09-29-人物识别与聚类 §5 第二批）。
 *
 * 这个文件存在的理由是那几条「错了不报错」的规则——它们在读接口里看不出问题，
 * 只有写下去之后再看一遍库才认得出来：
 *
 * 1. **「不是同一个」的两个方向。** 库里按较小的 id 在前存（§5.7.4）。反着存的表现是
 *    「点了不是同一个，建议里它还在」——没有报错，只是那条建议永远消不掉。
 * 2. **人做过的归属不被机器改回去**（§5.7.2）。写 `assigned_by` 漏掉的表现是
 *    「被人移出的图过两天自己回来了」。
 * 3. **被移空的人物当场删除，但「图全被软删」的人物不删**（§5.7.4）。前者漏了会留下
 *    一个查不到、也删不掉的空人物；后者漏了会把一个「图恢复后应该回来」的人物真的删掉。
 * 4. **整个请求不生效。** merge 与 assignments 都是「任何一条不合法就全不做」——
 *    半合并的状态是这里最坏的失败：图搬过去了、来源还在，两边各显示一部分。
 *
 * ## 上游是替身，而且它只负责拒绝
 *
 * 与 `tests/persons-api.test.ts` 同一套：`fetch` 恒回 503。写接口一条 AI 调用都不该有
 * （§6.7.1：「这四条不触发任何 AI 调用」）。真发生了调用，桩会当场把它变成失败。
 *
 * 逐字断言响应键集合的活儿在读路径那个文件里（`PERSON_KEYS` / `SERIES_KEYS`），
 * 这里只在**必须确认响应就是那个形状**的地方复用一份同样的常量——写接口的响应
 * 与 `GET` 同形是 SPEC 明写的，两边形状漂了要红。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

/** ⚠️ 必须在 import 任何 src 模块之前：默认连接读的是 `DATABASE_URL`。 */
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

/** 三组部署方默认值全部清空，理由与 `persons-api.test.ts` 逐字相同。 */
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
const { assignPersonVector } = await import('../src/data/persons.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { personsRoutes } = await import('../src/routes/persons.js')
const { seriesRoutes } = await import('../src/routes/series.js')
const { memeSubjects, personRejections, persons } = await import('../src/data/schema.js')
const { and, eq, sql: raw } = await import('drizzle-orm')

const { sql, db } = createTestDb()

const testApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/persons', personsRoutes)
  .route('/api/v1/series', seriesRoutes)
  .route('/api/v1/memes', memesRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
  vi.stubGlobal('fetch', async () => new Response('本文件的替身不提供任何 AI 能力', { status: 503 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await sql.end()
})

// ── 脚手架（与 `persons-api.test.ts` 同形，两个文件各自独立） ──────

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

async function errorCode(res: Response): Promise<string> {
  const body = await json(res)
  return (body['error'] as { code: string }).code
}

const MODEL_KEY = 'stub-image-model@768'

/** 单位向量：轴不同 = 余弦距离为 1，谁该像谁一眼看得出。 */
function axisVector(axis: number): number[] {
  const vector = new Array<number>(1024).fill(0)
  vector[axis] = 1
  return vector
}

/** 与 `axisVector(axis)` 的余弦恰为 `similarity` 的单位向量（给「像」造数据用）。 */
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

/** 给人物挂 `count` 张图（每张一行向量），返回图 id。 */
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

/** 库里这个人物还剩几张图（含已软删的 `meme_subjects` 行）。 */
async function subjectCount(personId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    raw`select count(*)::int as n from meme_subjects where person_id = ${personId}::uuid`,
  )
  return rows[0]?.n ?? 0
}

async function personExists(personId: string): Promise<boolean> {
  const rows = await db.select({ id: persons.id }).from(persons).where(eq(persons.id, personId))
  return rows.length > 0
}

/** 「不是同一个」这一对在库里怎么存的，**按较小的 id 在前**（§5.7.4）。 */
async function rejectionPair(
  a: string,
  b: string,
): Promise<{ personId: string; otherPersonId: string } | null> {
  const low = a < b ? a : b
  const high = a < b ? b : a
  const rows = await db
    .select({
      personId: personRejections.personId,
      otherPersonId: personRejections.otherPersonId,
    })
    .from(personRejections)
    .where(
      and(eq(personRejections.personId, low), eq(personRejections.otherPersonId, high)),
    )
  return rows[0] ?? null
}

// ── PATCH /persons/{id}（§6.7.4） ──────────────────────────────────

describe('PATCH /persons/{id}：改名 / 系列 / 封面 / 隐藏', () => {
  it('改名并留下 updatedBy / updatedAt', async () => {
    const actor = await signIn()
    const id = await makePerson(null)
    await linkMemes(id, 1, actor.id)

    const body = await json(await call('PATCH', `/persons/${id}`, actor, { name: '  塞西  ' }))
    // 去首尾空白后的名字（§6.7.4）
    expect(body['name']).toBe('塞西')
    expect(body['updatedBy']).toBe(actor.id)
    expect(body['updatedAt']).not.toBeNull()
  })

  it('name 为 null 是清空，回到未命名', async () => {
    const actor = await signIn()
    const id = await makePerson('塞西')
    await linkMemes(id, 1, actor.id)

    const body = await json(await call('PATCH', `/persons/${id}`, actor, { name: null }))
    expect(body['name']).toBeNull()
  })

  it('空请求体是合法的空操作，返回当前的人物', async () => {
    const actor = await signIn()
    const id = await makePerson('塞西')
    await linkMemes(id, 2, actor.id)

    const res = await call('PATCH', `/persons/${id}`, actor, {})
    expect(res.status).toBe(200)

    const body = await json(res)
    expect(body['name']).toBe('塞西')
    expect(body['memeCount']).toBe(2)
  })

  it('未知字段是 VALIDATION_FAILED，不是静默忽略', async () => {
    const actor = await signIn()
    const id = await makePerson('塞西')
    await linkMemes(id, 1, actor.id)

    const res = await call('PATCH', `/persons/${id}`, actor, { coverMemeID: null })
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('name 的规则：空串 / 41 字 / 控制字符都是 VALIDATION_FAILED', async () => {
    const actor = await signIn()
    const id = await makePerson('塞西')
    await linkMemes(id, 1, actor.id)

    for (const name of ['   ', '长'.repeat(41), '塞\n西']) {
      const res = await call('PATCH', `/persons/${id}`, actor, { name })
      expect(await errorCode(res)).toBe('VALIDATION_FAILED')
    }
  })

  it('指向不存在的系列是 VALIDATION_FAILED（不是 500）', async () => {
    const actor = await signIn()
    const id = await makePerson('塞西')
    await linkMemes(id, 1, actor.id)

    const res = await call('PATCH', `/persons/${id}`, actor, { seriesId: crypto.randomUUID() })
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('seriesId 给了真的系列就挂上去，给 null 就移出', async () => {
    const actor = await signIn()
    const id = await makePerson('塞西')
    await linkMemes(id, 1, actor.id)

    const created = await json(await call('POST', '/series', actor, { name: '银魂' }))
    const seriesId = created['id'] as string

    const attached = await json(await call('PATCH', `/persons/${id}`, actor, { seriesId }))
    expect(attached['seriesId']).toBe(seriesId)
    expect(attached['seriesName']).toBe('银魂')

    const detached = await json(await call('PATCH', `/persons/${id}`, actor, { seriesId: null }))
    expect(detached['seriesId']).toBeNull()
    expect(detached['seriesName']).toBeNull()
  })

  it('封面必须是自己名下、还没被软删的图', async () => {
    const actor = await signIn()
    const mine = await makePerson('塞西')
    const other = await makePerson('别人')
    // 两张：软删掉一张之后这个人物仍然可见，才测得到「封面那张被软删」这一支
    const [myMeme] = await linkMemes(mine, 2, actor.id)
    const [otherMeme] = await linkMemes(other, 1, actor.id)

    // 别人的图：400。**这一条不报错的话，界面上会出现一张不属于它的人物封面**
    const foreign = await call('PATCH', `/persons/${mine}`, actor, { coverMemeId: otherMeme })
    expect(await errorCode(foreign)).toBe('VALIDATION_FAILED')

    const ok = await json(await call('PATCH', `/persons/${mine}`, actor, { coverMemeId: myMeme }))
    expect((ok['cover'] as { memeId: string }).memeId).toBe(myMeme)

    // 自己名下、但已经软删：同样 400（§6.7.4「必须是这个人物下未软删的图」）
    await softDeleteMeme(myMeme as string, actor, db)
    const gone = await call('PATCH', `/persons/${mine}`, actor, { coverMemeId: myMeme })
    expect(await errorCode(gone)).toBe('VALIDATION_FAILED')
  })

  it('isHidden 只认真布尔值：字符串 "true" 是 VALIDATION_FAILED', async () => {
    const actor = await signIn()
    const id = await makePerson('塞西')
    await linkMemes(id, 1, actor.id)

    // "false" 判真的话会把一个人物隐藏起来，而客户端以为自己传的是 false
    const res = await call('PATCH', `/persons/${id}`, actor, { isHidden: 'false' })
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')

    const hidden = await json(await call('PATCH', `/persons/${id}`, actor, { isHidden: true }))
    expect(hidden['isHidden']).toBe(true)

    const shown = await json(await call('PATCH', `/persons/${id}`, actor, { isHidden: false }))
    expect(shown['isHidden']).toBe(false)
  })

  it('不存在的人物是 NOT_FOUND；图全被软删的也是，但行还在（§5.7.4）', async () => {
    const actor = await signIn()
    expect((await call('PATCH', `/persons/${crypto.randomUUID()}`, actor, { name: 'x' })).status).toBe(404)

    const id = await makePerson('塞西')
    const [memeId] = await linkMemes(id, 1, actor.id)
    await softDeleteMeme(memeId as string, actor, db)

    expect((await call('PATCH', `/persons/${id}`, actor, { name: 'x' })).status).toBe(404)
    expect((await call('GET', `/persons/${id}`, actor)).status).toBe(404)
    // 行必须留着：图恢复时人物跟着回来
    expect(await personExists(id)).toBe(true)
  })

  it('路径参数形状不合法是 NOT_FOUND，不是 400', async () => {
    const actor = await signIn()
    expect((await call('PATCH', '/persons/abc', actor, { name: 'x' })).status).toBe(404)
  })
})

// ── POST /persons/{id}/merge（§6.7.4） ────────────────────────────

describe('POST /persons/{id}/merge', () => {
  it('来源的图全归到目标，来源行消失', async () => {
    const actor = await signIn()
    const target = await makePerson('塞西')
    const source = await makePerson('西西')
    await linkMemes(target, 2, actor.id)
    await linkMemes(source, 3, actor.id)

    const body = await json(
      await call('POST', `/persons/${target}/merge`, actor, { sourceIds: [source] }),
    )
    expect(body['id']).toBe(target)
    expect(body['memeCount']).toBe(5)

    expect(await personExists(source)).toBe(false)
    expect(await subjectCount(target)).toBe(5)
  })

  it('目标未命名时取 sourceIds 里第一个有名字的', async () => {
    const actor = await signIn()
    const target = await makePerson(null)
    const unnamed = await makePerson(null)
    const named = await makePerson('塞西')
    await linkMemes(target, 1, actor.id)
    await linkMemes(unnamed, 1, actor.id)
    await linkMemes(named, 1, actor.id)

    const body = await json(
      await call('POST', `/persons/${target}/merge`, actor, {
        sourceIds: [unnamed, named],
      }),
    )
    expect(body['name']).toBe('塞西')
  })

  it('目标有名字时不看来源的名字', async () => {
    const actor = await signIn()
    const target = await makePerson('目标')
    const source = await makePerson('来源')
    await linkMemes(target, 1, actor.id)
    await linkMemes(source, 1, actor.id)

    const body = await json(
      await call('POST', `/persons/${target}/merge`, actor, { sourceIds: [source] }),
    )
    expect(body['name']).toBe('目标')
  })

  it('「不是同一个」转到目标上，来源与目标之间、来源与来源之间的丢掉', async () => {
    const actor = await signIn()
    const target = await makePerson('目标')
    const sourceA = await makePerson('甲')
    const sourceB = await makePerson('乙')
    const outsider = await makePerson('外人')
    for (const id of [target, sourceA, sourceB, outsider]) await linkMemes(id, 1, actor.id)

    // 来源 A × 外人：**应该转成 目标 × 外人**
    await call('POST', `/persons/${sourceA}/rejections`, actor, { otherId: outsider })
    // 目标 × 来源 A：应该丢掉（人刚说了它们是一个）
    await call('POST', `/persons/${target}/rejections`, actor, { otherId: sourceA })
    // 来源 A × 来源 B：也应该丢掉（它们马上是同一个人）
    await call('POST', `/persons/${sourceA}/rejections`, actor, { otherId: sourceB })

    await call('POST', `/persons/${target}/merge`, actor, { sourceIds: [sourceA, sourceB] })

    expect(await rejectionPair(target, outsider)).not.toBeNull()

    // **只该剩一条**。多出来的一条就说明「目标 × 来源」「来源 × 来源」那两类没被丢掉，
    // 而它们错在哪里不看库是看不见的：界面上只是同一条错建议换个身份回来了。
    const all = await db
      .select({ personId: personRejections.personId, otherPersonId: personRejections.otherPersonId })
      .from(personRejections)
    expect(all).toEqual([
      target < outsider
        ? { personId: target, otherPersonId: outsider }
        : { personId: outsider, otherPersonId: target },
    ])
  })

  it('sourceIds 含自己或有重复是 VALIDATION_FAILED', async () => {
    const actor = await signIn()
    const target = await makePerson('目标')
    const source = await makePerson('来源')
    await linkMemes(target, 1, actor.id)
    await linkMemes(source, 1, actor.id)

    const self = await call('POST', `/persons/${target}/merge`, actor, { sourceIds: [target] })
    expect(await errorCode(self)).toBe('VALIDATION_FAILED')

    const dup = await call('POST', `/persons/${target}/merge`, actor, {
      sourceIds: [source, source],
    })
    expect(await errorCode(dup)).toBe('VALIDATION_FAILED')
  })

  it('任何一个人物不存在就 NOT_FOUND，而且**整个请求不生效**', async () => {
    const actor = await signIn()
    const target = await makePerson('目标')
    const source = await makePerson('来源')
    await linkMemes(target, 1, actor.id)
    await linkMemes(source, 1, actor.id)

    const res = await call('POST', `/persons/${target}/merge`, actor, {
      sourceIds: [source, crypto.randomUUID()],
    })
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('NOT_FOUND')

    // 图一张都没搬走、来源还在——半合并是这里最坏的失败
    expect(await personExists(source)).toBe(true)
    expect(await subjectCount(source)).toBe(1)
    expect(await subjectCount(target)).toBe(1)
  })

  it('21 个来源是 VALIDATION_FAILED（上限 20）', async () => {
    const actor = await signIn()
    const target = await makePerson('目标')
    await linkMemes(target, 1, actor.id)

    const res = await call('POST', `/persons/${target}/merge`, actor, {
      sourceIds: Array.from({ length: 21 }, () => crypto.randomUUID()),
    })
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('目标自己不存在是 NOT_FOUND', async () => {
    const actor = await signIn()
    expect(
      (
        await call('POST', `/persons/${crypto.randomUUID()}/merge`, actor, {
          sourceIds: [crypto.randomUUID()],
        })
      ).status,
    ).toBe(404)
  })
})

// ── POST /persons/{id}/rejections（§6.7.4） ───────────────────────

describe('POST /persons/{id}/rejections', () => {
  it('204，幂等，库里按较小的 id 在前存', async () => {
    const actor = await signIn()
    const a = await makePerson('甲')
    const b = await makePerson('乙')
    await linkMemes(a, 1, actor.id)
    await linkMemes(b, 1, actor.id)

    const first = await call('POST', `/persons/${a}/rejections`, actor, { otherId: b })
    expect(first.status).toBe(204)

    const again = await call('POST', `/persons/${a}/rejections`, actor, { otherId: b })
    expect(again.status).toBe(204)

    // 反方向再点一次也是同一条，不是第二条
    const reversed = await call('POST', `/persons/${b}/rejections`, actor, { otherId: a })
    expect(reversed.status).toBe(204)

    const [low, high] = a < b ? [a, b] : [b, a]
    const pair = await rejectionPair(a, b)
    expect(pair).toEqual({ personId: low, otherPersonId: high })
  })

  it('点过之后合并建议里不再出现这一对（§6.7.3）', async () => {
    const actor = await signIn()
    const a = await makePerson('甲')
    const b = await makePerson('乙')
    // 两条向量足够近，本来会互相建议（阈值 0.825，距离 0.01）
    await linkMemes(a, 1, actor.id, axisVector(0))
    await linkMemes(b, 1, actor.id, tiltedVector(0, 1, 0.99))

    const before = await json(await call('GET', `/persons/${a}/suggestions`, actor))
    expect((before['items'] as { id: string }[]).map((p) => p.id)).toEqual([b])

    await call('POST', `/persons/${a}/rejections`, actor, { otherId: b })

    const after = await json(await call('GET', `/persons/${a}/suggestions`, actor))
    expect(after['items']).toEqual([])
  })

  it('otherId 等于自己是 VALIDATION_FAILED，人物不存在是 NOT_FOUND', async () => {
    const actor = await signIn()
    const a = await makePerson('甲')
    await linkMemes(a, 1, actor.id)

    expect(await errorCode(await call('POST', `/persons/${a}/rejections`, actor, { otherId: a }))).toBe(
      'VALIDATION_FAILED',
    )
    expect(
      (
        await call('POST', `/persons/${a}/rejections`, actor, {
          otherId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(404)
  })
})

// ── POST /persons/assignments（§6.7.4） ───────────────────────────

describe('POST /persons/assignments', () => {
  it('放进既有人物：movedCount 与 person 都对', async () => {
    const actor = await signIn()
    const person = await makePerson('塞西')
    await linkMemes(person, 1, actor.id)
    const loose = await makeMeme(db, { uploaderId: actor.id })
    const loose2 = await makeMeme(db, { uploaderId: actor.id })

    const body = await json(
      await call('POST', '/persons/assignments', actor, {
        memeIds: [loose.id, loose2.id],
        personId: person,
      }),
    )

    expect(body['movedCount']).toBe(2)
    expect((body['person'] as { id: string }).id).toBe(person)
    expect((body['person'] as { memeCount: number }).memeCount).toBe(3)
  })

  it('图全被软删的人物**收不了图**：它对客户端不存在（§5.7.4）', async () => {
    const actor = await signIn()
    const person = await makePerson('塞西')
    const [only] = await linkMemes(person, 1, actor.id)
    await softDeleteMeme(only as string, actor, db)

    const loose = await makeMeme(db, { uploaderId: actor.id })
    const res = await call('POST', '/persons/assignments', actor, {
      memeIds: [loose.id],
      personId: person,
    })
    // `personId` 是**这次要操作的对象**，和 `memeIds` 同一身份 → 404（§6.7.4 开头）：
    // 客户端拿到的 id 来自列表，而它已经从列表上消失了，正确反应是重拉列表
    expect(await errorCode(res)).toBe('NOT_FOUND')
    expect(await subjectCount(person)).toBe(1)
  })

  it('拆成新人物，name 可以不给', async () => {
    const actor = await signIn()
    const source = await makePerson('原来那组')
    const memes = await linkMemes(source, 2, actor.id)

    const body = await json(
      await call('POST', '/persons/assignments', actor, {
        memeIds: [memes[0]],
        newPerson: { name: '新的一组' },
      }),
    )
    expect((body['person'] as { name: string }).name).toBe('新的一组')

    // 原人物还剩一张，不能因为「被拆过」就消失
    expect(await subjectCount(source)).toBe(1)

    const unnamed = await json(
      await call('POST', '/persons/assignments', actor, {
        memeIds: [memes[1]],
        newPerson: {},
      }),
    )
    expect((unnamed['person'] as { name: string | null }).name).toBeNull()
    // 原人物的最后一张图被搬走 → 当场删除（§5.7.4）
    expect(await personExists(source)).toBe(false)
  })

  it('none：移出人物，被移空的人物当场删除', async () => {
    const actor = await signIn()
    const person = await makePerson('塞西')
    const [memeId] = await linkMemes(person, 1, actor.id)

    const body = await json(
      await call('POST', '/persons/assignments', actor, { memeIds: [memeId], none: true }),
    )
    expect(body['person']).toBeNull()
    expect(body['movedCount']).toBe(1)

    expect(await personExists(person)).toBe(false)

    const rows = await db
      .select({ personId: memeSubjects.personId, assignedBy: memeSubjects.assignedBy })
      .from(memeSubjects)
      .where(eq(memeSubjects.memeId, memeId as string))
    // 归属被清空，**但 `assigned_by` 必须留下**：那是「机器不许再改它」的凭据
    expect(rows[0]?.personId).toBeNull()
    expect(rows[0]?.assignedBy).toBe(actor.id)
  })

  it('图只是被软删、`meme_subjects` 行还在的人物**不删**（§5.7.4）', async () => {
    const actor = await signIn()
    const person = await makePerson('塞西')
    const [memeId] = await linkMemes(person, 2, actor.id)
    await softDeleteMeme(memeId as string, actor, db)

    // 把另一张也移走：这个人物已经没有「还在」的图了，但成员行还剩那张软删的
    const remaining = await db
      .select({ memeId: memeSubjects.memeId })
      .from(memeSubjects)
      .where(eq(memeSubjects.personId, person))
    expect(remaining.length).toBe(2)

    const alive = remaining.map((r) => r.memeId).filter((id) => id !== memeId)
    await call('POST', '/persons/assignments', actor, { memeIds: alive, none: true })

    // 行还在：那张软删的图恢复时，人物要跟着回来
    expect(await personExists(person)).toBe(true)
  })

  it('人放进去的归属，机器重算时不改（§5.7.2）', async () => {
    const actor = await signIn()
    const person = await makePerson('塞西')
    await linkMemes(person, 1, actor.id, axisVector(0))
    const loose = await makeMeme(db, { uploaderId: actor.id })

    await call('POST', '/persons/assignments', actor, {
      memeIds: [loose.id],
      personId: person,
    })

    // 声称「这张其实和另一个人物更像」，机器也不该把它挪走
    const other = await makePerson('别人')
    await linkMemes(other, 1, actor.id, axisVector(7))

    const outcome = await assignPersonVector(loose.id, axisVector(7), MODEL_KEY, db)
    expect(outcome.keptAssignment).toBe(true)
    expect(outcome.personId).toBe(person)
    expect(await subjectCount(other)).toBe(1)
  })

  it('任何一张图不存在或已软删：NOT_FOUND，整个请求不生效', async () => {
    const actor = await signIn()
    const person = await makePerson('塞西')
    const good = await makeMeme(db, { uploaderId: actor.id })
    const deleted = await makeMeme(db, { uploaderId: actor.id })
    await softDeleteMeme(deleted.id, actor, db)

    const missing = await call('POST', '/persons/assignments', actor, {
      memeIds: [good.id, crypto.randomUUID()],
      personId: person,
    })
    expect(await errorCode(missing)).toBe('NOT_FOUND')

    const softDeleted = await call('POST', '/persons/assignments', actor, {
      memeIds: [good.id, deleted.id],
      personId: person,
    })
    expect(await errorCode(softDeleted)).toBe('NOT_FOUND')

    // 一个请求里合法的那张也不能动：**连一行归属都不该写出来**
    const rows = await db
      .select({ personId: memeSubjects.personId })
      .from(memeSubjects)
      .where(eq(memeSubjects.memeId, good.id))
    expect(rows).toEqual([])
  })

  it('三种去处必须恰好给一种', async () => {
    const actor = await signIn()
    const person = await makePerson('塞西')
    const meme = await makeMeme(db, { uploaderId: actor.id })
    const base = { memeIds: [meme.id] }

    for (const body of [
      base, // 都不给
      { ...base, personId: person, none: true }, // 给两种
      { ...base, none: false }, // none 不是 true
      { ...base, newPerson: { name: '   ' } }, // 新名字空串
    ]) {
      const res = await call('POST', '/persons/assignments', actor, body)
      expect(await errorCode(res)).toBe('VALIDATION_FAILED')
    }
  })

  it('memeIds 为空、重复、超过 100 都是 VALIDATION_FAILED', async () => {
    const actor = await signIn()

    for (const memeIds of [
      [],
      ['not-a-uuid'],
      Array.from({ length: 101 }, () => crypto.randomUUID()),
    ]) {
      const res = await call('POST', '/persons/assignments', actor, { memeIds, none: true })
      expect(await errorCode(res)).toBe('VALIDATION_FAILED')
    }

    const one = await makeMeme(db, { uploaderId: actor.id })
    const dup = await call('POST', '/persons/assignments', actor, {
      memeIds: [one.id, one.id],
      none: true,
    })
    expect(await errorCode(dup)).toBe('VALIDATION_FAILED')
  })

  it('指向不存在的人物是 NOT_FOUND，与「图全被软删」同一条判据', async () => {
    const actor = await signIn()
    const meme = await makeMeme(db, { uploaderId: actor.id })

    const res = await call('POST', '/persons/assignments', actor, {
      memeIds: [meme.id],
      personId: crypto.randomUUID(),
    })
    // `personId` 是**这次要操作的对象**，不是某个字段的取值（§6.7.4 开头）：
    // 它和 `memeIds` 那张图同一个身份，所以是 404；`seriesId` / `coverMemeId`
    // 那两处才是 400。这一处曾经按后者判，2026-09-30 定死之后改的。
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('NOT_FOUND')

    // 整个请求不生效：那张合法的图也没被写出去
    const rows = await db
      .select({ personId: memeSubjects.personId })
      .from(memeSubjects)
      .where(eq(memeSubjects.memeId, meme.id))
    expect(rows).toEqual([])
  })
})

// ── 系列（§6.7.4） ────────────────────────────────────────────────

describe('系列：新建 / 改名 / 改成员 / 删除', () => {
  it('新建时就能带上第一批成员，计数正确', async () => {
    const actor = await signIn()
    const a = await makePerson('甲')
    const b = await makePerson('乙')
    await linkMemes(a, 2, actor.id)
    await linkMemes(b, 3, actor.id)

    const body = await json(
      await call('POST', '/series', actor, { name: ' 银魂 ', personIds: [a, b] }),
    )
    expect(body['name']).toBe('银魂')
    expect(body['personCount']).toBe(2)
    expect(body['memeCount']).toBe(5)
    expect(body['createdBy']).toBe(actor.id)
    // 创建不是一次「人工改动」，updatedBy/updatedAt 留空
    expect(body['updatedBy']).toBeNull()
    expect(body['updatedAt']).toBeNull()
  })

  it('不带 personIds 就是空系列，cover 为 null', async () => {
    const actor = await signIn()
    const body = await json(await call('POST', '/series', actor, { name: '空的' }))

    expect(body['personCount']).toBe(0)
    expect(body['cover']).toBeNull()

    // 空系列照样出现在列表里（§6.7.3）
    const list = await json(await call('GET', '/series', actor))
    expect((list['items'] as { id: string }[]).map((s) => s.id)).toEqual([body['id']])
  })

  it('名字撞车是 CONFLICT，且去空白、不区分大小写', async () => {
    const actor = await signIn()
    await call('POST', '/series', actor, { name: 'Naruto' })

    for (const name of ['Naruto', 'naruto', '  NARUTO  ']) {
      const res = await call('POST', '/series', actor, { name })
      expect(res.status).toBe(409)
      expect(await errorCode(res)).toBe('CONFLICT')
    }
  })

  it('改名时撞到别的系列也是 CONFLICT，改回自己不算撞', async () => {
    const actor = await signIn()
    const first = await json(await call('POST', '/series', actor, { name: '甲系列' }))
    await call('POST', '/series', actor, { name: '乙系列' })

    const clash = await call('PATCH', `/series/${first['id']}`, actor, { name: '乙系列' })
    expect(await errorCode(clash)).toBe('CONFLICT')

    const same = await call('PATCH', `/series/${first['id']}`, actor, { name: '甲系列' })
    expect(same.status).toBe(200)
  })

  it('personIds 是完整名单，不是增量', async () => {
    const actor = await signIn()
    const a = await makePerson('甲')
    const b = await makePerson('乙')
    const c = await makePerson('丙')
    for (const id of [a, b, c]) await linkMemes(id, 1, actor.id)

    const created = await json(
      await call('POST', '/series', actor, { name: '银魂', personIds: [a, b] }),
    )
    const seriesId = created['id'] as string

    // 只留 b、加上 c：a 必须被移出，c 进来
    const patched = await json(await call('PATCH', `/series/${seriesId}`, actor, { personIds: [b, c] }))
    expect(patched['personCount']).toBe(2)

    const personsBody = await json(await call('GET', `/persons?series=${seriesId}`, actor))
    const ids = (personsBody['items'] as { id: string }[]).map((p) => p.id)
    expect(ids.sort()).toEqual([b, c].sort())

    // 空名单 = 全部移出，而不是「不改」
    const emptied = await json(await call('PATCH', `/series/${seriesId}`, actor, { personIds: [] }))
    expect(emptied['personCount']).toBe(0)
  })

  it('personIds 里有不存在的人物是 VALIDATION_FAILED', async () => {
    const actor = await signIn()
    const res = await call('POST', '/series', actor, {
      name: '银魂',
      personIds: [crypto.randomUUID()],
    })
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('系列名不能是 null（它是系列的标识）', async () => {
    const actor = await signIn()
    const created = await json(await call('POST', '/series', actor, { name: '银魂' }))

    const res = await call('PATCH', `/series/${created['id']}`, actor, { name: null })
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('删除只删系列这一行：人物还在，seriesId 置空（§5.7.3）', async () => {
    const actor = await signIn()
    const person = await makePerson('甲')
    await linkMemes(person, 1, actor.id)

    const created = await json(
      await call('POST', '/series', actor, { name: '银魂', personIds: [person] }),
    )
    const seriesId = created['id'] as string

    const res = await call('DELETE', `/series/${seriesId}`, actor)
    expect(res.status).toBe(204)

    expect((await call('GET', `/series/${seriesId}`, actor)).status).toBe(404)
    expect(await personExists(person)).toBe(true)

    const after = await json(await call('GET', `/persons/${person}`, actor))
    expect(after['seriesId']).toBeNull()
  })

  it('不是创建者也不是 admin 就 FORBIDDEN，admin 可以删', async () => {
    const creator = await signIn()
    const other = await signIn()
    const admin = await signIn('admin')

    const created = await json(await call('POST', '/series', creator, { name: '银魂' }))
    const seriesId = created['id'] as string

    const forbidden = await call('DELETE', `/series/${seriesId}`, other)
    expect(forbidden.status).toBe(403)
    expect(await errorCode(forbidden)).toBe('FORBIDDEN')

    // 拒绝之后系列还在——403 不能顺手删掉
    expect((await call('GET', `/series/${seriesId}`, creator)).status).toBe(200)

    expect((await call('DELETE', `/series/${seriesId}`, admin)).status).toBe(204)
  })

  it('已删的再删一次是 NOT_FOUND（不幂等，理由同 §6.4.2）', async () => {
    const actor = await signIn()
    const created = await json(await call('POST', '/series', actor, { name: '银魂' }))
    const seriesId = created['id'] as string

    expect((await call('DELETE', `/series/${seriesId}`, actor)).status).toBe(204)
    expect((await call('DELETE', `/series/${seriesId}`, actor)).status).toBe(404)
  })

  it('未登录一律 401', async () => {
    for (const [method, path] of [
      ['POST', '/series'],
      ['PATCH', `/series/${crypto.randomUUID()}`],
      ['DELETE', `/series/${crypto.randomUUID()}`],
      ['POST', '/persons/assignments'],
      ['PATCH', `/persons/${crypto.randomUUID()}`],
      ['POST', `/persons/${crypto.randomUUID()}/merge`],
      ['POST', `/persons/${crypto.randomUUID()}/rejections`],
    ] as const) {
      expect((await call(method, path, null, {})).status).toBe(401)
    }
  })
})
