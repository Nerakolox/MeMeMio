import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

/**
 * `docs/fixtures/images/` 里的样本。**跑一次真管线**，不用测试自己捏的字节——
 * 捏出来的「GIF」常常连 ffprobe 都读不出帧数，那样的用例测的是编造物而不是契约。
 *
 * 生成脚本是 `scripts/gen-fixtures.ts`，样本的用途见 `docs/fixtures/README.md`。
 */
const root = fileURLToPath(new URL('../../../docs/fixtures/images/', import.meta.url))

export function fixturePath(name: string): string {
  return `${root}${name}`
}

export function loadFixture(name: string): Promise<Buffer> {
  return readFile(fixturePath(name))
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 各样本在管线里的预期结论。**集中放在这里而不是散在用例里**：
 * 阈值（`NEAR_DUP_DISTANCE = 8`）是「有依据的起点，尚未校准」（SPEC §9.16），
 * 一旦它被调过，改哪几个数字是明确的，而不是去猜每个用例为什么断言 7。
 */
export const FIXTURES = {
  /** 与 `exactA` **字节完全相同**：SHA-256 一致，走 exact_dup。 */
  exactB: 'dup/exact-b.png',
  exactA: 'dup/exact-a.png',
  /** 与 `exactA` 的 Hamming 距离实测 13，超过阈值 → 是两张不同的图。 */
  different: 'dup/different.png',
  /** 与 `nearResized` 的距离实测 7，低于阈值 8 → 近似重复。 */
  nearJpeg: 'dup/near-jpeg.jpg',
  nearResized: 'dup/near-resized.png',

  staticPng: 'static/static.png',
  staticJpg: 'static/static.jpg',
  staticWebp: 'static/static.webp',

  animatedGif: 'animated/animated.gif',
  /**
   * 12 帧，抽帧后采样到 `MAX_FRAMES`（10）。**降帧梯子（10 → 4 → 拼图）唯一能跑的样本**：
   * `animatedGif` 只有 4 帧，`planVisionAttempts` 排不出 10 帧那一级。
   */
  animatedLongGif: 'animated/animated-long.gif',
  /** 手写容器拼的：ffmpeg 读不出 ANIM/ANMF，只有 `lib/webp.ts` 认。见 image-pipeline.md §2。 */
  animatedWebp: 'animated/animated.webp',
  apng: 'animated/apng.png',
  /** 是 GIF 但只有一帧，**必须判成静图**——「按扩展名分流」会在这里出错。 */
  singleFrameGif: 'animated/single-frame.gif',

  /** 扩展名是 .png，内容其实不是。magic bytes 要能识破。 */
  fakeExt: 'edge/fake-ext.png',
  /** 0 字节，连文件头都不够。 */
  zeroByte: 'edge/zero-byte.png',
  /** PNG 头完好、数据被截断。前两关（大小、magic bytes）过得去，卡在解码。 */
  truncated: 'edge/truncated.png',
  /** 23,560,841 字节，超过 `MAX_FILE_BYTES`（20MiB）。 */
  huge: 'edge/huge.png',
} as const

export const HUGE_BYTES = 23_560_841
