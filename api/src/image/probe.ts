import { execFile } from 'node:child_process'
import { open, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FFMPEG_CONCURRENCY,
  FFMPEG_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  MAX_RAW_FRAMES,
} from './constants.js'
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
 * 输出上限逐调用点给：`extractFramePng`（单帧）走 stdout 的 PNG 字节流，所以给得宽；
 * 一次抽全套时输出直接落文件，stdout 只剩报错信息，给几 KB 就够。两边都设上限，
 * 是为了让一个畸形输入不可能把内存吃光。
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
  return assertFrameCountWithinLimit(await readMetadata(filePath))
}

/**
 * 帧数上限的**唯一出口**。见 `image/constants.ts` 的 `MAX_RAW_FRAMES`。
 *
 * 卡在 `probeMetadata` 而不是卡在抽帧那一层，是因为**帧数只在这里第一次被知道**，
 * 而认它的地方不止一处：导入靠它判 `is_animated`，抽帧靠它决定抽几帧。
 * 卡在下面的话，绕过抽帧直接读帧数的调用方（导入就是）就漏过去了——
 * 上限的作用是「这个文件我们处理不了，别再往下走」，而不是「抽到一半停下」。
 *
 * 报 `FILE_TOO_LARGE` 而不是 `UNSUPPORTED_FORMAT`：**这个文件的格式没有任何问题**，
 * 是它太大（SPEC §2.3 的 `FILE_TOO_LARGE` 原话就是「单文件超限」，像素上限
 * `MAX_INPUT_PIXELS` 走的是同一个码）；而 `UNSUPPORTED_FORMAT` 在 SPEC 里的定义是
 * 「magic bytes 探测结果不是支持的图片格式」，用在这里会把两种失败混成一条信息。
 */
function assertFrameCountWithinLimit(metadata: VideoMetadata): VideoMetadata {
  if (metadata.frameCount > MAX_RAW_FRAMES) {
    throw new AppError(
      'FILE_TOO_LARGE',
      `动图有 ${metadata.frameCount} 帧，超过 ${MAX_RAW_FRAMES} 帧上限`,
      { frameCount: metadata.frameCount, maxFrames: MAX_RAW_FRAMES },
    )
  }
  return metadata
}

