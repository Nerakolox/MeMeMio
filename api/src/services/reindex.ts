import { embedText, resolveEmbedConfig } from '../ai/embedder.js'
import { applyEmbedding, getSearchTextForEmbedding } from '../data/memes.js'
import { log } from '../logger.js'

/**
 * 重算一张图的向量（SPEC §6.5.4）。
 *
 * ⚠️ **只重算 embedding。** 从 `search_text` 重新生成向量，**不重新调视觉模型、
 *    不改任何 AI 产出字段**——换 embedding 模型不影响打标结果，重跑视觉是白花钱，
 *    而且会把用户手工编辑过的 description / tags 覆盖掉。
 *
 *    这一条靠本文件的 import 列表保证：这里根本没有 `ai/vision.js`。
 *
 * 不抛异常，返回值告诉 worker 是哪一类（同 `services/tagging.ts` 的口径）。
 */

export type ReindexOutcome =
  | { kind: 'done' }
  /** 图在排队期间被删了，或者 `search_text` 空了。任务判完成，没什么可重试的。 */
  | { kind: 'gone' }
  /** 没配 embedding 通道。**不消费重试次数**，推后再来。 */
  | { kind: 'not_configured' }
  | { kind: 'failed'; detail: string }

export async function reindexMeme(memeId: string): Promise<ReindexOutcome> {
  // 软删过滤在 getSearchTextForEmbedding 里。重算是异步的，图完全可能在排队期间被删
  const searchText = await getSearchTextForEmbedding(memeId)
  if (searchText === null) return { kind: 'gone' }

  const config = await resolveEmbedConfig()
  if (config === null) return { kind: 'not_configured' }

  // 文档侧**不加 instruct 前缀**（retrieval.md §4）。加了会和打标时写进去的向量
  // 不在同一个空间里，表现是搜索悄悄变差，不报错
  const result = await embedText(searchText, config)
  if (!result.ok) {
    if (result.reason === 'not_configured') return { kind: 'not_configured' }
    return { kind: 'failed', detail: `embedding ${result.reason}` }
  }

  // `embed_model` 写的必须是**真正算出这个向量的那个模型名**——config 是上面解析出来
  // 那一份，不是重新解析的。两次解析之间配置可能刚好被改掉，那时写进去的模型名对不上，
  // 不报错，只是那条记录从此被当成「已经是新模型了」永远不再重算
  const written = await applyEmbedding(memeId, result.vector, config.model)
  if (!written) return { kind: 'gone' }

  log.debug({ memeId, model: config.model }, '重算向量完成')
  return { kind: 'done' }
}
