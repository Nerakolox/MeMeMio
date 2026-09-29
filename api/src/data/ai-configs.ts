import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { env } from '../env.js'
import { AppError } from '../lib/app-error.js'
import { decryptSecret, encryptSecret, fingerprintSecret } from '../lib/config-crypto.js'
import { isMaskedApiKey, maskApiKey } from '../lib/redact.js'
import { db as defaultDb, type Db } from './db.js'
import { configTests, embedConfig, imageEmbedConfig, userAiConfigs } from './schema.js'

/**
 * `user_ai_configs` / `embed_config` / `config_tests` 的访问方法（SPEC §5.3、§6.5）。
 *
 * **这是整个进程里唯一接触 `env.configEncKey` 的文件。** `lib/config-crypto.ts` 刻意
 * 不认识 env，绑定发生在这里一处——多一处绑定就多一个会把主密钥写进日志的地方。
 *
 * ## 探测结果字段为什么写不进来
 *
 * `vision_json_mode_works` / `vision_multi_image` / `native_dim` / `dim_param_works`
 * 不接受客户端写入（SPEC §5.3、§9.7）。靠注释提醒挡不住下一个人，所以这里用**签名**挡：
 *
 * - 保存配置的函数只收 `ProviderInput`，那个类型**只有 baseUrl / model / apiKey 三个字段**，
 *   没有任何一个探测位；
 * - 探测位不是从参数抄进去的，是 `saveUserVisionConfig` / `saveEmbedConfig` **自己**
 *   回查 `config_tests` 抄进去的。
 *
 * 换句话说：不存在一条从「客户端传来的对象」到探测位列的路径，因为不存在承载它的参数。
 * 想改探测位只有一条路——重新跑一次 `POST /config/<scope>/test`。
 *
 * ## 明文 key 的生命周期
 *
 * 解密只发生在三个地方：回显时立刻脱敏、比对指纹、以及运行时把 key 交给 AI 调用。
 * 每一处都是用完即弃，**不缓存、不进长生命周期对象**（ai-providers.md §7）。
 */

// ── 对外类型 ────────────────────────────────────────────────────────

/**
 * 客户端能提供的全部字段，就这三个（SPEC §6.5.3：「探测结果字段不出现在请求体里」）。
 *
 * ⚠️ **不要往这个类型上加字段。** 它是上面那条「签名即约束」的全部实现——
 *    一旦这里多一个 `jsonModeWorks`，客户端就能写探测位了。
 */
export type ProviderInput = {
  baseUrl: string
  model: string
  /** 明文。脱敏串在进到这里之前已经被 `resolveSubmitted*Key` 换成了库里那把。 */
  apiKey: string
}

/** 视觉探测结果。只由 `POST /config/vision/test` 产生，只经 `recordVisionTest` 落库。 */
export type VisionProbeResult = {
  ok: boolean
  jsonModeWorks: boolean | null
  multiImage: boolean | null
}

export type EmbedProbeResult = {
  ok: boolean
  nativeDim: number | null
  dimParamWorks: boolean | null
}

/**
 * 图片向量的探测结果。**这里是数据层存得下的那几个字段**，报告里另外两个
 * （`willTruncate` / `rawError`）是给界面看的，不落库——同 `EmbedProbeResult` 的分工。
 */
export type ImageEmbedProbeResult = {
  ok: boolean
  nativeDim: number | null
  dimParamWorks: boolean | null
  imageInputWorks: boolean | null
}

/** `GET /config/vision` `GET /config/embed` 的对外形状里属于「已保存配置」的那部分（SPEC §6.5.3）。 */
export type VisionConfigView = {
  baseUrl: string
  model: string
  /** 已经是 "****1234"，**这一层就不再往上传明文**。 */
  maskedApiKey: string | null
  verifiedAt: Date | null
  jsonModeWorks: boolean | null
  multiImageWorks: boolean | null
}

export type EmbedConfigView = {
  baseUrl: string
  model: string
  maskedApiKey: string | null
  verifiedAt: Date | null
  nativeDim: number | null
  dimParamWorks: boolean | null
}

/**
 * 运行时要用的东西：明文 key + 实测出来的能力位。
 *
 * ⚠️ 拿到它就立刻用掉。它是本文件唯一会把明文 key 交出去的返回值。
 */
