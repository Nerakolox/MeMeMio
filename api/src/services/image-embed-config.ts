import { probeImageEmbed, type ImageEmbedProbeReport } from '../ai/probe.js'
import { asCredentials } from '../ai/provider.js'
import {
  findImageEmbedTest,
  getImageEmbedConfigView,
  getImageEmbedModel,
  recordImageEmbedTest,
  resolveSubmittedImageEmbedKey,
  saveImageEmbedConfig,
  type ProviderInput,
} from '../data/ai-configs.js'
import { hasPersonVectors } from '../data/memes.js'
import { env } from '../env.js'
import { PERSON_EMBED_DIM } from '../image/constants.js'
import { AppError } from '../lib/app-error.js'
import { maskApiKey } from '../lib/redact.js'
import { log } from '../logger.js'
import { restartPersonVectorReindex } from './person-vectors.js'

/**
 * 图片向量配置的编排（SPEC §6.7.5，与 `/config/embed` 同构）。
 *
 * ## 为什么不跟文本 embedding 那份写在一个文件里
 *
 * 它们**看起来**只是换个表名，其实是两条独立的配置流（§5.7.1）：
 *
 * - 探测位不同：这份多一个 `imageInputWorks`，而它是硬闸门
 * - 保存的后果不同：文本那份作废的是 `memes.embedding`，这份作废的是
 *   `meme_subjects.embedding`，**每张图重算一次付费调用**
 * - 文件依赖不同：这里要 import `services/person-vectors.ts`，而那边 import 的是
 *   `services/ai-config.ts` 的两个常量——合在一起就是**循环 import**，
 *   表现是 `ENQUEUE_CAP` 在某个入口下是 `undefined`，翻页循环永远走不到出口
 *
 * 前两条是「分开更清楚」，第三条是「不分不行」。
 *
 * ## 明文 key 在这一层活多久
 *
 * 与 `services/ai-config.ts` 逐字相同：`resolveSubmittedImageEmbedKey` 拿到明文，
 * 交给探测或加密，随函数返回消失。**不进日志、不进返回值、不进 AppError 的 details**。
 * 本文件里所有 `log.*` 只记 `baseUrl` 和 `model`。
 */

/** SPEC §6.7.5 的对外形状。`apiKey` 永远是 "****1234" 或 null。 */
export type ImageEmbedConfigResponse = {
  source: 'user' | 'default'
  baseUrl: string
  model: string
  apiKey: string | null
  verifiedAt: Date | null
  nativeDim: number | null
  dimParamWorks: boolean | null
  /** 探到图真的被编码过。**没测过是 null，不是 false**（§6.7.5）。 */
  imageInputWorks: boolean | null
}

/**
 * `GET /config/image-embed`。没配过就回显部署方默认值并带 `source: "default"`。
 *
 * 能力位固定 null，与 `getEmbedConfig` 同理：部署方那一套同样没有测试记录，
 * 不能因为「这是我们自己配的」就假设它支持什么。⚠️ 这一点在**这份**配置上比对
 * 文本那份更要紧——`resolveImageEmbedConfig` 只认 `image_input_works = true` 的
 * **库里那行**，部署方默认值走的是另一支，所以这里的 null 不是「没测」，
 * 是「本来就没有可测的东西」。
 */
export async function getImageEmbedConfig(): Promise<ImageEmbedConfigResponse> {
  const view = await getImageEmbedConfigView()
  if (view !== null) {
    return {
      source: 'user',
      baseUrl: view.baseUrl,
      model: view.model,
      apiKey: view.maskedApiKey,
      verifiedAt: view.verifiedAt,
      nativeDim: view.nativeDim,
      dimParamWorks: view.dimParamWorks,
      imageInputWorks: view.imageInputWorks,
    }
  }

  const fallback = asCredentials(env.defaultImageEmbed)
  return {
    source: 'default',
    baseUrl: fallback?.baseUrl ?? '',
    model: fallback?.model ?? '',
    // 部署方的 key 同样只给后四位（AGENTS.md §5）
    apiKey: maskApiKey(fallback?.apiKey ?? null),
    verifiedAt: null,
    nativeDim: null,
    dimParamWorks: null,
    imageInputWorks: null,
  }
}

/**
 * `POST /config/image-embed/test`。**不改变当前生效的配置**（§6.5.3）。
 *
 * 不通过也是 200，结果在响应体里——这里的 `rawError` 尤其重要：上游把图静默丢掉时
 * 用户唯一能拿到的线索就是上游回的那段话（`probe.ts` 甚至会把
 * `image_tokens = 0` 的解释拼在前面）。
 */
export async function testImageEmbedConfig(
  input: ProviderInput,
): Promise<ImageEmbedProbeReport> {
  const report = await probeImageEmbed(input)

  // 探测结果只经这一条路进库，客户端传不进来（`data/ai-configs.ts` 的签名挡着）
  await recordImageEmbedTest(input, report)

  log.info(
    {
      baseUrl: input.baseUrl,
      model: input.model,
      ok: report.ok,
      nativeDim: report.nativeDim,
      imageInputWorks: report.imageInputWorks,
    },
    '图片向量通道测试连接',
  )
  return report
}

