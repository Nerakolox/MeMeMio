import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertCanMutate,
  findMemeById,
  findMemeByIdIncludeDeleted,
  softDeleteMeme,
} from '../src/data/memes.js'
import { isAppError } from '../src/lib/app-error.js'
import { createTestDb, truncateAll } from './helpers/test-db.js'
import { createUser, makeMeme } from './helpers/factories.js'

/**
 * 骨架任务的**验证点 4**：软删的记录在默认查询里查不到。
 *
 * 漏掉 `deleted_at is null` 的表现是「删掉的图又出现了」——不报错、不崩溃，
 * 只有测试能抓到（SPEC §3.4）。所以这条必须留在仓库里，不是跑一次就算。
 */

const { sql, db } = createTestDb()

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

describe('软删', () => {
  it('软删后默认查询查不到，includeDeleted 仍然查得到', async () => {
    const alice = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: alice.id })

    expect(await findMemeById(meme.id, db)).not.toBeNull()

    await softDeleteMeme(meme.id, alice, db)

    expect(await findMemeById(meme.id, db)).toBeNull()

    const stillThere = await findMemeByIdIncludeDeleted(meme.id, db)
    expect(stillThere).not.toBeNull()
    // 软删不是物理删：30 天后才由定时任务真正删掉（SPEC §5.2.5）
    expect(stillThere?.deletedAt).toBeInstanceOf(Date)
  })

  it('软删已软删的记录报 NOT_FOUND，不是静默成功', async () => {
    const alice = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: alice.id })
    await softDeleteMeme(meme.id, alice, db)

    try {
      await softDeleteMeme(meme.id, alice, db)
      expect.unreachable('第二次软删应当抛错')
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      // 断到 code，不断 message 措辞（testing.md §5）
      expect(isAppError(error) && error.code).toBe('NOT_FOUND')
    }
  })
})

describe('写权限', () => {
  it('非上传者可以 edit —— 这条不对称是有意的', async () => {
    const alice = await createUser(db)
    const bob = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: alice.id })

    // 共享库里标签是公共品，谁发现标错了顺手改掉对所有人都是净收益（SPEC §9.1）。
    // 这个用例存在的意义就是挡住「顺手补一个归属检查」的改动。
    expect(() => assertCanMutate(meme, bob, 'edit')).not.toThrow()
  })

  it('非上传者不能 delete / retag，管理员可以', async () => {
    const alice = await createUser(db)
    const bob = await createUser(db)
    const admin = await createUser(db, { role: 'admin' })
    const meme = await makeMeme(db, { uploaderId: alice.id })

    for (const action of ['delete', 'retag'] as const) {
      try {
        assertCanMutate(meme, bob, action)
        expect.unreachable(`${action} 应当被拒`)
      } catch (error) {
        expect(isAppError(error) && error.code).toBe('FORBIDDEN')
      }
      expect(() => assertCanMutate(meme, alice, action)).not.toThrow()
      expect(() => assertCanMutate(meme, admin, action)).not.toThrow()
    }
  })

  it('非上传者删除被 softDeleteMeme 挡住，记录没变', async () => {
    const alice = await createUser(db)
    const bob = await createUser(db)
    const meme = await makeMeme(db, { uploaderId: alice.id })

    await expect(softDeleteMeme(meme.id, bob, db)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'FORBIDDEN',
    )
    expect(await findMemeById(meme.id, db)).not.toBeNull()
  })
})

describe('去重约束', () => {
  it('phash 相同但 content_hash 不同的两张图都能建记录', async () => {
    const alice = await createUser(db)
    // phash 唯一约束会硬性挡掉 Hamming 距离为 0 的情况，而判断权在人不在 DB
    //（SPEC §9.7）。这个用例测的是 phash **没有**唯一约束。
    const first = await makeMeme(db, { uploaderId: alice.id, phash: 42n })
    const second = await makeMeme(db, { uploaderId: alice.id, phash: 42n })

    expect(first.id).not.toBe(second.id)
    expect(second.phash).toBe(42n)
  })

  it('content_hash 相同直接被数据库拒绝', async () => {
    const alice = await createUser(db)
    const first = await makeMeme(db, { uploaderId: alice.id })

    await expect(
      makeMeme(db, { uploaderId: alice.id, contentHash: first.contentHash }),
    ).rejects.toThrow()
  })
})
