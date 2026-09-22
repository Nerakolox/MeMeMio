import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import { FFMPEG_CONCURRENCY, FFMPEG_TIMEOUT_MS, FFPROBE_TIMEOUT_MS } from './constants.js'
import { extractWebpFramePng } from './decode.js'
import { AppError } from '../lib/app-error.js'
import { createSlotPool, type SlotPool } from '../lib/slot-pool.js'
import { parseWebp, type WebpInfo } from '../lib/webp.js'
import { log } from '../logger.js'

/**
 * ffmpeg / ffprobe 子进程封装。
 *
 * 这一层只做一件事：**把「子进程卡住」变成一个确定的错误**。
 * 超时和并发上限都是硬要求，见 agents/rules/image-pipeline.md §8：
 * 一个损坏的文件能让 ffmpeg 挂住不退出，几个这样的就能把机器打满，
 * 而表现只是「导入进度条不动」——没有任何错误信息。
 */

/**
 * 同时运行的 ffmpeg 进程数。超时解决单个卡死，这个解决它们一起卡死。
 *
 * 初值是常量默认值，运行期由 `setFfmpegConcurrency` 改成 `runtime_config` 里的值
 * （SPEC §5.6）。**上限由调用方传入，这一层不读库**——`image/` 不认识 `db`
 * （project-structure.md 分层），也不该认识「配置」这个概念。
 *
 * 槽池本身在 `lib/slot-pool.ts`：那段逻辑（尤其是「上调要主动唤醒等待者」）是本功能
 * 最容易漏的地方，单独放一个没有 import 的模块才测得到。
 */
const slots: SlotPool = createSlotPool(FFMPEG_CONCURRENCY)

/**
 * 改 ffmpeg 并发上限。由打标 worker 每轮 tick 与导入批次开头调（SPEC §5.6）。
 *
 * ⚠️ **上调必须唤醒等待者**，否则新上限要等到某次 ffmpeg 自然结束才生效——表现是
 *    「调了没用」，不报错、不告警。这段补足逻辑在 `slot-pool.ts` 的 `setLimit` 里，
 *    有专门测试。下调什么都不用做：多出来的槽自然排走，在途任务不打断（§6.5.5）。
 */
export function setFfmpegConcurrency(next: number): void {
  slots.setLimit(next)
}

/**
 * 本进程此刻的 ffmpeg 上限。**给诊断与测试用**——「管理员调了没用」正是会来问的问题，
 * 而这个问题有两个可能：值没写进库（看 `GET /admin/runtime`），或者写进去了但没传到这里。
 * 它回答的是后者。
 *
 * **不要拿它当配置源**：真实来源是 `runtime_config`（`services/runtime-config.ts`）。
 */
export function ffmpegConcurrency(): number {
  return slots.stats().limit
}

type RunResult = { ok: true; stdout: Buffer } | { ok: false; reason: 'timeout' | 'failed'; message: string }

/**
 * 跑一个子进程，带超时与并发上限。
 *
 * 输出上限设成 64MB：抽帧时 stdout 是 PNG 字节流，正常的 10 帧远小于它，
 * 但设了上限才能保证一个畸形输入不会把内存吃光。
 */
async function run(
  command: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<RunResult> {
  await slots.acquire()
  try {
    return await new Promise<RunResult>((resolve) => {
      const child = execFile(
        command,
        args,
        { timeout: timeoutMs, maxBuffer: maxOutputBytes, encoding: 'buffer', windowsHide: true },
        (error, stdout) => {
          if (error === null) {
            resolve({ ok: true, stdout: Buffer.from(stdout) })
            return
          }
          // execFile 超时会 kill 子进程并把 killed 置为 true，此时 signal 才是真原因
          const killed = (error as { killed?: boolean }).killed === true
          resolve({
            ok: false,
            reason: killed ? 'timeout' : 'failed',
            message: error.message,
          })
        },
      )
      // stdin 关掉：某些容器里 ffmpeg 会等 stdin 而永远不退
      child.stdin?.end()
    })
  } finally {
    slots.release()
  }
}

export type VideoMetadata = {
  /** 容器里真实的帧数。**`is_animated` 只能由它决定**，见 image-pipeline.md §2。 */
  frameCount: number
  width: number | null
  height: number | null
}

/**
 * 用 ffprobe 读帧数与尺寸。
 *
 * **为什么必须问容器：** WebP 和 APNG 都可能是动图也可能是静图，
 * `mime` 推不出来。这个字段是前端复制/下载分流的唯一依据，
 * 错了的表现是「点了复制没反应」。见 SPEC §5.2.2 / image-pipeline.md §2。
 *
 * `nb_frames` 不是所有容器都给（单帧 PNG/JPEG 通常没有），
 * 那时退回 `count_frames` 数一遍。
 */
export async function probeMetadata(filePath: string): Promise<VideoMetadata> {
  // ⚠️ **动态 WebP 必须先走自己那一套。** ffmpeg 没有 WebP 解复用器
  //    （只有 webp_pipe），它会跳过 ANIM / ANMF 块，于是 ffprobe 报
  //    `width=0 nb_frames=N/A`，下面两条路径都读不到帧数，最后当成损坏文件拒掉——
  //    而那是一个完全正常的动图。容器结构读法见 lib/webp.ts。
  //
  //    判断只看前 12 字节（`RIFF` + `WEBP`），不是 WebP 就直接跳过这一步，零成本。
  const webpInfo = await readWebpContainer(filePath)
  if (webpInfo !== null && webpInfo.frameCount > 1) {
    return { frameCount: webpInfo.frameCount, width: webpInfo.width, height: webpInfo.height }
  }

  // 先走轻量的那一次：大多数容器在头里就写了 nb_frames，不必真的解一遍
  const head = await probe(filePath, ['stream=nb_frames,width,height'])
  const stream = head.streams[0]
  if (stream === undefined) {
    throw new AppError('UNSUPPORTED_FORMAT', '文件里没有图像流')
  }

  const declared = toFrameCount(stream.nb_frames)
  if (declared !== null) {
    return { frameCount: declared, width: stream.width ?? null, height: stream.height ?? null }
  }

  // nb_frames 缺席（单帧 PNG / JPEG 通常没有）时真的数一遍。
  // 数帧比读头贵得多，所以放在第二条路径而不是无条件跑
  const counted = await probe(filePath, ['stream=nb_read_frames'], ['-count_frames'])
  const readFrames = toFrameCount(counted.streams[0]?.nb_read_frames)
  if (readFrames !== null) {
    return { frameCount: readFrames, width: stream.width ?? null, height: stream.height ?? null }
  }

  // 一个连帧数都读不出来的文件，当作损坏处理，不要静默按 1 帧入库——
  // 「是 GIF 但只有一帧」要判静图，但判错的代价是前端复制行为出错，不能靠猜
  throw new AppError('UNSUPPORTED_FORMAT', '无法确定帧数，文件可能已损坏')
}

/**
 * 只在前 12 字节确认过 `RIFF`…`WEBP` 之后才整文件读进来解析。
 *
 * 分两步是为了让非 WebP 的文件**一个字节都不用读**——导入一千张 PNG 时，
 * 每次都把整文件读进内存只为了发现「不是 WebP」是没必要的。
 * 走完整的 `parseWebp` 而不是只认头，是因为帧数要扫完所有 ANMF 块，
 * 而 ANMF 的偏移必须从头顺序走，跳不过去。
 */
async function readWebpContainer(filePath: string): Promise<WebpInfo | null> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, 'r')
  } catch {
    // 文件读不了，交给 ffprobe 去报那个更有信息量的错
    return null
  }

  try {
    const head = Buffer.alloc(12)
    const { bytesRead } = await handle.read(head, 0, 12, 0)
    if (bytesRead < 12) return null
    if (head.subarray(0, 4).toString('latin1') !== 'RIFF') return null
    if (head.subarray(8, 12).toString('latin1') !== 'WEBP') return null

    const whole = await handle.readFile()
    return parseWebp(new Uint8Array(whole))
  } catch (error) {
    // 截断 / 空文件都可能在这里抛，交给 ffprobe 报 UNSUPPORTED_FORMAT
    log.warn({ err: error, filePath }, 'WebP 容器解析失败')
    return null
  } finally {
    await handle.close()
  }
}

