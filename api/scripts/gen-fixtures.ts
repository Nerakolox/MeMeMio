import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import sharp from 'sharp'

/**
 * 生成 `docs/fixtures/images/` 下的固定测试图片。
 *
 * 两个入口，**模式不同**：
 *
 *   npm run fixtures                    → generateFixtures('all')，覆盖同名文件
 *   tests/global-setup.ts 检测到缺样本  → generateFixtures('missing')，只补缺的
 *
 * ⚠️ `'all'` 会**覆盖**同名文件。改 fixture 的形态之前先确认没有测试依赖旧形态。
 *    `'missing'` 永远不碰已存在的文件——测试路径上重写样本等于让「这次跑的和上次
 *    跑的是同一批字节」这条保证消失，而它不报错，只是哈希断言开始飘。
 *
 * ffmpeg 必须在 PATH 上——但**只有动图那一组需要它**。`'missing'` 模式下动图都在时
 * 根本不会调 ffmpeg，所以「新克隆只缺 huge.png」的情况（docs/fixtures.md §2：它不进
 * 仓库）不依赖 ffmpeg，一个 sharp 就够。动图（GIF / 动态 WebP / APNG）没法用 sharp
 * 生成——libvips 那边写多帧的路径各平台不一致，而管线本来就用 ffmpeg，用同一个工具
 * 生成更贴近真实。
 */

const run = promisify(execFile)

const fixturesRoot = fileURLToPath(new URL('../../docs/fixtures/images/', import.meta.url))
const tmp = tmpdir()

/** `'all'` 覆盖，`'missing'` 只补缺的。 */
export type FixtureMode = 'all' | 'missing'

let mode: FixtureMode = 'all'

/**
 * 该不该产出这个文件。
 *
 * 判断放在**生成之前**而不是写入之前：噪声图要编码、动图要起 ffmpeg，
 * 已经存在的样本连算都不该算。
 */
function wanted(rel: string): boolean {
  return mode === 'all' || !existsSync(join(fixturesRoot, rel))
}

/** 确定性伪随机，不用 Math.random——重跑必须得到同一批字节。 */
function noiseRaw(width: number, height: number, seed: number): Buffer {
  const buf = Buffer.alloc(width * height * 3)
  let s = seed
  for (let i = 0; i < buf.length; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    buf[i] = (s >> 16) & 0xff
  }
  return buf
}

/**
 * 噪声图而不是纯色图：纯色过 dHash 会得到全 0，去重和近似去重的用例就都测不出东西了。
 * 噪声有真实的高低频，哈希才有区分度。
 */
async function noisePng(width: number, height: number, seed: number): Promise<Buffer> {
  return sharp(noiseRaw(width, height, seed), { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 6 })
    .toBuffer()
}

/**
 * 跑一次 ffmpeg。
 *
 * `-vsync 0` **不能省**：concat 出来的帧时间戳相同（每路输入都是自己的第 0 帧），
 * 默认的 vsync 会把「同一时刻」的帧当重复丢掉——实测 4 帧输入生成出 **2 帧**的 GIF/APNG，
 * 而且不报任何错（日志里只有一行 `drop=2`）。fixture 于是看着像动图、
 * 实际帧数和预期不符，拿它写的「多帧」用例测的是另一件事。
 */
async function ffmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-vsync', '0', ...args], {
    maxBuffer: 32 * 1024 * 1024,
  })
}

// ── 动态 WebP：自己拼容器 ───────────────────────────────────────────────
//
// ⚠️ **ffmpeg 生成不了它。** libwebp_anim 编码器在（`ffmpeg -encoders` 里有），
// 但 WebP 的解复用器只有 `webp_pipe`（图片序列），它**不认 ANIM / ANMF 块**：
//
//     [webp @ …] skipping unsupported chunk: ANIM
//     [webp @ …] skipping unsupported chunk: ANMF
//     Stream #0:0: Video: webp, 25 fps        ← 读成 25fps 的静图流
//
// 结果是写出一个文件、ffprobe 报 `width=0 nb_frames=N/A`、抽帧产出 0 字节 PNG。
// 部署镜像里的 ffmpeg 5.1（Debian bookworm）和本机的 8.1 都是这个行为，
// 所以这不是版本问题，是这条路根本不通。
//
// 因此这里按 WebP 容器规范（RIFF + VP8X/ANIM/ANMF）手工拼。帧数据本身仍然
// 由 sharp（libwebp）编码，只有容器是手写的——这是唯一能让 fixture 真的可用的办法。
// 生成后 `npm run fixtures` 会打印 ffprobe 的读数供核对。

