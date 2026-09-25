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
const {
  ocrPathCandidates,
  tagPathCandidates,
  vectorPathCandidates,
  findMemesForSearch,
  PATH_LIMIT,
} = await import('../src/data/search.js')
const { softDeleteMeme } = await import('../src/data/memes.js')
const { sql, db } = createTestDb()

// ⚠️ `sql` 上面已经是 postgres.js 的客户端，drizzle 的 SQL 构造器要另取一个名字，
//    两者混用不会报类型错，只会在跑的时候炸在 `query.getSQL is not a function`。
const { sql: drizzleSql } = await import('drizzle-orm')

/**
 * 只有**一条**连接的客户端。测「会话变量会不会留下」必须这样：连接池里下一次
 * 查询落到哪条连接是不确定的，那时用例测的就不是代码，而是运气。
 */
async function singleConnectionDb() {
  const postgres = (await import('postgres')).default
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const schema = await import('../src/data/schema.js')
  const { testDatabaseUrl, requireDatabaseUrl } = await import('./helpers/db-url.js')
  const conn = postgres(testDatabaseUrl(requireDatabaseUrl()), { max: 1, onnotice: () => {} })
  return { conn, db: drizzle(conn, { schema }) }
}

/**
 * `%` 在这条连接上此刻取什么阈值 —— 直接问运算符，不读 `current_setting`。
 *
 * ⚠️ **`current_setting('pg_trgm.similarity_threshold')` 在没加载过 pg_trgm 的连接上会报
 *    `unrecognized configuration parameter`**：那个参数是扩展的 `_PG_init` 定义的，而它
 *    只在这个后端第一次用到该扩展时才会跑。`set_config` 可以先建一个**占位符**，占位符
 *    在库加载时按名生效（实测：全新连接上设 0.99，同一事务里 `%` 就是 false），
 *    但 `current_setting` 读不到它。所以断言落在运算符的行为上——那才是真正被影响的东西。
 *
 * 这一对的 similarity 实测 **0.167**（`'今天不想'` vs `'今天真的不想上班'`，且不是子串）：
 * 默认阈值 0.3 下 `%` 为 false，被改到 0.1 之后就变成 true。
 */
