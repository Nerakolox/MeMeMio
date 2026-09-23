#!/usr/bin/env node
/**
 * 检查全部被 git 跟踪的 markdown 里的相对链接是否还存在。
 *
 * **为什么有这个脚本。** 「归档时检查相对链接」这条规则在
 * [documentation.md](../agents/rules/documentation.md) 里一直写着，但 2026-09-24
 * 审查时全仓仍有 22 条断链——21 条是同一个原因：任务文件从 `joint-tasks/` 移到
 * `_archive/joint-tasks/` 之后，`../spec/` 没有跟着变成 `../../spec/`。
 * 移动文件时人不会逐个去数层级，而断了也不报错，只有点进去才发现。
 * 所以把它变成一条能跑的命令。
 *
 * 用法（仓库根目录）：
 *
 *   node scripts/check-doc-links.mjs
 *
 * 有断链时打印 `文件:行号 -> 链接` 并以退出码 1 结束，可以直接进 CI 或 pre-commit。
 * 只检查相对链接；`http(s):` / `mailto:` 等外部地址不联网校验。
 */

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const files = execSync('git -c core.quotepath=false ls-files -z "*.md"', {
  encoding: 'utf8',
  maxBuffer: 1 << 28,
})
  .split('\0')
  .filter(Boolean)

const broken = []
let total = 0

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const re = /!?\[[^\]]*\]\(([^)]+)\)/g
    let m
    while ((m = re.exec(line)) !== null) {
      let target = m[1].trim()
      if (/^(https?:|mailto:|tel:|data:)/.test(target)) continue
      // 去掉锚点和包裹用的尖括号，剩下的才是路径
      target = target.replace(/#.*$/, '').replace(/^<|>$/g, '')
      if (target === '') continue
      total += 1
      // 以文件自身为基准；`/` 开头按仓库根算
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : path.join(path.dirname(file), target)
      if (!existsSync(resolved.replace(/\/$/, ''))) {
        broken.push(`${file}:${i + 1} -> ${m[1]}`)
      }
    }
  })
}

console.log(`检查 ${files.length} 个 markdown，相对链接 ${total} 条，失效 ${broken.length} 条`)
if (broken.length > 0) {
  console.log(broken.join('\n'))
  console.log('\n提示：文件被移动过时，链接里的 `../` 层数要跟着改。')
  process.exit(1)
}