function chunk(fourCC: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.write(fourCC, 0, 'ascii')
  header.writeUInt32LE(payload.length, 4)
  const padding = payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
  return Buffer.concat([header, payload, padding])
}

/** 把若干已编码的 WebP 帧拼成一个动态 WebP。每帧必须尺寸相同。 */
function muxAnimatedWebp(frameWebps: Buffer[], width: number, height: number, durationMs: number): Buffer {
  // 每一帧本身是一个完整的 RIFF 文件，取出其中的 VP8 / VP8L 数据块
  const payloads = frameWebps.map((file) => {
    if (file.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error('帧不是 RIFF/WebP')
    const fourCC = file.subarray(12, 16).toString('ascii')
    if (fourCC !== 'VP8 ' && fourCC !== 'VP8L') {
      throw new Error(`帧的编码块是 ${fourCC}，ANMF 里只接受 VP8 / VP8L`)
    }
    const size = file.readUInt32LE(16)
    return chunk(fourCC, file.subarray(20, 20 + size))
  })

  // VP8X：带 ANIM 标志（0x02），画布尺寸各减一
  const vp8x = Buffer.alloc(10)
  vp8x.writeUInt8(0x02, 0)
  vp8x.writeUIntLE(width - 1, 4, 3)
  vp8x.writeUIntLE(height - 1, 7, 3)

  // ANIM：背景色（BGRA，全 0 = 透明）+ 循环次数。0 = 无限循环
  const anim = Buffer.alloc(6)

  const anmf = payloads.map((payload) => {
    const header = Buffer.alloc(16)
    // x / y 各占 3 字节（除以 2 存储，这里都是 0），宽高各 3 字节（减一）
    header.writeUIntLE(width - 1, 6, 3)
    header.writeUIntLE(height - 1, 9, 3)
    header.writeUIntLE(durationMs, 12, 3)
    header.writeUInt8(0, 15) // 无混合、无处置
    return chunk('ANMF', Buffer.concat([header, payload]))
  })

  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunk('VP8X', vp8x), chunk('ANIM', anim), ...anmf])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

async function main(): Promise<void> {
  for (const dir of ['static', 'animated', 'edge', 'dup']) {
    await mkdir(join(fixturesRoot, dir), { recursive: true })
  }

  await genStatic()
  await genAnimated()
  await genEdge()
  await genDup()
}

// ── static/ 三种静图，同一张图三个格式 ──────────────────────────────────

async function genStatic(): Promise<void> {
  const targets = ['static/static.png', 'static/static.jpg', 'static/static.webp']
  if (!targets.some(wanted)) return

  const base = await noisePng(240, 240, 7)
  if (wanted('static/static.png')) {
    await writeFile(join(fixturesRoot, 'static/static.png'), base)
  }
  if (wanted('static/static.jpg')) {
    await writeFile(join(fixturesRoot, 'static/static.jpg'), await sharp(base).jpeg({ quality: 90 }).toBuffer())
  }
  if (wanted('static/static.webp')) {
    await writeFile(join(fixturesRoot, 'static/static.webp'), await sharp(base).webp({ quality: 90 }).toBuffer())
  }
}

// ── animated/ 动图，以及「同一 MIME 一动一静」的那一对 ──────────────────
//
// 这一组是**唯一需要 ffmpeg 的**，所以整组一个前置判断：都在就直接返回，
// 连准备帧都不做。没有它的话，一个只缺 huge.png 的新克隆会因为「ffmpeg 不在 PATH 上」
// 在 global setup 里炸掉，而错误信息和它真正缺的东西毫无关系。

async function genAnimated(): Promise<void> {
  const shortTargets = [
    'animated/animated.gif',
    'animated/single-frame.gif',
    'animated/animated.webp',
    'animated/apng.png',
  ]
  const needShort = shortTargets.some(wanted)
  const needLong = wanted('animated/animated-long.gif')
  if (!needShort && !needLong) return

  if (needShort) await genAnimatedShort()
  if (needLong) await genAnimatedLong()
}