export type StoredVisionCredentials = {
  baseUrl: string
  apiKey: string
  model: string
  jsonModeWorks: boolean | null
  multiImage: boolean | null
}

export type StoredEmbedCredentials = {
  baseUrl: string
  apiKey: string
  model: string
  nativeDim: number | null
  dimParamWorks: boolean | null
}

/** `GET /config/image-embed` 的「已保存配置」部分（SPEC §6.7.5）。 */
export type ImageEmbedConfigView = {
  baseUrl: string
  model: string
  maskedApiKey: string | null
  verifiedAt: Date | null
  nativeDim: number | null
  dimParamWorks: boolean | null
  imageInputWorks: boolean | null
}

/**
 * 图片向量的运行时凭据。
 *
 * ⚠️ `imageInputWorks` **只会是 true**：`loadImageEmbedCredentials` 在 SQL 层就把
 *    不为 true 的行滤掉了（部署方默认值那一支不走这里，见 `ai/image-embedder.ts`）。
 *    这个字段留在类型里是为了让「它确实是探过的」这件事在调用点上可见。
 */
export type StoredImageEmbedCredentials = {
  baseUrl: string
  apiKey: string
  model: string
  nativeDim: number | null
  dimParamWorks: boolean | null
  imageInputWorks: boolean
}

// ── 内部：加解密的唯一绑定点 ────────────────────────────────────────

function encrypt(plaintext: string): Buffer {
  return encryptSecret(plaintext, env.configEncKey)
}

function decrypt(blob: Buffer): string {
  return decryptSecret(blob, env.configEncKey)
}

/**
 * 三个字段齐全才算「配了」。任意一个为空就是没配——半套配置去调 AI 只会得到
 * 一个难懂的 401，不如当成未配置走兜底。和 `ai/provider.ts` 的 `asCredentials` 同一口径。
 */
function complete(baseUrl: string | null, model: string | null, keyEnc: Buffer | null): boolean {
  return baseUrl !== null && baseUrl !== '' && model !== null && model !== '' && keyEnc !== null
}

// ── 视觉配置 ────────────────────────────────────────────────────────

/**
 * `GET /config/vision` 用。**没配过返回 null**，由路由决定回显部署方默认值。
 *
 * 这里会解密一次，只为算出后四位，算完就丢。不存一列 `key_tail` 是因为那等于
 * 把「后四位」这个事实复制成两份，改 key 时漏更新就会显示错的尾号。
 */
export async function getVisionConfigView(
  userId: string,
  db: Db = defaultDb,
): Promise<VisionConfigView | null> {
  const [row] = await db.select().from(userAiConfigs).where(eq(userAiConfigs.userId, userId)).limit(1)
  if (row === undefined) return null
  if (!complete(row.visionBaseUrl, row.visionModel, row.visionApiKeyEnc)) return null

  return {
    baseUrl: row.visionBaseUrl ?? '',
    model: row.visionModel ?? '',
    maskedApiKey: row.visionApiKeyEnc === null ? null : maskApiKey(decrypt(row.visionApiKeyEnc)),
    verifiedAt: row.verifiedAt,
    jsonModeWorks: row.visionJsonModeWorks,
    multiImageWorks: row.visionMultiImage,
  }
}

/**
 * 运行时解析用（`ai/vision.ts`）。
 *
 * **只认通过过测试的行**：`verified_at` 为 null 的配置不能进生产打标（任务 E 项）。
 * 「测过但没通过」的行 `verified_at` 也是 null——`saveUserVisionConfig` 只在
 * 找到 ok 的测试记录时才写它，所以这里一个条件就够了。
 */
export async function loadUserVisionCredentials(
  userId: string,
  db: Db = defaultDb,
): Promise<StoredVisionCredentials | null> {
  const [row] = await db.select().from(userAiConfigs).where(eq(userAiConfigs.userId, userId)).limit(1)
  if (row === undefined) return null
  if (row.verifiedAt === null) return null
  if (!complete(row.visionBaseUrl, row.visionModel, row.visionApiKeyEnc)) return null

  return {
    baseUrl: row.visionBaseUrl ?? '',
    apiKey: decrypt(row.visionApiKeyEnc as Buffer),
    model: row.visionModel ?? '',
    jsonModeWorks: row.visionJsonModeWorks,
    multiImage: row.visionMultiImage,
  }
}

