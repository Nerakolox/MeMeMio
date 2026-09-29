#!/usr/bin/env node
/**
 * 人物聚类探测（一次性，不进 src）。任务：「人物识别与聚类」§4。
 *
 * 运行：cd api && npx tsx --env-file=.env.probe scripts/person-probe.ts <真值目录>
 * 真值目录两种写法，可混用；结果与缓存写在 <目录>/_out/：
 *   <目录>/<类型>/<角色>/<图>  文件夹名即真值；以「模板」开头的是同图换字，单独统计，不计入认人指标
 *   <目录>/<类型>/A1.jpg       平铺，文件名开头的字母相同 = 同一个角色（A1、A2 同人，B1 另一个）
 * 类型（如「二次元」「真人」）各自单独报，再报一遍全部混在一起的。
 * 灰区交给视觉模型判：PROBE_JUDGE_LO=0.70 PROBE_JUDGE_HI=0.83（不给就不跑）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const BASE_URL = (process.env.PROBE_BASE_URL ?? 'https://api.siliconflow.cn/v1').replace(/\/$/, '')
const API_KEY = process.env.PROBE_API_KEY ?? ''
const EMBED_MODEL = process.env.PROBE_EMBED_MODEL ?? 'Qwen/Qwen3-VL-Embedding-8B'
const VISION_MODEL = process.env.PROBE_VISION_MODEL ?? 'Qwen/Qwen3-VL-32B-Instruct'
const MAX_EDGE = 768
const EMBED_BATCH = 8
/**
 * 送 embedding 前统一缩放到长边这么多像素（小图放大、大图缩小）；0 = 不动。
 * 这个模型对输入尺寸很敏感，同一张图换个尺寸向量就漂，冒烟里 768 最好（任务文件 §9.1）。
 */
const UPSCALE = Number(process.env.PROBE_UPSCALE ?? 768)
const upscale = (png: Buffer) =>
  UPSCALE > 0 ? sharp(png).resize(UPSCALE, UPSCALE, { fit: 'inside' }).png().toBuffer() : Promise.resolve(png)

const root = resolve(process.argv[2] ?? '')
if (!API_KEY || !process.argv[2] || !existsSync(root)) {
  console.error('用法：npx tsx --env-file=.env.probe scripts/person-probe.ts <真值目录>（需要 PROBE_API_KEY）')
  process.exit(1)
}
const outDir = join(root, '_out')
const cropDir = join(outDir, 'crops')
mkdirSync(cropDir, { recursive: true })
const cachePath = join(outDir, 'cache.json')

type Box = [number, number, number, number]
type Subject = { kind: string; head: Box | null; body: Box | null }
type Cache = {
  embed: Record<string, number[]>
  boxes: Record<string, Subject[] | null>
  judge: Record<string, { verdict: string; reason: string }>
}
const cache: Cache = existsSync(cachePath)
  ? { judge: {}, ...(JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<Cache>) } as Cache
  : { embed: {}, boxes: {}, judge: {} }
const saveCache = () => writeFileSync(cachePath, JSON.stringify(cache))

const usage = { embedCalls: 0, embedMs: 0, imageTokens: 0, visionCalls: 0, visionMs: 0, visionTokens: 0, judgeCalls: 0, judgeMs: 0, judgeTokens: 0 }