async function genAnimatedShort(): Promise<void> {
  const frames: string[] = []
  for (let i = 0; i < 4; i += 1) {
    const path = join(tmp, `mememio-fixture-f${i}.png`)
    await writeFile(path, await noisePng(240, 240, 7 + i * 1000))
    frames.push(path)
  }
  // `-framerate 1` 让每路输入各占 1 秒，配合 ffmpeg() 里的 `-vsync 0` 保住全部 4 帧。
  const inputs = frames.flatMap((f) => ['-framerate', '1', '-i', f])
  const concat = `${frames.map((_, i) => `[${i}]`).join('')}concat=n=${frames.length}:v=1:a=0`

  if (wanted('animated/animated.gif')) {
    await ffmpeg([
      ...inputs,
      '-filter_complex',
      `${concat},split[a][b];[a]palettegen[p];[b][p]paletteuse`,
      '-loop',
      '0',
      join(fixturesRoot, 'animated/animated.gif'),
    ])
  }

  // 「是 GIF 但只有一帧」——image-pipeline.md §2 要求它判成**静图**
  if (wanted('animated/single-frame.gif')) {
    await ffmpeg(['-i', frames[0]!, '-loop', '0', join(fixturesRoot, 'animated/single-frame.gif')])
  }

  // 和 static/static.webp 同一个 MIME，一动一静。凭 mime 推断 isAnimated 会在这两个上翻车。
  //
  // 走 muxAnimatedWebp（ffmpeg 走不通，见上面的说明）。帧仍然由 sharp 编码成单帧 WebP，
  // 容器手写。`lossless: true` 是必须的：有损 WebP 会输出 VP8 块而非 VP8L，
  // 两者都能进 ANMF，但无损帧在 fixture 里更稳（同参数必然同字节）。
  if (wanted('animated/animated.webp')) {
    const webpFrames = await Promise.all(
      frames.map((f) =>
        sharp(f).webp({ lossless: true }).toBuffer(),
      ),
    )
    await writeFile(
      join(fixturesRoot, 'animated/animated.webp'),
      muxAnimatedWebp(webpFrames, 240, 240, 200),
    )
  }

  // 扩展名和 MIME 都是 PNG，但它是动图
  if (wanted('animated/apng.png')) {
    await ffmpeg([
      ...inputs,
      '-filter_complex',
      concat,
      '-plays',
      '0',
      '-f',
      'apng',
      join(fixturesRoot, 'animated/apng.png'),
    ])
  }
}

/**
 * 12 帧。抽帧会把它采样到 MAX_FRAMES（10），于是降帧梯子排得出 **10 → 4 → 拼图** 三级。
 * animated.gif 只有 4 帧，梯子退化成两级，「先降帧再降通道」里最关键的第一级根本跑不到。
 * 帧的种子和短片那 4 帧错开，保证相邻帧的 dHash 距离远大于去重阈值——否则采样前就被合掉了。
 * 尺寸取 120 而不是 240：噪声图压不动，12 帧 240×240 在仓库里接近 1MB，而这个样本
 * 只需要「帧数够多且彼此不同」，画幅大小对降帧梯子没有任何影响。
 */
async function genAnimatedLong(): Promise<void> {
  const longFrames: string[] = []
  for (let i = 0; i < 12; i += 1) {
    const path = join(tmp, `mememio-fixture-l${i}.png`)
    await writeFile(path, await noisePng(120, 120, 90_001 + i * 1000))
    longFrames.push(path)
  }
  const longInputs = longFrames.flatMap((f) => ['-framerate', '1', '-i', f])
  const longConcat = `${longFrames.map((_, i) => `[${i}]`).join('')}concat=n=${longFrames.length}:v=1:a=0`
  await ffmpeg([
    ...longInputs,
    '-filter_complex',
    `${longConcat},split[a][b];[a]palettegen[p];[b][p]paletteuse`,
    '-loop',
    '0',
    join(fixturesRoot, 'animated/animated-long.gif'),
  ])
}

// ── edge/ 会出问题的那批（docs/fixtures.md §3） ─────────────────────────

