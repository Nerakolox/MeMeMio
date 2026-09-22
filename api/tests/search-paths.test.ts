import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 搜索三路的集成测试（SPEC §6.3.1、agents/rules/retrieval.md §2）。
 *
 * 这里**必须**跑真 Postgres：两路的召回是 SQL 特性（pg_trgm 的 `similarity`、pgvector 的 `<=>`），
 * mock 掉数据层等于把要测的东西换成自己的实现。所以断的是「哪条记录被召回」，不是 SQL 文本。
 *
 * ⚠️ 下面这几行必须在**任何 src/ 模块被 import 之前**执行：`src/env.ts` 是在模块顶层跑校验的，
 *    先 import 再改环境变量就晚了。所以本文件里的 src 模块全走动态 import，别改成顶层 import。
 *
 * 刻意**不给** DEFAULT_*_* 配置：这是产品要求的降级态（embedding 未配置 → 向量路不跑），
 * 也是最容易被顺手改坏的一条路径。真配了模型，单测也不该发网络请求。
 */
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, favoriteMeme, makeMeme, unitVector } = await import('./helpers/factories.js')
const { ocrPathCandidates, tagPathCandidates, vectorPathCandidates, findMemesForSearch } =
  await import('../src/data/search.js')
const { softDeleteMeme } = await import('../src/data/memes.js')

const { sql, db } = createTestDb()

/** 向量路按 `embed_model` 过滤（SPEC §9.20），种子和查询都得说清自己是哪个模型的向量。 */
const MODEL = 'text-embedding-test'

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

describe('OCR / trgm 路', () => {
  it('命中 ocr_text + description，且软删的记录不出现', async () => {
    const alice = await createUser(db)
    const hit = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '一只猫在键盘上睡觉',
      description: '表情很无奈',
    })
    const deleted = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '一只猫在键盘上睡觉',
      description: '但是已经删了',
    })
    const unrelated = await makeMeme(db, { uploaderId: alice.id, ocrText: '一只狗在草地上跑' })

    await softDeleteMeme(deleted.id, alice, db)

    const ids = await ocrPathCandidates('猫在键盘上睡觉', [], db)

    expect(ids).toContain(hit.id)
    expect(ids).not.toContain(deleted.id)
    expect(ids).not.toContain(unrelated.id)
  })

  it('⚠️ 不匹配 search_text —— 标签值不该在这一路里再计一次分（SPEC §9.21）', async () => {
    const alice = await createUser(db)
    // search_text 里拼着六个数组的标签值。这一路也匹配它的话，同一个「无语」会被
    // 文本路和标签路各召回一次，RRF 融合时靠标签沾边的图会压过原文精确命中的图。
    // 表现是排序变差，不报错——所以要有一条用例把它钉住。
    const labelOnly = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '',
      description: '',
      emotions: ['无语'],
      searchText: '无语',
    })

    expect(await ocrPathCandidates('无语', [], db)).not.toContain(labelOnly.id)
  })

  it('original_filename 单独参与匹配（不进 search_text）', async () => {
    const alice = await createUser(db)
    // 从网上存的表情包文件名里常带梗名（SPEC §9.18）
    const hit = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '一只猫张着嘴大喊',
      originalFilename: 'shocked-cat-reaction.png',
    })

    expect(await ocrPathCandidates('shocked-cat-reaction', [], db)).toContain(hit.id)
  })

  it('软删的记录在文件名匹配上也不出现', async () => {
    const alice = await createUser(db)
    const deleted = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '一只猫',
      originalFilename: 'deleted-by-filename.png',
    })
    await softDeleteMeme(deleted.id, alice, db)

    expect(await ocrPathCandidates('deleted-by-filename', [], db)).not.toContain(deleted.id)
  })

  it('过短的查询直接不召回', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, ocrText: '猫' })

    expect(await ocrPathCandidates('猫', [], db)).toEqual([])
  })

  it('LIKE 元字符按字面量处理', async () => {
    const alice = await createUser(db)
    const hit = await makeMeme(db, { uploaderId: alice.id, ocrText: '进度条已经 100% 了' })
    await makeMeme(db, { uploaderId: alice.id, ocrText: '完全没有关系的一句话' })

    // 未转义时 `%` 会变成通配符，把库里所有记录都捞回来
    const ids = await ocrPathCandidates('100%', [], db)
    expect(ids).toEqual([hit.id])
  })

  it('exclude 的标签会被排掉，哪怕正文命中', async () => {
    const alice = await createUser(db)
    const realPerson = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '一只猫在键盘上睡觉',
      tags: ['真人'],
    })
    const kept = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '一只猫在键盘上睡觉',
      tags: ['动漫'],
    })

    // 用户搜「猫在键盘上睡觉 -真人」：排除作用在三路上，不是只在标签路
    const ids = await ocrPathCandidates('猫在键盘上睡觉', ['真人'], db)

    expect(ids).toContain(kept.id)
    expect(ids).not.toContain(realPerson.id)
  })
})