// ── 真值 ──────────────────────────────────────────────────────────────────────
type Item = { file: string; path: string; kind: string; identity: string; isTemplate: boolean }
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const items: Item[] = []
/** 平铺写法：A1.jpg，字母相同 = 同一个角色 */
const flatIdentity = (name: string) => /^([A-Za-z]+)\d+/.exec(name)?.[1]?.toUpperCase()
for (const kind of readdirSync(root)) {
  const kindPath = join(root, kind)
  if (!statSync(kindPath).isDirectory()) {
    // 直接平铺在根目录、没分类型的图
    const who = flatIdentity(kind)
    if (who && IMAGE_EXT.has(extname(kind).toLowerCase())) {
      items.push({ file: kind, path: kindPath, kind: '未分类', identity: `未分类/${who}`, isTemplate: false })
    }
    continue
  }
  if (kind.startsWith('_')) continue
  for (const who of readdirSync(kindPath)) {
    const dir = join(kindPath, who)
    if (!statSync(dir).isDirectory()) {
      const id = flatIdentity(who)
      if (!id || !IMAGE_EXT.has(extname(who).toLowerCase())) continue
      items.push({ file: who, path: dir, kind, identity: `${kind}/${id}`, isTemplate: false })
      continue
    }
    for (const f of readdirSync(dir)) {
      if (!IMAGE_EXT.has(extname(f).toLowerCase())) continue
      items.push({ file: f, path: join(dir, f), kind, identity: `${kind}/${who}`, isTemplate: who.startsWith('模板') })
    }
  }
}
console.log(`真值：${items.length} 张，${new Set(items.map(i => i.identity)).size} 个身份`)

// ── 图像预处理：动图取中间帧，只缩不放，一律 PNG ──────────────────────────────
type Frame = { png: Buffer; w: number; h: number; key: string }
async function loadFrame(path: string): Promise<Frame> {
  const meta = await sharp(path).metadata()
  const pages = meta.pages ?? 1
  const page = pages > 1 ? Math.floor(pages / 2) : 0
  const { data, info } = await sharp(path, { page })
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true })
  return { png: data, w: info.width, h: info.height, key: createHash('sha256').update(data).digest('hex').slice(0, 16) }
}

