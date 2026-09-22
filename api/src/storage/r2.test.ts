import { describe, expect, it, vi } from 'vitest'
// 纯类型 import，编译期就擦掉了，不会在 stubEnv 之前把模块拉起来
import type { SerializeMemeInput } from '../serialize/meme.js'

/**
 * 公开 URL 的部署前缀（joint-tasks/2026-09-18-r2-public-url-prefix.md）。
 *
 * ⚠️ **前缀必须非空，而且必须由这个文件自己定**，不能用 `.env` 里填的那个。
 *    `R2_KEY_PREFIX` 为空时「派生公开 URL 时漏了前缀」这个 bug 完全不可见——
 *    带不带前缀拼出来的是同一个字符串，断言照过。用空前缀写的回归测试等于没写，
 *    而 `.env` 里填什么不由这里控制。
 *
 * 所以先 stubEnv 再动态 import：`src/env.ts` 在 import 的那一刻读 process.env，
 * 顺序反了就拿不到这两个值。其余变量仍来自 `.env`（tests/setup-env.ts 加载）。
 */
const PREFIX = 'r2-public-url-test/'
const BASE = 'https://cdn.example.test'

vi.stubEnv('R2_KEY_PREFIX', PREFIX)
vi.stubEnv('R2_PUBLIC_BASE_URL', BASE)

const { permanentKeyFor, publicUrlFor, tempKeyFor, thumbKeyFor } = await import('./r2.js')
const { serializeMeme } = await import('../serialize/meme.js')

/** 只写与本测试相关的字段，其余填合法值占位。 */
function memeRow(storageKey: string): SerializeMemeInput {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    uploaderId: '22222222-2222-4222-8222-222222222222',
    uploaderName: 'alice',
    storageKey,
    originalFilename: 'cat.png',
    mime: 'image/png',
    width: 240,
    height: 240,
    sizeBytes: 1024n,
    isAnimated: false,
    ocrText: null,
    description: null,
    expressions: null,
    emotions: null,
    tones: null,
    purposes: null,
    scenes: null,
    tags: null,
    tagStatus: 'pending',
    visionModel: null,
    editedBy: null,
    editedAt: null,
    createdAt: new Date('2026-09-18T00:00:00Z'),
    favorited: false,
  }
}

describe('publicUrlFor', () => {
  it('带上 R2_KEY_PREFIX——对象在前缀下面，地址也必须在', () => {
    expect(publicUrlFor('memes/abc.png')).toBe(`${BASE}/${PREFIX}memes/abc.png`)
  })

  it('待确认队列的 tempUrl 同样带前缀（SPEC §6.2.3）', () => {
    const tempKey = tempKeyFor('batch-1', 'cat.png')
    expect(publicUrlFor(tempKey)).toBe(`${BASE}/${PREFIX}temp/batch-1/cat.png`)
  })
})

describe('serializeMeme 的 url / thumbUrl（SPEC §5.2.6）', () => {
  const storageKey = permanentKeyFor('4d92a40e-0000-4000-8000-000000000000', 'png')

  it('两个地址都带前缀', () => {
    const out = serializeMeme(memeRow(storageKey))

    // 写成字面量而不是再调一次被测函数：两侧都用同一个表达式的话，
    // publicUrlFor 自己拼错时两边会一起错，断言照过
    expect(out.url).toBe(`${BASE}/${PREFIX}memes/4d92a40e-0000-4000-8000-000000000000.png`)
    expect(out.thumbUrl).toBe(`${BASE}/${PREFIX}thumbs/4d92a40e-0000-4000-8000-000000000000.webp`)
  })

  it('走的是 publicUrlFor 与 thumbKeyFor，不自己拼第二份', () => {
    const out = serializeMeme(memeRow(storageKey))

    // 这两条钉的是「实现只剩一处」：serialize 里再出现一份自拼的 base + key，
    // 哪怕当下拼对了，下一次改前缀规则时也只会改到其中一边
    expect(out.url).toBe(publicUrlFor(storageKey))
    expect(out.thumbUrl).toBe(publicUrlFor(thumbKeyFor(storageKey)))
  })
})