async function readMetadata(filePath: string): Promise<VideoMetadata> {
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
 * 抽**一帧**为 PNG 字节流。
 *
 * `index` 从 0 开始。用 `-vf select` 而不是 `-ss` 定位——`-ss` 在动图上按时间跳，
 * 而我们要的是确定的第几帧。帧间去重与采样都要靠这个确定性。
 *
 * ⚠️ **现在只有导入阶段那一次单帧探活在用它**（`services/import.ts`：确认 ffmpeg
 *    真的解得开，而不是只读了容器头）。**抽全套帧不要回到这个函数上循环**——
 *    每调一次都要从头解到第 `index` 帧，循环起来总解码量随帧数平方增长，
 *    几百帧的 GIF 就是这么变成「导入卡住」的。抽全套用 `extractAllFrames`。
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

/** 落盘帧的文件名里，帧号占几位。**序号 == 帧号**这个契约靠它和 `f%06d` 对齐。 */
const FRAME_NUMBER_WIDTH = 6

/** 给 ffmpeg 的 `image2` 输出模板。序号从 `-start_number 0` 起，写满这个宽度。 */
const FRAME_FILE_PATTERN = `f%0${FRAME_NUMBER_WIDTH}d.png`

/** 一个抽出来的帧：`index` 是**原始帧号**，`path` 是落盘 PNG。 */
export type DecodedFrame = { index: number; path: string }

/**
 * 一次 ffmpeg 调用把动图**全部**帧抽成 PNG 落到 `destDir`，按帧号排序返回。
 *
 * 取代 `frames.ts` 原来那个「每帧起一个进程 + `select=eq(n,i)`」的循环：那种写法的
 * 每一帧都要**从文件开头解到第 i 帧**，总解码量随帧数**平方**增长。实测 120 帧
 * 从 8574ms 降到 200ms，且输出**与逐帧抽取逐字节一致**（四个样本的数字在
 * 任务 2026-09-24-search-media-perf 的验收里）。
 *
 * ⚠️ **`-vsync 0` 不能省。** 默认的 `-vsync auto` 会为了凑帧率**丢掉重复帧**，
 *    而长静止段正是表情包动图的常态。帧一丢，文件序号就和原始帧号错位——
 *    偏后段的采样会取到别的画面，**不报错，只是标签悄悄变差**。
 *
 * ⚠️ **`-start_number 0` + `f%06d.png` 是「序号 == 帧号」契约的一半**，另一半是
 *    动态 WebP 走 sharp 的 `page`（`decode.ts` 的 `extractWebpFramePng`）。
 *    这一层**不假设序号连续**：帧号从文件名里读回来（`listFrameFiles`），
 *    ffmpeg 少写一个文件也只是少一帧，不会让后面全部错位。
 */
export async function extractAllFrames(
  filePath: string,
  destDir: string,
  frameCount: number,
): Promise<DecodedFrame[]> {
  // ⚠️ **动态 WebP 只能走 sharp**（ffmpeg 没有 WebP 解复用器，抽出来是 0 字节，
  //    见 `extractFramePng` 的说明）。这一支仍然逐帧调 sharp，但**不起进程**——
  //    起进程才是原实现的代价，sharp 一次调用是毫秒级。
  const webpInfo = await readWebpContainer(filePath)
  if (webpInfo !== null && webpInfo.frameCount > 1) {
    const frames: DecodedFrame[] = []
    for (let i = 0; i < frameCount; i += 1) {
      const png = await extractWebpFramePng(filePath, i)
      const path = join(destDir, frameFileName(i))
      await writeFile(path, png)
      frames.push({ index: i, path })
    }
    return frames
  }

  const result = await run(
    'ffmpeg',
    [
      '-v', 'error',
      '-i', filePath,
      '-vsync', '0',
      '-start_number', '0',
      '-f', 'image2',
      join(destDir, FRAME_FILE_PATTERN),
    ],
    FFMPEG_TIMEOUT_MS,
    // 输出走文件，stdout 只剩 ffmpeg 的报错信息，几 KB 封顶
    1 * 1024 * 1024,
  )
  if (!result.ok) {
    log.warn({ reason: result.reason, message: result.message }, 'ffmpeg 一次抽帧失败')
    throw new AppError('UNSUPPORTED_FORMAT', '抽帧失败，文件可能已损坏')
  }

  const frames = await listFrameFiles(destDir)
  if (frames.length === 0) {
    throw new AppError('UNSUPPORTED_FORMAT', '没有抽到任何帧，文件可能已损坏')
  }
  return frames
}

/**
 * 读回 `destDir` 里的帧文件，**帧号取自文件名**，按帧号排序。
 *
 * 不靠 `readdir` 的顺序，也不靠「第几个文件就是第几帧」：前者在文件系统之间没有保证，
 * 后者在 ffmpeg 少写一个文件时会让后面全部错位——而两者都是**静默**的。
 */
async function listFrameFiles(destDir: string): Promise<DecodedFrame[]> {
  const files = await readdir(destDir)
  const frames: DecodedFrame[] = []
  for (const name of files) {
    const matched = /^f(\d+)\.png$/.exec(name)
    if (matched === null) continue
    frames.push({ index: Number(matched[1]), path: join(destDir, name) })
  }
  frames.sort((a, b) => a.index - b.index)
  return frames
}

/** 帧号 → 落盘文件名。和 `FRAME_FILE_PATTERN` 必须同宽，否则序号和帧号对不上。 */
function frameFileName(index: number): string {
  return `f${String(index).padStart(FRAME_NUMBER_WIDTH, '0')}.png`
}
