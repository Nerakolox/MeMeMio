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

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

describe('OCR / trgm 路', () => {
  it('命中 search_text，且软删的记录不出现', async () => {
    const alice = await createUser(db)
    const hit = await makeMeme(db, {
      uploaderId: alice.id,
      searchText: '一只猫在键盘上睡觉，表情很无奈',
    })
    const deleted = await makeMeme(db, {
      uploaderId: alice.id,
      searchText: '一只猫在键盘上睡觉，但是已经删了',
    })
    const unrelated = await makeMeme(db, { uploaderId: alice.id, searchText: '一只狗在草地上跑' })

    await softDeleteMeme(deleted.id, alice, db)

    const ids = await ocrPathCandidates('猫在键盘上睡觉', db)

    expect(ids).toContain(hit.id)
    expect(ids).not.toContain(deleted.id)
    expect(ids).not.toContain(unrelated.id)
  })

  it('original_filename 单独参与匹配（不进 search_text）', async () => {
    const alice = await createUser(db)
    // 从网上存的表情包文件名里常带梗名（SPEC §9.18）
    const hit = await makeMeme(db, {
      uploaderId: alice.id,
      searchText: '一只猫张着嘴大喊',
      originalFilename: 'shocked-cat-reaction.png',
    })

    expect(await ocrPathCandidates('shocked-cat-reaction', db)).toContain(hit.id)
  })

  it('软删的记录在文件名匹配上也不出现', async () => {
    const alice = await createUser(db)
    const deleted = await makeMeme(db, {
      uploaderId: alice.id,
      searchText: '一只猫',
      originalFilename: 'deleted-by-filename.png',
    })
    await softDeleteMeme(deleted.id, alice, db)

    expect(await ocrPathCandidates('deleted-by-filename', db)).not.toContain(deleted.id)
  })

  it('过短的查询直接不召回', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, searchText: '猫' })

    expect(await ocrPathCandidates('猫', db)).toEqual([])
  })

  it('LIKE 元字符按字面量处理', async () => {
    const alice = await createUser(db)
    const hit = await makeMeme(db, { uploaderId: alice.id, searchText: '进度条已经 100% 了' })
    await makeMeme(db, { uploaderId: alice.id, searchText: '完全没有关系的一句话' })

    // 未转义时 `%` 会变成通配符，把库里所有记录都捞回来
    const ids = await ocrPathCandidates('100%', db)
    expect(ids).toEqual([hit.id])
  })
})

describe('标签路', () => {
  it('情绪 / 场景 / 标签三个数组都会被匹配', async () => {
    const alice = await createUser(db)
    const byEmotion = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'] })
    const byScene = await makeMeme(db, { uploaderId: alice.id, scenes: ['拒绝'] })
    const byTag = await makeMeme(db, { uploaderId: alice.id, tags: ['猫'] })

    // 单个词各查一次：多词是 AND（见下一条），拿三个词一起来查永远查不到东西
    expect(await tagPathCandidates(['无语'], db)).toContain(byEmotion.id)
    expect(await tagPathCandidates(['拒绝'], db)).toContain(byScene.id)
    expect(await tagPathCandidates(['猫'], db)).toContain(byTag.id)
  })

  it('只匹配标签，不看 search_text —— 命中词表才进来', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, searchText: '一只很无语的猫', tags: ['狗'] })

    // 「无语」在正文里出现过，但标签不是「无语」，这一路就不该召回它（SPEC §6.3.1：
    // 文字匹配是 trgm 路的职责，两路各管各的，否则 RRF 融合出来的 matchedBy 全是噪声）
    expect(await tagPathCandidates(['无语'], db)).toEqual([])
  })

  it('多个词之间是 AND —— 要同时有这两个标签', async () => {
    const alice = await createUser(db)
    const onlyOne = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'], tags: ['狗'] })
    const both = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'], tags: ['猫'] })

    const ids = await tagPathCandidates(['无语', '猫'], db)

    expect(ids).toContain(both.id)
    expect(ids).not.toContain(onlyOne.id)
  })

  it('软删的记录不出现', async () => {
    const alice = await createUser(db)
    const deleted = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'] })
    await softDeleteMeme(deleted.id, alice, db)

    expect(await tagPathCandidates(['无语'], db)).not.toContain(deleted.id)
  })

  it('没有命中词表时返回空，不查库', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'] })

    expect(await tagPathCandidates([], db)).toEqual([])
  })
})

describe('向量路', () => {
  it('按 cosine 距离升序返回，软删的不出现，没 embedding 的不出现', async () => {
    const alice = await createUser(db)
    const near = await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1) })
    const far = await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(2) })
    const deletedNear = await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1) })
    const noEmbedding = await makeMeme(db, { uploaderId: alice.id, searchText: '没有向量' })

    await softDeleteMeme(deletedNear.id, alice, db)

    const ids = await vectorPathCandidates(unitVector(1), db)

    expect(ids).toContain(near.id)
    expect(ids).toContain(far.id)
    expect(ids).not.toContain(deletedNear.id)
    expect(ids).not.toContain(noEmbedding.id)
    expect(ids.indexOf(near.id)).toBeLessThan(ids.indexOf(far.id))
  })

  it('空向量返回空，不发查询', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1) })

    expect(await vectorPathCandidates([], db)).toEqual([])
  })
})

describe('融合取数', () => {
  it('带出 uploaderName 与当前用户的 favorited，软删的取不到', async () => {
    const alice = await createUser(db, { name: 'alice' })
    const bob = await createUser(db, { name: 'bob' })

    const mine = await makeMeme(db, { uploaderId: alice.id, searchText: '猫' })
    const deleted = await makeMeme(db, { uploaderId: alice.id, searchText: '猫' })
    await favoriteMeme(db, bob.id, mine.id)
    await softDeleteMeme(deleted.id, alice, db)

    const rows = await findMemesForSearch([mine.id, deleted.id], bob.id, db)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.uploaderName).toBe('alice')
    expect(rows[0]?.favorited).toBe(true)
  })

  it('未登录时 favorited 恒为 false', async () => {
    const alice = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: alice.id, searchText: '猫' })

    const rows = await findMemesForSearch([meme.id], null, db)

    expect(rows[0]?.favorited).toBe(false)
  })

  it('ids 为空时不查库', async () => {
    expect(await findMemesForSearch([], null, db)).toEqual([])
  })
})