async function percentOn(
  conn: Awaited<ReturnType<typeof singleConnectionDb>>['conn'],
): Promise<boolean> {
  const rows = await conn<{ hit: boolean }[]>`
    select ${'今天不想'} % ${'今天真的不想上班'} as hit
  `
  return rows[0]!.hit
}

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

    const ids = await ocrPathCandidates('猫在键盘上睡觉', {}, db)

    expect(ids).toContain(hit.id)
    expect(ids).not.toContain(deleted.id)
    expect(ids).not.toContain(unrelated.id)
  })

  it('⚠️ 不匹配 search_text —— 标签值不该在这一路里再计一次分（SPEC §9.21）', async () => {
    const alice = await createUser(db)
    // search_text 里拼着七个数组的标签值。这一路也匹配它的话，同一个「无语」会被
    // 文本路和标签路各召回一次，RRF 融合时靠标签沾边的图会压过原文精确命中的图。
    // 表现是排序变差，不报错——所以要有一条用例把它钉住。
    const labelOnly = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '',
      description: '',
      emotions: ['无语'],
      searchText: '无语',
    })

    expect(await ocrPathCandidates('无语', {}, db)).not.toContain(labelOnly.id)
  })

  it('original_filename 单独参与匹配（不进 search_text）', async () => {
    const alice = await createUser(db)
    // 从网上存的表情包文件名里常带梗名（SPEC §9.18）
    const hit = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '一只猫张着嘴大喊',
      originalFilename: 'shocked-cat-reaction.png',
    })

    expect(await ocrPathCandidates('shocked-cat-reaction', {}, db)).toContain(hit.id)
  })

  it('软删的记录在文件名匹配上也不出现', async () => {
    const alice = await createUser(db)
    const deleted = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '一只猫',
      originalFilename: 'deleted-by-filename.png',
    })
    await softDeleteMeme(deleted.id, alice, db)

    expect(await ocrPathCandidates('deleted-by-filename', {}, db)).not.toContain(deleted.id)
  })

  it('过短的查询直接不召回', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, ocrText: '猫' })

    expect(await ocrPathCandidates('猫', {}, db)).toEqual([])
  })

  it('LIKE 元字符按字面量处理', async () => {
    const alice = await createUser(db)
    const hit = await makeMeme(db, { uploaderId: alice.id, ocrText: '进度条已经 100% 了' })
    await makeMeme(db, { uploaderId: alice.id, ocrText: '完全没有关系的一句话' })

    // 未转义时 `%` 会变成通配符，把库里所有记录都捞回来
    const ids = await ocrPathCandidates('100%', {}, db)
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
    const ids = await ocrPathCandidates('猫在键盘上睡觉', { exclude: ['真人'] }, db)

    expect(ids).toContain(kept.id)
    expect(ids).not.toContain(realPerson.id)
  })

  it('相似但不连着的原文也召回 —— 这一路是 trgm，不只是子串', async () => {
    const alice = await createUser(db)
    // 用户记错了几个字是常态。「相似」这件事只有 `%`（trgm）能给，`LIKE` 给了——
    // 少了 `%` 那一支，这一路就退化成文件名/子串匹配，而用例全都照样绿。
    const typo = await makeMeme(db, { uploaderId: alice.id, ocrText: '今天真的不想上班' })

    const ids = await ocrPathCandidates('今天真的不想上班啊', {}, db)

    expect(ids).toContain(typo.id)
  })

  it('⚠️ 相似度阈值只在本路的事务里生效，不留给连接池的下一个查询', async () => {
    // 阈值是**会话变量**，而会话是连接池共享的。`setLocalGuc` 用 is_local = true，
    // 离开事务什么都不留下；写成会话级的 `SET` 的话，下一个复用这条连接的查询会按
    // 上一个查询的阈值过滤——**不报错**，只是结果莫名其妙地多几条或少几条。
    //
    // 同理，这里另起一个 `max: 1` 的客户端：两次查询之间**必然**是同一条连接，
    // 「变量有没有留下」才是确定的，而不是碰运气命中池里那条连接。
    const { conn, db: single } = await singleConnectionDb()
    try {
      // 走一遍真路：里面会 `set_config('pg_trgm.similarity_threshold', '0.1', true)`
      const alice = await createUser(db)
      await makeMeme(db, { uploaderId: alice.id, ocrText: '一只猫在键盘上睡觉' })
      await ocrPathCandidates('一只猫在键盘上睡觉', {}, single)

      // 同一条连接、事务外：阈值必须已经回到默认的 0.3。
      // 这一对在 0.1 下为 true、在 0.3 下为 false（见 percentOn 注释），
      // 所以「false」就是「没留下」的证据；写成会话级 `SET` 的话这里会是 true。
      expect(await percentOn(conn)).toBe(false)
    } finally {
      await conn.end()
    }
  })

  it('阈值是我们设的那个 —— 比默认值低，所以相似但不连着的查询也召得回', async () => {
    const alice = await createUser(db)
    // 「今天不想」和「今天真的不想上班」的 similarity 实测 **0.167**，而且**不是子串**
    // （是子串的话 `LIKE` 那一支就会命中，这条用例白写）。
    // 默认阈值 0.3 把它挡在外面，`TRGM_SIMILARITY_THRESHOLD = 0.1` 才收得进来。
    // 这一路存在的前提就是「松一点换召回」，精确排序交给 RRF 的排名。
    //
    // ⚠️ 别换成「今天真」那种更短的前缀：它的 similarity 正好 0.300，
    //    卡在默认阈值上（`%` 判的是 `>=`），默认值也能过——用例会恒绿，钉不住任何东西。
    const hit = await makeMeme(db, { uploaderId: alice.id, ocrText: '今天真的不想上班' })
    await makeMeme(db, { uploaderId: alice.id, ocrText: '完全无关的另一句话' })

    expect(await ocrPathCandidates('今天不想', {}, db)).toContain(hit.id)
  })
})