// ── 远端调用 ──────────────────────────────────────────────────────────────────
const dataUri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`

async function post(path: string, body: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let r: Response
    try {
      r = await fetch(BASE_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      })
    } catch (e) {
      // 超时、断连：和 HTTP 失败一样重试
      if (attempt >= 2) throw e
      console.warn(`\n  ${path} 第 ${attempt + 1} 次失败（${(e as Error).name}），重试`)
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)))
      continue
    }
    const text = await r.text()
    if (r.ok) return JSON.parse(text) as unknown
    if (attempt >= 2) throw new Error(`${path} HTTP ${r.status}: ${text.slice(0, 200)}`)
    await new Promise(res => setTimeout(res, 2000 * (attempt + 1)))
  }
}

async function embedPngs(pngs: { key: string; png: Buffer }[]): Promise<void> {
  const todo = pngs.filter(p => !cache.embed[p.key])
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH)
    const t = Date.now()
    const res = (await post('/embeddings', {
      model: EMBED_MODEL,
      input: batch.map(b => ({ image: dataUri(b.png) })),
    })) as { data?: { embedding?: number[] }[]; usage?: { image_tokens?: number } }
    usage.embedCalls++
    usage.embedMs += Date.now() - t
    usage.imageTokens += res.usage?.image_tokens ?? 0
    batch.forEach((b, j) => {
      const v = res.data?.[j]?.embedding
      if (!Array.isArray(v) || v.length === 0) throw new Error(`embedding 缺失：${b.key}`)
      cache.embed[b.key] = v
    })
    saveCache()
  }
}

const BOX_PROMPT = `找出图中所有的人物或角色（动漫角色、真人、拟人化或作为主角的动物都算）。对每一个给出：
- kind："anime"（二次元/动漫/插画）、"real"（真人照片）、"animal"、"other"
- head：头部框，包括头发、耳朵、头饰
- body：这个角色在画面里可见部分的框
坐标用 0 到 1000 的相对坐标 [x1, y1, x2, y2]，原点在左上角。
忽略文字、字幕、气泡和背景物件。没有任何人物或角色时返回空数组。
只输出 JSON，不要解释：{"subjects":[{"kind":"anime","head":[x1,y1,x2,y2],"body":[x1,y1,x2,y2]}]}`

function parseBox(v: unknown): Box | null {
  if (!Array.isArray(v) || v.length !== 4) return null
  const n = v.map(Number)
  if (n.some(x => !Number.isFinite(x))) return null
  const [x1, y1, x2, y2] = n as Box
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null
}

async function detect(frame: Frame): Promise<Subject[] | null> {
  if (frame.key in cache.boxes) return cache.boxes[frame.key] ?? null
  const t = Date.now()
  let subjects: Subject[] | null = null
  try {
    const res = (await post('/chat/completions', {
      model: VISION_MODEL,
      temperature: 0,
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUri(frame.png) } },
          { type: 'text', text: BOX_PROMPT },
        ],
      }],
    })) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } }
    usage.visionTokens += res.usage?.total_tokens ?? 0
    const content = res.choices?.[0]?.message?.content ?? ''
    const json = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)
    const parsed = JSON.parse(json) as { subjects?: unknown[] }
    subjects = (parsed.subjects ?? []).map(s => {
      const o = (s ?? {}) as Record<string, unknown>
      return { kind: String(o['kind'] ?? 'other'), head: parseBox(o['head']), body: parseBox(o['body']) }
    })
  } catch (e) {
    console.warn(`  框解析失败：${(e as Error).message.slice(0, 120)}`)
  }
  usage.visionCalls++
  usage.visionMs += Date.now() - t
  // 失败不进缓存，否则一次网络抖动会变成永久的「没检出」
  if (subjects !== null) {
    cache.boxes[frame.key] = subjects
    saveCache()
  }
  return subjects
}

async function crop(frame: Frame, box: Box, pad: number): Promise<Buffer | null> {
  const [x1, y1, x2, y2] = box.map((v, i) => (v / 1000) * (i % 2 === 0 ? frame.w : frame.h)) as Box
  const pw = (x2 - x1) * pad
  const ph = (y2 - y1) * pad
  const left = Math.max(0, Math.floor(x1 - pw))
  const top = Math.max(0, Math.floor(y1 - ph))
  const width = Math.min(frame.w, Math.ceil(x2 + pw)) - left
  const height = Math.min(frame.h, Math.ceil(y2 + ph)) - top
  if (width < 16 || height < 16) return null
  return sharp(frame.png).extract({ left, top, width, height }).png().toBuffer()
}

// ── 采集 ──────────────────────────────────────────────────────────────────────
type Variant = 'whole' | 'head' | 'body'
const VARIANTS: Variant[] = ['whole', 'head', 'body']
const vecKeys = new Map<string, Partial<Record<Variant, string>>>()
const wholePngs = new Map<string, { key: string; png: Buffer }>()
const detectLog = new Map<string, { file: string; identity: string; subjects: Subject[] | null }>()
/** 报告里怎么称呼一张图：评测集的图取序号，平铺写法取 A1 这样的主名；多个类型时带上类型 */
const kinds = [...new Set(items.map(i => i.kind))]
const label = (it: Item) => {
  const stem = basename(it.file, extname(it.file)).split('_')[0]!
  return kinds.length > 1 ? `${it.kind}/${stem}` : stem
}

let done = 0
async function collect(it: Item): Promise<void> {
  const frame = await loadFrame(it.path)
  const wholePng = await upscale(frame.png)
  const wholeKey = UPSCALE > 0 ? `whole${UPSCALE}:${createHash('sha256').update(wholePng).digest('hex').slice(0, 16)}` : frame.key
  const keys: Partial<Record<Variant, string>> = { whole: wholeKey }
  const pending: { key: string; png: Buffer }[] = [{ key: wholeKey, png: wholePng }]
  wholePngs.set(it.path, { key: wholeKey, png: wholePng })

  const subjects = await detect(frame)
  detectLog.set(it.path, { file: label(it), identity: it.identity, subjects })
  const area = (b: Box | null) => (b ? (b[2] - b[0]) * (b[3] - b[1]) : 0)
  const main = (subjects ?? []).slice().sort((a, b) => area(b.body ?? b.head) - area(a.body ?? a.head))[0]
  const stem = basename(it.file, extname(it.file))
  for (const [variant, box, pad] of [['head', main?.head, 0.15], ['body', main?.body, 0.05]] as const) {
    if (!box) continue
    const raw = await crop(frame, box, pad)
    if (!raw) continue
    const png = await upscale(raw)
    const key = `${variant}:${createHash('sha256').update(png).digest('hex').slice(0, 16)}`
    writeFileSync(join(cropDir, `${it.kind}_${stem}_${variant}.png`), png)
    keys[variant] = key
    pending.push({ key, png })
  }
  await embedPngs(pending)
  vecKeys.set(it.path, keys)
  process.stdout.write(`\r采集 ${++done}/${items.length}`)
}
// 画框一张要 9 秒上下，4 路并发
const queue = items.slice()
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let it = queue.shift(); it; it = queue.shift()) await collect(it)
}))
console.log('\n采集完成')

// ── 分析 ──────────────────────────────────────────────────────────────────────
function normalize(v: number[], dim: number): number[] {
  const t = v.slice(0, dim)
  const n = Math.sqrt(t.reduce((s, x) => s + x * x, 0))
  return t.map(x => x / n)
}
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)

function quantiles(xs: number[]): string {
  if (xs.length === 0) return '（无）'
  const s = xs.slice().sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!.toFixed(3)
  return `n=${s.length} min=${q(0)} p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} max=${q(1)}`
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Row = { it: Item; v: number[] }
function cluster(rows: Row[], t: number, order: number[]) {
  const clusters: { sum: number[]; members: Row[] }[] = []
  for (const i of order) {
    const r = rows[i]!
    let best = -1, bestSim = -2
    clusters.forEach((c, ci) => {
      const n = Math.sqrt(c.sum.reduce((s, x) => s + x * x, 0))
      const sim = dot(r.v, c.sum) / n
      if (sim > bestSim) { bestSim = sim; best = ci }
    })
    if (best >= 0 && bestSim >= t) {
      const c = clusters[best]!
      c.members.push(r)
      c.sum = c.sum.map((x, k) => x + r.v[k]!)
    } else {
      clusters.push({ sum: r.v.slice(), members: [r] })
    }
  }
  let wrong = 0, impure = 0
  for (const c of clusters) {
    const counts = new Map<string, number>()
    c.members.forEach(m => counts.set(m.it.identity, (counts.get(m.it.identity) ?? 0) + 1))
    if (counts.size > 1) impure++
    wrong += c.members.length - Math.max(...counts.values())
  }
  let frag = 0
  const byId = new Map<string, Set<number>>()
  clusters.forEach((c, ci) => c.members.forEach(m => {
    if (!byId.has(m.it.identity)) byId.set(m.it.identity, new Set())
    byId.get(m.it.identity)!.add(ci)
  }))
  byId.forEach(s => { frag += s.size - 1 })
  return { clusters: clusters.length, impure, wrong, frag, members: clusters.map(c => c.members) }
}

// 合并建议：保守阈值挂完簇以后，由人收拢碎片。两组的相似度取组间最像的那一对图（单链），
// 合并后重排；点掉过的「X 不是 Z」在 X 并进别的组以后仍然成立。两种给法：
//   全局清单——所有组对按相似度排一张表，从上往下点，数收拢全部碎片前要点掉几条错的；
//   互为最近——X 最像 Y、Y 也最像 X 才给，不看绝对值；一轮给完再重算，碎片收全就停，数第一轮的对错与总共点掉几条错的。
function suggest(members: Row[][]) {
  type G = { ms: Row[]; id: string; rejected: Set<number>; key: number }
  const major = (ms: Row[]) => {
    const counts = new Map<string, number>()
    ms.forEach(m => counts.set(m.it.identity, (counts.get(m.it.identity) ?? 0) + 1))
    return [...counts].sort((a, b) => b[1] - a[1])[0]![0]
  }
  const fresh = (): G[] => members.map((ms, i) => ({ ms, id: major(ms), rejected: new Set<number>(), key: i }))
  const simCache = new Map<Row, Map<Row, number>>()
  const sim = (x: Row, y: Row) => {
    let m = simCache.get(x)
    if (!m) simCache.set(x, m = new Map())
    let s = m.get(y)
    if (s === undefined) m.set(y, s = dot(x.v, y.v))
    return s
  }
  const link = (a: G, b: G) => Math.max(...a.ms.flatMap(x => b.ms.map(y => sim(x, y))))
  const fragOf = (gs: G[]) => gs.length - new Set(gs.map(g => g.id)).size
  const merge = (gs: G[], a: G, b: G): G[] => {
    const rest = gs.filter(g => g !== a && g !== b)
    rest.forEach(g => { if (g.rejected.delete(b.key)) g.rejected.add(a.key) })
    return [...rest, { ms: [...a.ms, ...b.ms], id: a.id, rejected: new Set([...a.rejected, ...b.rejected]), key: a.key }]
  }
  const reject = (a: G, b: G) => { a.rejected.add(b.key); b.rejected.add(a.key) }
  const bestOf = (gs: G[], g: G) => {
    let best: G | null = null, bs = -2
    for (const o of gs) {
      if (o === g || g.rejected.has(o.key)) continue
      const s = link(g, o)
      if (s > bs) { bs = s; best = o }
    }
    return best
  }

  let groups = fresh()
  const frag0 = fragOf(groups)
  // 每个有兄弟组的组：它最像的那一组是不是兄弟（组详情里「可能是同一个」只给一条时的命中）
  let sibTop1 = 0, withSib = 0
  for (const g of groups) {
    if (!groups.some(o => o !== g && o.id === g.id)) continue
    withSib++
    if (bestOf(groups, g)?.id === g.id) sibTop1++
  }

  let rejects = 0, rejectsAtHalf = -1, last = ''
  while (fragOf(groups) > 0) {
    let best: { a: G; b: G; s: number } | null = null
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i]!, b = groups[j]!
      if (a.rejected.has(b.key)) continue
      const s = link(a, b)
      if (!best || s > best.s) best = { a, b, s }
    }
    if (!best) break
    if (best.a.id === best.b.id) {
      if (fragOf(groups) === 1) last = `${best.a.ms.map(r => label(r.it)).join('+')} ← ${best.b.ms.map(r => label(r.it)).join('+')} ${best.s.toFixed(3)}（前面点掉 ${rejects} 条）`
      groups = merge(groups, best.a, best.b)
      if (rejectsAtHalf < 0 && fragOf(groups) <= frag0 / 2) rejectsAtHalf = rejects
    } else {
      reject(best.a, best.b)
      rejects++
    }
  }

  let mg = fresh(), mRejects = 0
  let round1: { ok: number; bad: number } | null = null
  while (fragOf(mg) > 0) {
    const pairs: [G, G, number][] = []
    for (const g of mg) {
      const b = bestOf(mg, g)
      if (b && b.key > g.key && bestOf(mg, b) === g) pairs.push([g, b, link(g, b)])
    }
    if (pairs.length === 0) break
    pairs.sort((x, y) => y[2] - x[2])
    let ok = 0, bad = 0
    for (const [a, b] of pairs) {
      if (a.id === b.id) { mg = merge(mg, a, b); ok++ } else { reject(a, b); bad++ }
    }
    round1 ??= { ok, bad }
    mRejects += bad
  }
  return {
    frag0, sibTop1, withSib, rejects, rejectsAtHalf: Math.max(rejectsAtHalf, 0), last,
    r1ok: round1?.ok ?? 0, r1bad: round1?.bad ?? 0, mRejects, mLeft: fragOf(mg),
  }
}

const lines: string[] = []
const log = (s = '') => { lines.push(s); console.log(s) }
log(`# 人物聚类探测报告\n`)
log(`- 真值目录：\`${root}\``)
log(`- 模型：embedding \`${EMBED_MODEL}\`，画框 \`${VISION_MODEL}\``)
log(`- 送 embedding 前统一缩放到长边：${UPSCALE || '不缩放'}`)
log(`- ${items.length} 张，${new Set(items.map(i => i.identity)).size} 个身份；动图取中间帧，长边 ≤ ${MAX_EDGE}`)

