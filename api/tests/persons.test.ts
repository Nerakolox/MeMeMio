import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, isNull, sql as raw } from 'drizzle-orm'

/**
 * 人物与系列的**数据层**（SPEC §5.7 / §6.7，任务 2026-09-29-人物识别与聚类 §5.1）。
 *
 * 这里测三件在这一层才成立的事：
 *
 * 1. **机器分配**：阈值内挂上、阈值外自成一组、**并发不重复建人物**、
 *    已经分配过的行重算只换向量（§5.7.2）
 * 2. **软删过滤**：图数、封面、列表、详情、系列计数五处（§5.7.4）
 * 3. **合并建议**：不含隐藏的、不含点过「不是同一个」的（§6.7.3）
 *
 * ⏸️ 2026-10-01 起人物功能暂停（任务 2026-10-01-人物功能临时下线 §4）：
 * 算向量那一步改调 `writePersonVector`（只写向量），`assignPersonVector` 暂时没有
 * 调用点。**它的测试一条都不删也不改**——那个函数原样留着，恢复自动挂就是把它接回去。
 * 这一段下面新加的 `writePersonVector` 测的是暂停期间真正在跑的那条写路径。
 *
 * 上游（图片向量的那次 HTTP 调用）**全部是桩**：本文件不碰任何真实 AI 通道，
 * 也不花部署方的额度——它连 `fetch` 都不 stub，因为这里没有任何一条路径该调上游。
 * 替身换回来的那一层在 `persons-api.test.ts` / `persons-image-embed.test.ts` 的文件头。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 必须在 import 任何 src 模块之前：默认连接读的是 DATABASE_URL
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { softDeleteMeme } = await import('../src/data/memes.js')
const {
  assignPersonVector,
  findPersonById,
  findSeriesById,
  listPersons,
  listSeries,
  listSuggestedPersonIds,
  resolvePersonCovers,
  writePersonVector,
} = await import('../src/data/persons.js')
const { memeSubjects, persons, series } = await import('../src/data/schema.js')

const { sql, db } = createTestDb()

/** 与 `ai/image-embedder.ts` 的口径串一致：模型名 + 长边。 */
const MODEL_KEY = 'test-image-model@768'
const OTHER_MODEL_KEY = 'test-image-model@512'

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

/** 单位向量：轴不同 = 余弦距离为 1，一眼看得出该挂谁。 */
function axisVector(axis: number): number[] {
  const vector = new Array<number>(1024).fill(0)
  vector[axis] = 1
  return vector
}

/**
 * 与 `axisVector(axis)` 的余弦为 `similarity` 的向量（同在 axis 那一维所在的方向上偏一点）。
 *
 * 直接构造「向量的第 axis 维是 cos θ、第 other 维是 sin θ」——这才是精确可算的，
 * 而且两个向量都是单位向量，符合 `assignPersonVector` 对入参的要求。
 */
function tiltedVector(axis: number, otherAxis: number, similarity: number): number[] {
  const vector = new Array<number>(1024).fill(0)
  vector[axis] = similarity
  vector[otherAxis] = Math.sqrt(1 - similarity * similarity)
  return vector
}

async function makePerson(name: string | null = null): Promise<string> {
  const rows = await db.insert(persons).values({ name }).returning({ id: persons.id })
  const row = rows[0]
  if (row === undefined) throw new Error('建人物失败')
  return row.id
}

/**
 * ⏸️ 这一组六条**一条都没改**，尽管函数暂停期间没有调用点。
 *
 * 它们测的是 `assignPersonVector` 自己的规矩（阈值、并发、不动人做过的决定）。
 * 那个函数原样留着，规矩就没变，测试也就没理由变——**删掉它们才是退化**：
 * 恢复自动挂时那一下接回去，靠的就是这一组还在。
 */
