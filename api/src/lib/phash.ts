/**
 * 感知哈希（pHash）与 Hamming 距离。
 *
 * 纯函数、零 import：喂一串灰度像素就能算，不起 Postgres、不碰 sharp。
 * 用哪种缩放由调用方（`image/phash.ts`）决定，这里只管算法。
 *
 * ⚠️ 命名区分：`memes.phash` 是**入库去重**用的整图哈希；
 *    动图抽帧时还有一份**帧间去重**的哈希（见 `image/frames.ts`），
 *    两者阈值和用途都不同，不要合并。见 agents/rules/image-pipeline.md §3。
 */

/** dHash 的块尺寸：9 列 × 8 行，横向相邻像素比大小，得到 64 位。 */
export const HASH_WIDTH = 9
export const HASH_HEIGHT = 8

/** dHash 输出 64 位。 */
export const HASH_BITS = (HASH_WIDTH - 1) * HASH_HEIGHT

const HEX_WIDTH = 16

/**
 * 由 9×8 灰度像素算 dHash。
 *
 * **为什么是 dHash 而不是 aHash / pHash(DCT)：** 它只比相邻像素的亮度大小，
 * 对「同一模板换了字」「压缩过一遍」「尺寸变了一点」都稳定，而那正是表情包库里的重复形态。
 * DCT 版对缩放和压缩更鲁棒，但在这个分辨率下多出来的鲁棒性换不回多写的代码量。
 *
 * ⚠️ **返回的是有符号 64 位**，和 `memes.phash` 的 `bigint` 列一模一样（SPEC §5.2）。
 * 哈希是 64 位满的，最高位有一半概率为 1；留着无符号形式最大会到 2^64-1，
 * 写进 int8 列直接 `value ... is out of range for type bigint`。
 * **位模式才是哈希本身，符号只是 int8 的表示方式**——本文件所有消费者
 * （`hammingDistance` / `splitHash` / `toHashHex`）都先按位取 64 位，
 * 传有符号还是无符号进来结果都一样。不要「顺手把负数改回正数」。
 *
 * @param gray 长度必须是 HASH_WIDTH * HASH_HEIGHT，行优先，0..255
 */
export function dHashFromGray(gray: Uint8Array): bigint {
  const expected = HASH_WIDTH * HASH_HEIGHT
  if (gray.length !== expected) {
    throw new Error(`dHash 输入长度必须是 ${expected}，实际 ${gray.length}`)
  }

  let hash = 0n
  let bit = 0
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH - 1; x += 1) {
      const left = gray[y * HASH_WIDTH + x] ?? 0
      const right = gray[y * HASH_WIDTH + x + 1] ?? 0
      // 左比右亮记 1。相等记 0——不引入随机性，同样的图必须得到同样的哈希
      if (left > right) hash |= 1n << BigInt(bit)
      bit += 1
    }
  }
  return BigInt.asIntN(HASH_BITS, hash)
}

/**
 * 十六进制表示，定长 16 位，**不带 `0x`、不带符号**。
 *
 * 这个形式很关键：`memes.phash` 是 `bigint`（有符号 64 位），最高位为 1 的哈希
 * 写成十进制会变成负数，跨语言、跨 SQL 都容易读错。定长十六进制是唯一无歧义的写法。
 */
export function toHashHex(hash: bigint): string {
  // 负数进来是正常的（见 `dHashFromGray`），取它的 64 位位模式，不是报错的理由
  return BigInt.asUintN(HASH_BITS, hash).toString(16).padStart(HEX_WIDTH, '0')
}

export function fromHashHex(hex: string): bigint {
  return BigInt.asIntN(HASH_BITS, BigInt(`0x${hex}`))
}

/** 两个 64 位哈希的 Hamming 距离。按位取 64 位，避免符号位把 1 一路带出来。 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(HASH_BITS, a ^ b)
  let count = 0
  while (x !== 0n) {
    // 每轮消掉最低位的 1
    x &= x - 1n
    count += 1
  }
  return count
}

/**
 * 把一个 64 位哈希拆成高、低两个 32 位整数，**两个都是有符号 int4**。
 *
 * **为什么需要拆：** SPEC §5.2 把 `phash` 定成 `bigint`（有符号），而 Postgres 的
 * `bit_count` 没有 `bigint` 重载，只有 `bit` / `bytea`。直接 `bit_count(phash # $1)`
 * 会 `function bit_count(bigint) does not exist`。拆成两个 int4 各自 XOR 再 `bit_count(…::bit(32))`，
 * 避开无符号 64 位在 SQL 里无法表示的问题（18446744073709551615 超出 int8 范围）。
 *
 * ⚠️ **为什么是有符号：** int4 上限是 2147483647，而 32 位的半个哈希有一半概率超过它。
 * 返回无符号值会让查询里的 `$1::int` 报 `value "3480189747" is out of range for type integer`，
 * 而且是 Bind 阶段就报——库里一行都没有照样炸，表现是「导入几乎每张图都失败」。
 * `::bit(32)` 只认位模式，有符号和无符号异或出来的 `bit_count` 完全一样。
 */
export function splitHash(hash: bigint): { hi: number; lo: number } {
  const unsigned = BigInt.asUintN(HASH_BITS, hash)
  return {
    hi: Number(BigInt.asIntN(32, unsigned >> 32n)),
    lo: Number(BigInt.asIntN(32, unsigned)),
  }
}