describe('标签路', () => {
  it('七个数组都会被匹配', async () => {
    const alice = await createUser(db)
    const byExpression = await makeMeme(db, { uploaderId: alice.id, expressions: ['假笑'] })
    const byEmotion = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'] })
    const byTone = await makeMeme(db, { uploaderId: alice.id, tones: ['敷衍'] })
    const byPurpose = await makeMeme(db, { uploaderId: alice.id, purposes: ['拒绝'] })
    const byScene = await makeMeme(db, { uploaderId: alice.id, scenes: ['加班'] })
    const byTag = await makeMeme(db, { uploaderId: alice.id, tags: ['猫'] })
    const byRating = await makeMeme(db, { uploaderId: alice.id, ratings: ['成人向'] })

    // 一维一次：多词之间是 OR，混在一起查看不出哪一维没被匹配
    expect(await tagPathCandidates(['假笑'], {}, db)).toContain(byExpression.id)
    expect(await tagPathCandidates(['无语'], {}, db)).toContain(byEmotion.id)
    expect(await tagPathCandidates(['敷衍'], {}, db)).toContain(byTone.id)
    expect(await tagPathCandidates(['拒绝'], {}, db)).toContain(byPurpose.id)
    expect(await tagPathCandidates(['加班'], {}, db)).toContain(byScene.id)
    expect(await tagPathCandidates(['猫'], {}, db)).toContain(byTag.id)
    // ratings 走的是同一套 VOCAB_FIELDS 遍历，但**它不在前六个的语义轴上**，
    // 加维度时如果哪里按维度手写了数组，这一条会红（SPEC §4.3）
    expect(await tagPathCandidates(['成人向'], {}, db)).toContain(byRating.id)
  })

  it('只匹配标签，不看 search_text —— 命中词表才进来', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, searchText: '一只很无语的猫', tags: ['狗'] })

    // 「无语」在正文里出现过，但标签不是「无语」，这一路就不该召回它（SPEC §6.3.1：
    // 文字匹配是 trgm 路的职责，两路各管各的，否则 RRF 融合出来的 matchedBy 全是噪声）
    expect(await tagPathCandidates(['无语'], {}, db)).toEqual([])
  })

  it('⚠️ 多个词之间是 OR，不是 AND', async () => {
    const alice = await createUser(db)
    const onlyOne = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'], tags: ['狗'] })
    const both = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'], tags: ['猫'] })

    // 2026-09-22 从 AND 改成 OR：六个维度之后，「猫 无语 敷衍 加班」这种查询用 AND
    // 要求一张图同时带齐四个标签，库里多半一张都没有，整条路塌成空集（data/search.ts）
    const ids = await tagPathCandidates(['无语', '猫'], {}, db)

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

    const ids = await tagPathCandidates(['无语', '敷衍', '猫'], {}, db)

    expect(ids.indexOf(three.id)).toBeLessThan(ids.indexOf(one.id))
  })

  it('软删的记录不出现', async () => {
    const alice = await createUser(db)
    const deleted = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'] })
    await softDeleteMeme(deleted.id, alice, db)

    expect(await tagPathCandidates(['无语'], {}, db)).not.toContain(deleted.id)
  })

  it('没有命中词表时返回空，不查库', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'] })

    expect(await tagPathCandidates([], {}, db)).toEqual([])
  })

  it('exclude 优先于 include：既命中又被排除的不出现', async () => {
    const alice = await createUser(db)
    const excluded = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'], tags: ['真人'] })
    const kept = await makeMeme(db, { uploaderId: alice.id, emotions: ['无语'], tags: ['动漫'] })

    const ids = await tagPathCandidates(['无语'], { exclude: ['真人'] }, db)

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

    const ids = await vectorPathCandidates(unitVector(1), MODEL, {}, db)

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

    const ids = await vectorPathCandidates(unitVector(1), MODEL, {}, db)

    expect(ids).toContain(current.id)
    expect(ids).not.toContain(stale.id)
  })

  it('embedModel 为 null 时整路不跑 —— embedding 没配置', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1), embedModel: MODEL })

    expect(await vectorPathCandidates(unitVector(1), null, {}, db)).toEqual([])
  })

  it('空向量返回空，不发查询', async () => {
    const alice = await createUser(db)
    await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(1), embedModel: MODEL })

    expect(await vectorPathCandidates([], MODEL, {}, db)).toEqual([])
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

    const ids = await vectorPathCandidates(unitVector(1), MODEL, { exclude: ['真人'] }, db)

    expect(ids).toContain(kept.id)
    expect(ids).not.toContain(excluded.id)
  })

  it('⚠️ 走 HNSW 时也要取满 PATH_LIMIT 条', async () => {
    // HNSW 一次索引扫描最多给 `hnsw.ef_search` 条，**默认是 40**，而这里要 50。
    // 少了那行 set_config 就是「永远少 10 条候选」：不报错、不告警，只是 RRF 少了
    // 一路候选，排序静静地变差（SPEC §9.20 那段只说了过滤，这件事与过滤无关）。
    const alice = await createUser(db)
    const total = PATH_LIMIT + 10
    for (let i = 0; i < total; i += 1) {
      await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(i), embedModel: MODEL })
    }

    const ids = await db.transaction(async (tx) => {
      // 测试库只有 60 行，规划器不会自己选 HNSW——默认计划是顺序扫描，
      // 那样改不改 ef_search 都是 50 条，这条用例就什么都没守住。关掉它逼着走索引。
      await tx.execute(drizzleSql`set local enable_seqscan = off`)
      return vectorPathCandidates(unitVector(0), MODEL, {}, tx)
    })

    expect(ids).toHaveLength(PATH_LIMIT)
  })

  it('⚠️ 全新连接上 GUC 也生效 —— pgvector 还没加载时就设得上', async () => {
    // 连接池里每条连接的「第一次用到向量列」之前，pgvector 在本后端**尚未加载**，
    // `hnsw.ef_search` 也还没有被注册。这时 `set_config` 建的是一个**占位符**，
    // 等扩展随后被首次用到时才把它提升成真参数——值必须活下来。
    //
    // ⚠️ 这里守的是两种静默失效：
    //    1. 占位符没被提升 → 设置静默无效，又回到 40 条（本用例的断点）。
    //    2. 换成 pgvector 没注册的 `hnsw.*` 名字（比如老版本上的 `iterative_scan`）→
    //       在**已加载** pgvector 的连接上那会直接报 42602，在这里则被静默吞掉。
    //    两种情况都不报错，只是召回少 10 条。用池里的连接测不出来：那条连接早就加载过扩展了。
    const alice = await createUser(db)
    const total = PATH_LIMIT + 10
    for (let i = 0; i < total; i += 1) {
      await makeMeme(db, { uploaderId: alice.id, embedding: unitVector(i), embedModel: MODEL })
    }

    // 种子走池里的 `db`，所以这条 `max: 1` 客户端的**第一条 SQL** 就是被测代码
    const { conn, db: fresh } = await singleConnectionDb()
    try {
      const { ids, efSearch } = await fresh.transaction(async (tx) => {
        await tx.execute(drizzleSql`set local enable_seqscan = off`)
        const out = await vectorPathCandidates(unitVector(0), MODEL, {}, tx)
        // 读回来当证据：`set_config(..., is_local = true)` 在**子事务**里设的值会留到
        // 外层事务结束，所以这里读得到。它才是「占位符有没有被提升成真参数」的直接证据。
        const ef = await tx.execute(
          drizzleSql`select current_setting('hnsw.ef_search', true) as v`,
        )
        const row = (ef as unknown as { v: string | null }[])[0]
        return { ids: out, efSearch: row?.v ?? null }
      })

      // ① 值真的落在这条连接上了（没被当成未注册的名字丢掉）
      expect(efSearch).toBe('100')
      // ② 而且起了作用：40 是**不设** GUC 时的条数（同一套种子实测），所以「比 40 多」
      //    就是「设置生效了」。
      //
      // ⚠️ 这一条**刻意不写 `= PATH_LIMIT`**：它守的是「GUC 在全新连接上生效」，
      //    不是「表里此刻有多少行」——等值断言会把别的用例留下的行数噪声报成代码 bug
      //    （实测整批跑时偶发 44 条、单独跑与连跑 10 次都不复现，与被测代码无关）。
      //    等值那一档在池化连接那条用例里（`⚠️ 走 HNSW 时也要取满 PATH_LIMIT 条`）。
      expect(ids.length).toBeGreaterThan(PATH_LIMIT - 10)
    } finally {
      await conn.end()
    }
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