describe('机器分配（§5.7.2）', () => {
  it('阈值内挂到已有人物上', async () => {
    const user = await createUser(db)
    const existing = await makeMeme(db, { uploaderId: user.id })
    const target = await makePerson('甲')
    await db.insert(memeSubjects).values({
      memeId: existing.id,
      embedding: axisVector(0),
      embedModel: MODEL_KEY,
      personId: target,
    })

    const fresh = await makeMeme(db, { uploaderId: user.id })
    // 余弦 0.99 —— 远高于 0.825
    const outcome = await assignPersonVector(fresh.id, tiltedVector(0, 1, 0.99), MODEL_KEY, db)

    expect(outcome.personId).toBe(target)
    expect(outcome.createdPerson).toBe(false)
    expect(outcome.keptAssignment).toBe(false)
  })

  it('阈值外自成一个新的未命名人物', async () => {
    const user = await createUser(db)
    const existing = await makeMeme(db, { uploaderId: user.id })
    const target = await makePerson('甲')
    await db.insert(memeSubjects).values({
      memeId: existing.id,
      embedding: axisVector(0),
      embedModel: MODEL_KEY,
      personId: target,
    })

    const fresh = await makeMeme(db, { uploaderId: user.id })
    // 余弦 0.5 —— 低于 0.825
    const outcome = await assignPersonVector(fresh.id, tiltedVector(0, 1, 0.5), MODEL_KEY, db)

    expect(outcome.personId).not.toBe(target)
    expect(outcome.createdPerson).toBe(true)
    const [created] = await db.select().from(persons).where(eq(persons.id, outcome.personId!))
    expect(created?.name).toBeNull()
  })

  it('只有同口径的向量参与比较（§5.7.1）', async () => {
    const user = await createUser(db)
    const existing = await makeMeme(db, { uploaderId: user.id })
    const target = await makePerson('甲')
    await db.insert(memeSubjects).values({
      memeId: existing.id,
      // 同一维向量，但口径是另一个长边
      embedding: axisVector(0),
      embedModel: OTHER_MODEL_KEY,
      personId: target,
    })

    const fresh = await makeMeme(db, { uploaderId: user.id })
    const outcome = await assignPersonVector(fresh.id, axisVector(0), MODEL_KEY, db)

    // 两个空间比出来的余弦是噪声，所以那份向量必须被当成「不存在」
    expect(outcome.personId).not.toBe(target)
    expect(outcome.createdPerson).toBe(true)
  })

  it('并发分配不会为同一个角色建出两个人物', async () => {
    const user = await createUser(db)
    const memes = await Promise.all(
      Array.from({ length: 6 }, () => makeMeme(db, { uploaderId: user.id })),
    )

    // 六张几乎一样的图同时进来。没有那把 advisory 锁的话，每一张都在别人建组之前
    // 找不到可挂的人物，于是各建一个——同一个人碎成六组，而且不报错
    await Promise.all(
      memes.map((m) => assignPersonVector(m.id, tiltedVector(0, 1, 0.999), MODEL_KEY, db)),
    )

    const rows = await db.select().from(persons)
    expect(rows).toHaveLength(1)
    const subjects = await db.select().from(memeSubjects)
    expect(subjects).toHaveLength(6)
    expect(new Set(subjects.map((s) => s.personId)).size).toBe(1)
  })

  it('人做过的决定不会被重算改掉（§5.7.2）', async () => {
    const user = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: user.id })
    const personA = await makePerson('甲')
    const personB = await makePerson('乙')

    // 甲必须是一个**真的候选**，否则这个测试什么都没证明：没有成员的人物没有质心，
    // 机器根本不会看它一眼，于是「没被改掉」是它本来就做不到，不是守住了归属
    const anchor = await makeMeme(db, { uploaderId: user.id })
    await db.insert(memeSubjects).values({
      memeId: anchor.id,
      embedding: axisVector(0),
      embedModel: MODEL_KEY,
      personId: personA,
    })

    // 人把这张图放进了乙
    await db.insert(memeSubjects).values({
      memeId: meme.id,
      embedding: axisVector(0),
      embedModel: MODEL_KEY,
      personId: personB,
      assignedBy: user.id,
      assignedAt: new Date(),
    })

    // 重算：新向量与甲的质心完全相同（相似度 1，远高于 0.825），但机器不许动归属
    const outcome = await assignPersonVector(meme.id, axisVector(0), MODEL_KEY, db)

    expect(outcome.keptAssignment).toBe(true)
    expect(outcome.personId).toBe(personB)
    const [row] = await db.select().from(memeSubjects).where(eq(memeSubjects.memeId, meme.id))
    expect(row?.embedModel).toBe(MODEL_KEY)
    expect(row?.assignedBy).toBe(user.id)
  })

  it('人移出过的图（person_id 为 null）也不会被机器挂回去', async () => {
    const user = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: user.id })
    await makePerson('甲')

    await db.insert(memeSubjects).values({
      memeId: meme.id,
      embedding: axisVector(0),
      embedModel: MODEL_KEY,
      personId: null,
      assignedBy: user.id,
      assignedAt: new Date(),
    })

    const outcome = await assignPersonVector(meme.id, axisVector(0), MODEL_KEY, db)
    expect(outcome.keptAssignment).toBe(true)
    expect(outcome.personId).toBeNull()
    // 那次「不是他」的判断留在库里，不能因为重算就被抹掉
    const [row] = await db.select().from(memeSubjects).where(eq(memeSubjects.memeId, meme.id))
    expect(row?.assignedBy).toBe(user.id)
  })
})

