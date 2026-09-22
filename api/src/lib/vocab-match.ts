import { isKnownTerm, vocabulary } from '../vocab.js'

/**
 * 标签通路的查询词归一化。纯函数，测它不用起 Postgres（project-structure.md）。
 *
 * 用户搜「无语 猫」时，期望的是「无语」和「猫」两个词条各自命中，而不是把整串
 * 当成一个不存在的标签。所以先切词再逐条查词表。
 *
 * ⚠️ **不硬编码任何具体词条**（vocab.ts 的警告）：词表当前是 `proposed`，
 *    `if (term === '无语')` 这种分支会在词表修订时变成债。这里只做「在不在词表里」。
 *
 * **这一层不知道词属于哪个维度。** 用户搜「微笑」时不会声明那是 `expressions`，
 * 所以命中判定走 `isKnownTerm`（任一维度有就算），过滤条件由 `data/search.ts` 展开成
 * 七个数组的 OR。维度是打标和筛选 UI 的事，不是查询分词的事。
 */

/**
 * 切词分隔符。中文没有空格，所以除了空白还要切常见标点——
 * 「无语,猫」「无语、猫」都该切成两个词。
 *
 * 不做真正的分词（那是 zhparser 的事，SPEC §9.10 明确不装）。切不出来的长串
 * 会先整串查一次词表，再走下面的助词兜底，都不中就是没命中。
 */
const SEPARATORS = /[\s,，、;；/|+]+/

/**
 * 结构助词。**只在整串查不到词表时才拿来二次切分**，顺序不能反过来。
 *
 * 反过来的代价是具体的：`得意`、`得逞` 里就带着「得」，把「得」当成一级分隔符会把它们
 * 切成两个查不到的碎片。先整串命中、再助词兜底，两个词条都安然无恙，而「敷衍的微笑」
 * 仍然能切成「敷衍」+「微笑」。
 *
 * ⚠️ **这不是模糊匹配。** 只按结构助词切，不做子串扫描——
 * `vocab-match.test.ts` 钉着「整串里嵌着词条不算命中」那条，别在这里偷偷加一个 includes。
 */
const PARTICLES = /[的地得]/

/**
 * 明确的排除词。**贴着词写也算**——「排除真人」「除了动漫」没有第二种读法。
 *
 * 「不要」「不想」不在这里，理由见 `SOFT_NEGATORS`。
 */
const HARD_NEGATORS = ['排除', '去掉', '去除', '不含', '不带', '除了', '非']

/**
 * 只在**独立成词**时才算排除的否定词。
 *
 * 为什么要分两档：「不想上班」是**心情**，不是「排除上班」——那正是 SPEC §9.10 拿来
 * 举例的那句查询。贴着词的 `不想 / 不要` 一律按心情处理，只有用户自己用空格或标点把它
 * 隔开（「猫，不要 真人」）才当成排除。**宁可漏掉一个排除，也不能把用户想搜的东西删掉。**
 */
const SOFT_NEGATORS = ['不要', '不想要', '不用', '别', '不']

/** 一元 `-` 前缀，搜索框里的老习惯：`猫 -真人`。 */
const MINUS_PREFIX = /^[-−](.+)$/

export type QueryTerms = {
  /** 用户想要的标签，顺序保持输入顺序。可能为空数组，那是正常情况（标签路不召回）。 */
  include: string[]
  /**
   * 用户明确不要的标签。**这是过滤条件，不是负分**（SPEC §6.3.1）——
   * 三路召回之前就把带这些标签的图剔掉，不靠排序把它们压下去。
   */
  exclude: string[]
}

function canonicalize(token: string): string | null {
  const aliases = vocabulary.aliases ?? {}
  // 别名优先：模型输出「服了」时会被归一化成「无语」，用户搜「服了」应当同样命中
  const canonical = aliases[token] ?? token
  return isKnownTerm(canonical) ? canonical : null
}

/** 剥掉一层否定前缀，返回被否定的那个词条；不是否定就返回 null。 */
function stripNegation(token: string): string | null {
  const minus = MINUS_PREFIX.exec(token)
  if (minus?.[1] !== undefined) return canonicalize(minus[1])

  for (const negator of HARD_NEGATORS) {
    if (token.length > negator.length && token.startsWith(negator)) {
      return canonicalize(token.slice(negator.length))
    }
  }
  return null
}

/**
 * 把查询切成落在词表内的词条，用于标签通路。
 *
 * 只做单跳别名归一化，不做链式解析（shared/vocab/README.md）——`A → B` 且 `B → C`
 * 是词表配置错误，不是这里要兜的情况。
 *
 * **同一个词既被要又被排除时，排除赢。** 用户写死的条件优先于顺带提到的词。
 */
export function matchVocabTerms(query: string): QueryTerms {
  const include: string[] = []
  const exclude: string[] = []
  const seen = new Set<string>()
  const excluded = new Set<string>()

  /** 上一个 token 是独立的否定词时置位，只作用于**紧接着的下一个**命中，然后复位。 */
  let pendingNegation = false

  const take = (term: string, negated: boolean): void => {
    if (negated) {
      if (!excluded.has(term)) {
        excluded.add(term)
        exclude.push(term)
      }
      return
    }
    if (seen.has(term)) return
    seen.add(term)
    include.push(term)
  }

  for (const raw of query.split(SEPARATORS)) {
    const token = raw.trim()
    if (token === '') continue

    if (SOFT_NEGATORS.includes(token)) {
      pendingNegation = true
      continue
    }

    const negated = pendingNegation
    pendingNegation = false

    // 1) 整串就是词条（`得意` 这类带助词的词条靠这一步活下来）
    const whole = canonicalize(token)
    if (whole !== null) {
      take(whole, negated)
      continue
    }

    // 2) 贴着写的明确排除：「排除真人」
    const hardNegated = stripNegation(token)
    if (hardNegated !== null) {
      take(hardNegated, true)
      continue
    }

    // 3) 助词兜底：「敷衍的微笑」→ 敷衍 + 微笑。切出来的每一段各自查词表，
    //    查不到就丢掉——这里不做任何猜测。
    if (PARTICLES.test(token)) {
      for (const piece of token.split(PARTICLES)) {
        const term = piece.trim() === '' ? null : canonicalize(piece.trim())
        if (term !== null) take(term, negated)
      }
    }
  }

  // 排除赢：既在 include 又在 exclude 的词从 include 里拿掉
  return { include: include.filter((t) => !excluded.has(t)), exclude }
}
