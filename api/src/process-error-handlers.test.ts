import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * `installProcessErrorHandlers` 的**行为**测试：真的把一个未接住的拒绝扔出去，
 * 看进程死不死（任务 2026-09-24-queue-reliability §3）。
 *
 * ⚠️ 必须在**子进程**里跑。想在测试进程里造 unhandledRejection 的话，捕获它的是
 *    vitest 自己（它会把这轮判为失败），于是测到的是「vitest 怎么处理」，
 *    不是「我们的进程怎么处理」。这里要断言的是「进程还活着」，只能起真进程。
 *
 * 生产里那个场景是具体的：任务整体超时之后 `applyFailure` 写库失败（库刚好在重启），
 * 那次 reject 没人接。Node 22 的默认动作是升级成致命错误、退出 1——
 * 于是一次写库抖动就把整个 worker 带走。
 */
const shutdownModuleUrl = pathToFileURL(
  fileURLToPath(new URL('./shutdown.ts', import.meta.url)),
).href

const workDir = mkdtempSync(join(tmpdir(), 'mememio-shutdown-'))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** 起一个子进程：装上兜底处理器、扔一个未接住的拒绝、然后报告自己还活着。 */
async function runProbe(body: string): Promise<{ stdout: string; code: number | null }> {
  const scriptPath = join(workDir, `probe-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(scriptPath, body, 'utf-8')

  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    // `.env` 得传过去：`shutdown.ts` 会拉进 `env.ts`，缺变量它直接 exit(1)。
    //
    // ⚠️ **刻意把 `NODE_ENV` 从 `test` 改成 `development`**：`logger.ts` 在 test 下把
    //    level 设成 `silent`（测试里不该有日志噪音），而这条用例要断言的正是
    //    「有一条日志」。它对着静音的日志器断言会永远红，而红的原因和被测代码无关
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })

  const code = await new Promise<number | null>((resolve) => {
    child.on('exit', (exitCode) => resolve(exitCode))
  })
  return { stdout, code }
}

describe('unhandledRejection 兜底', () => {
  it('装上处理器之后，未接住的拒绝只记日志，进程不退出', async () => {
    const { stdout, code } = await runProbe(
      [
        `import { installProcessErrorHandlers } from ${JSON.stringify(shutdownModuleUrl)}`,
        'installProcessErrorHandlers()',
        `void Promise.reject(new Error('测试用的未接住拒绝'))`,
        // 200ms 足够让 Node 判定这个 promise 没人接（它在 microtask 队列排空时就判了）
        `setTimeout(() => { process.stdout.write('STILL_ALIVE\\n') }, 200)`,
      ].join('\n'),
    )

    expect(stdout).toContain('STILL_ALIVE')
    // 「有一条日志」是这条验收的一半：不记日志的兜底等于把 bug 吞掉
    expect(stdout).toContain('unhandledRejection')
    expect(code).toBe(0)
  })

  it('对照组：不装处理器时，Node 22 自己会把进程带走（退出码非 0）', async () => {
    // 没有这一条的话，上面那个用例在「Node 的默认行为变了」时不会红——
    // 它会一直绿着，而我们以为兜底在起作用
    const { code } = await runProbe(
      [
        `void Promise.reject(new Error('测试用的未接住拒绝'))`,
        `setTimeout(() => { process.stdout.write('STILL_ALIVE\\n') }, 200)`,
      ].join('\n'),
    )

    expect(code).not.toBe(0)
  })
})
