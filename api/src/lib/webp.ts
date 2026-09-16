/**
 * WebP 容器解析。**纯函数、零 import**，喂一段 Buffer 就能判，不起 Postgres、不碰文件系统。
 *
 * ⚠️ **为什么需要这个文件：ffmpeg 读不出动态 WebP。**
 *
 * WebP 的解复用器只有 `webp_pipe`（图片序列）这一个，它**不认 ANIM / ANMF 块**：
 *
 *     [webp @ …] skipping unsupported chunk: ANIM
 *     [webp @ …] skipping unsupported chunk: ANMF
 *     Stream #0:0: Video: webp, 25 fps        ← 读成 25fps 的静图流
 *
 * 结果是 ffprobe 报 `width=0 nb_frames=N/A`，抽帧写出 0 字节。
 * **ffmpeg 5.1（Debian bookworm，部署镜像）和 8.1（开发机）行为一致**，
 * 不是版本问题。同一个文件用 sharp/libvips 读是好的（`pages: 4`），
 * 所以问题在 ffmpeg 这一侧，而我们不能换掉 ffmpeg——GIF 和 APNG 的抽帧还靠它。
 *
 * 这段解析器只做一件事：**把帧数和画布尺寸从容器里读出来**，不解像素。
 * 抽帧由 sharp 走 `decode.ts` 那条路。
 *
 * 判定「是不是动图」不能从 mime 推断——WebP 和 APNG 都可能是动图也可能静图，
 * 这个字段是前端复制/下载分流的唯一依据，错了的表现是「点了复制没反应」。
 * 见 SPEC §5.2.2 / agents/rules/image-pipeline.md §2。
 */

/**
 * VP8X 的容器标志位（WebP 容器规范 §2.3.1）。只有 `animation` 是我们关心的：
 * 没有 VP8X 块就一定是简单格式（纯 VP8/VP8L），也就是静图。
 */
const VP8X_ANIMATION_FLAG = 0x02

/** VP8X 载荷的固定布局：1 字节标志 + 3 字节保留 + 3 字节宽 + 3 字节高。 */
const VP8X_PAYLOAD_BYTES = 10

export type WebpInfo = {
  /** 画布宽高。取自 VP8X；没有 VP8X 时是 null（静图，尺寸让 sharp 读）。 */
  width: number | null
  height: number | null
  /**
   * ANMF 块个数，也就是帧数。
   *
   * VP8X 的 ANIM 标志说「这是动图」，ANMF 个数说「有几帧」，两者都要看：
   * 一个只有 ANIM 没有 ANMF 的文件是坏的，按静图处理比按动图处理安全。
   * 静图为 1（单帧 WebP 就是一个 VP8/VP8L 块，没有 ANMF）。
   */
  frameCount: number
  /** 容器声明是动图。`frameCount > 1` 才是真正的判据，这个字段只用于日志与排查。 */
  declaresAnimation: boolean
}

/**
 * 读 RIFF 块结构。
 *
 * 块的排布是 `FourCC(4) + 长度(4, 小端) + 载荷 + 补齐`；载荷长度为奇数时**多一个补齐字节**
 * （WebP 容器规范 §2），漏掉这一步会让后续所有块的偏移错一位，然后读到一堆垃圾——
 * 且不报错，只是帧数变成随机数。所以 `+ (size & 1)` 不能省。
 */
function walkChunks(bytes: Uint8Array): { fourCC: string; payload: Uint8Array }[] {
  const chunks: { fourCC: string; payload: Uint8Array }[] = []
  // offset 12 = 'RIFF'(4) + 长度(4) + 'WEBP'(4)，第一个块从这里开始
  let offset = 12

  while (offset + 8 <= bytes.length) {
    const fourCC = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    )
    const size =
      (bytes[offset + 4]! |
        (bytes[offset + 5]! << 8) |
        (bytes[offset + 6]! << 16) |
        (bytes[offset + 7]! << 24)) >>>
      0

    const start = offset + 8
    const end = start + size
    // 声明长度超出实际字节：文件被截断。已经读到的块仍然有效，就此打住
    if (end > bytes.length) {
      chunks.push({ fourCC, payload: bytes.subarray(start, bytes.length) })
      break
    }
    chunks.push({ fourCC, payload: bytes.subarray(start, end) })
    const next = end + (size & 1)
    // 长度字段是 32 位无符号，而 `+ 1` 可能把 end 推到 2^32 —— 那种值过得了上面
    // 的边界检查（因为比较的是 number 不是 uint32），然后 offset 会绕回一个很小的值，
    // 循环重来。文件大小本来就有上限（MAX_FILE_BYTES），但这段代码跑在用户上传的字节上，
    // 一行防御比一个死循环便宜。
    if (next <= offset) break
    offset = next
  }

  return chunks
}

/** 3 字节小端整数。VP8X / ANMF 里的宽高都这么存。 */
function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

/**
 * 解析 WebP 容器。
 *
 * **不解像素。** 只读 VP8X 和 ANMF 的头部，对 20MB 的文件也是一次线性扫描。
 *
 * 返回 `null` 表示这**不是**一个 WebP（调用方已经用 magic bytes 判过，走到这里说明文件被截断到
 * 连 RIFF 头都不完整）。调用方应当回退到「按静图处理」而不是报错——
 * 一个截断到只剩几字节的文件，报「损坏」比报「不是 WebP」更接近事实。
 */
export function parseWebp(bytes: Uint8Array): WebpInfo | null {
  // 'RIFF' + 4 字节长度 + 'WEBP'：至少 12 字节才谈得上解析
  if (bytes.length < 12) return null
  if (
    bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50
  ) {
    return null
  }

  const chunks = walkChunks(bytes)

  let width: number | null = null
  let height: number | null = null
  let declaresAnimation = false
  let frameCount = 0

  for (const { fourCC, payload } of chunks) {
    if (fourCC === 'VP8X') {
      if (payload.length < VP8X_PAYLOAD_BYTES) continue
      declaresAnimation = (payload[0]! & VP8X_ANIMATION_FLAG) !== 0
      // VP8X 里存的是「宽减一」「高减一」（容器规范 §2.3.1）
      width = readUInt24LE(payload, 4) + 1
      height = readUInt24LE(payload, 7) + 1
      continue
    }
    if (fourCC === 'ANMF') frameCount += 1
  }

  // 没有 ANMF 就是静图，哪怕 VP8X 的 ANIM 位被置了（畸形容器，按静图处理更安全）
  if (frameCount === 0) frameCount = 1

  return { width, height, frameCount, declaresAnimation }
}