describe('标签路', () => {
  it('六个数组都会被匹配', async () => {
    const alice = await createUser(db)
    const byExpression = await makeMeme(db, { uploaderId: alice.id, expressions: ['假笑'] })
    const byEmotion = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'] })
    const byTone = await makeMeme(db, { uploaderId: alice.id, tones: ['敷衍'] })
    const byPurpose = await makeMeme(db, { uploaderId: alice.id, purposes: ['拒绝'] })
    const byScene = await makeMeme(db, { uploaderId: alice.id, scenes: ['加班'] })
    const byTag = await makeMeme(db, { uploaderId: alice.id, tags: ['猫'] })

    // 一维一次：多词之间是 OR，混在一起查看不出哪一维没被匹配
    expect(await tagPathCandidates(['假笑'], [], db)).toContain(byExpression.id)
    expect(await tagPathCandidates(['无语'], [], db)).toContain(byEmotion.id)
    expect(await tagPathCandidates(['敷衍'], [], db)).toContain(byTone.id)
    expect(await tagPathCandidates(['拒绝'], [], db)).toContain(byPurpose.id)
    expect(await tagPathCandidates(['加班'], [], db)).toContain(byScene.id)
    expect(await tagPathCandidates(['猫'], [], db)).toContain(byTag.id)
  })

  it('只匹配标签，不看 search_text —— 命中词表才进来', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, searchText: '一只很无语的猫', tags: ['狗'] })

    // 「无语」在正文里出现过，但标签不是「无语」，这一路就不该召回它（SPEC §6.3.1：
    // 文字匹配是 trgm 路的职责，两路各管各的，否则 RRF 融合出来的 matchedBy 全是噪声）
    expect(await tagPathCandidates(['无语'], [], db)).toEqual([])
  })

  it('⚠️ 多个词之间是 OR，不是 AND', async () => {
    const alice = await createUser(db)
    const onlyOne = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'], tags: ['狗'] })
    const both = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'], tags: ['猫'] })

    // 2026-09-22 从 AND 改成 OR：六个维度之后，「猫 无语 敷衍 加班」这种查询用 AND
    // 要求一张图同时带齐四个标签，库里多半一张都没有，整条路塌成空集（data/search.ts）
    const ids = await tagPathCandidates(['无语', '猫'], [], db)

    expect(ids).toContain(both.id)
    expect(ids).toContain(onlyOne.id)
  })

  it('⚠️ 按命中个数排序，命中多的在前 —— RRF 只吃排名', async () => {
    const alice = await createUser(db)
    // 先建「命中一个」的，让它在 created_at 上更旧；排序真按命中个数走的话它仍然排后面。
    // 反过来建的话，时间倒序也能凑出同样的结果，这条用例就白写了。
    const one = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'] })
    const three = await makeMeme(db, {
      uploaderId: alice.id,
      emotions: ['无语'],
      tones: ['敷衍'],
      tags: ['猫'],
    })

    const ids = await tagPathCandidates(['无语', '敷衍', '猫'], [], db)

    expect(ids.indexOf(three.id)).toBeLessThan(ids.indexOf(one.id))
  })

  it('软删的记录不出现', async () => {
    const alice = await createUser(db)
    const deleted = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'] })
    await softDeleteMeme(deleted.id, alice, db)

    expect(await tagPathCandidates(['无语'], [], db)).not.toContain(deleted.id)
  })

  it('没有命中词表时返回空，不查库', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'] })

    expect(await tagPathCandidates([], [], db)).toEqual([])
  })

  it('exclude 优先于 include：既命中又被排除的不出现', async () => {
    const alice = await createUser(db)
    const excluded = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'], tags: ['真人'] })
    const kept = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'], tags: ['动漫'] })

    const ids = await tagPathCandidates(['无语'], ['真人'], db)

    expect(ids).toContain(kept.id)
    expect(ids).not.toContain(excluded.id)
  })
})