/**
 * 脱敏串 = 不修改（SPEC §3.5 / §6.5.3）。换成库里那把明文再往下走。
 *
 * 放在数据层是因为它要解密。路由只负责把用户填的串原样递进来，
 * 判断用 `lib/redact.ts` 的 `isMaskedApiKey`，**不在路由里再写一遍前缀判断**。
 *
 * @throws AppError VALIDATION_FAILED —— 此前没配过 key 却传了脱敏串，等于没传（§6.5.3）
 */
export async function resolveSubmittedVisionKey(
  userId: string,
  submitted: string,
  db: Db = defaultDb,
): Promise<string> {
  if (!isMaskedApiKey(submitted)) return submitted

  const [row] = await db
    .select({ enc: userAiConfigs.visionApiKeyEnc })
    .from(userAiConfigs)
    .where(eq(userAiConfigs.userId, userId))
    .limit(1)
  if (row === undefined || row.enc === null) {
    throw new AppError('VALIDATION_FAILED', '此前没有保存过 API Key，需要填写完整的 key')
  }
  return decrypt(row.enc)
}

/**
 * `PUT /config/vision`。
 *
 * **没有探测结果参数**——探测位由本函数自己回查 `config_tests` 抄进来。
 * 调用方多查一次的成本是一次索引命中，换来的是「客户端写不到探测位」这条硬保证。
 *
 * @throws AppError CONFIG_TEST_REQUIRED —— 这个 baseUrl + model + key 指纹的组合
 *         没有成功的测试记录（SPEC §6.5.2）
 */
export async function saveUserVisionConfig(
  userId: string,
  input: ProviderInput,
  db: Db = defaultDb,
): Promise<void> {
  const test = await findVisionTest(userId, input, db)
  if (test === null || !test.ok) {
    throw new AppError('CONFIG_TEST_REQUIRED', '保存前需要先通过测试连接')
  }

  const values = {
    visionBaseUrl: input.baseUrl,
    visionModel: input.model,
    visionApiKeyEnc: encrypt(input.apiKey),
    visionJsonModeWorks: test.jsonModeWorks,
    visionMultiImage: test.multiImage,
    verifiedAt: test.testedAt,
  }
  await db
    .insert(userAiConfigs)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userAiConfigs.userId, set: values })
}

/**
 * 全站有没有**任何一条**通过过测试的视觉配置。
 *
 * 只给队列 worker 的「值不值得取任务」判断用（`ai/vision.ts` 的 `isVisionConfigured`）。
 * 存在性查询 + `limit 1`，不是 count——它落在 worker 的每一轮轮询上。
 */
export async function hasAnyVerifiedVisionConfig(db: Db = defaultDb): Promise<boolean> {
  const rows = await db
    .select({ userId: userAiConfigs.userId })
    .from(userAiConfigs)
    .where(
      and(
        isNotNull(userAiConfigs.verifiedAt),
        isNotNull(userAiConfigs.visionApiKeyEnc),
        isNotNull(userAiConfigs.visionBaseUrl),
        isNotNull(userAiConfigs.visionModel),
      ),
    )
    .limit(1)
  return rows.length > 0
}

// ── Embedding 配置（全站单行） ──────────────────────────────────────

export async function getEmbedConfigView(db: Db = defaultDb): Promise<EmbedConfigView | null> {
  const [row] = await db.select().from(embedConfig).where(eq(embedConfig.id, 1)).limit(1)
  if (row === undefined) return null
  if (!complete(row.baseUrl, row.model, row.apiKeyEnc)) return null

  return {
    baseUrl: row.baseUrl ?? '',
    model: row.model ?? '',
    maskedApiKey: row.apiKeyEnc === null ? null : maskApiKey(decrypt(row.apiKeyEnc)),
    verifiedAt: row.verifiedAt,
    nativeDim: row.nativeDim,
    dimParamWorks: row.dimParamWorks,
  }
}

export async function loadEmbedCredentials(db: Db = defaultDb): Promise<StoredEmbedCredentials | null> {
  const [row] = await db.select().from(embedConfig).where(eq(embedConfig.id, 1)).limit(1)
  if (row === undefined) return null
  if (row.verifiedAt === null) return null
  if (!complete(row.baseUrl, row.model, row.apiKeyEnc)) return null

  return {
    baseUrl: row.baseUrl ?? '',
    apiKey: decrypt(row.apiKeyEnc as Buffer),
    model: row.model ?? '',
    nativeDim: row.nativeDim,
    dimParamWorks: row.dimParamWorks,
  }
}