/** 脱敏串 → 库里那把明文。理由与 `resolveEmbedKey` 逐字相同。 */
export async function resolveImageEmbedKey(submitted: string): Promise<string> {
  return resolveSubmittedImageEmbedKey(submitted)
}

export type SaveImageEmbedOutcome = {
  /** 这次保存换了模型。换了就意味着全站人物向量作废。 */
  modelChanged: boolean
  /**
   * 顺带排进队列的重算任务数。没换模型时为 0。
   *
   * **名字必须带 `Count`**（§6.5.3）。它是条数不是布尔，而这里的条数**每一张都是
   * 一次付费调用**——界面要靠它说清「这一下要花多少钱」。
   */
  reindexEnqueuedCount: number
}

/**
 * `PUT /config/image-embed`。三道闸门，**顺序与 `saveEmbedConfigChecked` 一致**：
 *
 *   1. 有没有通过的测试记录 → `CONFIG_TEST_REQUIRED`
 *   2. 实测维度够不够 → `EMBED_DIM_TOO_SMALL`
 *   3. 换模型且库里已有人物向量、又没带确认 → `EMBED_MODEL_CHANGED`（409）
 *
 * ⚠️ **第 1 道在这里多问一句 `imageInputWorks`。** 数据层（`saveImageEmbedConfig`）
 *    本来就会挡——`probeImageEmbed` 判 false 时 `ok` 也是 false，那条记录过不了
 *    CONFIG_TEST_REQUIRED。但**用户会看不懂那条消息**：他明明点了测试，界面还把
 *    「图被丢掉了」摆在眼前，保存时却被告知「保存前需要先通过测试连接」。
 *    这里用同一个错误码给一句能对上号的说明，真正的闸门仍在数据层那一句。
 *
 * ⚠️ **第 3 道的 `confirmReindex` 语义与文本侧不同**：那边是「全站向量作废」，
 *    这边是「**全站每张图再花一次钱**」（§6.7.5）。所以这个布尔在这条路上不能默认
 *    为真，界面必须真的问过。库里一个向量都没有时不拦，理由同文本侧：没有东西可重算。
 */
export async function saveImageEmbedConfigChecked(
  input: ProviderInput,
  confirmReindex: boolean,
): Promise<SaveImageEmbedOutcome> {
  const test = await findImageEmbedTest(input)

  // 先单独问一句「图到底有没有被编码」：`ok` 为 false 的原因有好几种，
  // 这一种要把话说清楚
  if (test !== null && test.imageInputWorks === false) {
    throw new AppError(
      'CONFIG_TEST_REQUIRED',
      '测试连接显示上游没有真的编码图片（image_tokens 为 0，或两张不同的图算出的向量几乎一样），这份配置不能保存',
    )
  }

  if (test === null || !test.ok) {
    throw new AppError('CONFIG_TEST_REQUIRED', '保存前需要先通过测试连接')
  }

  if (test.nativeDim !== null && test.nativeDim < PERSON_EMBED_DIM) {
    // 维度不足没法截断补齐，向量列是 1024 维的固定形状（§9.6）
    throw new AppError(
      'EMBED_DIM_TOO_SMALL',
      `实测输出 ${test.nativeDim} 维，低于要求的 ${PERSON_EMBED_DIM} 维`,
      { nativeDim: test.nativeDim, required: PERSON_EMBED_DIM },
    )
  }

  const currentModel = await getImageEmbedModel()
  const modelChanged = currentModel !== null && currentModel !== input.model

  if (modelChanged && !confirmReindex) {
    // 没数据就不拦，理由同文本侧
    if (await hasPersonVectors()) {
      throw new AppError(
        'EMBED_MODEL_CHANGED',
        '更换图片向量模型会让全站已有的人物向量作废，需要确认后重算',
        { currentModel, nextModel: input.model },
      )
    }
  }

  // ⚠️ 上面这四道闸门在数据层**又各有一遍**（`saveImageEmbedConfig` 会自己回查测试
  //  记录）。那是故意的：真正的闸门只有一处，路由绕过这次编排也挡得住。
  //  这里的重复是为了「顺序」和「错误消息能对上号」，不是为了省一次查询。
  await saveImageEmbedConfig(input)
  log.info(
    { baseUrl: input.baseUrl, model: input.model, modelChanged },
    '保存图片向量配置',
  )

  if (!modelChanged) return { modelChanged: false, reindexEnqueuedCount: 0 }

  // 换模型 = 全站重算。**这里必须先把上一轮的 failed 行清掉**，理由见
  // `restartPersonVectorReindex`
  const reindexEnqueuedCount = await restartPersonVectorReindex()
  log.info(
    { model: input.model, reindexEnqueuedCount },
    '换图片向量模型，全站人物向量重算入队',
  )
  return { modelChanged: true, reindexEnqueuedCount }
}
