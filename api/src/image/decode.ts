import sharp from 'sharp'
import { AI_LONG_EDGE, MAX_INPUT_PIXELS, THUMB_LONG_EDGE } from './constants.js'
import { HASH_HEIGHT, HASH_WIDTH, dHashFromGray } from '../lib/phash.js'
import { AppError } from '../lib/app-error.js'
import { log } from '../logger.js'

/**
 * sharp 相关的解码与变换。
 *
 * 和 `probe.ts` 的分工：**容器层的事问 ffmpeg（帧数、抽帧），像素层的事问 sharp（缩放、哈希）**。
 * 两者都会遇到损坏文件，转成的错误码也一致。
 */

/**
 * 本文件**所有** sharp 解码共用的入参。新建解码路径时用它，不要另写一份：
 * 单个调用点漏掉 `limitInputPixels` 的表现是那张图能把进程解到 OOM，**不报错**。
 *
 * ⚠️ `limitInputPixels` **必须显式给**。sharp 的默认值是 16383² ≈ 2.68 亿像素、
 *    全解码约 1 GB，而 `MAX_FILE_BYTES` 管不到它——20MB 是压缩后的字节数，PNG/WebP
 *    的压缩比可以到几百倍。取值依据见 `image/constants.ts` 的 `MAX_INPUT_PIXELS`；
 *    超限时 sharp 报 `Input image exceeds pixel limit`，`asImageError` 转成 FILE_TOO_LARGE。
 *
 * `failOn: 'none'` 是原有口径：损坏的文件不在这里抛，交给下面的分类报具体原因
 * （「文件损坏」和「格式不支持」对用户是两条信息，image-pipeline.md §7）。
 */
const SHARP_INPUT_OPTS = { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS } as const

/**
 * 把 sharp 的失败转成具体错误。
 *
 * ⚠️ **不要只报「图片处理失败」**（image-pipeline.md §7）。用户面对一千张图的导入结果，
 * 「失败 37 张」和「37 张因为文件损坏」是完全不同的信息量。
 */
function asImageError(error: unknown, what: string): AppError {
  const message = error instanceof Error ? error.message : String(error)
  log.warn({ err: error, what }, 'sharp 处理失败')

  // sharp 把「不是图片」「图太大」「不支持的编解码器」混在同一个 throw 里，
  // 只能按 message 分类。分不出来的归到「损坏」，因为那是更常见的原因
  if (/Input image exceeds pixel limit|too large/i.test(message)) {
    return new AppError('FILE_TOO_LARGE', `${what}：图片像素数超出处理上限`)
  }
  if (/unsupported image format|colourspace|codec/i.test(message)) {
    return new AppError('UNSUPPORTED_FORMAT', `${what}：图片格式不受支持`)
  }
  return new AppError('UNSUPPORTED_FORMAT', `${what}：文件损坏`)
}

/** 图像尺寸。宽高要入库，前端布局依赖它。 */
export type ImageSize = { width: number; height: number }

export async function readSize(bytes: Buffer): Promise<ImageSize> {
  try {
    const meta = await sharp(bytes, SHARP_INPUT_OPTS).metadata()
    if (meta.width === undefined || meta.height === undefined) {
      throw new AppError('UNSUPPORTED_FORMAT', '读不到图片尺寸，文件可能已损坏')
    }
    return { width: meta.width, height: meta.height }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw asImageError(error, '读取尺寸')
  }
}

/**
 * 算整图 pHash（入库去重那一份）。
 *
 * 缩到 9×8 灰度后比相邻像素——尺寸和压缩格式的差异都被缩放抹平，
 * 「同一张图存了两遍、一次 PNG 一次 JPEG」也能对上。
 */
