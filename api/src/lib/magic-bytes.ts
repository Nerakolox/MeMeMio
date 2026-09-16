/**
 * 由文件头判断真实格式。**不信扩展名，也不信客户端报的 mime。**
 *
 * 用户会上传 `xxx.png` 实际是 GIF 的文件——不是恶意，是微信「另存为」的常态。
 * 扩展名只用来猜格式的话，一个被改名成 .png 的 GIF 会以 `image/png` 入库，
 * 前端照着 `is_animated` 分流的行为就全错了。见 agents/rules/image-pipeline.md §2。
 *
 * 纯函数、零 import：喂一段 Buffer 就能判，不起 Postgres、不碰文件系统。
 */

export type ImageFormat = 'png' | 'gif' | 'jpeg' | 'webp' | 'avif' | 'heic' | 'bmp' | 'tiff'

/** 判定结果。`null` 表示不是我们认识的图片格式。 */
export type DetectedFormat = {
  format: ImageFormat
  /** 入 `memes.mime` 的值。由真实格式决定，不是上传时附带的值。 */
  mime: string
}

/**
 * 容器嗅探所需的字节数。WebP 的 `WEBP` 标记在 offset 8，AVIF 的 `ftyp` 品牌在 offset 8..12，
 * 所以 32 字节足够判定所有支持格式，也避免为了判定把整个文件读进内存。
 */
export const SNIFF_BYTES = 32

const FORMAT_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, i) => bytes[offset + i] === byte)
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  return startsWith(
    bytes,
    [...text].map((ch) => ch.charCodeAt(0)),
    offset,
  )
}

/**
 * 从文件头识别格式。
 *
 * ⚠️ 判定顺序有讲究：ISO-BMFF 家族（HEIC / AVIF / MP4）共用 `ftyp` 盒子，
 * 只能靠 major brand 和 compatible brands 区分，所以先判前缀再看 brand。
 */
export function detectFormat(bytes: Uint8Array): DetectedFormat | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A —— 那个 \r\n\x1a\n 是为了探测传输损坏，必须全比
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { format: 'png', mime: FORMAT_MIME.png }
  }

  // GIF87a / GIF89a
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) {
    return { format: 'gif', mime: FORMAT_MIME.gif }
  }

  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { format: 'jpeg', mime: FORMAT_MIME.jpeg }
  }

  // WebP: 'RIFF' + 4 字节长度 + 'WEBP'
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) {
    return { format: 'webp', mime: FORMAT_MIME.webp }
  }

  // ISO-BMFF: 4 字节长度 + 'ftyp'
  if (asciiAt(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(...bytes.slice(8, 12))
    if (brand === 'avif' || brand === 'avis') return { format: 'avif', mime: FORMAT_MIME.avif }
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'mif1') {
      return { format: 'heic', mime: FORMAT_MIME.heic }
    }
    // 其余 ftyp 品牌（mp4 等）不是图片，交给下面的 null 分支
  }

  // BMP: 'BM'
  if (asciiAt(bytes, 0, 'BM')) return { format: 'bmp', mime: FORMAT_MIME.bmp }

  // TIFF: little-endian (II*\0) 或 big-endian (MM\0*)
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { format: 'tiff', mime: FORMAT_MIME.tiff }
  }

  return null
}

/**
 * 我们从容器直接支持的格式。**AVIF / HEIC / BMP / TIFF 判得出但不是可入库格式** ——
 * 前端能上传什么、服务端接受什么由这里决定，避免「判出来了但管线处理不了」。
 *
 * 判出来但不在支持列表里，报 `UNSUPPORTED_FORMAT` 而不是静默失败（image-pipeline.md §7）。
 */
export const INGESTIBLE_FORMATS: readonly ImageFormat[] = ['png', 'gif', 'jpeg', 'webp']

export function isIngestible(format: ImageFormat): boolean {
  return INGESTIBLE_FORMATS.includes(format)
}
