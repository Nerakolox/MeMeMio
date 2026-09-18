import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { findNearestByPhash, softDeleteMeme } from '../src/data/memes.js'
import { createTestDb, truncateAll } from './helpers/test-db.js'
import { createUser, makeMeme } from './helpers/factories.js'

/**
 * pHash 全库 Hamming 扫描（database.md §3 / SPEC §6.2.2）。
 *
 * 这条查询要在**真 Postgres** 上跑才有意义：`bit_count` 没法 mock，
 * 参数超出 int4 范围也只有真驱动会报。dHash 的高低两半各有一半概率超过
 * 2147483647，之前的实现把它们当无符号传，于是大约四分之三的图在导入时
 * 直接 `value "3480189747" is out of range for type integer`——而这条路径
 * 在此之前一个用例都没有，所以一路活到了线上。
 */

const { sql, db } = createTestDb()

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

/** 高低两半的最高位都是 1：两边拆出来都超过 int4 上限。 */
const HIGH_BIT_HASH = BigInt.asIntN(64, 0xcf6b7b33_9a5d24e1n)

describe('pHash 近似查重', () => {
  it('最高位为 1 的哈希查得动，不报 out of range', async () => {
    const alice = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: alice.id, phash: HIGH_BIT_HASH })

    const hit = await findNearestByPhash(HIGH_BIT_HASH, 0, db)

    expect(hit?.meme.id).toBe(meme.id)
    expect(hit?.distance).toBe(0)
  })

  it('只差最高位时距离是 1 —— 高半边没被丢掉', async () => {
    const alice = await createUser(db)
    // bit 63 落在 hi 那一半。高半边算错（或整半边被当成 0）的实现在这里会给出 0
    await makeMeme(db, { uploaderId: alice.id, phash: BigInt.asIntN(64, 1n << 63n) })

    const hit = await findNearestByPhash(0n, 8, db)

    expect(hit?.distance).toBe(1)
  })

  it('低半边的差异同样算得到', async () => {
    const alice = await createUser(db)
    // bit 0、bit 31 各一位，都在 lo 那一半
    await makeMeme(db, { uploaderId: alice.id, phash: BigInt.asIntN(64, (1n << 31n) | 1n) })

    const hit = await findNearestByPhash(0n, 8, db)

    expect(hit?.distance).toBe(2)
  })

  it('超过阈值的不返回', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, phash: -1n })

    // -1 与 0 相差 64 位，远超阈值
    expect(await findNearestByPhash(0n, 8, db)).toBeNull()
  })

  it('最近的那张排在前面', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, phash: BigInt.asIntN(64, 0b111n) })
    const nearest = await makeMeme(db, { uploaderId: alice.id, phash: 1n })

    const hit = await findNearestByPhash(0n, 8, db)

    expect(hit?.meme.id).toBe(nearest.id)
    expect(hit?.distance).toBe(1)
  })

  it('软删的图不参与近似判重', async () => {
    const alice = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: alice.id, phash: HIGH_BIT_HASH })
    await softDeleteMeme(meme.id, alice, db)

    // 已删的图再传一次应当能正常入库，而不是被判成「你重复了这张」（SPEC §3.4）
    expect(await findNearestByPhash(HIGH_BIT_HASH, 8, db)).toBeNull()
  })
})
