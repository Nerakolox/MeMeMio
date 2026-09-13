import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 每个测试进程都要跑一次 —— worker 是独立进程，global-setup 里加载的变量不会传过来。
 * 必须在任何 import src/env.js 的模块之前执行，所以放在 setupFiles 里。
 */
const envPath = fileURLToPath(new URL('../../.env', import.meta.url))
if (existsSync(envPath)) process.loadEnvFile(envPath)
