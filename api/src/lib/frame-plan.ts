/**
 * 送 AI 的图片怎么发、发不下去怎么降。**纯函数、零 import**。
 *
 * 这个文件回答的是 ai-providers.md §4 里最容易做错的一条：
 * **图片数超限先降帧，不降通道。**
 *
 * 为什么不能降通道：`vision_multi_image` 只是个布尔值，**探测不出供应商的单请求
 * 图片数上限**（image-pipeline.md §3），撞上了只会在运行时报错。换个供应商同样
 * 可能超限，而且白花另一条通道的钱。
 */

/** 拼图固定 2×2 的 4 帧，**不跟着 MAX_FRAMES 涨**（image-pipeline.md §3）。 */
export const COLLAGE_FRAME_COUNT = 4

/**
 * 一次尝试怎么发图。
 *
 *   single  —— 一张 PNG（静图，或去重后只剩一帧的动图）
 *   frames  —— 独立多帧，`count` 张
 *   collage —— 末尾 4 帧拼成**一张** 2×2 图
 */
export type VisionAttempt =
  | { mode: 'single' }
  | { mode: 'frames'; count: number }
  | { mode: 'collage' }

/**
 * 排出这张图的尝试序列。**全部在同一个通道内**，列表走完还不行才算这个通道失败。
 *
 * 动图且供应商实测支持多图时是 `10 帧 → 4 帧 → 拼图` 三级；
 * **没有探测记录时（`multiImage === null`）直接走拼图**——没有测试连接记录时按最保守
 * 路径走（ai-providers.md §2），不许因为「这是我们自己配的默认通道」就假设它支持多图。
 *
 * @param frameCount 去重采样之后真正要发的帧数（≤ MAX_FRAMES）
 */
export function planVisionAttempts(
  isAnimated: boolean,
  frameCount: number,
  multiImage: boolean | null,
): VisionAttempt[] {
  // 静图，以及去重后只剩一帧的动图（实测 252 个 GIF 里有 13 个只有一帧）
  if (!isAnimated || frameCount <= 1) return [{ mode: 'single' }]

  if (multiImage !== true) return [{ mode: 'collage' }]

  const attempts: VisionAttempt[] = [{ mode: 'frames', count: frameCount }]
  // 已经不超过 4 帧就没有「降到 4 帧」这一级可降，直接进拼图
  if (frameCount > COLLAGE_FRAME_COUNT) {
    attempts.push({ mode: 'frames', count: COLLAGE_FRAME_COUNT })
  }
  attempts.push({ mode: 'collage' })
  return attempts
}

/**
 * 降帧时保留哪几帧：**取末尾**。
 *
 * 和 `image/frames.ts` 的 `pickCollageFrames` 同一个道理——表情包动图的文字往往要到
 * 后面几帧才出现，降帧时保住「文字出现之后」的画面比保住铺垫帧重要。
 */
export function takeTailFrames<T>(frames: T[], count: number): T[] {
  return count >= frames.length ? frames : frames.slice(-count)
}