/** 当前生效的 embedding 模型名。换模型判定（EMBED_MODEL_CHANGED）要用，不需要解密。 */
export async function getEmbedModel(db: Db = defaultDb): Promise<string | null> {
  const [row] = await db.select({ model: embedConfig.model }).from(embedConfig).where(eq(embedConfig.id, 1)).limit(1)
  const model = row?.model ?? null
  return model === '' ? null : model
}

export async function resolveSubmittedEmbedKey(submitted: string, db: Db = defaultDb): Promise<string> {
  if (!isMaskedApiKey(submitted)) return submitted

  const [row] = await db.select({ enc: embedConfig.apiKeyEnc }).from(embedConfig).where(eq(embedConfig.id, 1)).limit(1)
  if (row === undefined || row.enc === null) {
    throw new AppError('VALIDATION_FAILED', '此前没有保存过 API Key，需要填写完整的 key')
  }
  return decrypt(row.enc)
}

/**
 * `PUT /config/embed`。单行表，**用 upsert，不要 insert 后自己判重**——
 * 判重那种写法在两个管理员同时保存时会各插一行，然后撞上 `check (id = 1)` 报个看不懂的错。
 *
 * 维度校验和换模型确认在路由层做（它们要返回不同的错误码，且换模型还要看库里有没有数据），
 * 这里只负责「有成功的测试记录才让写」这一条。
 */
export async function saveEmbedConfig(input: ProviderInput, db: Db = defaultDb): Promise<void> {
  const test = await findEmbedTest(input, db)
  if (test === null || !test.ok) {
    throw new AppError('CONFIG_TEST_REQUIRED', '保存前需要先通过测试连接')
  }

  const values = {
    baseUrl: input.baseUrl,
    model: input.model,
    apiKeyEnc: encrypt(input.apiKey),
    nativeDim: test.nativeDim,
    dimParamWorks: test.dimParamWorks,
    verifiedAt: test.testedAt,
  }
  await db
    .insert(embedConfig)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: embedConfig.id, set: values })
}

// ── 测试记录 ────────────────────────────────────────────────────────

export type VisionTestRecord = VisionProbeResult & { testedAt: Date }
export type EmbedTestRecord = EmbedProbeResult & { testedAt: Date }

/** 图片向量的测试记录，比 embedding 那份多一个 `imageInputWorks`。 */
export type ImageEmbedTestRecord = {
  ok: boolean
  nativeDim: number | null
  dimParamWorks: boolean | null
  imageInputWorks: boolean | null
  testedAt: Date
}

// ── 图片向量配置（全站单行，SPEC §5.7 / §6.7.5） ────────────────────

/**
 * 图片向量配置在**能力位**上与文本 embedding 有一处硬差别，就一处：
 * `image_input_works` 是硬闸门。
 *
 * 少了它，一个「把图静默丢掉、照样回向量」的上游能存进来，此后每张图都被编码成
 * 差不多的向量，所有人物慢慢并成一团——**不报错**（§6.7.5）。
 * 所以这里不是「有测试记录就放行」，而是「图真的被编码过才放行」。
 */
export async function getImageEmbedConfigView(db: Db = defaultDb): Promise<ImageEmbedConfigView | null> {
  const [row] = await db.select().from(imageEmbedConfig).where(eq(imageEmbedConfig.id, 1)).limit(1)
  if (row === undefined) return null
  if (!complete(row.baseUrl, row.model, row.apiKeyEnc)) return null

  return {
    baseUrl: row.baseUrl ?? '',
    model: row.model ?? '',
    maskedApiKey: row.apiKeyEnc === null ? null : maskApiKey(decrypt(row.apiKeyEnc)),
    verifiedAt: row.verifiedAt,
    nativeDim: row.nativeDim,
    dimParamWorks: row.dimParamWorks,
    imageInputWorks: row.imageInputWorks,
  }
}

/**
 * 运行时用的那份。**比 `loadEmbedCredentials` 多两道过滤**：
 *
 * 1. `verified_at` 非空——测试过（同文本那份）
 * 2. `image_input_works = true`——**探到图真的被编码过**
 *
 * 第 2 条是这里的全部理由：这一行要是漏过去，`resolveImageEmbedConfig` 就会返回一份
 * 「以为能用」的配置，而它的失败方式是静默的（所有人并成一团）。SQL 层挡比运行时
 * 每个调用点判一次可靠得多——判断只有一处，就不可能漏。
 */
