import { toAiPng, toPersonPng } from './decode.js'
import { extractFramePng, probeMetadata } from './probe.js'
import { withTempFile } from './temp-file.js'

/**
 * 「一张图 → 送模型的一张 PNG」，**动图取中间帧**。
 *
 * 这个文件存在的理由只有一条：**取法要只有一份**。已经有三个地方要「把一张动图
 * 变成一张有代表性的静图」——近似重复判定（`services/import.ts`）、人物向量
 * （`services/person-vectors.ts`）、以及将来任何按图算的模型调用。各处自己抽一帧的话，
 * 迟早出现「A 用的是首帧、B 用的是中间帧」，而两份向量/两次判定都会被拿去互相比，
 * **不报错**，只是结论悄悄不对。
 *
 * ## 为什么是中间帧
 *
 * 不是「最有代表性的一帧」——那要多帧比一遍，是更贵的另一件事。这里要的是
 * **两边取同一个位置**：近似重复判定比的是「新鲜的那张」和「库里已有的那张」，
 * 两张的内部分帧序列不一样，取同一规则才谈得上可比。表情包动图又常常首尾是
 * 铺垫/定格，取中间比取首帧更靠近「这张图在说什么」。
 *
 * ## 缩放口径由调用方给
 *
 * 取帧和缩放是两件事：帧的取法共用，**缩到多大不共用**。
 * 打标/去重要的是「只缩不放」的 512（image-pipeline.md §4），人物向量要的是
 * 「大图缩小、小图放大」的 768（SPEC §5.7.1）——两者的依据相反，
 * 合并不了，所以这里只把 `target` 传下去。
 *
 * ⚠️ 一律输出 PNG：动图不直接送给模型（image-pipeline.md），GIF 的首帧更是没有
 *    任何一家的接口认。
 */
export type RepresentativeTarget = 'ai' | 'person'

export async function representativePng(
  bytes: Buffer,
  label: string,
  isAnimated: boolean,
  target: RepresentativeTarget,
): Promise<Buffer> {
  const resize = target === 'person' ? toPersonPng : toAiPng
  if (!isAnimated) return resize(bytes)

  // ffmpeg 只认路径不认 Buffer，所以动图这一路要落一次临时文件
  const frame = await withTempFile(bytes, label, async (filePath) => {
    const metadata = await probeMetadata(filePath)
    // 帧号用解出来的 `frameCount` 算，不写死 0：`Math.floor((n - 1) / 2)`
    // 在 n = 1（静图被误判）时也退化成 0，不会越界
    return extractFramePng(filePath, Math.floor((metadata.frameCount - 1) / 2))
  })
  return resize(frame)
}