/**
 * ⏸️ 暂停期间真正在跑的那条写路径（`computePersonVector` 末尾调它）。
 *
 * 它与上面的 `assignPersonVector` 是**同一条线上的两个版本**：同一个 upsert，
 * 一个写归属、一个不写。所以这里的两条性质必须和那边逐字对齐——动了一边要回看另一边。
 */
describe('只写向量、不写归属（⏸️ 暂停期间）', () => {
  it('新行：向量写进去，归属三列全空，也不会建人物', async () => {
    const user = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: user.id })

    await writePersonVector(meme.id, axisVector(3), MODEL_KEY, db)

    const [row] = await db.select().from(memeSubjects).where(eq(memeSubjects.memeId, meme.id))
    expect(row?.embedModel).toBe(MODEL_KEY)
    expect(row?.personId).toBeNull()
    expect(row?.assignedBy).toBeNull()
    expect(row?.assignedAt).toBeNull()
    // 机器不建人物——「136 个单图人物」就是这么长出来的（任务 §13.6 ⑦）
    expect(await db.select().from(persons)).toHaveLength(0)
  })

  it('已有行：只换向量，人做过的归属原样留着（与 assignPersonVector 第 1 步同一个口径）', async () => {
    const user = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: user.id })
    const personId = await makePerson('甲')
    await db.insert(memeSubjects).values({
      memeId: meme.id,
      embedding: axisVector(0),
      embedModel: OTHER_MODEL_KEY,
      personId,
      assignedBy: user.id,
      assignedAt: new Date(),
    })

    await writePersonVector(meme.id, axisVector(1), MODEL_KEY, db)

    const [row] = await db.select().from(memeSubjects).where(eq(memeSubjects.memeId, meme.id))
    // 向量换成新口径了
    expect(row?.embedModel).toBe(MODEL_KEY)
    // 归属一个字没动：重算不能把人做过的决定抹掉（§5.7.2）
    expect(row?.personId).toBe(personId)
    expect(row?.assignedBy).toBe(user.id)
    expect(row?.assignedAt).not.toBeNull()
  })
})

