import { describe, expect, it } from 'vitest'
import {
  ConfigCryptoError,
  decryptSecret,
  encryptSecret,
  fingerprintEquals,
  fingerprintSecret,
} from './config-crypto.js'

/** 两把合法长度（32 字节）的主密钥，用来验证「换密钥后解不开」。 */
const KEY_A = 'A'.repeat(32)
const KEY_B = 'B'.repeat(32)

const SECRET = 'sk-proj-THIS-MUST-NOT-LEAK-9876'

describe('encryptSecret / decryptSecret', () => {
  it('往返一致', () => {
    expect(decryptSecret(encryptSecret(SECRET, KEY_A), KEY_A)).toBe(SECRET)
  })

  it('中文和空串也能往返（key 是用户填的，不假设字符集）', () => {
    expect(decryptSecret(encryptSecret('密钥·测试', KEY_A), KEY_A)).toBe('密钥·测试')
    expect(decryptSecret(encryptSecret('', KEY_A), KEY_A)).toBe('')
  })

  it('密文每次不同——nonce 不复用', () => {
    const blobs = Array.from({ length: 16 }, () => encryptSecret(SECRET, KEY_A))
    const ivs = new Set(blobs.map((b) => b.subarray(1, 13).toString('hex')))
    expect(ivs.size).toBe(blobs.length)
    expect(new Set(blobs.map((b) => b.toString('hex'))).size).toBe(blobs.length)
  })

  it('密文里搜不到明文', () => {
    const blob = encryptSecret(SECRET, KEY_A)
    expect(blob.toString('utf-8')).not.toContain('THIS-MUST-NOT-LEAK')
    expect(blob.toString('hex')).not.toContain(Buffer.from(SECRET, 'utf-8').toString('hex'))
  })

  it('换了主密钥是可判断的失败，不是脏数据', () => {
    const blob = encryptSecret(SECRET, KEY_A)
    expect(() => decryptSecret(blob, KEY_B)).toThrow(ConfigCryptoError)
    try {
      decryptSecret(blob, KEY_B)
      expect.unreachable('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigCryptoError)
      expect((error as ConfigCryptoError).reason).toBe('auth_failed')
    }
  })

  it('密文被改一个字节也解不开（GCM 校验，不是「解出别的东西」）', () => {
    const blob = encryptSecret(SECRET, KEY_A)
    const tampered = Buffer.from(blob)
    const last = tampered.length - 1
    tampered[last] = (tampered[last] ?? 0) ^ 0xff
    expect(() => decryptSecret(tampered, KEY_A)).toThrow(
      expect.objectContaining({ reason: 'auth_failed' }),
    )
  })

  it('不是本函数写出来的数据：长度不足 → malformed，版本号不认识 → unsupported_version', () => {
    expect(() => decryptSecret(Buffer.alloc(8), KEY_A)).toThrow(
      expect.objectContaining({ reason: 'malformed' }),
    )
    const blob = encryptSecret(SECRET, KEY_A)
    const wrongVersion = Buffer.from(blob)
    wrongVersion[0] = 0x02
    expect(() => decryptSecret(wrongVersion, KEY_A)).toThrow(
      expect.objectContaining({ reason: 'unsupported_version' }),
    )
  })

  it('主密钥长度不对直接拒绝，不静默补齐', () => {
    expect(() => encryptSecret(SECRET, 'too-short')).toThrow(
      expect.objectContaining({ reason: 'bad_master_key' }),
    )
    expect(() => decryptSecret(encryptSecret(SECRET, KEY_A), 'too-short')).toThrow(
      expect.objectContaining({ reason: 'bad_master_key' }),
    )
  })

  it('错误 message 里不含明文，也不含主密钥（SPEC §3.5：两者都不进 details）', () => {
    const blob = encryptSecret(SECRET, KEY_A)
    try {
      decryptSecret(blob, KEY_B)
      expect.unreachable('应当抛错')
    } catch (error) {
      const text = String((error as Error).message) + String((error as Error).stack ?? '')
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(KEY_A)
      expect(text).not.toContain(KEY_B)
      expect(text).not.toContain(blob.toString('hex'))
    }
  })
})

describe('fingerprintSecret', () => {
  it('同一个 key 得到同一个指纹，不同 key 不同指纹', () => {
    expect(fingerprintSecret(SECRET)).toBe(fingerprintSecret(SECRET))
    expect(fingerprintSecret(SECRET)).not.toBe(fingerprintSecret(SECRET + 'x'))
  })

  it('是定长十六进制，且不含原 key', () => {
    const fp = fingerprintSecret(SECRET)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(fp).not.toContain('9876')
  })

  it('已知向量——换了实现也得算出同一个值，否则老的测试记录会全部失配', () => {
    // echo -n "" | sha256sum
    expect(fingerprintSecret('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('fingerprintEquals 只对相同指纹为真', () => {
    expect(fingerprintEquals(fingerprintSecret(SECRET), fingerprintSecret(SECRET))).toBe(true)
    expect(fingerprintEquals(fingerprintSecret(SECRET), fingerprintSecret('other'))).toBe(false)
    expect(fingerprintEquals(fingerprintSecret(SECRET), 'short')).toBe(false)
  })
})