type ProbeStream = {
  nb_frames?: string
  nb_read_frames?: string
  width?: number
  height?: number
}

function toFrameCount(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw)
  // "N/A" 之类的非数字会变成 NaN，当作没读到
  if (!Number.isInteger(n) || n < 1) return null
  return n
}

/** 跑一次 ffprobe 并解析 JSON。损坏文件在这里统一变成 UNSUPPORTED_FORMAT。 */
async function probe(
  filePath: string,
  showEntries: string[],
  extraArgs: string[] = [],
): Promise<{ streams: ProbeStream[] }> {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    ...extraArgs,
    ...showEntries.flatMap((entry) => ['-show_entries', entry]),
    '-of', 'json',
    filePath,
  ]
  const result = await run('ffprobe', args, FFPROBE_TIMEOUT_MS, 8 * 1024 * 1024)

  if (!result.ok) {
    // 损坏文件与「不是图像容器」走同一个失败分支，但至少要和「我们判错了格式」区分开。见 §7
    log.warn({ reason: result.reason, message: result.message }, 'ffprobe 失败')
    throw new AppError('UNSUPPORTED_FORMAT', '文件损坏或不是可识别的图片')
  }

  try {
    const parsed = JSON.parse(result.stdout.toString('utf8')) as { streams?: ProbeStream[] }
    return { streams: parsed.streams ?? [] }
  } catch {
    throw new AppError('UNSUPPORTED_FORMAT', '文件损坏或不是可识别的图片')
  }
}

/**
 * 抽一帧为 PNG 字节流。
 *
 * `index` 从 0 开始。用 `-vf select` 而不是 `-ss` 定位——`-ss` 在动图上按时间跳，
 * 而我们要的是确定的第几帧。帧间去重与采样都要靠这个确定性。
 */
export async function extractFramePng(filePath: string, index: number): Promise<Buffer> {
  // ⚠️ **动态 WebP 走 sharp，不走 ffmpeg。** ffmpeg 没有 WebP 解复用器，
  //    抽出来是 0 字节（见 lib/webp.ts 的说明）。libvips 认得，且把帧竖排堆叠，
  //    用 `page` + `pages: 1` 就能切出确定的一帧——和 `select=eq(n,index)` 的语义一致。
  const webpInfo = await readWebpContainer(filePath)
  if (webpInfo !== null && webpInfo.frameCount > 1) {
    return await extractWebpFramePng(filePath, index)
  }

  const args = [
    '-v', 'error',
    '-i', filePath,
    '-vf', `select=eq(n\\,${index})`,
    '-vsync', '0',
    '-frames:v', '1',
    '-f', 'image2pipe',
    '-c:v', 'png',
    '-',
  ]
  const result = await run('ffmpeg', args, FFMPEG_TIMEOUT_MS, 64 * 1024 * 1024)
  if (!result.ok) {
    log.warn({ index, reason: result.reason }, 'ffmpeg 抽帧失败')
    throw new AppError('UNSUPPORTED_FORMAT', '抽帧失败，文件可能已损坏')
  }
  if (result.stdout.length === 0) {
    throw new AppError('UNSUPPORTED_FORMAT', `第 ${index} 帧是空的`)
  }
  return result.stdout
}
