import { describe, expect, it } from 'vitest'
import {
  HASH_HEIGHT,
  HASH_WIDTH,
  dHashFromGray,
  fromHashHex,
  hammingDistance,
  splitHash,
  toHashHex,
} from './phash.js'

/**
 * 这组用例盯的是**符号**，不是哈希算得准不准。
 *
 * dHash 是 64 位满的，最高位有一半概率为 1。之前的实现一路用无符号：
 * 写库会 `out of range for type bigint`，`splitHash` 给出的半个哈希会让查重 SQL 的
 * `$1::int` 报 `value "3480189747" is out of range for type integer`——后者在 Bind
 * 阶段就抛，库里一行都没有照样炸，表现是「导入几乎每张图都失败」。
 *
 * 所以这里的断言全部围绕「位模式不变、取值落在 int8 / int4 里」。
 */

const INT8_MIN = -(2n ** 63n)
const INT8_MAX = 2n ** 63n - 1n
const INT4_MIN = -2147483648
const INT4_MAX = 2147483647

/** 每行严格递减 → 每次比较都是「左比右亮」→ 64 位全 1。 */
function allOnesGray(): Uint8Array {
  const gray = new Uint8Array(HASH_WIDTH * HASH_HEIGHT)
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH; x += 1) {
      gray[y * HASH_WIDTH + x] = 255 - x
    }
  }
  return gray
}

/** 每行严格递增 → 一位都不置 → 0。 */
function allZerosGray(): Uint8Array {
  const gray = new Uint8Array(HASH_WIDTH * HASH_HEIGHT)
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH; x += 1) {
      gray[y * HASH_WIDTH + x] = x
    }
  }
  return gray
}

// 高低两半都超过 int4 上限的哈希（两个半边的最高位都是 1）
const HIGH_BIT_HASH = BigInt.asIntN(64, 0xcf6b7b33_9a5d24e1n)

describe('dHashFromGray', () => {
  it('全 1 的哈希是 -1，不是 2^64-1 —— 它要能直接写进 bigint 列', () => {
    const hash = dHashFromGray(allOnesGray())

    expect(hash).toBe(-1n)
    expect(hash).toBeGreaterThanOrEqual(INT8_MIN)
    expect(hash).toBeLessThanOrEqual(INT8_MAX)
  })

  it('全 0 仍然是 0', () => {
    expect(dHashFromGray(allZerosGray())).toBe(0n)
  })

  it('相等的相邻像素记 0，同样的输入给同样的哈希', () => {
    const flat = new Uint8Array(HASH_WIDTH * HASH_HEIGHT).fill(128)

    expect(dHashFromGray(flat)).toBe(0n)
    expect(dHashFromGray(flat)).toBe(dHashFromGray(flat))
  })

  it('长度不对直接抛，不静默补零', () => {
    expect(() => dHashFromGray(new Uint8Array(10))).toThrow()
  })
})

describe('splitHash', () => {
  it('两半都落在 int4 范围内 —— 这条挂了就是导入全失败', () => {
    for (const hash of [HIGH_BIT_HASH, -1n, 0n, dHashFromGray(allOnesGray())]) {
      const { hi, lo } = splitHash(hash)

      expect(hi, `hi of ${hash}`).toBeGreaterThanOrEqual(INT4_MIN)
      expect(hi, `hi of ${hash}`).toBeLessThanOrEqual(INT4_MAX)
      expect(lo, `lo of ${hash}`).toBeGreaterThanOrEqual(INT4_MIN)
      expect(lo, `lo of ${hash}`).toBeLessThanOrEqual(INT4_MAX)
      expect(Number.isInteger(hi)).toBe(true)
      expect(Number.isInteger(lo)).toBe(true)
    }
  })

  it('位模式没丢：两半拼回去等于原哈希', () => {
    for (const hash of [HIGH_BIT_HASH, -1n, 0n, 42n, BigInt.asIntN(64, 1n << 63n)]) {
      const { hi, lo } = splitHash(hash)
      const rejoined = (BigInt.asUintN(32, BigInt(hi)) << 32n) | BigInt.asUintN(32, BigInt(lo))

      expect(rejoined, `rejoin ${hash}`).toBe(BigInt.asUintN(64, hash))
    }
  })

  it('有符号和无符号形式拆出来一样 —— 调用方传哪种都行', () => {
    expect(splitHash(HIGH_BIT_HASH)).toEqual(splitHash(BigInt.asUintN(64, HIGH_BIT_HASH)))
  })
})

describe('hammingDistance', () => {
  it('全 1 和 0 差 64 位，符号位不会把 1 一路带出来', () => {
    expect(hammingDistance(-1n, 0n)).toBe(64)
  })

  it('只差最高位就是 1，不是 64', () => {
    // 无符号实现里 `1n << 63n` 和 0 的差是 1 位；符号处理错了会变成一长串 1
    expect(hammingDistance(BigInt.asIntN(64, 1n << 63n), 0n)).toBe(1)
  })

  it('跨符号比较：有符号和无符号形式给出同一个距离', () => {
    expect(hammingDistance(HIGH_BIT_HASH, 0n)).toBe(
      hammingDistance(BigInt.asUintN(64, HIGH_BIT_HASH), 0n),
    )
  })

  it('自己和自己距离为 0', () => {
    expect(hammingDistance(HIGH_BIT_HASH, HIGH_BIT_HASH)).toBe(0)
  })
})

describe('十六进制表示', () => {
  it('负哈希也能出十六进制，定长 16 位无符号', () => {
    expect(toHashHex(-1n)).toBe('ffffffffffffffff')
    expect(toHashHex(0n)).toBe('0000000000000000')
    expect(toHashHex(HIGH_BIT_HASH)).toBe('cf6b7b339a5d24e1')
  })

  it('往返回来还是同一个值', () => {
    for (const hash of [HIGH_BIT_HASH, -1n, 0n, 42n]) {
      expect(fromHashHex(toHashHex(hash))).toBe(hash)
    }
  })
})
