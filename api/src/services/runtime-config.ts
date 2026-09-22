import { availableParallelism } from 'node:os'
import { loadRuntimeConfig, saveRuntimeConfig } from '../data/runtime-config.js'
import { FFMPEG_CONCURRENCY } from '../image/constants.js'
import { AppError } from '../lib/app-error.js'
import { log } from '../logger.js'
import { TAG_CONCURRENCY_DEFAULT, TAG_PER_USER_INFLIGHT_DEFAULT } from '../queue/worker.js'
import { PIPELINE_CONCURRENCY_DEFAULT } from './import.js'

/**
 * 运行参数：校验、归一化、组装响应（SPEC §5.6 / §6.5.5）。
 *
 * ## 四个数的性质
 *
 * 它们是**每个服务进程**的上限，不是全站的：多副本时实际全局上限 = 配置值 × 进程数。
 * 这与 [queue.md §1](../../agents/rules/queue.md)「不假设单副本」不冲突——那条管**正确性**
 * （不重复消费），这条管**节流**。真正的全局上限要分布式限流，而本项目不引入 Redis
 * （SPEC §9.11）。**接口文案与界面措辞都必须按「每个服务进程」说**（任务 §陷阱五）。
 *
 * ## 越界报错，不静默截断
 *
 * 截断的表现是「填了 16、提示保存成功、回显还是 2」，管理员会以为没存上（SPEC §9.26）。
 *
 * ⚠️ **默认值不在这个文件里。** 这四个 `*_DEFAULT` 是 import 进来的，不是在这里又写
 *    一遍：默认值只有一处真源，就是它们各自的模块（任务 §陷阱四）。代价是 services/
 *    反向 import 了 `queue/`——接受这个代价，因为把常量搬到这里等于把默认值拆成两份，
 *    而拆开之后没有任何机制保证两边同步。依赖方向没有环：`queue/worker.ts` 与
 *    `services/import.ts` 读配置都走 `data/runtime-config.ts`，不 import 本文件。
 */

/** `ffmpegConcurrency` 的上限封顶。核数是「这台机器同时能跑几个 ffmpeg」唯一有依据的判据。 */
const FFMPEG_CPU_CAP = 16

type Limitable = 'tagConcurrency' | 'tagPerUserInflight' | 'importConcurrency' | 'ffmpegConcurrency'

type FieldLimit = {
  key: Limitable
  /** 中文名，只用在错误文案里（`message` 措辞不进断言，改它是自由的）。 */
  label: string
  min: number
  max: number
  /** 代码默认值。等于它就在保存时归一成 `NULL`。 */
  fallback: number
  /** 上限为什么是它。只有 ffmpeg 那个有——其余三个的上限是产品定的。 */
  hint?: string
}

/**
 * 上下限表。`cpuCount` 是参数而不是在这里现取——**上限与响应里的 `cpuCount` 必须是
 * 同一个数**，所以取值只有一处（两个公开函数各取一次），这里只做派生。
 */
function limitsFor(cpuCount: number): FieldLimit[] {
  return [
    { key: 'tagConcurrency', label: '打标并发任务数', min: 1, max: 16, fallback: TAG_CONCURRENCY_DEFAULT },
    {
      key: 'tagPerUserInflight',
      label: '每用户在途',
      min: 1,
      max: 4,
      fallback: TAG_PER_USER_INFLIGHT_DEFAULT,
    },
    { key: 'importConcurrency', label: '导入管线并发', min: 1, max: 8, fallback: PIPELINE_CONCURRENCY_DEFAULT },
    {
      key: 'ffmpegConcurrency',
      label: 'ffmpeg 上限',
      min: 1,
      max: Math.min(cpuCount, FFMPEG_CPU_CAP),
      fallback: FFMPEG_CONCURRENCY,
      hint: `本机核数 ${cpuCount}`,
    },
  ]
}

/**
 * 客户端能提供的全部字段，就这四个（SPEC §6.5.5：**全部必填、不做部分更新**）。
 *
 * ⚠️ **不要往这里加字段。** 这个类型是「签名即约束」的实现：有了它，调用方就没法把
 *    请求体里多出来的东西顺手塞进配置行——`updatedBy` / `updatedAt` 由服务端填，
 *    客户端给什么都不该生效。
 */
export type RuntimeConfigInput = {
  tagConcurrency: number
  tagPerUserInflight: number
  importConcurrency: number
  ffmpegConcurrency: number
}

