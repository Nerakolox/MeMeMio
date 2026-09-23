import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * 抽帧的集成测试（SPEC §9.4、agents/rules/image-pipeline.md §3）。
 *
 * **必须跑真的 ffmpeg 和真的样本**：这里要证明的是「一次调用输出全部帧」与
 * 「每帧一个进程」**等价**，用测试自己捏的字节测等于把被测对象换成自己的实现。
 * 样本来自 `docs/fixtures/images/`（进仓库，见 docs/fixtures.md §2）。
 *
 * ⚠️ 下面这几行必须在任何 src/ 模块被 import 之前执行：`src/env.ts` 在模块顶层跑校验。
 *    所以本文件里的 src 模块全走动态 import，别改成顶层 import（同 search-paths.test.ts）。
 */
const { fixturePath, FIXTURES, MANY_FRAMES_EXPECTED } = await import('./helpers/fixtures.js')
const { extractAllFrames, extractFramePng, probeMetadata } = await import('../src/image/probe.js')
const { extractFrames } = await import('../src/image/frames.js')
const { MAX_RAW_FRAMES } = await import('../src/image/constants.js')
const sharp = (await import('sharp')).default

const run = promisify(execFile)
const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mememio-test-'))
  tempDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

/** 解码成裸像素再比。**不能比 PNG 字节**：ffmpeg 和 libvips 的编码器不同，字节必然不同。 */
function pixels(png: Buffer): Promise<Buffer> {
  return sharp(png, { failOn: 'none' }).raw().toBuffer()
}

/**
 * 逐帧抽取（旧实现）与一次抽取（新实现）**逐帧一致**。
 *
 * 这是本任务验收里那条「逐帧一致」的固化版本，也是**唯一**能挡住帧序错位的东西：
 * `-vsync 0` 漏了就丢帧、`-start_number` 漏了序号就整体偏移——两种都不报错，
 * 只是让偏后段的采样取到别的画面，标签悄悄变差。
 */
describe('一次抽帧与逐帧抽取等价', () => {
  const cases = ['animatedGif', 'animatedLongGif', 'animatedWebp', 'apng'] as const

  for (const name of cases) {
    it(`${name}：帧号连续，且每一帧的像素与 extractFramePng 相同`, async () => {
      const file = fixturePath(FIXTURES[name])
      const metadata = await probeMetadata(file)
      const frames = await extractAllFrames(file, await tempDir(), metadata.frameCount)

      // 帧号契约的一半：序号从 0 起、连续、不缺
      expect(frames.map((f) => f.index)).toEqual(
        Array.from({ length: metadata.frameCount }, (_, i) => i),
      )

      for (const frame of frames) {
        const fromBatch = await pixels(await readFile(frame.path))
        const fromPerFrame = await pixels(await extractFramePng(file, frame.index))
        expect(fromBatch.equals(fromPerFrame), `${name} 第 ${frame.index} 帧不一致`).toBe(true)
      }
    })
  }

  /**
   * 帧号契约的另一半：libvips 的 `page` 切法。
   *
   * ⚠️ **只对 GIF 和动态 WebP 成立，APNG 不行**（实测：libvips 读 APNG 时
   *    `metadata().pages` 是 `undefined`，`page: 1/2/3` 全部返回第 0 帧的内容）。
   *    APNG 因此**必须**留在 ffmpeg 那条路上——哪天有人看「动态 WebP 走 sharp」
   *    顺手把 APNG 也挪过去，模型拿到的会是同一张首帧的若干副本，
   *    而偏后段的采样恰恰是为了避开首帧，两者合起来就是「标签全错且不报错」。
   */
  it('GIF / 动态 WebP：帧序与 libvips 的 page 一致', async () => {
    for (const name of ['animatedGif', 'animatedLongGif', 'animatedWebp'] as const) {
      const file = fixturePath(FIXTURES[name])
      const metadata = await probeMetadata(file)
      const frames = await extractAllFrames(file, await tempDir(), metadata.frameCount)

      for (const frame of frames) {
        const fromBatch = await pixels(await readFile(frame.path))
        const fromLibvips = await sharp(file, { failOn: 'none', animated: true, page: frame.index, pages: 1 })
          .raw()
          .toBuffer()
        expect(fromBatch.equals(fromLibvips), `${name} 第 ${frame.index} 帧与 libvips 不一致`).toBe(
          true,
        )
      }
    }
  })
})