export async function computePhash(bytes: Buffer): Promise<bigint> {
  try {
    const gray = await sharp(bytes, SHARP_INPUT_OPTS)
      .greyscale()
      .resize(HASH_WIDTH, HASH_HEIGHT, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer()
    return dHashFromGray(new Uint8Array(gray))
  } catch (error) {
    if (error instanceof AppError) throw error
    throw asImageError(error, '计算感知哈希')
  }
}

/**
 * 算**帧**的 pHash，只用于动图内部去重。
 *
 * ⚠️ **和 `computePhash` 是两个东西，不要合并。** 帧间去重作用于同一个文件的帧集合，
 * 入库去重作用于跨文件，两者的阈值和误判代价都不同（image-pipeline.md §3）。
 * 两者共用 `dHashFromGray` 这个纯函数是合理的——那是算法，不是策略。
 */
export async function computeFramePhash(framePng: Buffer): Promise<bigint> {
  try {
    const gray = await sharp(framePng, SHARP_INPUT_OPTS)
      .greyscale()
      .resize(HASH_WIDTH, HASH_HEIGHT, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer()
    return dHashFromGray(new Uint8Array(gray))
  } catch (error) {
    throw asImageError(error, '计算帧哈希')
  }
}

/**
 * 从**动态 WebP** 里切出一帧，输出 PNG 字节。
 *
 * ⚠️ **这条路是 sharp 独有的，ffmpeg 走不了。** WebP 解复用器只有 `webp_pipe`，
 * 它跳过 ANIM / ANMF 块，抽帧产出 0 字节（ffmpeg 5.1 与 8.1 一致，
 * 详细根因见 `lib/webp.ts` 的文件头）。libvips 认得，所以这一路归 sharp。
 *
 * **帧序与 ffmpeg 的文件序号一致**：libvips 把动图竖排堆叠
 * （240×240 的 4 帧读出来是 240×960），`page: index` 就是第 index 帧；
 * ffmpeg 那一支靠 `-vsync 0` + `-start_number 0` 让写出的文件序号等于帧号
 * （`probe.ts` 的 `extractAllFrames`）。
 * 两者对上很关键——`extractAllFrames` 对 ffmpeg 和 sharp 两条路都用同一个 index 语义，
 * 错位了会静默丢掉「文字出现之后」的那几帧，而那正是选帧策略存在的理由。
 */
export async function extractWebpFramePng(filePath: string, index: number): Promise<Buffer> {
  try {
    return await sharp(filePath, { ...SHARP_INPUT_OPTS, animated: true, page: index, pages: 1 })
      .png()
      .toBuffer()
  } catch (error) {
    throw asImageError(error, `抽取第 ${index} 帧`)
  }
}

/**
 * 静图归一化：长边缩到 512 的 PNG。**只缩不放。**
 *
 * 实测真实库里 13% 的图长边不足 256、最小只有 50px。放大不会凭空生出信息，
 * 只会让模型把插值糊出来的笔画猜成文字。这类小图的正确行为是「看不清就别标」。
 * 见 image-pipeline.md §4。
 *
 * **不裁剪、不增强、不去水印** —— 那些会改变模型看到的内容，而我们无法验证改得对不对。
 */
export async function toAiPng(bytes: Buffer): Promise<Buffer> {
  try {
    return await sharp(bytes, SHARP_INPUT_OPTS)
      .resize({ width: AI_LONG_EDGE, height: AI_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
  } catch (error) {
    throw asImageError(error, '生成 PNG')
  }
}

/**
 * 把若干帧拼成**一张**网格图，给不支持多图的供应商兜底（image-pipeline.md §3）。
 *
 * 输出整体长边仍是 `AI_LONG_EDGE`，所以四格时每帧只剩 256 —— 这正是拼图固定 2×2、
 * **不跟着 `MAX_FRAMES` 涨**的原因：再密下去表情包里的小字就糊没了。
 *
 * 格子数按传进来的帧数定（2 帧就是 1×2），不拿空白格凑满 2×2：空白格白占分辨率预算，
 * 还会让模型去描述那块空白。**帧的先后就是从左上到右下**，调用方的提示词依赖这个顺序。
 *
 * 透明底压成白色：表情包大量是带 alpha 的 PNG，不压的话 sharp 合成出来是黑底，
 * 黑底白字的表情包会整个消失——**这不会报错，只会让那张图标出一片空白**。
 */
export async function composeCollage(pngs: Buffer[]): Promise<Buffer> {
  if (pngs.length === 0) throw new AppError('UNSUPPORTED_FORMAT', '拼图：没有可用的帧')
  if (pngs.length === 1) return toAiPng(pngs[0]!)

  const columns = Math.min(pngs.length, 2)
  const rows = Math.ceil(pngs.length / columns)
  const cell = Math.floor(AI_LONG_EDGE / Math.max(columns, rows))

  try {
    // 每帧先按 contain 缩进格子并补白，保证每格尺寸一致，composite 的落点才算得准
    const cells = await Promise.all(
      pngs.map((png) =>
        sharp(png, SHARP_INPUT_OPTS)
          .resize(cell, cell, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          })
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .png()
          .toBuffer(),
      ),
    )

    return await sharp({
      create: {
        width: cell * columns,
        height: cell * rows,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(
        cells.map((input, i) => ({
          input,
          left: (i % columns) * cell,
          top: Math.floor(i / columns) * cell,
        })),
      )
      .png()
      .toBuffer()
  } catch (error) {
    if (error instanceof AppError) throw error
    throw asImageError(error, '拼接帧网格')
  }
}

/**
 * 缩略图：长边 400 的 WebP。给列表页用，原图在几十张一屏时会把流量打爆。
 *
 * 用 WebP 而不是 PNG：缩略图是纯显示用途，不进 AI，没有「必须无损」的理由，
 * 体积差好几倍。**和送 AI 的那一路是两件事**，不要因为 §4 说「PNG」就把这里也改成 PNG。
 */
export async function toThumbnail(bytes: Buffer): Promise<Buffer> {
  try {
    return await sharp(bytes, SHARP_INPUT_OPTS)
      .resize({
        width: THUMB_LONG_EDGE,
        height: THUMB_LONG_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer()
  } catch (error) {
    throw asImageError(error, '生成缩略图')
  }
}
