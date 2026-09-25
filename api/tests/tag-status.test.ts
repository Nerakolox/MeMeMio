import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 打标状态汇总的端到端集成测试（SPEC §6.6.1 / 任务 2026-09-19-tagging-status）。
 *
 * 这个接口是「打标流水线最后一米」的反馈面：在那之前用户看不到卡着的图有多少张。
 * 所以本文件测的重点不是数字本身，是**这几个数字能不能被信任**——
 *
 *   1. 口径与 `GET /memes?uploader=me&tagStatus=X` 逐字一致（同一批图，两处对不上
 *      就是有一处漏了软删过滤，而它不报错、只是数字偏大）
 *   2. `failures` 只出类别、不出 `last_error` 原文（原文来自供应商响应）
 *   3. 权限：`mine` 是缺省，`all` 只有 admin 能要，**非法取值不许掉进 `all` 分支**
 *   4. `visionConfigured` 看的是调用者自己（含部署方兜底），不是「全站有没有人配了」
 *
 * 与 favorites.test.ts 同形：真实路由 + 真 Postgres。这个接口不碰图片，所以不需要 R2 替身。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 必须在 import 任何 src 模块之前：路由读的是默认连接，不改掉就会打到开发库
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

/**
 * 部署方一项都没配。`visionConfigured` 的两条分支都靠库里的用户配置走——
 * 理由同 config-user-vision.test.ts：`env.ts` 首次 import 时把值冻住，
 * 同一个文件里没法既有配置又没配置。
 */
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { softDeleteMeme } = await import('../src/data/memes.js')
const { recordVisionTest, saveUserVisionConfig } = await import('../src/data/ai-configs.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { tagJobs } = await import('../src/data/schema.js')

const { sql, db } = createTestDb()

const testApp = new Hono().use('*', requestId).route('/api/v1/memes', memesRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

// ── 脚手架 ─────────────────────────────────────────────────────────

type Actor = { id: string; role: 'admin' | 'member'; cookie: string }

async function signIn(role: 'admin' | 'member' = 'member'): Promise<Actor> {
  const user = await createUser(db, { role })
  const session = await createSession(user.id, db)
  return { id: user.id, role: user.role, cookie: `sid=${session.id}` }
}

/** 响应形状照抄 SPEC §6.6.1 的那段示例，测试里不另立一套字段名。 */
type Summary = {
  scope: string
  visionConfigured: boolean
  counts: { ok: number; pending: number; refused: number; needsManual: number }
  running: number
  failures: { reason: string; count: number }[]
}

async function callTagStatus(actor: Actor | null, query = ''): Promise<Response> {
  return testApp.request(`/api/v1/memes/tag-status${query}`, {
    headers: actor === null ? {} : { cookie: actor.cookie },
  })
}

async function tagStatus(actor: Actor, query = ''): Promise<Summary> {
  const res = await callTagStatus(actor, query)
  expect(res.status).toBe(200)
  return (await res.json()) as Summary
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } }
  return body.error.code
}

/**
 * 一条打标任务。`last_error` 的格式跟着 worker 的 `applyFailure` 走
 * （`` `${failure}: ${detail}` ``），测试里别自己发明第三种格式。
 */
async function addTagJob(
  uploaderId: string,
  memeId: string,
  fields: { status?: string; lastError?: string | null } = {},
): Promise<void> {
  await db.insert(tagJobs).values({
    memeId,
    userId: uploaderId,
    status: fields.status ?? 'failed',
    lastError: fields.lastError ?? null,
  })
}

/** 走真实保存路径（要有成功的测试记录才存得进去，SPEC §6.5.2），不手写那两行。 */
const VISION_INPUT = {
  baseUrl: 'https://own-relay.example.test',
  model: 'user-vision-model',
  apiKey: 'sk-user-own-key-4d2f9a1b',
}

async function configureVision(actor: Actor): Promise<void> {
  await recordVisionTest(actor.id, VISION_INPUT, { ok: true, jsonModeWorks: null, multiImage: null })
  await saveUserVisionConfig(actor.id, VISION_INPUT)
}

