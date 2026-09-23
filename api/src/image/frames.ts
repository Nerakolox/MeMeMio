import { readFile } from 'node:fs/promises'
import { COLLAGE_FRAMES, FRAME_DEDUP_DISTANCE, MAX_FRAMES } from './constants.js'
import { computeFramePhash } from './decode.js'
import { extractAllFrames, type VideoMetadata } from './probe.js'
import { withTempDir } from './temp-file.js'
import { hammingDistance } from '../lib/phash.js'
import { log } from '../logger.js'

/**
 * 动图分帧。SPEC §9.4 / image-pipeline.md §3。
 *
 * ⚠️ **这里的 pHash 是帧间去重，和入库去重是两回事。** 作用对象不同
 * （同一个文件的帧集合 vs 跨文件），阈值也不同。**不要复用同一个阈值，
 * 也不要共用同一个函数名**——这就是 `computeFramePhash` 和 `computePhash`
 * 分开命名的原因。
 */

/**
 * 一张要送 AI 的帧。`index` 是**原始帧号**。
 *
 * 它不只是给日志看的：偏后段的采样、去重都按它定位，动态 WebP 那边还要拿它当
 * libvips 的 `page`。帧号错位不会报错，只会让标签悄悄变差（见 `pickFrames`）。
 */
export type ExtractedFrame = { index: number; png: Buffer }

export type FrameSelection = {
  frames: ExtractedFrame[]
  /** 去重后的不同状态数。用于日志，也是「采样是常态」那条结论的观测点。 */
  distinctFrameCount: number
  /** **实际解出来的**原始帧数。可能与容器声明的 `metadata.frameCount` 不等，见下面的警告。 */
  rawFrameCount: number
}

/**
 * 抽帧并选帧。
 *
 * 两道处理，顺序不能换：
 *
 * 1. **去重**（`FRAME_DEDUP_DISTANCE`）——去掉长静止段的重复帧。不去重直接采样，
 *    抽中的很可能全是同一张静止画面。
 * 2. **采样**（`MAX_FRAMES`）——去重后 ≤ 10 帧全发；> 10 帧才采样，**偏向后段**。
 *
 * 为什么偏向后段：表情包动图的第一帧通常是铺垫，人物还没做表情，**文字往往要到
 * 后面几帧才出现**。用首帧打标等于丢掉全部关键信息——这是抽帧方案存在的全部理由，
 * 改选帧策略前先想清楚这一条。
 *
 * 实测参考（989 张真实库）：去重后状态数中位数 9、均值 15.3、最大 81，
 * 只有 55% 的动图 ≤10 帧。**所以采样是常态，不是例外**，这条路径和「全发」同等重要。
 *
 * **帧是一次 ffmpeg 调用抽完的**（`probe.ts` 的 `extractAllFrames`），落在临时目录里。
 * 原来每帧起一个进程（`select=eq(n,i)` 要从头解到第 i 帧，总解码量是帧数的平方），
 * 120 帧的 GIF 就要 8.6 秒，几百帧的直接把打标任务拖超时、重试五次落成 `needs_manual`。
 */
export async function extractFrames(
  filePath: string,
  metadata: VideoMetadata,
): Promise<FrameSelection> {
  return withTempDir('frames', async (dir) => {
    const decoded = await extractAllFrames(filePath, dir, metadata.frameCount)

    if (decoded.length !== metadata.frameCount) {
      // 容器声明的帧数与真的解出来的帧数**可以不一致**（有的容器是估的）。
      // 以解出来的为准，不按声明去补齐：去重和采样走的都是这份实际帧列表，
      // 少几帧不影响结果，凭空多出几帧才是问题。只记一条，不报错。
      log.warn(
        { declared: metadata.frameCount, decoded: decoded.length, filePath },
        '实际解出的帧数与容器声明不一致',
      )
    }

    // 去重是**顺序**扫描，每个静止段保留的是它的第一帧——与「全部抽出来再顺序比对」
    // 的结果完全一样（验收里「逐帧一致」比的就是这个顺序）。
    //
    // 只留帧号不留字节：去重后的帧可能上百张（实测最大 81），而真正要用的最多
    // `MAX_FRAMES` 张。全留在内存里是几百 MB 的 PNG 缓冲，白占着。
    const distinct: { index: number; path: string; hash: bigint }[] = []
    for (const frame of decoded) {
      const hash = await computeFramePhash(await readFile(frame.path))
      // 线性比对：帧数上限由 MAX_RAW_FRAMES 兜住（image/constants.ts），不值得为它上索引
      const seen = distinct.some((kept) => hammingDistance(kept.hash, hash) <= FRAME_DEDUP_DISTANCE)
      if (!seen) distinct.push({ ...frame, hash })
    }

    const frames: ExtractedFrame[] = []
    for (const frame of pickFrames(distinct)) {
      frames.push({ index: frame.index, png: await readFile(frame.path) })
    }

    return { frames, distinctFrameCount: distinct.length, rawFrameCount: decoded.length }
  })
}

/**
 * 从去重后的帧里挑最多 `MAX_FRAMES` 张。**偏向后段。**
 *
 * 后段偏置的做法是「尾部占 2/3、头部均匀取够剩下的」而不是简单等距：
 * 等距在 81 帧这种长尾上仍然会把最关键的结尾几帧漏掉（长尾比预期厚得多，
 * 分镜式、多段文字的长动图是常见形态）。具体权重见下面注释，改之前先看 §3。
 */
function pickFrames<T>(distinct: T[]): T[] {
  const n = distinct.length
  if (n <= MAX_FRAMES) return distinct

  const tailCount = Math.ceil((MAX_FRAMES * 2) / 3)
  const headCount = MAX_FRAMES - tailCount // 4
  const headEnd = n - tailCount

  const picked: T[] = []
  if (headCount > 0) {
    for (let i = 0; i < headCount; i += 1) {
      // 头部等距铺开，不取第 0 帧——它是铺垫帧，单独占一个名额不值
      const at = Math.floor(((i + 1) * headEnd) / (headCount + 1))
      picked.push(distinct[at]!)
    }
  }
  for (let i = tailCount; i >= 1; i -= 1) picked.push(distinct[n - i]!)

  return picked
}

/**
 * 兜底拼图的取帧：固定 2×2 的 4 帧，**不跟着 `MAX_FRAMES` 涨**。
 *
 * 拼图受限于分辨率而不是数量——多数模型对单图有 token 上限，拼四格等于每帧只剩
 * 四分之一的分辨率预算，表情包里的小字会糊掉。3×3 只会更糊。
 * 两条路径帧数不同是有意的，**不要"顺手统一"**。
 *
 * 只在供应商 `vision_multi_image` 为 false 时走这条（image-pipeline.md §3）。
 * 取末尾 4 帧：拼图是兼容性兜底，这时更该保住「文字出现之后」的画面。
 * 调用方负责把它们拼成网格并保证发出去的是**一张**图。
 */
export function pickCollageFrames<T>(frames: T[]): T[] {
  return frames.slice(-COLLAGE_FRAMES)
}

/**
 * 判断是不是动图。**帧数决定，不看 mime。**
 *
 * WebP 和 APNG 都可能是动图也可能是静图，mime 里看不出来。而且
 * 「是 GIF 但只有一帧」要判为静图——实测 252 个 GIF 里有 13 个只有一帧。
 * 这个字段是前端复制/下载分流的唯一依据，错了的表现是「点了复制没反应」。
 */
export function isAnimatedByFrames(metadata: VideoMetadata): boolean {
  return metadata.frameCount > 1
}
