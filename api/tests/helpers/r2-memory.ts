import { vi } from 'vitest'

/**
 * R2 的内存替身。**测试用真的 `src/storage/r2.ts`，只把 AWS SDK 的 `send` 换掉。**
 *
 * 为什么不直接把整个 `storage/r2.js` mock 掉：那个模块里除了网络之外还有真实逻辑——
 * `key()` 拼前缀、`permanentKeyFor` 派生键、`thumbKeyFor` 换了前缀还改了扩展名。
 * 整模块 mock 掉这些就全成了测试自己写的假的，两边同时改错也发现不了。
 * 换 `send` 只砍掉网络这一层，键的拼法与两段上传的事务顺序照旧被测到。
 *
 * 用 `apply` 包住 Proxy 是必须的：`getSignedUrl` 会先调
 * `client.middlewareStack.identify()` / `.resolve()` 再进 `send`，
 * 只挂 send 会让预签名在测试里直接抛错。
 */
export type R2Command =
  | { kind: 'put'; key: string; body: Buffer; contentType: string | undefined }
  | { kind: 'get'; key: string }
  | { kind: 'delete'; key: string }
  | { kind: 'head'; key: string }

/**
 * 一次预签名。**记下 `contentLength`** —— 它是签名绑定的那个大小。
 *
 * 真的 R2 会拿实际 `Content-Length` 和它比，不符直接 403；替身没有「浏览器 PUT」这一步
 * （测试用 `seedObject` 直接放字节），所以在这里断言签名里**绑了**这个值，
 * 而不是假装替身能复现 R2 的拒绝。
 */
export type PresignCall = { key: string; contentLength: number | undefined }

export type R2Calls = { commands: R2Command[]; urls: string[]; presigns: PresignCall[] }

/** 对象键 → 字节。键是**带前缀的完整键**，和 R2 里真实存的一致。 */
const objects = new Map<string, { body: Buffer; contentType: string | undefined }>()

export const r2Calls: R2Calls = { commands: [], urls: [], presigns: [] }

export function resetR2(): void {
  objects.clear()
  r2Calls.commands.length = 0
  r2Calls.urls.length = 0
  r2Calls.presigns.length = 0
}

/**
 * 桶里的键是**带 `R2_KEY_PREFIX` 的完整键**，和 `storage/r2.ts` 的 `key()` 一致。
 *
 * 只在这个 helper 里补一次前缀，断言和 seed 都写业务键（`temp/<batchId>/x.png`）。
 * 否则每条断言都要手写环境变量的值，`.env` 一改整套测试全红，
 * 而红的原因是键前面多了几个字符——不是被测代码的问题。
 */
function full(objectKey: string): string {
  return `${process.env['R2_KEY_PREFIX'] ?? ''}${objectKey}`
}

/**
 * 直接塞一个对象进「桶」。预签名直传那一步在测试里没有浏览器，用它代替前端 PUT。
 * `tempKey` 与 `createBatch` 写进条目的 `temp_storage_key` 是同一个字符串。
 */
export function seedObject(objectKey: string, body: Buffer, contentType?: string): void {
  objects.set(full(objectKey), { body, contentType })
}

export function getObjectBytes(objectKey: string): Buffer | undefined {
  return objects.get(full(objectKey))?.body
}

export function hasObject(objectKey: string): boolean {
  return objects.has(full(objectKey))
}

export function objectKeys(): string[] {
  return [...objects.keys()]
}

/** 取某一类操作的键（去掉部署前缀），断言顺序时用。 */
export function keysOf(kind: R2Command['kind']): string[] {
  return r2Calls.commands
    .filter((c) => c.kind === kind)
    .map((c) => stripPrefix(c.key))
}

function stripPrefix(objectKey: string): string {
  const prefix = process.env['R2_KEY_PREFIX'] ?? ''
  return prefix !== '' && objectKey.startsWith(prefix) ? objectKey.slice(prefix.length) : objectKey
}

/**
 * 把 `send` 换成内存实现，并把预签名换成「把键拼进 URL」的假签名。
 *
 * 预签名也要替掉，而且**不是**因为懒：真的 `getSignedUrl` 要读 `client.config`
 * 里的 region、credentials、endpoint 去算 SigV4，替身没有这些字段，会在预签名
 * 这一步抛错——而那一步是整条导入链路的入口，它一炸后面全测不到。
 * 替身返回的 URL 里带上真实的完整键，所以「前缀有没有拼上」照旧是可断言的。
 *
 * 必须在 import 任何 src 模块**之前**调用。
 */
export function installR2Memory(): void {
  vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>()
    return {
      ...actual,
      S3Client: class {
        middlewareStack = { identify: () => [], resolve: () => async (next: unknown) => next }
        send(command: unknown): Promise<unknown> {
          return send(command)
        }
      },
    }
  })

  vi.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: async (
      _client: unknown,
      command: { input: Record<string, unknown> },
      options: { expiresIn?: number } = {},
    ): Promise<string> => {
      const objectKey = String(command.input['Key'])
      const contentLength = command.input['ContentLength']
      r2Calls.presigns.push({
        key: objectKey,
        // 没绑的话 `input` 里根本没有这个字段，断言会看到 undefined——那正是要测的
        contentLength: typeof contentLength === 'number' ? contentLength : undefined,
      })
      const url = `https://r2.test/${objectKey}?X-Amz-Expires=${options.expiresIn ?? 0}`
      r2Calls.urls.push(url)
      return url
    },
  }))
}

/**
 * 按构造器名字分发。`instanceof` 在 mock 里不可靠（`importOriginal` 拿到的类和
 * 调用方拿到的是同一个，但 `__client` 那条路没有真的实例），名字足够稳。
 */
async function send(command: unknown): Promise<unknown> {
  const name = (command as { constructor: { name: string } }).constructor.name
  const input = (command as { input: Record<string, unknown> }).input
  const key = String(input['Key'])

  if (name === 'PutObjectCommand') {
    const body = Buffer.from(input['Body'] as Buffer)
    objects.set(key, { body, contentType: input['ContentType'] as string | undefined })
    r2Calls.commands.push({
      kind: 'put',
      key,
      body,
      contentType: input['ContentType'] as string | undefined,
    })
    return {}
  }
  if (name === 'GetObjectCommand') {
    const found = objects.get(key)
    if (found === undefined) {
      const error = new Error('NoSuchKey') as Error & { name: string }
      error.name = 'NoSuchKey'
      throw error
    }
    r2Calls.commands.push({ kind: 'get', key })
    return { Body: { transformToByteArray: async () => new Uint8Array(found.body) } }
  }
  if (name === 'DeleteObjectCommand') {
    objects.delete(key)
    r2Calls.commands.push({ kind: 'delete', key })
    return {}
  }
  if (name === 'HeadObjectCommand') {
    const found = objects.get(key)
    if (found === undefined) throw new Error('NotFound')
    r2Calls.commands.push({ kind: 'head', key })
    return { ContentLength: found.body.byteLength }
  }
  throw new Error(`测试的 R2 替身不认识这个命令：${name}`)
}
