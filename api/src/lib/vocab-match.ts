import { vocabulary } from '../vocab.js'

/**
 * 标签通路的查询词归一化。纯函数，测它不用起 Postgres（project-structure.md）。
 *
 * 用户搜「无语 猫」时，期望的是「无语」和「猫」两个词条各自命中，而不是把整串
 * 当成一个不存在的标签。所以先切词再逐条查词表。
 *
 * ⚠️ **不硬编码任何具体词条**（vocab.ts 的警告）：词表当前是 `proposed`，
 *    `if (term === '无语')` 这种分支会在词表修订时变成债。这里只做「在不在词表里」。
 */

/**
 * 切词分隔符。中文没有空格，所以除了空白还要切常见标点——
 * 「无语,猫」「无语、猫」都该切成两个词。
 *
 * 不做真正的分词（那是 zhparser 的事，SPEC §9.10 明确不装）。切不出来的长串
 * 直接用原文查词表，查不到就是没命中，这比猜错强。
 */
const SEPARATORS = /[\s,，、;；/|+]+/

/** 词表里最短的词条也就两个字，单字查询只会满库乱命中，直接丢掉。 */
const MIN_TERM_LENGTH = 2

/** 词条总数很少，每次查询现拼一个 Set 的开销可以忽略，不必做缓存失效。 */
function knownTerms(): Set<string> {
  return new Set([
    ...vocabulary.emotions,
    ...vocabulary.scenes,
    ...vocabulary.tags.subject,
    ...vocabulary.tags.style,
  ])
}

/**
 * 把查询切成落在词表内的词条，用于标签通路。
 *
 * 只做单跳别名归一化，不做链式解析（shared/vocab/README.md）——`A → B` 且 `B → C`
 * 是词表配置错误，不是这里要兜的情况。
 *
 * @returns 去重后的词条，顺序保持用户输入顺序。可能为空数组，那是正常情况（标签路不召回）。
 */
export function matchVocabTerms(query: string): string[] {
  const terms = knownTerms()
  const aliases = vocabulary.aliases ?? {}
  const matched: string[] = []
  const seen = new Set<string>()

  for (const raw of query.split(SEPARATORS)) {
    const token = raw.trim()
    if (token.length < MIN_TERM_LENGTH) continue

    // 别名优先：模型输出「服了」时会被归一化成「无语」，用户搜「服了」应当同样命中
    const canonical = aliases[token] ?? token
    if (!terms.has(canonical)) continue
    if (seen.has(canonical)) continue

    seen.add(canonical)
    matched.push(canonical)
  }

  return matched
}
