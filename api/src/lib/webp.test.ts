import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseWebp } from './webp.js'

/**
 * 这些用例**读真的 fixture**，不手搓字节。
 *
 * 手搓的容器只能证明「解析器同意我手搓的那份」，证明不了它认得出真实的 WebP——
 * 而这段解析器存在的全部理由就是 ffmpeg 认不出真实的动态 WebP。
 * 容器的边角（补齐字节、块顺序、VP8X 的位置）只有真文件里才有。
 */

const fixture = (name: string): Promise<Buffer> =>
  readFile(fileURLToPath(new URL(`../../../docs/fixtures/images/${name}`, import.meta.url)))

/**
 * 拼一个 RIFF 头。**长度字段是「文件长度减 8」**，按容器规范填。
 * `parts` 的第一个元素必须是 `WEBP` 那 4 个字节——它们是 RIFF 载荷的开头，
 * 不是头的一部分，很容易写成 `head.write('WEBP')` 那种错的形态。
 */
function riff(parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

describe('parseWebp', () => {
  it('简单格式的静态 WebP：1 帧、不声明动图', async () => {
    const info = parseWebp(await fixture('static/static.webp'))
    expect(info).not.toBeNull()
    expect(info!.frameCount).toBe(1)
    expect(info!.declaresAnimation).toBe(false)
    // ⚠️ 宽高是 null，这是对的，不是 bug。没有 VP8X 就是简单格式（只有 VP8 / VP8L 块），
    // 容器里根本没有画布尺寸字段——尺寸要解码 VP8 头才知道。静态 WebP 走 ffprobe
    // （ffmpeg 读得了它），尺寸由那边给；只有动图才用得上这个解析器，而动图必有 VP8X。
    expect(info!.width).toBeNull()
  })

  it('动态 WebP：数出 ANMF 块个数', async () => {
    const info = parseWebp(await fixture('animated/animated.webp'))
    expect(info).not.toBeNull()
    // ⚠️ 这是本文件的核心断言。ffprobe 对同一个文件报 nb_frames=N/A，
    // 只靠 ffmpeg 的话这张图会被判成静图（进而复制行为出错）或被当成损坏文件拒掉
    expect(info!.frameCount).toBe(4)
    expect(info!.declaresAnimation).toBe(true)
    expect(info!.width).toBe(240)
    expect(info!.height).toBe(240)
  })

  it('非 WebP 返回 null，不去猜格式', () => {
    // 格式判定归 detectFormat（magic-bytes.ts）。这里只回答「是不是 WebP」
    expect(parseWebp(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBeNull()
    expect(parseWebp(Buffer.from('RIFFxxxxWAVE'))).toBeNull()
    expect(parseWebp(Buffer.alloc(0))).toBeNull()
  })

  it('截断到只剩 RIFF 头：不抛异常，交给调用方回退', () => {
    // 12 字节够认出是 WebP，但没有完整块。解析器不该崩——
    // 导入路径上「损坏文件」要变成 UNSUPPORTED_FORMAT，不是未捕获异常
    const head = Buffer.from('RIFF\x10\x00\x00\x00WEBP', 'latin1')
    const info = parseWebp(head)
    expect(info).not.toBeNull()
    expect(info!.frameCount).toBe(1)
    expect(info!.width).toBeNull()
  })

  it('块长度为奇数时按 RIFF 规范跳过补齐字节', () => {
    // 一个 3 字节载荷（奇数）+ 1 个补齐字节 + **两个** ANMF。
    //
    // 用两个是有讲究的：只有一个 ANMF 时，漏掉补齐和没漏掉都会得到 frameCount === 1
    // （解析器把「没找到 ANMF」也归成 1 帧），这个用例就什么都测不出来。
    // 有两个才区分得开——漏掉补齐的话 ANMF 会从错的偏移开始读，只数到一个。
    const anmf = (): Buffer[] => [Buffer.from('ANMF', 'latin1'), u32(16), Buffer.alloc(16)]
    const parts = [
      Buffer.from('WEBP', 'latin1'),
      Buffer.from('XYZ ', 'latin1'),
      u32(3),
      Buffer.alloc(3),
      Buffer.alloc(1), // 补齐（不计入 u32(3) 的长度）
      ...anmf(),
      ...anmf(),
    ]
    const info = parseWebp(new Uint8Array(riff(parts)))
    expect(info!.frameCount).toBe(2)
  })

  it('声明了动画但没有 ANMF：按静图处理', () => {
    // 畸形容器。按动图处理会让前端走「复制动图」那条路，而帧根本不存在；
    // 按静图处理最多是行为保守
    const info = parseWebp(
      new Uint8Array(
        riff([
          Buffer.from('WEBP', 'latin1'),
          Buffer.from('VP8X', 'latin1'),
          u32(10),
          // ANIM 位置位；宽高各 239（存的是「减一」）
          Buffer.from([0x02, 0, 0, 0, 239, 0, 0, 239, 0, 0]),
        ]),
      ),
    )
    expect(info!.declaresAnimation).toBe(true)
    expect(info!.frameCount).toBe(1)
  })
})
