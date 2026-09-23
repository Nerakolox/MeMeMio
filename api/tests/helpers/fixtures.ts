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
  /**
   * 240 帧，其中只有 30 个不同画面（每个画面连着重复 8 次）。抽帧那条路的**量级样本**：
   * 旧的「每帧一个进程」在这个样本上要 12.7 秒（`select=eq(n,i)` 要从头解到第 i 帧，
   * 总解码量是帧数的平方），几百帧的 GIF 正是「导入卡住 / 打标超时」的来源。
   * 连着的重复帧同时是**长静止段**——去重存在的理由。预期结论见 `MANY_FRAMES_EXPECTED`。
   */
  manyFramesGif: 'animated/animated-many-frames.gif',
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

/**
 * `manyFramesGif` 在抽帧管线里的**预期结论**（`tests/frame-extraction.test.ts`）。
 *
 * `selected` 是 `pickFrames` 的尾部偏置算法作用在 30 个状态上的结果：头部 3 帧
 * （等距铺开、不取第 0 个）+ 尾部 7 帧。**写成具体的帧号而不是「10 帧左右」**，
 * 因为这条路的错法全是静默的：个数对不上是少送/多送，帧号错位是取错画面
 * （选帧策略的全部意义就是取到「文字出现之后」那几帧），两者都不会报错。
 *
 * ⚠️ 帧号是**原始帧号**，不是去重后的序号：30 个状态里第 k 个出现在原始帧 `8k`，
 *    所以去重列表的第 5 个状态对应原始帧 40。
 */
export const MANY_FRAMES_EXPECTED = {
  raw: 240,
  distinct: 30,
  selected: [40, 88, 136, 184, 192, 200, 208, 216, 224, 232],
} as const