describe('向量路', () => {
  it('按 cosine 距离升序返回，软删的不出现，没 embedding 的不出现', async () => {
    const alice = await createUser(db)
    const near = await makeMeme(db, {
      uploaderId: alice.id,
      embedding: unitVector(1),
      embedModel: MODEL,
    })
    const far = await makeMeme(db, {
      uploaderId: alice.id,
      embedding: unitVector(2),
      embedModel: MODEL,
    })
    const deletedNear = await makeMeme(db, {
      uploaderId: alice.id,
      embedding: unitVector(1),
      embedModel: MODEL,
    })
    const noEmbedding = await makeMeme(db, { uploaderId: alice.id, ocrText: '没有向量' })

    await softDeleteMeme(deletedNear.id, alice, db)

    const ids = await vectorPathCandidates(unitVector(1), MODEL, [], db)

    expect(ids).toContain(near.id)
    expect(ids).toContain(far.id)
    expect(ids).not.toContain(deletedNear.id)
    expect(ids).not.toContain(noEmbedding.id)
    expect(ids.indexOf(near.id)).toBeLessThan(ids.indexOf(far.id))
  })

  it('⚠️ 别的模型算出来的向量不参与召回（SPEC §9.20）', async () => {
    const alice = await createUser(db)
    const current = await makeMeme(db, {
      uploaderId: alice.id,
      embedding: unitVector(2),
      embedModel: MODEL,
    })
    const stale = await makeMeme(db, {
      uploaderId: alice.id,
      // 轴选得比 current 更近：不过滤的话它会排在第一个，过滤了就一条都不出
      embedding: unitVector(1),
      embedModel: 'some-older-model',
    })

    const ids = await vectorPathCandidates(unitVector(1), MODEL, [], db)

    expect(ids).toContain(current.id)
    expect(ids).not.toContain(stale.id)
  })

  it('embedModel 为 null 时整路不跑 —— embedding 没配置', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1), embedModel: MODEL })

    expect(await vectorPathCandidates(unitVector(1), null, [], db)).toEqual([])
  })

  it('空向量返回空，不发查询', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1), embedModel: MODEL })

    expect(await vectorPathCandidates([], MODEL, [], db)).toEqual([])
  })

  it('exclude 的标签在向量路上同样生效', async () => {
    const alice = await createUser(db)
    const excluded = await makeMeme(db, {
      uploaderId: alice.id,
      embedding: unitVector(1),
      embedModel: MODEL,
      tags: ['真人'],
    })
    const kept = await makeMeme(db, {
      uploaderId: alice.id,
      embedding: unitVector(2),
      embedModel: MODEL,
      tags: ['动漫'],
    })

    const ids = await vectorPathCandidates(unitVector(1), MODEL, ['真人'], db)

    expect(ids).toContain(kept.id)
    expect(ids).not.toContain(excluded.id)
  })
})

describe('融合取数', () => {
  it('带出 uploaderName 与当前用户的 favorited，软删的取不到', async () => {
    const alice = await createUser(db, { name: 'alice' })
    const bob = await createUser(db, { name: 'bob' })

    const mine = await makeMeme(db, { uploaderId: alice.id, ocrText: '猫' })
    const deleted = await makeMeme(db, { uploaderId: alice.id, ocrText: '猫' })
    await favoriteMeme(db, bob.id, mine.id)
    await softDeleteMeme(deleted.id, alice, db)

    const rows = await findMemesForSearch([mine.id, deleted.id], bob.id, db)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.uploaderName).toBe('alice')
    expect(rows[0]?.favorited).toBe(true)
  })

  it('未登录时 favorited 恒为 false', async () => {
    const alice = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: alice.id, ocrText: '猫' })

    const rows = await findMemesForSearch([meme.id], null, db)

    expect(rows[0]?.favorited).toBe(false)
  })

  it('ids 为空时不查库', async () => {
    expect(await findMemesForSearch([], null, db)).toEqual([])
  })
})
