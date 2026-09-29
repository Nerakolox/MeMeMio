import type { Probe } from './TestResultPanel'
import type {
  EmbedTestResult,
  ImageEmbedTestResult,
  VisionTestResult,
} from '../../lib/api-config'

/**
 * 把测试连接的响应翻成「逐项列出探测到了什么」的清单（settings-ux.md §5）。
 *
 * 每一项都写了 `unknown` 分支：能力位是 **三态**，`null` 是「这次没探出结论」。
 * 缺了它界面就会把「还没测」显示成「不支持」，而那两件事对用户的意思完全相反。
 *
 * false 分支带 `note` 说明后果——用户要判断的是「这个模型还能不能用」，
 * 光说「不支持多图」他不知道那意味着什么。
 */

export function visionProbes(result: VisionTestResult): Probe[] {
  return [
    {
      value: result.canReceiveImage,
      yes: '能接收图片',
      no: '不能接收图片',
      note: '纯文本模型不能用来打标',
      unknown: '能否接收图片：未探测',
    },
    {
      value: result.jsonModeWorks,
      yes: '支持 JSON 模式',
      no: '不支持 JSON 模式',
      note: '将退回提示词约束 + 解析兜底',
      unknown: 'JSON 模式：未探测',
    },
    {
      value: result.multiImageWorks,
      yes: '支持多图输入',
      no: '不支持多图输入',
      note: '动图将使用拼图模式',
      unknown: '多图输入：未探测',
    },
    {
      value: result.vocabCompliant,
      yes: '返回的标签都在词表内',
      no: '返回的标签有不在词表内的',
      note: '越界的标签会被丢弃，打标质量会下降',
      unknown: '标签是否落在词表内：未探测',
    },
  ]
}

/**
 * 维度这一项不是布尔量，所以先换算成布尔再进清单，实测值写进文案——
 * `nativeDim < 1024` 会被服务端直接拒绝保存（`EMBED_DIM_TOO_SMALL`，SPEC §9.6）。
 */
export function embedProbes(result: EmbedTestResult): Probe[] {
  return [
    {
      value: result.nativeDim === null ? null : result.nativeDim >= 1024,
      yes: `实测输出维度 ${result.nativeDim} ≥ 1024`,
      no: `实测输出维度 ${result.nativeDim} < 1024，不能保存`,
      note: '换一个输出维度更高的模型',
      unknown: '输出维度：未探测',
    },
    {
      value: result.dimParamWorks,
      yes: 'dimensions 参数生效，服务端直接返回 1024 维',
      no: 'dimensions 参数不生效',
      note: '将由客户端截断到 1024 维并重新归一化',
      unknown: 'dimensions 参数：未探测',
    },
  ]
}

/**
 * `willTruncate` 不进 ✓ / ✗ 清单：截断本身不是缺陷，**支持 MRL 的模型截断基本无损**
 * （SPEC §9.6）。标成 ✗ 会让管理员以为选错了模型，而系统并不知道它支不支持 MRL。
 */
export function embedNotes(result: EmbedTestResult): string[] {
  if (result.willTruncate === null) return ['是否需要截断：未探测']
  return result.willTruncate
    ? ['向量会截断到 1024 维并重新归一化；不支持 MRL 的模型截断后检索质量会明显下降']
    : ['无需截断，模型直接输出 1024 维']
}

/**
 * 图片向量的探测清单（SPEC §6.7.5）。在 embedding 那两项之外多一项，
 * 而且那一项**排在最前面**——它是这份配置唯一的硬闸门。
 *
 * `imageInputWorks` 的三态在这里比别处更要紧：`null` 是「**还没测过**」，不是「上游不收图」。
 * 渲染成后者会让管理员去换一个本来没问题的模型（`TestResultPanel` 的 `Probe` 是同一条）。
 *
 * `false` 的 `note` 说清**后果**而不只是「不支持」：上游把图丢掉时它照样回一个向量、
 * 不报错，表现是所有人物慢慢并成一团。用户要判断的正是「这能不能用」，
 * 光说「不支持图片输入」他不知道那意味着什么（对比 `visionProbes` 的 `no` 分支）。
 */
export function imageEmbedProbes(result: ImageEmbedTestResult): Probe[] {
  return [
    {
      value: result.imageInputWorks,
      yes: '上游确实在编码图片',
      no: '上游没有在编码图片，图片被丢掉了',
      note: '这种配置存进来每张图都会被算成差不多的向量，所有人物会慢慢并成一团，而且不报错',
      unknown: '图片是否真的被编码：未探测',
    },
    ...embedProbes(result),
  ]
}

/**
 * 图片向量不用单独写一份 notes——截断的取舍与 embedding 逐字相同（SPEC §9.6）。
 * 包一层只是为了**调用点不必知道那件事**：两边一旦分化，改这里比改调用点安全。
 */
export function imageEmbedNotes(result: ImageEmbedTestResult): string[] {
  return embedNotes(result)
}

