import { pino } from 'pino'
import { createRequire } from 'node:module'
import { env, isProduction } from './env.js'

/**
 * 结构化日志：第一个参数是对象，第二个是消息。
 *
 *     log.info({ requestId, memeId, model }, 'tagging completed')
 *
 * 每条错误日志必须带 requestId —— 它就是 SPEC §2.1 里返回给用户的那个。
 *
 * ⚠️ 永远不记 API Key、CONFIG_ENC_KEY、会话 token。redact 名单是第二道保险，
 *    第一道是别把它们传进来。见 agents/rules/error-handling.md §6。
 */

/**
 * pino-pretty 是 devDependency，镜像里 `npm prune --omit=dev` 之后不存在。
 * 只按 NODE_ENV 判断不够 —— 拿非 production 的 NODE_ENV 跑镜像会在加载日志器时
 * 直接崩掉（`unable to determine transport target for "pino-pretty"`），
 * **报错点离根因很远**。所以这里探测的是「装没装」，不是「哪个环境」。
 */
function prettyAvailable(): boolean {
  if (isProduction) return false
  try {
    createRequire(import.meta.url).resolve('pino-pretty')
    return true
  } catch {
    return false
  }
}

export const log = pino({
  // 不做成环境变量：校验过的 env 之外不再出现 process.env（env-validation.md §1）
  level: env.nodeEnv === 'test' ? 'silent' : isProduction ? 'info' : 'debug',
  base: { app: env.appSlug },
  redact: {
    paths: [
      'apiKey',
      'api_key',
      'configEncKey',
      'sessionSecret',
      'authorization',
      '*.apiKey',
      '*.authorization',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
  transport: prettyAvailable()
    ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,app' } }
    : undefined,
})