export async function loadImageEmbedCredentials(
  db: Db = defaultDb,
): Promise<StoredImageEmbedCredentials | null> {
  const [row] = await db.select().from(imageEmbedConfig).where(eq(imageEmbedConfig.id, 1)).limit(1)
  if (row === undefined) return null
  if (row.verifiedAt === null) return null
  if (row.imageInputWorks !== true) return null
  if (!complete(row.baseUrl, row.model, row.apiKeyEnc)) return null

  return {
    baseUrl: row.baseUrl ?? '',
    apiKey: decrypt(row.apiKeyEnc as Buffer),
    model: row.model ?? '',
    nativeDim: row.nativeDim,
    dimParamWorks: row.dimParamWorks,
    imageInputWorks: row.imageInputWorks,
  }
}

/** 当前生效的图片向量模型名。口径比对（换模型 / 换长边）用它，不需要解密。 */
export async function getImageEmbedModel(db: Db = defaultDb): Promise<string | null> {
  const [row] = await db
    .select({ model: imageEmbedConfig.model })
    .from(imageEmbedConfig)
    .where(eq(imageEmbedConfig.id, 1))
    .limit(1)
  const model = row?.model ?? null
  return model === '' ? null : model
}

/**
 * 脱敏串 → 库里那把明文。与 `resolveSubmittedEmbedKey` 逐字同理：用户看到的是
 * `****1234`，原样提交回来时不能当成新 key 去测连接。
 */
export async function resolveSubmittedImageEmbedKey(
  submitted: string,
  db: Db = defaultDb,
): Promise<string> {
  if (!isMaskedApiKey(submitted)) return submitted

  const [row] = await db
    .select({ enc: imageEmbedConfig.apiKeyEnc })
    .from(imageEmbedConfig)
    .where(eq(imageEmbedConfig.id, 1))
    .limit(1)
  if (row === undefined || row.enc === null) {
    throw new AppError('VALIDATION_FAILED', '此前没有保存过 API Key，需要填写完整的 key')
  }
  return decrypt(row.enc)
}

/**
 * `PUT /config/image-embed`。单行表、upsert，理由与 `saveEmbedConfig` 逐字相同。
 *
 * ⚠️ **这里仍然是「签名即约束」那一套**：入参只有 `ProviderInput` 三个字段，
 *    `image_input_works` 不是从参数抄的，是回查测试记录抄的。想改它只有一条路——
 *    重跑 `POST /config/image-embed/test`。
 */
export async function saveImageEmbedConfig(
  input: ProviderInput,
  db: Db = defaultDb,
): Promise<void> {
  const test = await findImageEmbedTest(input, db)
  if (test === null || !test.ok) {
    throw new AppError('CONFIG_TEST_REQUIRED', '保存前需要先通过测试连接')
  }

  const values = {
    baseUrl: input.baseUrl,
    model: input.model,
    apiKeyEnc: encrypt(input.apiKey),
    nativeDim: test.nativeDim,
    dimParamWorks: test.dimParamWorks,
    imageInputWorks: test.imageInputWorks,
    verifiedAt: test.testedAt,
  }
  await db
    .insert(imageEmbedConfig)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: imageEmbedConfig.id, set: values })
}

/**
 * 三个 scope。**`image_embed` 与 `embed` 是两条独立的记录**，哪怕 baseUrl / model /
 * key 完全一样也不共用：它们的探测位不同（`image_input_works` 只有前者有），
 * 而「这份配置能不能存」正是靠探测位判的。共用一条记录会出现「测过文本那份，
 * 图片这份就自动放行」——那等于把这个硬闸门拆了（§6.7.5）。
 */
type TestScope = 'vision' | 'embed' | 'image_embed'

/**
 * 匹配三要素：**baseUrl + model + key 指纹**（SPEC §6.5.2）。
 *
 * 少了指纹，「换了 key 没测就保存」能过校验，而那恰恰是最常见的填错方式。
 * 指纹在 SQL 里比对是安全的——它本身就是公开可算的摘要，不是秘密；
 * `fingerprintEquals` 的常数时间比对留给需要防侧信道的场景，这里走索引。
 */
