import { eq } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { runtimeConfig } from './schema.js'

/**
 * 运行参数的**唯一 SQL 落点**（SPEC §5.6）。单行表，`NULL` 列 = 用代码默认值。
 *
 * ## 不缓存
 *
 * 每次用之前查一次库，读到的就是别的进程刚写进去的值——「改完不用重启」全靠这一条。
 * **不要在这里加进程内缓存或事件通知**（§9.26）：worker 不假设单副本
 * （[queue.md §1](../../agents/rules/queue.md)），进程内通知到不了别的进程，读库才能到。
 * 视觉通道（`isVisionConfigured`）和 embedding 通道（`isEmbedConfigured`）都是这么做的。
 *
 * ⚠️ **默认值不在这个文件里。** 四列的可空语义要配上「默认几」才完整，而那份默认值
 *    只有一处真源——四个模块级常量（`queue/worker.ts`、`services/import.ts`、
 *    `image/constants.ts`）。在这里再抄一张默认值表，两处迟早分叉（任务 §陷阱四）。
 *    归一化的比对在 `services/runtime-config.ts` 里做，它 import 的是那几个常量本身。
 */

/** 未经序列化的数据库行。`null` = 一行都没有（从没配过），四个字段都可能是 `null`。 */
export type RuntimeConfigRow = {
  tagConcurrency: number | null
  tagPerUserInflight: number | null
  importConcurrency: number | null
  ffmpegConcurrency: number | null
  updatedBy: string | null
  updatedAt: Date | null
}

/** 现查单行，照 `data/ai-configs.ts` 的 `loadEmbedCredentials`。 */
export async function loadRuntimeConfig(db: Db = defaultDb): Promise<RuntimeConfigRow | null> {
  const [row] = await db.select().from(runtimeConfig).where(eq(runtimeConfig.id, 1)).limit(1)
  if (row === undefined) return null

  return {
    tagConcurrency: row.tagConcurrency,
    tagPerUserInflight: row.tagPerUserInflight,
    importConcurrency: row.importConcurrency,
    ffmpegConcurrency: row.ffmpegConcurrency,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  }
}

/**
 * 写单行。**调用方必须已经做过归一化**——`null` 在这里就是「用代码默认值」，
 * 数据层不判断哪个值算默认（它不认识那几个常量）。
 */
export async function saveRuntimeConfig(
  values: RuntimeConfigRow & { updatedBy: string | null; updatedAt: Date },
  db: Db = defaultDb,
): Promise<void> {
  const patch = {
    tagConcurrency: values.tagConcurrency,
    tagPerUserInflight: values.tagPerUserInflight,
    importConcurrency: values.importConcurrency,
    ffmpegConcurrency: values.ffmpegConcurrency,
    updatedBy: values.updatedBy,
    updatedAt: values.updatedAt,
  }
  await db
    .insert(runtimeConfig)
    .values({ id: 1, ...patch })
    .onConflictDoUpdate({ target: runtimeConfig.id, set: patch })
}