export type RuntimeConfigView = RuntimeConfigInput & {
  /** `ffmpegConcurrency` 上限的由来。界面要显示「上限 8（本机核数）」。 */
  cpuCount: number
  /** 从没改过则 `null`。序列化成 ISO 秒是路由的事（`toIsoSecondsOrNull`）。 */
  updatedAt: Date | null
  updatedBy: string | null
}

/** 读生效值。没有 `source` 字段——这里只有一层来源（代码默认值），见 SPEC §5.6。 */
export async function getRuntimeConfig(): Promise<RuntimeConfigView> {
  const cpuCount = availableParallelism()
  const row = await loadRuntimeConfig()

  return {
    ...effectiveValues(row, limitsFor(cpuCount)),
    cpuCount,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  }
}

/**
 * `PUT /admin/runtime`：校验 → 归一化 → 落库 → 回显**生效值**。
 *
 * 回显的是归一化之后的生效值，而不是刚收进去的原始值——界面因此不需要知道哪些列是
 * 空的（SPEC §6.5.5）。这里不再查一次库：归一化后的值和读回来再解析是同一个结果，
 * 多一次查询只是多一个失败点。
 */
export async function saveRuntimeConfigChecked(
  raw: Record<string, unknown>,
  actorId: string,
): Promise<RuntimeConfigView> {
  const cpuCount = availableParallelism()
  const limits = limitsFor(cpuCount)
  const input = validate(raw, limits)

  const now = new Date()
  const stored = normalized(input, limits)
  await saveRuntimeConfig({ ...stored, updatedBy: actorId, updatedAt: now })

  log.info({ ...input, cpuCount, updatedBy: actorId }, '保存运行参数')

  return {
    ...effectiveValues(stored, limits),
    cpuCount,
    updatedAt: now,
    updatedBy: actorId,
  }
}

/** 生效值 = 存了就用存的，没存就用代码默认值。**四个数都是每进程的。** */
function effectiveValues(
  row: Partial<Record<Limitable, number | null>> | null,
  limits: FieldLimit[],
): RuntimeConfigInput {
  const effective = {} as RuntimeConfigInput
  for (const limit of limits) {
    effective[limit.key] = row?.[limit.key] ?? limit.fallback
  }
  return effective
}

/**
 * 等于默认值的输入落成 `NULL`（SPEC §5.6）。
 *
 * 不归一的话，一个显式存的 `2` 会在默认值改成别的数之后把它钉住，而界面上看不出
 * 「这是被钉住的旧默认值」——它显示的也是 `2`，和「用着默认值」长得一模一样。
 */
function normalized(input: RuntimeConfigInput, limits: FieldLimit[]): Record<Limitable, number | null> {
  const stored = {} as Record<Limitable, number | null>
  for (const limit of limits) {
    const value = input[limit.key]
    stored[limit.key] = value === limit.fallback ? null : value
  }
  return stored
}

/**
 * 四组上下限 + 交叉约束。**越界一律 `VALIDATION_FAILED`，不截断成一个合法值。**
 *
 * 请求体的**形状**（是不是 JSON 对象）由路由挡（`routes/` 管参数校验），字段的类型、
 * 整数性、上下限、交叉关系都在这里——它们是业务规则，而且这样能用不经过 HTTP 的
 * 测试覆盖全部分支。
 */
function validate(raw: Record<string, unknown>, limits: FieldLimit[]): RuntimeConfigInput {
  const values = {} as RuntimeConfigInput

  for (const limit of limits) {
    const value = raw[limit.key]
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new AppError('VALIDATION_FAILED', `${limit.key} 必须是整数（四个字段全部必填）`, {
        field: limit.key,
      })
    }
    if (value < limit.min || value > limit.max) {
      const range = `必须在 ${limit.min}–${limit.max} 之间`
      throw new AppError(
        'VALIDATION_FAILED',
        `${limit.label} ${range}${limit.hint === undefined ? '' : `（${limit.hint}）`}`,
        { field: limit.key, min: limit.min, max: limit.max, value },
      )
    }
    values[limit.key] = value
  }

  // 交叉约束：一个人最多能占多少槽，大于总槽数时这一项等于不存在。
  // **静默无效的配置比报错更难查**（SPEC §5.6），所以按越界处理
  if (values.tagPerUserInflight > values.tagConcurrency) {
    throw new AppError(
      'VALIDATION_FAILED',
      `每用户在途（${values.tagPerUserInflight}）不能大于打标并发任务数（${values.tagConcurrency}），否则这一项等于不存在`,
      {
        field: 'tagPerUserInflight',
        value: values.tagPerUserInflight,
        tagConcurrency: values.tagConcurrency,
      },
    )
  }

  return values
}