describe('软删过滤（§5.7.4）', () => {
  async function seed(): Promise<{ personId: string; memeIds: string[]; uploaderId: string }> {
    const user = await createUser(db)
    const personId = await makePerson('甲')
    const memeIds: string[] = []
    for (const _ of [0, 1]) {
      const meme = await makeMeme(db, { uploaderId: user.id })
      memeIds.push(meme.id)
      await db
        .insert(memeSubjects)
        .values({ memeId: meme.id, personId, embedding: axisVector(0), embedModel: MODEL_KEY })
    }
    return { personId, memeIds, uploaderId: user.id }
  }

  it('图数只算还在的', async () => {
    const { personId, memeIds, uploaderId } = await seed()
    await softDeleteMeme(memeIds[0]!, { id: uploaderId, role: 'member' }, db)

    const { items } = await listPersons({ limit: 40 }, db)
    expect(items).toHaveLength(1)
    expect(items[0]?.memeCount).toBe(1)
    expect((await findPersonById(personId, db))?.memeCount).toBe(1)
  })

  it('图全被软删的人物不出现在列表里，详情是 null', async () => {
    const { personId, memeIds, uploaderId } = await seed()
    for (const id of memeIds) await softDeleteMeme(id, { id: uploaderId, role: 'member' }, db)

    expect((await listPersons({ limit: 40 }, db)).items).toHaveLength(0)
    // 行还在：图被恢复时人物跟着回来
    expect(await findPersonById(personId, db)).toBeNull()
    const rows = await db.select().from(persons).where(eq(persons.id, personId))
    expect(rows).toHaveLength(1)
  })

  it('显式封面被软删时回落到成员里最新的一张', async () => {
    const { personId, memeIds, uploaderId } = await seed()
    await db.update(persons).set({ coverMemeId: memeIds[0]! }).where(eq(persons.id, personId))
    await softDeleteMeme(memeIds[0]!, { id: uploaderId, role: 'member' }, db)

    const summary = await findPersonById(personId, db)
    const covers = await resolvePersonCovers(
      [{ id: personId, coverMemeId: summary?.coverMemeId ?? null }],
      db,
    )
    expect(covers.get(personId)?.memeId).toBe(memeIds[1])
  })

  it('系列的图数与人物数都按还在的图算', async () => {
    const { personId, memeIds, uploaderId } = await seed()
    const rows = await db.insert(series).values({ name: '某作品', createdBy: uploaderId }).returning()
    const seriesId = rows[0]!.id
    await db.update(persons).set({ seriesId }).where(eq(persons.id, personId))

    expect((await findSeriesById(seriesId, db))?.memeCount).toBe(2)
    expect((await findSeriesById(seriesId, db))?.personCount).toBe(1)

    for (const id of memeIds) await softDeleteMeme(id, { id: uploaderId, role: 'member' }, db)
    const gone = await findSeriesById(seriesId, db)
    expect(gone?.memeCount).toBe(0)
    expect(gone?.personCount).toBe(0)
    // 系列本身还在（§6.7.3：系列不论空不空都在）
    expect(gone).not.toBeNull()

    // 列表里同样在。`left join` 掉了的话它会被整个吞掉，而表现是「刚建好的系列不见了」
    const listed = await listSeries({ limit: 40 }, db)
    expect(listed.items.map((s) => s.id)).toEqual([seriesId])
    // 图数归零的人物不再是它的封面人物（封面人物只从 `live` 里挑）
    expect(listed.items[0]?.coverPersonId).toBeNull()
  })
})

