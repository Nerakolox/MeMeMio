import { parseEnv, type Env } from './lib/env.js'

/**
 * 进程启动的第一件事。
 *
 * 校验失败 = 拒绝启动，并打印缺了哪个。理由见 agents/rules/env-validation.md §1：
 * `process.env.X!` 的问题不是类型不安全，是报错时机 —— 第一次调用可能发生在
 * 部署后几小时的某次导入里，那时的堆栈离「忘了配环境变量」已经很远了。
 *
 * 除了这里导出的 env 对象，**代码里不应该再出现 process.env**。
 */
function load(): Env {
  const result = parseEnv(process.env)
  if (result.ok) return result.env

  // 这里刻意不用 logger：logger 自己要读 env，而且启动失败的信息要能被 docker logs 直接看见
  process.stderr.write('\n环境变量校验未通过，拒绝启动：\n')
  for (const message of result.errors) {
    process.stderr.write(`  ✗ ${message}\n`)
  }
  process.stderr.write('\n字段清单见 docs/environments.md §1，样例见 .env.example。\n\n')
  process.exit(1)
}

export const env: Env = load()

export const isProduction = env.nodeEnv === 'production'