function testScopeWhere(scope: TestScope, userId: string | null, input: ProviderInput) {
  return and(
    eq(configTests.scope, scope),
    userId === null ? isNull(configTests.userId) : eq(configTests.userId, userId),
    eq(configTests.baseUrl, input.baseUrl),
    eq(configTests.model, input.model),
    eq(configTests.keyFingerprint, fingerprintSecret(input.apiKey)),
  )
}

export async function findVisionTest(
  userId: string,
  input: ProviderInput,
  db: Db = defaultDb,
): Promise<VisionTestRecord | null> {
  const [row] = await db.select().from(configTests).where(testScopeWhere('vision', userId, input)).limit(1)
  if (row === undefined) return null
  return { ok: row.ok, jsonModeWorks: row.jsonModeWorks, multiImage: row.multiImage, testedAt: row.testedAt }
}

export async function findEmbedTest(input: ProviderInput, db: Db = defaultDb): Promise<EmbedTestRecord | null> {
  const [row] = await db.select().from(configTests).where(testScopeWhere('embed', null, input)).limit(1)
  if (row === undefined) return null
  return { ok: row.ok, nativeDim: row.nativeDim, dimParamWorks: row.dimParamWorks, testedAt: row.testedAt }
}

/**
 * 落一条测试记录。同一组合只留最近一次——先删后插，同事务。
 *
 * 不用 `onConflictDoUpdate` 是因为唯一约束得建在 `(scope, user_id, base_url, model, fingerprint)`
 * 上，而 `user_id` 在 embed 记录里是 NULL，Postgres 的唯一索引认为两个 NULL 不相等，
 * 全站配置会一直往里堆行。删+插绕开这件事，代价是一次事务。
 *
 * ⚠️ 这里存的是**指纹**，不是明文也不是密文（SPEC §6.5.2）。本函数全程不碰
 *    `env.configEncKey`——如果哪天有人想在这张表上加一列密文，先回读 §6.5.2。
 */
export async function recordVisionTest(
  userId: string,
  input: ProviderInput,
  probe: VisionProbeResult,
  db: Db = defaultDb,
): Promise<Date> {
  return recordTest('vision', userId, input, {
    ok: probe.ok,
    jsonModeWorks: probe.jsonModeWorks,
    multiImage: probe.multiImage,
  }, db)
}

export async function recordEmbedTest(
  input: ProviderInput,
  probe: EmbedProbeResult,
  db: Db = defaultDb,
): Promise<Date> {
  return recordTest('embed', null, input, {
    ok: probe.ok,
    nativeDim: probe.nativeDim,
    dimParamWorks: probe.dimParamWorks,
  }, db)
}

export async function findImageEmbedTest(
  input: ProviderInput,
  db: Db = defaultDb,
): Promise<ImageEmbedTestRecord | null> {
  const [row] = await db
    .select()
    .from(configTests)
    .where(testScopeWhere('image_embed', null, input))
    .limit(1)
  if (row === undefined) return null
  return {
    ok: row.ok,
    nativeDim: row.nativeDim,
    dimParamWorks: row.dimParamWorks,
    imageInputWorks: row.imageInputWorks,
    testedAt: row.testedAt,
  }
}

export async function recordImageEmbedTest(
  input: ProviderInput,
  probe: ImageEmbedProbeResult,
  db: Db = defaultDb,
): Promise<Date> {
  return recordTest('image_embed', null, input, {
    ok: probe.ok,
    nativeDim: probe.nativeDim,
    dimParamWorks: probe.dimParamWorks,
    imageInputWorks: probe.imageInputWorks,
  }, db)
}

type ProbeColumns = {
  ok: boolean
  jsonModeWorks?: boolean | null
  multiImage?: boolean | null
  nativeDim?: number | null
  dimParamWorks?: boolean | null
  imageInputWorks?: boolean | null
}

async function recordTest(
  scope: TestScope,
  userId: string | null,
  input: ProviderInput,
  probe: ProbeColumns,
  db: Db,
): Promise<Date> {
  const testedAt = new Date()
  await db.transaction(async (tx) => {
    await tx.delete(configTests).where(testScopeWhere(scope, userId, input))
    await tx.insert(configTests).values({
      scope,
      userId,
      baseUrl: input.baseUrl,
      model: input.model,
      keyFingerprint: fingerprintSecret(input.apiKey),
      testedAt,
      ...probe,
    })
  })
  return testedAt
}
