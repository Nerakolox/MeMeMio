import type { LiveCover, PersonSummary, SeriesSummaryWithCoverPerson } from '../data/persons.js'
import { publicUrlFor, thumbKeyFor } from '../storage/r2.js'
import { toIsoSeconds, toIsoSecondsOrNull } from './meme.js'

/**
 * 人物与系列的对外序列化（SPEC §6.7.2）。
 *
 * 单独一个文件而不是写在路由里：`GET /persons`、`GET /persons/{id}`、
 * `/suggestions`，以及第二批那些写接口的响应（`merge`、`assignments`）都是同一个
 * 形状——四份实现迟早会在「`cover` 到底给不给 `thumbUrl`」这种地方分叉。
 *
 * ## 三件不许在这里做的事
 *
 * 1. **不返回任何相似度数值**（§6.7.2）。阈值和口径归 api：数值一旦外露，前端就会长出
 *    第二套阈值，然后两边开始不一致。合并建议那一条尤其要注意——它的排序依据就是相似度，
 *    而对外只能是一个「最像的在前」的顺序。
 * 2. **不返回内部字段**：`coverMemeId` 是库里那一列的原值，不是回落后的封面，它在客户端
 *    没有消费场景（客户端要的是能显示的图）。
 * 3. **不自己拼图片地址**：路径经 `thumbKeyFor`、URL 经 `publicUrlFor`，与
 *    `serialize/meme.ts` 是同一对函数。那份注释里记了两次「自己拼一套」的后果
 *    （图片 404，不报错），不要在这里来第三次。
 */

/** §6.7.2 的 Person。`cover` 恒非 null：图数 ≥ 1 的人物一定有封面（§5.7.4）。 */
export type SerializedPerson = {
  id: string
  name: string | null
  seriesId: string | null
  seriesName: string | null
  isHidden: boolean
  memeCount: number
  cover: { memeId: string; thumbUrl: string }
  updatedBy: string | null
  updatedAt: string | null
}

export function serializePerson(summary: PersonSummary, cover: LiveCover): SerializedPerson {
  return {
    id: summary.id,
    name: summary.name,
    seriesId: summary.seriesId,
    seriesName: summary.seriesName,
    isHidden: summary.isHidden,
    memeCount: summary.memeCount,
    cover: { memeId: cover.memeId, thumbUrl: publicUrlFor(thumbKeyFor(cover.storageKey)) },
    updatedBy: summary.updatedBy,
    updatedAt: toIsoSecondsOrNull(summary.updatedAt),
  }
}

/** §6.7.2 的 Series。`cover` 可以为 null：空系列没有封面。 */
export type SerializedSeries = {
  id: string
  name: string
  personCount: number
  memeCount: number
  cover: { memeId: string; thumbUrl: string } | null
  createdBy: string
  createdAt: string
  updatedBy: string | null
  updatedAt: string | null
}

/**
 * @param cover 封面人物的封面。传 `null` / `undefined`（空系列、或那个封面人物的图
 *              刚被删光）时给 null——**不是错误**：系列不论空不空都在（§6.7.3）。
 */
export function serializeSeries(
  summary: SeriesSummaryWithCoverPerson,
  cover: LiveCover | null | undefined,
): SerializedSeries {
  return {
    id: summary.id,
    name: summary.name,
    personCount: summary.personCount,
    memeCount: summary.memeCount,
    cover:
      cover === null || cover === undefined
        ? null
        : { memeId: cover.memeId, thumbUrl: publicUrlFor(thumbKeyFor(cover.storageKey)) },
    createdBy: summary.createdBy,
    createdAt: toIsoSeconds(summary.createdAt),
    updatedBy: summary.updatedBy,
    updatedAt: toIsoSecondsOrNull(summary.updatedAt),
  }
}
