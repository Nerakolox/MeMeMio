/**
 * AI 配置里 API Key 的加解密。**纯函数，只 import node:crypto**（project-structure.md）。
 *
 * 主密钥由调用方传进来，本文件不认识 `env`——这样单测能用「另一把密钥」验证
 * 「换密钥后解密失败」，而不用去改进程环境变量。绑定 `env.configEncKey` 的地方
 * 只有 `data/ai-configs.ts` 一处。
 *
 * ⚠️ 两条硬规则（SPEC §3.5、ai-providers.md §7）：
 *    - 主密钥 `CONFIG_ENC_KEY` 不进任何接口、任何日志、任何错误 `details`。
 *      所以本文件抛出的错误**只带枚举 reason，不带任何输入片段**——message 里
 *      拼一段密文或明文，下一个人把它塞进 `details` 就泄露了。
 *    - 解密结果只在调用那一瞬间存在，不要缓存 `decryptSecret` 的返回值。
 *
 * 密文布局（存 `bytea`）：
 *
 *     [0]      版本号 0x01
 *     [1,13)   IV（12 字节，每次随机，绝不复用）
 *     [13,29)  GCM auth tag（16 字节）
 *     [29,)    密文
 *
 * 版本号占一个字节是为了以后换算法时能同库共存——读的时候先看它，
 * 认不出的版本按 `unsupported_version` 失败，而不是当成 v1 硬解出一堆脏数据。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const VERSION = 0x01
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

const VERSION_OFFSET = 0
const IV_OFFSET = 1
const TAG_OFFSET = IV_OFFSET + IV_BYTES
const CIPHERTEXT_OFFSET = TAG_OFFSET + TAG_BYTES

/**
 * 失败原因是**枚举**而不是自由文本：调用方需要区分「密钥不对 / 数据被改」和
 * 「这行根本不是密文」，但不需要——也不允许——看到任何输入内容。
 */
export type ConfigCryptoReason =
  /** 主密钥长度不对。启动时 `lib/env.ts` 已经校验过，走到这里说明调用方传错了东西 */
  | 'bad_master_key'
  /** 长度不足、版本号不认识——不是本函数写出来的数据 */
  | 'malformed'
  | 'unsupported_version'
  /** GCM 校验失败：换过密钥，或者密文被改过。**这是「解不出来」，不是「解出脏数据」** */
  | 'auth_failed'

export class ConfigCryptoError extends Error {
  readonly reason: ConfigCryptoReason

  constructor(reason: ConfigCryptoReason) {
    // message 只有 reason，不含任何输入。见文件头。
    super(`config crypto failed: ${reason}`)
    this.name = 'ConfigCryptoError'
    this.reason = reason
  }
}

function toMasterKey(masterKey: string): Buffer {
  const key = Buffer.from(masterKey, 'utf-8')
  if (key.length !== KEY_BYTES) throw new ConfigCryptoError('bad_master_key')
  return key
}

/**
 * 加密一段明文（这里永远是 API Key）。
 *
 * IV 每次重新随机，所以**同一段明文每次得到的密文都不同**——这不是副作用而是要求，
 * GCM 在同一把密钥下复用 IV 会直接泄露明文异或关系。单测里「密文每次不同」那条
 * 断的就是这个。
 */
export function encryptSecret(plaintext: string, masterKey: string): Buffer {
  const key = toMasterKey(masterKey)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body])
}

/**
 * 解密。失败一律抛 `ConfigCryptoError`，**不返回 null、不返回空串**——
 * 「解不出来」和「存的就是空 key」必须是两种可分辨的结果，
 * 悄悄返回空串会让运行时把它当成「没配置」，然后无声地回落到部署方通道。
 */
export function decryptSecret(blob: Buffer, masterKey: string): string {
  const key = toMasterKey(masterKey)
  if (blob.length < CIPHERTEXT_OFFSET) throw new ConfigCryptoError('malformed')
  if (blob[VERSION_OFFSET] !== VERSION) throw new ConfigCryptoError('unsupported_version')

  const iv = blob.subarray(IV_OFFSET, TAG_OFFSET)
  const tag = blob.subarray(TAG_OFFSET, CIPHERTEXT_OFFSET)
  const body = blob.subarray(CIPHERTEXT_OFFSET)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf-8')
  } catch {
    // node 的原始错误是 "Unsupported state or unable to authenticate data"，
    // 换成枚举，顺便保证原始 message 不会被上层顺手塞进 details。
    throw new ConfigCryptoError('auth_failed')
  }
}

/**
 * Key 指纹：SHA-256 十六进制。
 *
 * 用途只有一个——测试记录按 **baseUrl + model + 指纹**匹配（SPEC §6.5.2）。
 * 记录里不存明文也不存密文，只存这个。少了它，「换了 key 没测就保存」能过校验，
 * 而那恰恰是最常见的填错方式。
 *
 * 不加盐：跨行比对必须得到同一个值，加了随机盐就比不了；而这里保护的不是口令库，
 * 是一段高熵随机串，彩虹表对它没有意义。
 */
export function fingerprintSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf-8').digest('hex')
}

/** 指纹比对走常数时间，避免用比对耗时反推指纹。两边都是定长 hex，长度不同直接 false。 */
export function fingerprintEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf-8')
  const right = Buffer.from(b, 'utf-8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