const detects = items.map(it => detectLog.get(it.path)!)
const withSubject = detects.filter(d => (d.subjects?.length ?? 0) > 0).length
const failed = detects.filter(d => d.subjects === null).length
log(`\n## 画框\n`)
log(`- 检出至少一个主体：${withSubject}/${items.length}；解析失败：${failed}`)
log(`- 未检出：${detects.filter(d => d.subjects?.length === 0).map(d => d.file).join('、') || '无'}`)
for (const kind of kinds) {
  const ds = detects.filter((_, i) => items[i]!.kind === kind)
  log(`- 「${kind}」里的主体类型分布：${JSON.stringify(ds.flatMap(d => d.subjects ?? []).reduce<Record<string, number>>((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {}))}`)
}
log(`- 多主体的图：${detects.filter(d => (d.subjects?.length ?? 0) > 1).map(d => `${d.file}(${d.subjects!.length})`).join('、') || '无'}`)

// 各类型单独报（§4：二次元与真人不混着算）；多个类型时再报一遍「全部」，那是入库时真实的样子
const scopes = kinds.length > 1 ? [...kinds, '全部'] : kinds
for (const scope of scopes) {
  const scoped = items.filter(it => scope === '全部' || it.kind === scope)
  if (kinds.length > 1) log(`\n# 范围：${scope}（${scoped.length} 张，${new Set(scoped.map(i => i.identity)).size} 个身份）`)
  for (const dim of [4096, 1024]) {
    for (const variant of VARIANTS) {
      const rows: Row[] = scoped
        .map(it => ({ it, key: vecKeys.get(it.path)?.[variant] }))
        .filter((x): x is { it: Item; key: string } => !!x.key && !!cache.embed[x.key])
        .map(x => ({ it: x.it, v: normalize(cache.embed[x.key]!, dim) }))
      const same: number[] = [], diff: number[] = [], tmpl: number[] = []
      const pairs: { a: string; b: string; sim: number; same: boolean }[] = []
      for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!, b = rows[j]!
        const sim = dot(a.v, b.v)
        const isSame = a.it.identity === b.it.identity
        if (isSame && a.it.isTemplate) tmpl.push(sim)
        else if (isSame) same.push(sim)
        else diff.push(sim)
        pairs.push({ a: label(a.it), b: label(b.it), sim, same: isSame })
      }
      const idRows = rows.filter(r => !r.it.isTemplate)
      const hasPartner = idRows.filter(r => idRows.some(o => o !== r && o.it.identity === r.it.identity))
      let top1 = 0
      for (const r of hasPartner) {
        const nn = rows.filter(o => o !== r).sort((x, y) => dot(r.v, y.v) - dot(r.v, x.v))[0]
        if (nn?.it.identity === r.it.identity) top1++
      }
      const maxDiff = Math.max(...diff)
      const recallAtZeroFp = same.filter(s => s > maxDiff).length

      log(`\n## ${kinds.length > 1 ? `${scope} · ` : ''}${variant}（${dim} 维）\n`)
      log(`- 覆盖：${rows.length}/${scoped.length} 张`)
      log(`- 同角色对：${quantiles(same)}`)
      log(`- 同模板换字对：${quantiles(tmpl)}`)
      log(`- 不同角色对：${quantiles(diff)}`)
      log(`- 最近邻命中（有同伴的 ${hasPartner.length} 张里）：${top1}/${hasPartner.length}`)
      log(`- 零误合并的最低阈值 ≈ ${maxDiff.toFixed(3)}，此时同角色对召回 ${recallAtZeroFp}/${same.length}`)
      log(`- 同角色对逐条：${pairs.filter(p => p.same).sort((x, y) => x.sim - y.sim).map(p => `${p.a}-${p.b} ${p.sim.toFixed(3)}`).join('，')}`)
      log(`- 最像的不同角色对：${pairs.filter(p => !p.same).sort((x, y) => y.sim - x.sim).slice(0, 10).map(p => `${p.a}-${p.b} ${p.sim.toFixed(3)}`).join('，')}`)

      log(`\n| 阈值 | 簇数 | 混了人的簇 | 被并错的图 | 碎片（多出来的簇） |\n|---|---|---|---|---|`)
      const suggestRuns: { t: number; runs: ReturnType<typeof suggest>[] }[] = []
      for (let t = 0.7; t <= 0.951; t += 0.025) {
        const runs = Array.from({ length: 20 }, (_, s) => {
          const rnd = mulberry32(s + 1)
          const order = rows.map((_, i) => i)
          for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            [order[i], order[j]] = [order[j]!, order[i]!]
          }
          return cluster(rows, t, order)
        })
        const avg = (k: 'clusters' | 'impure' | 'wrong' | 'frag') => (runs.reduce((s, r) => s + r[k], 0) / runs.length).toFixed(1)
        log(`| ${t.toFixed(3)} | ${avg('clusters')} | ${avg('impure')} | ${avg('wrong')} | ${avg('frag')} |`)
        if (variant === 'whole' && [0.8, 0.825, 0.85].some(x => Math.abs(t - x) < 1e-6)) {
          suggestRuns.push({ t, runs: runs.map(r => suggest(r.members)) })
        }
      }
      if (suggestRuns.length > 0) {
        log(`\n合并建议（整图，组间最像的一对图算相似度，合并后重排；20 次入库顺序平均）：\n`)
        const tails = new Map<number, string[]>()
        log(`| 阈值 | 碎片 | 单看一组：最像的那组就是兄弟 | 全局清单：收一半前点掉的错建议 | 全局清单：收全前点掉的错建议 | 互为最近：第一轮对 / 错 | 互为最近：收全前点掉的错建议 |\n|---|---|---|---|---|---|---|`)
        for (const { t, runs } of suggestRuns.splice(0)) {
          const m = (f: (r: ReturnType<typeof suggest>) => number) => (runs.reduce((s, r) => s + f(r), 0) / runs.length).toFixed(1)
          log(`| ${t.toFixed(3)} | ${m(r => r.frag0)} | ${m(r => r.sibTop1)}/${m(r => r.withSib)} | ${m(r => r.rejectsAtHalf)} | ${m(r => r.rejects)} | ${m(r => r.r1ok)} / ${m(r => r.r1bad)} | ${m(r => r.mRejects)} |`)
          tails.set(t, runs.map(r => r.last))
        }
        for (const [t, ls] of tails) {
          const counts = new Map<string, number>()
          ls.filter(Boolean).forEach(l => { const k = l.replace(/（.*）$/, ''); counts.set(k, (counts.get(k) ?? 0) + 1) })
          log(`- 阈值 ${t.toFixed(3)} 全局清单最后收进来的：${[...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}（${n}/20 次）`).join('；') || '无碎片'}`)
        }
      }
    }
  }
}

// ── 灰区交给视觉模型：只判整图、原生维度那一组 ─────────────────────────────────
const JUDGE_LO = Number(process.env.PROBE_JUDGE_LO ?? 0)
const JUDGE_HI = Number(process.env.PROBE_JUDGE_HI ?? 0)
if (JUDGE_HI > JUDGE_LO) {
  const JUDGE_PROMPT = `这两张图里的主要角色，是不是同一个角色（同一个真人，或同一个动漫/插画角色）？
画风、清晰度、表情、动作、服装、配字不同，都可能仍是同一个角色。
同一作品里的不同角色、只是画风或配色相似的不同角色，都不算同一个。
拿不准就答 unsure，不要猜。只输出 JSON：{"verdict":"same"|"different"|"unsure","reason":"一句话"}`
  const rows = items.map(it => ({ it, v: normalize(cache.embed[vecKeys.get(it.path)!.whole!]!, 4096) }))
  const gray: { a: Item; b: Item; sim: number }[] = []
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const sim = dot(rows[i]!.v, rows[j]!.v)
    if (sim >= JUDGE_LO && sim < JUDGE_HI) gray.push({ a: rows[i]!.it, b: rows[j]!.it, sim })
  }
  const judgeOne = async (p: (typeof gray)[number]) => {
    const key = `judge:${wholePngs.get(p.a.path)!.key}:${wholePngs.get(p.b.path)!.key}`
    if (cache.judge[key]) return cache.judge[key]!
    const t = Date.now()
    let out = { verdict: 'error', reason: '' }
    try {
      const res = (await post('/chat/completions', {
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUri(wholePngs.get(p.a.path)!.png) } },
            { type: 'image_url', image_url: { url: dataUri(wholePngs.get(p.b.path)!.png) } },
            { type: 'text', text: JUDGE_PROMPT },
          ],
        }],
      })) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } }
      usage.judgeTokens += res.usage?.total_tokens ?? 0
      const content = res.choices?.[0]?.message?.content ?? ''
      const parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)) as { verdict?: string; reason?: string }
      out = { verdict: ['same', 'different', 'unsure'].includes(parsed.verdict ?? '') ? parsed.verdict! : 'invalid', reason: parsed.reason ?? '' }
    } catch (e) {
      out = { verdict: 'error', reason: (e as Error).message.slice(0, 100) }
    }
    usage.judgeCalls++
    usage.judgeMs += Date.now() - t
    if (out.verdict !== 'error') {
      cache.judge[key] = out
      saveCache()
    }
    return out
  }
  const results: { p: (typeof gray)[number]; verdict: string; reason: string }[] = []
  for (let i = 0; i < gray.length; i += 4) {
    const chunk = gray.slice(i, i + 4)
    const outs = await Promise.all(chunk.map(judgeOne))
    chunk.forEach((p, k) => results.push({ p, ...outs[k]! }))
    process.stdout.write(`\r判定 ${Math.min(i + 4, gray.length)}/${gray.length}`)
  }
  console.log()
  log(`\n## 灰区判定（整图 4096 维，${JUDGE_LO} ≤ 相似度 < ${JUDGE_HI}，共 ${gray.length} 对）\n`)
  log(`| 真值 \\ 模型 | same | different | unsure | 出错 |\n|---|---|---|---|---|`)
  for (const truth of [true, false]) {
    const rs = results.filter(r => (r.p.a.identity === r.p.b.identity) === truth)
    const c = (v: string) => rs.filter(r => r.verdict === v).length
    log(`| ${truth ? '同角色' : '不同角色'}（${rs.length}） | ${c('same')} | ${c('different')} | ${c('unsure')} | ${c('error') + c('invalid')} |`)
  }
  log(`\n判错的（真值不同却答 same，或真值相同却答 different）：`)
  for (const r of results) {
    const same = r.p.a.identity === r.p.b.identity
    if ((same && r.verdict === 'different') || (!same && r.verdict === 'same')) {
      log(`- ${label(r.p.a)}-${label(r.p.b)}（${same ? '同' : '不同'}，${r.p.sim.toFixed(3)}）→ ${r.verdict}：${r.reason}`)
    }
  }
  log(`\n同角色对的判定：`)
  for (const r of results.filter(r => r.p.a.identity === r.p.b.identity)) {
    log(`- ${label(r.p.a)}-${label(r.p.b)}（${r.p.sim.toFixed(3)}）→ ${r.verdict}：${r.reason}`)
  }
}

log(`\n## 调用与成本\n`)
log(`- embedding：${usage.embedCalls} 次批量调用，平均 ${usage.embedCalls ? Math.round(usage.embedMs / usage.embedCalls) : 0} ms/批（≤${EMBED_BATCH} 张），image_tokens 合计 ${usage.imageTokens}`)
log(`- 画框：${usage.visionCalls} 次，平均 ${usage.visionCalls ? Math.round(usage.visionMs / usage.visionCalls) : 0} ms/张，tokens 合计 ${usage.visionTokens}`)
log(`- 灰区判定：${usage.judgeCalls} 次（每次两张图，4 路并发），平均 ${usage.judgeCalls ? Math.round(usage.judgeMs / usage.judgeCalls) : 0} ms/次，tokens 合计 ${usage.judgeTokens}`)
log(`- 本次命中缓存的调用不计入上面的数（缓存：\`_out/cache.json\`）`)

writeFileSync(join(outDir, UPSCALE > 0 ? `report-up${UPSCALE}.md` : 'report.md'), lines.join('\n') + '\n')
writeFileSync(join(outDir, 'detect.json'), JSON.stringify(detects, null, 1))