/**
 * 去重 + 采样的结果。用 240 帧那个样本：长静止段（8 帧一组）让去重结果**确定**，
 * 30 个状态又足够多，能把尾部偏置那套算法完整跑出来（`animatedLongGif` 只有 12 帧，
 * 采样和全发几乎看不出区别）。
 */
describe('去重与采样', () => {
  it('240 帧 → 30 个状态 → 10 帧，帧号逐个对得上', async () => {
    const file = fixturePath(FIXTURES.manyFramesGif)
    const metadata = await probeMetadata(file)
    expect(metadata.frameCount).toBe(MANY_FRAMES_EXPECTED.raw)

    const selection = await extractFrames(file, metadata)

    // 长静止段被合掉了：240 帧里只有 30 个不同画面
    expect(selection.rawFrameCount).toBe(MANY_FRAMES_EXPECTED.raw)
    expect(selection.distinctFrameCount).toBe(MANY_FRAMES_EXPECTED.distinct)
    // 只送 10 帧，且是偏后段挑出来的那 10 帧
    expect(selection.frames.map((f) => f.index)).toEqual([...MANY_FRAMES_EXPECTED.selected])
  })

  it('去重保留的是每个静止段的**第一帧**', async () => {
    const file = fixturePath(FIXTURES.manyFramesGif)
    const metadata = await probeMetadata(file)
    const selection = await extractFrames(file, metadata)

    // 首帧落在 40 而不是 41/42：扫描是顺序的，保留先出现的那个。
    // 反过来（保留最后一个）会让「第 0 帧是铺垫」这件事跨过整段静止——
    // 语义上就成了另一个算法，虽然帧数一模一样。
    expect(selection.frames[0]?.index).toBe(MANY_FRAMES_EXPECTED.selected[0])

    // 同一段里的其它帧像素完全相同，是「静止段」这件事本身的证据
    const same = await Promise.all([
      pixels(await extractFramePng(file, 40)),
      pixels(await extractFramePng(file, 47)),
    ])
    expect(same[0]!.equals(same[1]!)).toBe(true)
  })
})

/**
 * 原始帧数上限（`MAX_RAW_FRAMES`）。**卡在 `probeMetadata` 上**，不是在抽帧那一层：
 * 认帧数的调用方不止抽帧（导入靠它判 `is_animated`），只拦一处等于漏一处。
 */
describe('原始帧数上限', () => {
  it(`超过 ${MAX_RAW_FRAMES} 帧的文件按 FILE_TOO_LARGE 拒掉，并带上帧数`, async () => {
    const dir = await tempDir()
    const over = MAX_RAW_FRAMES + 1
    // 1×1 的帧：这条用例只关心帧数，画幅越小生成越快
    const onePixel = await sharp(fixturePath(FIXTURES.staticPng)).resize(1, 1).png().toBuffer()
    for (let i = 0; i < over; i += 1) {
      await writeFile(join(dir, `f${String(i).padStart(4, '0')}.png`), onePixel)
    }
    const gif = join(dir, 'over.gif')
    await run('ffmpeg', [
      '-y', '-loglevel', 'error', '-vsync', '0',
      '-framerate', '1', '-i', join(dir, 'f%04d.png'),
      '-filter_complex', 'split[a][b];[a]palettegen[p];[b][p]paletteuse',
      '-loop', '0', gif,
    ])

    await expect(probeMetadata(gif)).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
      details: { frameCount: over, maxFrames: MAX_RAW_FRAMES },
    })
  })
})