// ── 汇总 ───────────────────────────────────────────────────────────

describe('GET /memes/tag-status', () => {
  it('空库：四个计数全给且都是 0，没有失败分布', async () => {
    const alice = await signIn()

    const summary = await tagStatus(alice)
    expect(summary.scope).toBe('mine')
    expect(summary.counts).toEqual({ ok: 0, pending: 0, refused: 0, needsManual: 0 })
    expect(summary.running).toBe(0)
    expect(summary.failures).toEqual([])
  })

  it('counts 按 tag_status 分布，四个取值齐全', async () => {
    const alice = await signIn()
    await makeMeme(db, { uploaderId: alice.id, tagStatus: 'ok' })
    await makeMeme(db, { uploaderId: alice.id, tagStatus: 'ok' })
    await makeMeme(db, { uploaderId: alice.id, tagStatus: 'needs_manual' })

    expect((await tagStatus(alice)).counts).toEqual({
      ok: 2,
      pending: 0, // 一张都没建，但契约要求这个键存在
      refused: 0,
      needsManual: 1,
    })
  })

  it('counts 与 GET /memes?uploader=me&tagStatus=X 的条数对得上', async () => {
    const alice = await signIn()
    const expected = [
      ['ok', 2],
      ['pending', 3],
      ['refused', 1],
      ['needs_manual', 2],
    ] as const
    for (const [status, n] of expected) {
      for (let i = 0; i < n; i += 1) {
        await makeMeme(db, { uploaderId: alice.id, tagStatus: status })
      }
    }
    // 每种状态各删一张：**这条用例挡的是「有一处漏了软删过滤」**。删掉的图只留在
    // 其中一边的表现是数字比列表多，不报错——所以两个数字都要有被删记录在旁边。
    for (const [status] of expected) {
      const doomed = await makeMeme(db, { uploaderId: alice.id, tagStatus: status })
      await softDeleteMeme(doomed.id, { id: alice.id, role: 'member' }, db)
    }

    const summary = await tagStatus(alice)
    expect(summary.counts).toEqual({ ok: 2, pending: 3, refused: 1, needsManual: 2 })

    const pairs = [
      ['ok', summary.counts.ok],
      ['pending', summary.counts.pending],
      ['refused', summary.counts.refused],
      ['needs_manual', summary.counts.needsManual],
    ] as const
    for (const [param, count] of pairs) {
      const res = await testApp.request(`/api/v1/memes?uploader=me&tagStatus=${param}`, {
        headers: { cookie: alice.cookie },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: unknown[] }
      expect(body.items.length).toBe(count)
    }
  })

  it('软删的图不计入 counts，也不计入 failures', async () => {
    const alice = await signIn()
    const kept = await makeMeme(db, { uploaderId: alice.id, tagStatus: 'needs_manual' })
    const gone = await makeMeme(db, { uploaderId: alice.id, tagStatus: 'needs_manual' })
    await addTagJob(alice.id, kept.id, { lastError: 'unreachable: HTTP 层判定：unreachable' })
    await addTagJob(alice.id, gone.id, { lastError: 'refused: image_limit' })
    await softDeleteMeme(gone.id, { id: alice.id, role: 'member' }, db)

    const summary = await tagStatus(alice)
    expect(summary.counts.needsManual).toBe(1)
    // join 的方向就是为这一条存在的：不 join 的话这张已删的图会一直算在失败分布里
    expect(summary.failures).toEqual([{ reason: 'unreachable', count: 1 }])
  })

  it('running 取库里 status = running 的真实计数，重试中的任务不算失败', async () => {
    const alice = await signIn()
    const first = await makeMeme(db, { uploaderId: alice.id })
    const second = await makeMeme(db, { uploaderId: alice.id })
    const retrying = await makeMeme(db, { uploaderId: alice.id })
    const finished = await makeMeme(db, { uploaderId: alice.id })
    await addTagJob(alice.id, first.id, { status: 'running' })
    await addTagJob(alice.id, second.id, { status: 'running' })
    // 退避重试的 `last_error` 里也有类别，但它**不是终局失败**——状态还是 pending
    await addTagJob(alice.id, retrying.id, {
      status: 'pending',
      lastError: 'unreachable: HTTP 层判定：unreachable',
    })
    await addTagJob(alice.id, finished.id, { status: 'done' })

    const summary = await tagStatus(alice)
    expect(summary.running).toBe(2)
    expect(summary.failures).toEqual([])
  })

  it('failures 按原因分组降序；embed_failed 的图 tag_status 仍是 ok', async () => {
    const alice = await signIn()
    const failed = [
      ['unreachable', 3],
      ['refused', 2],
      ['invalid_output', 1],
      ['unsupported', 1],
    ] as const
    for (const [reason, n] of failed) {
      for (let i = 0; i < n; i += 1) {
        const meme = await makeMeme(db, { uploaderId: alice.id, tagStatus: 'needs_manual' })
        await addTagJob(alice.id, meme.id, { lastError: `${reason}: 诊断串：${reason}` })
      }
    }
    // 打标成功、向量没算出来：**tag_status 留在 ok**，所以它不进 counts.needsManual
    const embedded = await makeMeme(db, { uploaderId: alice.id, tagStatus: 'ok' })
    await addTagJob(alice.id, embedded.id, { lastError: 'embed_failed: embedding unreachable' })

    const summary = await tagStatus(alice)
    expect(summary.counts.needsManual).toBe(7)
    expect(summary.failures).toEqual([
      { reason: 'unreachable', count: 3 },
      { reason: 'refused', count: 2 },
      // 三个 1 条之间的顺序是固定的类别顺序（稳定排序），不是随机
      { reason: 'invalid_output', count: 1 },
      { reason: 'unsupported', count: 1 },
      { reason: 'embed_failed', count: 1 },
    ])
    // sum(failures) = 8 而 needsManual = 7，**差的那一张正是 embed_failed**。
    // 这个不等式是契约的一部分（SPEC §6.6.1），不要为了让它相等去改口径
    expect(summary.failures.reduce((sum, f) => sum + f.count, 0)).not.toBe(
      summary.counts.needsManual,
    )
  })

  it('不返回 last_error 原文，只返回类别', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id, tagStatus: 'needs_manual' })
    // 真串里可能带着供应商回显的内容、甚至 Authorization 的痕迹——它绝不能进响应
    await addTagJob(alice.id, meme.id, {
      lastError:
        'unreachable: HTTP 层判定：unreachable upstream=relay.example Authorization=Bearer sk-live-DEADBEEF',
    })

    const res = await callTagStatus(alice)
    const text = await res.text()
    expect(text).not.toContain('sk-live-DEADBEEF')
    expect(text).not.toContain('HTTP 层判定')
    expect((JSON.parse(text) as Summary).failures).toEqual([{ reason: 'unreachable', count: 1 }])
  })

  it('表里出现契约之外的类别时丢掉，不原样返回', async () => {
    const alice = await signIn()
    const meme = await makeMeme(db, { uploaderId: alice.id, tagStatus: 'needs_manual' })
    // 这条串来自 requeueStaleRunningJobs，本来只出现在 pending 行上。故意写成 failed
    // 模拟「以后有人往这张表里加第三个失败来源」——契约只有五个类别，第六个不能漏出去
    await addTagJob(alice.id, meme.id, { lastError: 'worker 异常退出，任务被回收' })

    expect((await tagStatus(alice)).failures).toEqual([])
  })
})

