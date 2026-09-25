import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * `PATCH /memes/{id}` 与 `DELETE /memes/{id}` 的端到端集成测试
 * （SPEC §6.4.1 / §6.4.2，任务 2026-09-19-browse-meme-actions）。
 *
 * 这两条端点写在契约里很久了，本文件测的是**契约本身**，不是实现细节。四条最要紧的：
 *
 * 1. **编辑对所有人开放** —— 非上传者改别人的图必须成功。这是 SPEC §9.1 有意的不对称，
 *    而它最容易被「顺手补一个归属检查」改坏（agents/rules/testing.md §4 点名要求）。
 * 2. **词表外的标签是 `VALIDATION_FAILED`，不是 `AI_INVALID_OUTPUT`** —— 后者会走重试
 *    与降级，用错的表现是编辑失败时前端去等一个永远不会来的降级（SPEC §4.5）。
 * 3. **`search_text` 与内容字段同一条 UPDATE 重算** —— 拆成两条的话中间崩掉会留下
 *    文本与标签对不上的记录，不报错（SPEC §5.2.3）。
 * 4. **`embedding` 一个字都不动** —— 这是 §9.19 写下的取舍，不是漏做。
 *
 * 软删过滤（`deleted_at is null`）也在本文件里对两条端点各测一遍：它是本条任务里
 * 唯一一处「错了不会报错」的边界（SPEC §3.4）。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 必须在 import 任何 src 模块之前：路由读的是默认连接，不改掉就会打到开发库
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme, unitVector } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { ocrPathCandidates, tagPathCandidates, vectorPathCandidates } = await import(
  '../src/data/search.js'
)
const { memes } = await import('../src/data/schema.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

/** 向量路按 `embed_model` 过滤（SPEC §9.20），种子和查询得报同一个模型名。 */
const EMBED_MODEL = 'test-embed-model'

const testApp = new Hono().use('*', requestId).route('/api/v1/memes', memesRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

type Actor = { id: string; cookie: string }

async function signIn(role: 'admin' | 'member' = 'member'): Promise<Actor> {
  const user = await createUser(db, { role })
  const session = await createSession(user.id, db)
  return { id: user.id, cookie: `sid=${session.id}` }
}

function headers(actor: Actor | null): Record<string, string> {
  return actor === null ? {} : { cookie: actor.cookie }
}

// 三个都 `async`：`testApp.request` 的返回类型是 `Response | Promise<Response>`，
// 直接 `return` 收不进 `Promise<Response>`（hono 的类型如此，不是这里写错了）。
async function patch(id: string, body: unknown, actor: Actor | null): Promise<Response> {
  return await testApp.request(`/api/v1/memes/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers(actor) },
    body: JSON.stringify(body),
  })
}

async function remove(id: string, actor: Actor | null): Promise<Response> {
  return await testApp.request(`/api/v1/memes/${id}`, {
    method: 'DELETE',
    headers: headers(actor),
  })
}

async function get(id: string, actor: Actor | null): Promise<Response> {
  return await testApp.request(`/api/v1/memes/${id}`, { headers: headers(actor) })
}

/** 直接读库。**断言的是落库的值**，不是响应体——响应体由序列化层决定（有它自己的测试）。 */
async function readRow(id: string) {
  const rows = await db.select().from(memes).where(eq(memes.id, id))
  return rows[0]
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } }
  return body.error.code
}

/**
 * 七个数组维度都填上的样本，用来测「不传 / null / []」三种传法的差别。
 *
 * **每一维都给一个不同的值**：只填其中三维的话，「PATCH 漏改某一维」这种错误
 * 会被另外几维的值盖过去——那一维本来就是空的，改没改不出来（SPEC §4.3.1）。
 * `searchText` 按 `buildSearchText` 的顺序手写，和迁移、打标写回三处保持一致。
 */
async function richMeme(uploaderId: string) {
  return makeMeme(db, {
    uploaderId,
    ocrText: '图上的字',
    description: '原来的描述',
    expressions: ['微笑'],
    emotions: ['开心'],
    tones: ['敷衍'],
    purposes: ['打招呼'],
    scenes: ['加班'],
    tags: ['猫'],
    ratings: ['成人向'],
    searchText: '图上的字 原来的描述 微笑 开心 敷衍 打招呼 加班 猫 成人向',
  })
}

describe('PATCH /memes/:id 的权限（SPEC §9.1 / §3.3）', () => {
  it('非上传者编辑别人的图**成功**——这是有意的不对称，不是漏了归属检查', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const meme = await richMeme(alice.id)

    const res = await patch(meme.id, { description: 'bob 改的描述' }, bob)
    expect(res.status).toBe(200)

    const row = await readRow(meme.id)
    expect(row?.description).toBe('bob 改的描述')
    // 记的是**改的人**，不是上传者。共享库里这比「谁拥有」有用得多（SPEC §3.3）
    expect(row?.editedBy).toBe(bob.id)
    expect(row?.editedAt).toBeInstanceOf(Date)
  })

  it('非上传者改七个数组也成功', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const meme = await richMeme(alice.id)

    const res = await patch(
      meme.id,
      {
        expressions: ['翻白眼'],
        emotions: ['无语'],
        tones: ['阴阳怪气'],
        purposes: ['吐槽'],
        scenes: [],
        tags: ['狗'],
        ratings: [],
      },
      bob,
    )
    expect(res.status).toBe(200)

    const row = await readRow(meme.id)
    expect(row?.expressions).toEqual(['翻白眼'])
    expect(row?.emotions).toEqual(['无语'])
    expect(row?.tones).toEqual(['阴阳怪气'])
    expect(row?.purposes).toEqual(['吐槽'])
    expect(row?.scenes).toEqual([])
    expect(row?.tags).toEqual(['狗'])
    // 清空也走得通：`[]` 和「不传」是两件事，后者保留库里的值
    expect(row?.ratings).toEqual([])
  })

  it('未登录是 UNAUTHENTICATED，不是 FORBIDDEN', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    const res = await patch(meme.id, { description: '匿名改的' }, null)
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('UNAUTHENTICATED')
    expect((await readRow(meme.id))?.description).toBe('原来的描述')
  })
})

describe('PATCH 的请求体（SPEC §6.4.1）', () => {
  it('不传的字段不动', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    expect((await patch(meme.id, { description: '新描述' }, alice)).status).toBe(200)

    const row = await readRow(meme.id)
    expect(row?.description).toBe('新描述')
    expect(row?.expressions).toEqual(['微笑'])
    expect(row?.emotions).toEqual(['开心'])
    expect(row?.tones).toEqual(['敷衍'])
    expect(row?.purposes).toEqual(['打招呼'])
    expect(row?.scenes).toEqual(['加班'])
    expect(row?.tags).toEqual(['猫'])
  })

  it('description: null 清空描述，不是「不改」', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    expect((await patch(meme.id, { description: null }, alice)).status).toBe(200)

    const row = await readRow(meme.id)
    expect(row?.description).toBeNull()
    // 其余维度不受影响，「清空描述」不是「清空一切」
    expect(row?.tags).toEqual(['猫'])
  })

  it('tags: [] 清空这个维度，且落库是空数组不是 null', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    expect((await patch(meme.id, { tags: [] }, alice)).status).toBe(200)

    const row = await readRow(meme.id)
    expect(row?.tags).toEqual([])
    expect(row?.emotions).toEqual(['开心'])
  })

  it('空对象 {} 是合法请求：返回当前状态，但不留「有人编辑过」的痕迹', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    const res = await patch(meme.id, {}, alice)
    expect(res.status).toBe(200)

    const row = await readRow(meme.id)
    expect(row?.editedBy).toBeNull()
    expect(row?.editedAt).toBeNull()
  })

  it('词表外的标签是 VALIDATION_FAILED（400），**不是 AI_INVALID_OUTPUT**', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    const res = await patch(meme.id, { tags: ['这个词不存在'] }, alice)
    expect(res.status).toBe(400)
    // 错误码是契约的一部分（testing.md §5）：混用 AI_INVALID_OUTPUT 的话，
    // 前端会去等一次永远不会来的 AI 降级，而这是个普通请求。
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')

    expect((await readRow(meme.id))?.tags).toEqual(['猫'])
  })

  it('七个数组各拒一次词表外的值', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    // 逐维各发一次：校验漏掉某一维的表现是那一维能存进任意字符串，而请求返回 200
    for (const body of [
      { expressions: ['不存在'] },
      { emotions: ['不存在'] },
      { tones: ['不存在'] },
      { purposes: ['不存在'] },
      { scenes: ['不存在'] },
      { tags: ['不存在'] },
      { ratings: ['不存在'] },
    ]) {
      const res = await patch(meme.id, body, alice)
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe('VALIDATION_FAILED')
    }
  })

  it('⚠️ 跨维度的词条也被拒 —— 校验按维度，不是按全表', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    // 「微笑」是 expressions 里的正式词条，填进 emotions 就是越界。
    // 这正是拆维度要挡住的那个错误（SPEC §4.3.1）：脸上在笑不等于心里开心。
    // 按全表校验的话它会照收，而那张图会被标成一个视觉事实推不出来的情绪。
    expect(await errorCode(await patch(meme.id, { emotions: ['微笑'] }, alice))).toBe(
      'VALIDATION_FAILED',
    )
    expect(await errorCode(await patch(meme.id, { tones: ['开心'] }, alice))).toBe(
      'VALIDATION_FAILED',
    )
  })

  it('alias 归一化后再校验：存进去的是规范词条（猫咪 → 猫）', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    expect((await patch(meme.id, { tags: ['猫咪'] }, alice)).status).toBe(200)

    // 人工编辑和打标写回走同一套 alias（api/src/vocab.ts 的 vocabAdapter）
    expect((await readRow(meme.id))?.tags).toEqual(['猫'])
  })

  it('ocrText 出现在请求体里就是 400 —— 它是只读的', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    const res = await patch(meme.id, { ocrText: '我改的' }, alice)
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')

    // 静默忽略的话前端会以为改成功了，而那个「成功」是假的
    expect((await readRow(meme.id))?.ocrText).toBe('图上的字')
  })

  it('其余未知字段同样被拒', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    expect(await errorCode(await patch(meme.id, { isAnimated: true }, alice))).toBe(
      'VALIDATION_FAILED',
    )
    expect(await errorCode(await patch(meme.id, { uploaderId: alice.id }, alice))).toBe(
      'VALIDATION_FAILED',
    )
  })

  it('类型不对是 400：description 非字符串、tags 不是数组、数组里混了非字符串', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    expect(await errorCode(await patch(meme.id, { description: 42 }, alice))).toBe(
      'VALIDATION_FAILED',
    )
    expect(await errorCode(await patch(meme.id, { tags: '猫' }, alice))).toBe('VALIDATION_FAILED')
    expect(await errorCode(await patch(meme.id, { tags: ['猫', 1] }, alice))).toBe(
      'VALIDATION_FAILED',
    )
    expect(await errorCode(await patch(meme.id, [], alice))).toBe('VALIDATION_FAILED')
  })
})

describe('PATCH 的写入（SPEC §5.2.3 / §9.19）', () => {
  it('search_text 与内容字段在**同一条**更新里重算', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    const res = await patch(
      meme.id,
      { description: '新描述', emotions: ['无语'], scenes: [], tags: ['狗'] },
      alice,
    )
    expect(res.status).toBe(200)

    const row = await readRow(meme.id)
    // 精确值，不是「包含」：漏掉某个来源字段、或者用旧值拼，都会在这里露出来。
    // ocr_text 不可编辑，所以它照原样留在文本里；没传的四维（expressions / tones /
    // purposes / ratings）拿库里的旧值参与拼接，顺序仍是 buildSearchText 那一个。
    expect(row?.searchText).toBe('图上的字 新描述 微笑 无语 敷衍 打招呼 狗 成人向')
    // 被移除的标签不能留在 search_text 里——留着就是「文本与标签对不上」，
    // 那张图会被一个它已经没有的标签搜出来
    expect(row?.searchText).not.toContain('开心')
    expect(row?.searchText).not.toContain('加班')
  })

  it('清空后的 search_text 里不留旧词', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    expect(
      (
        await patch(
          meme.id,
          {
            description: null,
            expressions: [],
            emotions: [],
            tones: [],
            purposes: [],
            scenes: [],
            tags: [],
            ratings: [],
          },
          alice,
        )
      ).status,
    ).toBe(200)

    // 只剩 ocrText —— 它是唯一不可编辑的来源字段
    expect((await readRow(meme.id))?.searchText).toBe('图上的字')
  })

  it('**不重算 embedding、不动 embed_model**（SPEC §9.19 的取舍，不是漏做）', async () => {
    const alice = await signIn()
    const vector = unitVector(3)
    const meme = await makeMeme(db, {
      uploaderId: alice.id,
      description: '旧描述',
      searchText: '旧描述',
      embedding: vector,
      embedModel: 'test-embed-model',
    })

    expect((await patch(meme.id, { description: '新描述' }, alice)).status).toBe(200)

    const row = await readRow(meme.id)
    expect(row?.searchText).toBe('新描述')
    // 向量保持陈旧：编辑对全员开放而 embedding 走部署方的钱，
    // 「编辑一次重算一次」是一条公开的烧钱路径（§9.19）
    expect(row?.embedding).toEqual(vector)
    expect(row?.embedModel).toBe('test-embed-model')
  })

  it('两个人同时改同一张图：search_text 仍与内容字段自洽（读-改-写加了行锁）', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const meme = await richMeme(alice.id)

    // 一个只改标签、一个只改描述。**旧的实现（不锁）会交错成**：
    // 两人都先读到旧行 → 各写各的 → 后写的那个拿**自己读到的旧值**拼 search_text，
    // 于是库里留下「标签是新的、文本是旧的」这种半新半旧的记录，且不报错（SPEC §5.2.3）。
    const [a, b] = await Promise.all([
      patch(meme.id, { tags: ['狗'] }, alice),
      patch(meme.id, { description: 'B 的描述' }, bob),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)

    const row = await readRow(meme.id)
    expect(row?.tags).toEqual(['狗'])
    expect(row?.description).toBe('B 的描述')

    // 断言终值而不是「包含」：加锁之后两种先后顺序的终值**相同**，所以这条是确定性的。
    // 少了锁就会在这里露出来——某个来源字段已经改了，它的词却不在 search_text 里。
    expect(row?.searchText).toBe('图上的字 B 的描述 微笑 开心 敷衍 打招呼 加班 狗 成人向')
  })

  it('响应是更新后的完整 Meme，与 GET /memes/:id 同形', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    const patched = await patch(meme.id, { description: '新描述' }, alice)
    const fetched = await get(meme.id, alice)

    const patchBody = (await patched.json()) as Record<string, unknown>
    expect(patchBody).toEqual(await fetched.json())
    expect(patchBody['description']).toBe('新描述')

    // 内部字段一个都不能漏进响应（SPEC §5.2.6、AGENTS.md §5 的第三条硬边界）
    for (const internal of ['storageKey', 'contentHash', 'phash', 'embedding', 'searchText']) {
      expect(Object.keys(patchBody)).not.toContain(internal)
    }
  })

  it('软删的记录 PATCH 到不了：NOT_FOUND，不是 FORBIDDEN、也不静默成功', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    expect((await remove(meme.id, alice)).status).toBe(204)

    const res = await patch(meme.id, { description: '还能改吗' }, alice)
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('NOT_FOUND')
  })
})

describe('DELETE /memes/:id（SPEC §6.4.2）', () => {
  it('上传者删除成功，204，且三路读都查不到它了', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '一只猫在键盘上睡觉',
      description: '一只猫',
      tags: ['猫'],
      embedding: unitVector(0),
      embedModel: EMBED_MODEL,
    })

    // 删之前三路都召回得到 —— 否则下面那三条断言是白过的
    expect(await ocrPathCandidates('猫在键盘上睡觉', [], db)).toContain(meme.id)
    expect(await tagPathCandidates(['猫'], [], db)).toContain(meme.id)
    expect(await vectorPathCandidates(unitVector(0), EMBED_MODEL, [], db)).toContain(meme.id)

    const res = await remove(meme.id, alice)
    expect(res.status).toBe(204)

    // 三路是分别写的 SQL，最容易只改一路（database.md §1.1）
    expect(await ocrPathCandidates('猫在键盘上睡觉', [], db)).not.toContain(meme.id)
    expect(await tagPathCandidates(['猫'], [], db)).not.toContain(meme.id)
    expect(await vectorPathCandidates(unitVector(0), EMBED_MODEL, [], db)).not.toContain(meme.id)

    // 详情接口同样查不到
    expect((await get(meme.id, alice)).status).toBe(404)

    // 软删不是物理删：30 天后才由定时任务真正删掉（SPEC §5.2.5）
    expect((await readRow(meme.id))?.deletedAt).toBeInstanceOf(Date)
  })

  it('非上传者非 admin 被拒：FORBIDDEN，图还在', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const meme = await richMeme(alice.id)

    const res = await remove(meme.id, bob)
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe('FORBIDDEN')
    expect((await readRow(meme.id))?.deletedAt).toBeNull()
  })

  it('管理员可以删别人的图', async () => {
    const alice = await signIn()
    const admin = await signIn('admin')
    const meme = await richMeme(alice.id)

    expect((await remove(meme.id, admin)).status).toBe(204)
    expect((await readRow(meme.id))?.deletedAt).toBeInstanceOf(Date)
  })

  it('**不幂等**：已软删的记录再删一次是 404，不是 204', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    expect((await remove(meme.id, alice)).status).toBe(204)

    const again = await remove(meme.id, alice)
    // 与收藏那两条刻意不同：删除不做乐观更新，客户端不会在没看到结果时重发。
    // 剩下的重复调用只可能是「这张图已经不在列表里了」，404 比 204 诚实（§6.4.2）
    expect(again.status).toBe(404)
    expect(await errorCode(again)).toBe('NOT_FOUND')
  })

  it('未登录是 UNAUTHENTICATED，图还在', async () => {
    const alice = await signIn()
    const meme = await richMeme(alice.id)

    const res = await remove(meme.id, null)
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('UNAUTHENTICATED')
    expect((await readRow(meme.id))?.deletedAt).toBeNull()
  })

  it('不存在的 id 是 NOT_FOUND', async () => {
    const alice = await signIn()
    const res = await remove('00000000-0000-0000-0000-000000000000', alice)
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('NOT_FOUND')
  })
})