describe('列表筛选（§6.7.3）', () => {
  it('q / named / hidden / series=none / minCount 各按字面生效', async () => {
    const user = await createUser(db)
    const named = await makePerson('塞西莉亚')
    const other = await makePerson('露娜')
    const unnamed = await makePerson(null)
    const hiddenPerson = await makePerson('隐藏的')

    const link = async (personId: string, count: number) => {
      for (let i = 0; i < count; i += 1) {
        const meme = await makeMeme(db, { uploaderId: user.id })
        await db
          .insert(memeSubjects)
          .values({ memeId: meme.id, personId, embedding: axisVector(0), embedModel: MODEL_KEY })
      }
    }
    await link(named, 2)
    await link(other, 1)
    await link(unnamed, 1)
    await link(hiddenPerson, 5)

    await db.update(persons).set({ hiddenAt: new Date() }).where(eq(persons.id, hiddenPerson))
    const seriesRows = await db
      .insert(series)
      .values({ name: '作品', createdBy: user.id })
      .returning()
    await db.update(persons).set({ seriesId: seriesRows[0]!.id }).where(eq(persons.id, other))

    const all = await listPersons({ limit: 40 }, db)
    // 隐藏的默认不出现；排序是 memeCount desc, id
    expect(all.items.map((p) => p.id)).not.toContain(hiddenPerson)
    expect(all.items).toHaveLength(3)

    expect((await listPersons({ q: '塞西', limit: 40 }, db)).items.map((p) => p.id)).toEqual([named])
    expect((await listPersons({ named: true, limit: 40 }, db)).items).toHaveLength(2)
    expect((await listPersons({ named: false, limit: 40 }, db)).items.map((p) => p.id)).toEqual([
      unnamed,
    ])
    expect((await listPersons({ hidden: true, limit: 40 }, db)).items.map((p) => p.id)).toEqual([
      hiddenPerson,
    ])
    expect((await listPersons({ series: 'none', limit: 40 }, db)).items).toHaveLength(2)
    expect((await listPersons({ minCount: 2, limit: 40 }, db)).items.map((p) => p.id)).toEqual([
      named,
    ])
  })

  it('游标翻页：图数相同的那些也不会漏', async () => {
    const user = await createUser(db)
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const personId = await makePerson(`人物${i}`)
      ids.push(personId)
      const meme = await makeMeme(db, { uploaderId: user.id })
      await db
        .insert(memeSubjects)
        .values({ memeId: meme.id, personId, embedding: axisVector(0), embedModel: MODEL_KEY })
    }

    const first = await listPersons({ limit: 2 }, db)
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const second = await listPersons(
      { limit: 2, cursor: (await import('../src/data/persons.js')).decodePersonListCursor(first.nextCursor!) },
      db,
    )
    const seen = [...first.items, ...second.items].map((p) => p.id)
    // 图数全都相同——游标那一对键少一个方向就会在这里重复或漏
    expect(new Set(seen).size).toBe(4)
  })
})

describe('合并建议（§6.7.3）', () => {
  async function seedPair(): Promise<{ a: string; b: string; uploaderId: string }> {
    const user = await createUser(db)
    const a = await makePerson('甲')
    const b = await makePerson('乙')
    for (const [personId, vector] of [
      [a, axisVector(0)],
      [b, tiltedVector(0, 1, 0.95)],
    ] as const) {
      const meme = await makeMeme(db, { uploaderId: user.id })
      await db
        .insert(memeSubjects)
        .values({ memeId: meme.id, personId, embedding: vector, embedModel: MODEL_KEY })
    }
    return { a, b, uploaderId: user.id }
  }

  it('给出阈值内最像的，且不含相似度以外的排序依据', async () => {
    const { a, b } = await seedPair()
    expect(await listSuggestedPersonIds(a, 3, db)).toEqual([b])
  })

  it('隐藏的人物不进建议', async () => {
    const { a, b } = await seedPair()
    await db.update(persons).set({ hiddenAt: new Date() }).where(eq(persons.id, b))
    expect(await listSuggestedPersonIds(a, 3, db)).toEqual([])
  })

  it('点过「不是同一个」之后不再给这一对（两个方向都算）', async () => {
    const { a, b, uploaderId } = await seedPair()
    // 故意反着存：库里按较小的 id 在前，查的时候必须用 least/greatest 对齐
    await db.execute(raw`
      insert into person_rejections (person_id, other_person_id, created_by)
      values (least(${a}::uuid, ${b}::uuid), greatest(${a}::uuid, ${b}::uuid), ${uploaderId}::uuid)
    `)
    expect(await listSuggestedPersonIds(a, 3, db)).toEqual([])
    expect(await listSuggestedPersonIds(b, 3, db)).toEqual([])
  })

  it('图数归零的人物不进建议', async () => {
    const { a, b, uploaderId } = await seedPair()
    const rows = await db
      .select({ memeId: memeSubjects.memeId })
      .from(memeSubjects)
      .where(eq(memeSubjects.personId, b))
    await softDeleteMeme(rows[0]!.memeId, { id: uploaderId, role: 'member' }, db)
    expect(await listSuggestedPersonIds(a, 3, db)).toEqual([])
  })

  it('只比同口径的向量', async () => {
    const { a, b } = await seedPair()
    await db
      .update(memeSubjects)
      .set({ embedModel: OTHER_MODEL_KEY })
      .where(
        and(eq(memeSubjects.personId, b), isNull(memeSubjects.assignedBy)),
      )
    expect(await listSuggestedPersonIds(a, 3, db)).toEqual([])
  })
})