async function genEdge(): Promise<void> {
  // 0 字节：连 magic bytes 都读不到
  if (wanted('edge/zero-byte.png')) {
    await writeFile(join(fixturesRoot, 'edge/zero-byte.png'), Buffer.alloc(0))
  }

  // 假扩展名：扩展名 .png、内容真是 GIF。magic bytes 必须赢过扩展名
  if (wanted('edge/fake-ext.png')) {
    await writeFile(
      join(fixturesRoot, 'edge/fake-ext.png'),
      await sharp(await noisePng(120, 120, 99)).gif().toBuffer(),
    )
  }

  // 截断：取前 40% 的合法 PNG。有完整文件头，没有完整像素数据——
  // 这正是「探测得出格式、解码时才失败」的那一类，也是最容易把 sharp 搞崩的一类
  if (wanted('edge/truncated.png')) {
    const truncatedSource = await noisePng(200, 200, 31)
    await writeFile(
      join(fixturesRoot, 'edge/truncated.png'),
      truncatedSource.subarray(0, Math.floor(truncatedSource.length * 0.4)),
    )
  }

  // 超大：**必须确实超过 `MAX_FILE_BYTES`（20MB）**，否则它测不到任何东西。
  // 用 compressionLevel 0（不压缩）+ 高频噪声，像素填成几乎不可压缩的字节。
  //
  // ⚠️ 这个文件**不进仓库**（docs/fixtures.md §2：23 MB、纯噪声、可复现）。所以它是
  //    新克隆里唯一一个必然缺的样本，也是 tests/global-setup.ts 自动生成这条路存在的
  //    全部理由。字节数必须正好 23_560_841 —— tests/helpers/fixtures.ts 的 HUGE_BYTES
  //    在断言它，改这里任何一个参数都会把那条断言打红。
  if (wanted('edge/huge.png')) {
    const bigSide = 2800
    const big = Buffer.alloc(bigSide * bigSide * 3)
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 2654435761) % 251
    await writeFile(
      join(fixturesRoot, 'edge/huge.png'),
      await sharp(big, { raw: { width: bigSide, height: bigSide, channels: 3 } })
        .png({ compressionLevel: 0 })
        .toBuffer(),
    )
  }
}

// ── dup/ 同一张图的多个变体（去重用例） ─────────────────────────────────

async function genDup(): Promise<void> {
  const targets = [
    'dup/exact-a.png',
    'dup/exact-b.png',
    'dup/near-jpeg.jpg',
    'dup/near-resized.png',
    'dup/different.png',
  ]
  if (!targets.some(wanted)) return

  const dupSource = await noisePng(240, 240, 4242)

  // ① 字节完全相同：SHA-256 精确重复
  if (wanted('dup/exact-a.png')) await writeFile(join(fixturesRoot, 'dup/exact-a.png'), dupSource)
  if (wanted('dup/exact-b.png')) await writeFile(join(fixturesRoot, 'dup/exact-b.png'), dupSource)

  // ② 字节不同、画面相同：JPEG 压过一遍，SHA-256 对不上但 pHash 距离很小
  if (wanted('dup/near-jpeg.jpg')) {
    await writeFile(join(fixturesRoot, 'dup/near-jpeg.jpg'), await sharp(dupSource).jpeg({ quality: 92 }).toBuffer())
  }

  // ③ 缩放过：pHash 同样应当命中
  if (wanted('dup/near-resized.png')) {
    await writeFile(join(fixturesRoot, 'dup/near-resized.png'), await sharp(dupSource).resize(160, 160).png().toBuffer())
  }

  // ④ 明显不同的另一张图：**必须不进待确认队列**。少了这个，
  //    「全部判成近似重复」这种退化实现也能让用例通过
  if (wanted('dup/different.png')) {
    await writeFile(join(fixturesRoot, 'dup/different.png'), await noisePng(240, 240, 777))
  }
}

/**
 * 生成入口。**测试的 global setup 用 `'missing'` 调它**，所以这个模块不能有顶层副作用——
 * 下面那个 isCli 判断就是为此存在的：`npm run fixtures` 跑它，被 import 时不跑。
 */
export async function generateFixtures(requested: FixtureMode): Promise<void> {
  mode = requested
  try {
    await main()
  } finally {
    mode = 'all'
  }
}

// 直接跑（npm run fixtures）才生成，被 import 时什么都不做
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await generateFixtures('all')
  console.log(`fixtures 已生成：${fixturesRoot}`)
}