// ── scope 与权限 ───────────────────────────────────────────────────

describe('scope', () => {
  it('缺省是 mine，只算自己的图', async () => {
    const alice = await signIn()
    const bob = await signIn()
    await makeMeme(db, { uploaderId: alice.id, tagStatus: 'ok' })
    const bobMeme = await makeMeme(db, { uploaderId: bob.id, tagStatus: 'ok' })
    await addTagJob(bob.id, bobMeme.id, { status: 'running', lastError: null })
    const bobFailed = await makeMeme(db, { uploaderId: bob.id, tagStatus: 'needs_manual' })
    await addTagJob(bob.id, bobFailed.id, { lastError: 'unreachable: HTTP 层判定：unreachable' })

    const summary = await tagStatus(alice)
    expect(summary.scope).toBe('mine')
    expect(summary.counts).toEqual({ ok: 1, pending: 0, refused: 0, needsManual: 0 })
    expect(summary.running).toBe(0)
    expect(summary.failures).toEqual([])
  })

  it('显式传 mine 与不传完全一致（SPEC §6.6.1）', async () => {
    const alice = await signIn()
    await makeMeme(db, { uploaderId: alice.id, tagStatus: 'pending' })

    expect(await tagStatus(alice, '?scope=mine')).toEqual(await tagStatus(alice))
  })

  it('admin 传 all 覆盖他人上传', async () => {
    const admin = await signIn('admin')
    const alice = await signIn()
    await makeMeme(db, { uploaderId: admin.id, tagStatus: 'ok' })
    await makeMeme(db, { uploaderId: alice.id, tagStatus: 'ok' })
    const running = await makeMeme(db, { uploaderId: alice.id })
    await addTagJob(alice.id, running.id, { status: 'running' })
    const failed = await makeMeme(db, { uploaderId: alice.id, tagStatus: 'needs_manual' })
    await addTagJob(alice.id, failed.id, { lastError: 'refused: image_limit' })

    const summary = await tagStatus(admin, '?scope=all')
    expect(summary.scope).toBe('all')
    expect(summary.counts).toEqual({ ok: 2, pending: 1, refused: 0, needsManual: 1 })
    // running 的 `all` 口径是不按 user_id 过滤，所以别人的在跑任务也算
    expect(summary.running).toBe(1)
    expect(summary.failures).toEqual([{ reason: 'refused', count: 1 }])
  })

  it('member 传 all 是 FORBIDDEN', async () => {
    const alice = await signIn()

    const res = await callTagStatus(alice, '?scope=all')
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe('FORBIDDEN')
  })

  it('非法 scope 是 VALIDATION_FAILED，不许掉进 all 分支', async () => {
    const alice = await signIn()

    // 少一个校验的话 `ALL` 会走到「不是 mine」那一支，等于给非管理员开了全站统计的口子——
    // **静默越权**，比报错难查得多
    const res = await callTagStatus(alice, '?scope=ALL')
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('未登录是 UNAUTHENTICATED', async () => {
    const res = await callTagStatus(null)
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('UNAUTHENTICATED')
  })

  it('会话过期与未登录同一条路 —— 不是 403，也不是空数据', async () => {
    const alice = await signIn()
    await sql`update sessions set expires_at = now() - interval '1 day' where user_id = ${alice.id}`

    const res = await callTagStatus(alice)
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('UNAUTHENTICATED')
  })
})

// ── visionConfigured ───────────────────────────────────────────────

describe('visionConfigured', () => {
  it('没配通道时是 false —— 这一批 pending 不会自己好，界面必须把这句话说出来', async () => {
    const alice = await signIn()
    await makeMeme(db, { uploaderId: alice.id, tagStatus: 'pending' })

    expect((await tagStatus(alice)).visionConfigured).toBe(false)
  })

  it('mine 看调用者自己的配置：别人配了不算自己配了', async () => {
    const alice = await signIn()
    const bob = await signIn()
    await configureVision(alice)

    expect((await tagStatus(alice)).visionConfigured).toBe(true)
    expect((await tagStatus(bob)).visionConfigured).toBe(false)
  })

  it('all 问的是「全站有没有任一可用通道」', async () => {
    const admin = await signIn('admin')
    const alice = await signIn()

    // 部署方没配、也没有任何用户配过
    expect((await tagStatus(admin, '?scope=all')).visionConfigured).toBe(false)

    // 一个用户配了之后，全站口径就是真——这正是 worker 决定要不要去取任务的那一个判断
    await configureVision(alice)
    expect((await tagStatus(admin, '?scope=all')).visionConfigured).toBe(true)
  })
})
