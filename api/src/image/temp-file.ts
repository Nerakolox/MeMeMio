import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { log } from '../logger.js'

/**
 * 把字节落成临时文件跑一段逻辑，跑完删掉。
 *
 * 存在的理由：**ffmpeg / ffprobe 只认路径，不认 Buffer**（`image/probe.ts`）。
 * 导入和打标两条路径都要抽帧，落盘这一段一模一样，共用一份免得只在一边修了 bug。
 */
export async function withTempFile<T>(
  bytes: Buffer,
  label: string,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), 'mememio-'))
  const localPath = join(tempDir, 'source')
  try {
    await writeFile(localPath, bytes)
    return await fn(localPath)
  } finally {
    await cleanupTempDir(tempDir, label)
  }
}

/**
 * 删临时目录，**失败不抛**。
 *
 * ⚠️ Windows 上 `rm` 会撞 EBUSY：sharp/libvips 可能还握着文件句柄（见
 * `image/decode.ts` 的 `extractWebpFramePng`——动图 WebP 只能走 sharp）。
 * 早先这个 rm 会抛出去，结果是那批字节其实已经好好地进了 R2 和库，
 * 用户看到的却是「导入失败」加一张丢不掉的图。
 *
 * 先重试几次（句柄通常几十毫秒内就松了），仍不行就留给系统清理 tmpdir——
 * 和 `storage/r2.ts` 里 `deleteObject` 的取舍一致。
 */
async function cleanupTempDir(tempDir: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(tempDir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 2) {
        log.warn({ err: error, tempDir, label }, '临时目录未能删除，交给系统清理')
        return
      }
      await sleep(50)
    }
  }
}
