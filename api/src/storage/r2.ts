import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../env.js'
import { log } from '../logger.js'

/**
 * R2 对象存储。Cloudflare R2 走 S3 兼容协议。
 *
 * ⚠️ **这一层的操作不能进数据库事务**（agents/rules/database.md §5）。R2 不在数据库里，
 * 事务回滚不会把对象变回来。正确顺序是「先写 R2，再写库」——失败时留下的是孤儿对象，
 * 定时清理能收；反过来留下的是「库里有记录但文件不存在」，用户能直接看见。
 *
 * 键的布局见 image-pipeline.md §6，三段前缀语义不同：
 *   temp/    预签名直传的落点，待确认与失败的文件在这
 *   memes/   正式对象
 *   thumbs/  缩略图，丢了能重生成，所以清理任务只碰这里和 temp/
 */

/** 预签名 PUT 的有效期。太短会让大图传到一半失效，太长等于给了个长期上传口子。 */
const UPLOAD_URL_TTL_SECONDS = 15 * 60

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.r2.accessKeyId,
    secretAccessKey: env.r2.secretAccessKey,
  },
})

/**
 * 拼一个完整的对象键。**前缀必须带**（`R2_KEY_PREFIX` 以 / 结尾，env 校验保证），
 * 否则与同机其他项目共用 bucket 时对象会互相覆盖。
 */
function key(path: string): string {
  return `${env.r2.keyPrefix}${path}`
}

export function tempKeyFor(batchId: string, fileName: string): string {
  return `temp/${batchId}/${fileName}`
}

/**
 * 正式对象的键。
 *
 * 用随机 uuid 而不是文件名：文件名是用户给的字符串，可能重复、可能是 `../`、
 * 可能带任何字符。用它做键既会互相覆盖，又是个路径穿越面。可读性由
 * `memes.original_filename` 提供，不靠键。
 */
export function permanentKeyFor(memeId: string, format: string): string {
  return `memes/${memeId}.${format}`
}

/**
 * 缩略图键。**必须和正式对象放在不同前缀**——清理任务只碰缩略图和 temp/，
 * 同前缀下「重建缩略图」和「删原图」就是同一次操作。
 *
 * 派生规则：保持 `memes/` 下的相对路径，只换前缀并把扩展名换成 `webp`
 * （`toThumbnail` 固定输出 WebP，见 image/decode.ts）。
 *
 * ⚠️ **写在这里、由 `serialize/meme.ts` 调用**，不各写一份。之前两边各推一套：
 * 这边写 `thumbs/<file>.jpg`，那边给 `/thumb/memes/<file>.jpg`，路径和扩展名都不一致，
 * 结果是入库成功、缩略图 404，而且**不报错**——正是那种要等用户来发现的问题。
 */
export function thumbKeyFor(storageKey: string): string {
  const rest = storageKey.startsWith('memes/') ? storageKey.slice('memes/'.length) : storageKey
  const dot = rest.lastIndexOf('.')
  const stem = dot > 0 ? rest.slice(0, dot) : rest
  return `thumbs/${stem}.webp`
}

/** 签发预签名直传 URL。文件字节不经过 api，只给一个指定键的上传权。 */
export async function presignUpload(params: {
  batchId: string
  fileName: string
}): Promise<{ uploadUrl: string; tempKey: string }> {
  const tempKey = tempKeyFor(params.batchId, params.fileName)
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: env.r2.bucket, Key: key(tempKey) }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  )
  return { uploadUrl, tempKey }
}

/** 读对象。图片管线要在本地解码，所以整份取回——大小上限由 MAX_FILE_BYTES 兜住。 */
export async function getObject(objectKey: string): Promise<Buffer> {
  const result = await client.send(
    new GetObjectCommand({ Bucket: env.r2.bucket, Key: key(objectKey) }),
  )
  if (result.Body === undefined) {
    throw new Error(`R2 对象 ${objectKey} 没有响应体`)
  }
  const bytes = await result.Body.transformToByteArray()
  return Buffer.from(bytes)
}

/**
 * 对象是否存在及大小。预签名直传后**必须实际核一下**：用户可能根本没上传成功
 * （网络断了、关掉页面了），也可能声明 1MB 实际传了 50MB。前端给的 sizeBytes 不可信。
 */
export async function headObject(objectKey: string): Promise<{ sizeBytes: bigint } | null> {
  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: env.r2.bucket, Key: key(objectKey) }),
    )
    return { sizeBytes: BigInt(result.ContentLength ?? 0) }
  } catch {
    return null
  }
}

export async function putObject(
  objectKey: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: env.r2.bucket,
      Key: key(objectKey),
      Body: body,
      ContentType: contentType,
    }),
  )
}

/**
 * 删除对象。**不抛错**——删除是收尾动作，删不掉只该留日志。
 *
 * 报错出去会让「精确重复」这条路径因为清理失败而变成导入失败，而用户的图本来就已经
 * 重复了，这时的正确行为是照常跳过。
 */
export async function deleteObject(objectKey: string): Promise<void> {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: key(objectKey) }))
  } catch (error) {
    log.warn({ err: error, objectKey }, 'R2 删除失败，留给定时清理')
  }
}

/** 公开访问地址。图片由 CDN 直出，api 不做图片代理。SPEC §5.2.6 */
export function publicUrlFor(objectKey: string): string {
  return `${env.r2PublicBaseUrl}/${objectKey}`
}
