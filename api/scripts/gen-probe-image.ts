import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import sharp from 'sharp'

/**
 * 生成「测试连接」用的内置探测图，并把它编译进 `src/ai/probe-image.ts`。
 *
 * ## 为什么是内置的 base64 常量，不是 assets/ 下的一个文件
 *
 * 根 `Dockerfile` 的最终镜像只 COPY `node_modules` / `dist` / `migrations` / `public`
 * 和 `/shared`。**新加一个 `api/assets/` 目录不会进镜像**，而改 Dockerfile 属于部署
 * 事项，归总管（`AGENTS.md §3` 的需求路由）。编译进 `dist/` 的常量零部署改动，
 * 且不可能在运行时「文件不见了」。
 *
 * ## 为什么不用 docs/fixtures/
 *
 * 那批是测试与评测用的，`huge.png` 还被 .gitignore 排除着（docs/fixtures.md）。
 * 运行时依赖它等于依赖一个不保证存在的目录——任务文件里明写了不要引用它。
 *
 * ## 为什么是这张图
 *
 * 探测图必须是**一张真的能被打出标签的图**：`vocabCompliant` 判的是「返回的标签
 * 落在词表内」，拿噪声图或纯色块去测，一个好模型也会返回空字段，那正好长得像
 * `ai-providers.md §3` 的第三种拒绝形态——测试连接会把能用的供应商判成不能用。
 *
 * 所以这张图对着 `shared/vocab/vocab.json` 设计，每一层都命中闭集里的词条：
 *
 *   - 主体：猫（`subject.猫`）、画面里有文字（`subject.文字`）
 *   - 情绪：半睁的死鱼眼 + 黑眼圈 + 一条平嘴（`emotions.疲惫` / `生无可恋` / `无奈`）
 *   - 场景：字幕「今天不想上班」（`scenes.上班摸鱼` / `加班` / `周一`）
 *   - 风格：粗描边平涂（`style.手绘` / `简笔画`）、有字幕（`style.带字幕`）
 *
 * 它同时还是一张**合规**的图：纯矢量、无人脸、无版权素材，不会撞上任何供应商的
 * 内容策略——探测图被判 `AI_REFUSED` 的话，整个测试连接就废了。
 *
 * 用法：`npx tsx scripts/gen-probe-image.ts`。改了图必须重跑，然后把生成的
 * `src/ai/probe-image.ts` 一起提交。
 *
 * ⚠️ **产物不是跨机器确定性的。** 字幕走的是 SVG `<text>` + 系统字体，装了哪套中文
 *    字体决定了最终像素，换台机器重跑大概率得到不同的 sha256；**完全没有中文字体的
 *    机器上会渲染成豆腐块，而脚本不会报错**。所以重跑之后要做两件事：把生成的图打开
 *    看一眼字还在不在，再把新的 `PROBE_IMAGE_SHA256` 一起提交。
 *
 *    运行时不受影响——线上用的是已提交的 base64 常量，不跑这个脚本。
 */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384" viewBox="0 0 384 384">
  <rect width="384" height="384" fill="#fdf6e3"/>
  <rect x="0" y="286" width="384" height="98" fill="#d9c7a3"/>
  <line x1="0" y1="286" x2="384" y2="286" stroke="#3b3b3b" stroke-width="5"/>
  <ellipse cx="192" cy="286" rx="132" ry="34" fill="#ffffff" stroke="#3b3b3b" stroke-width="6"/>
  <path d="M96 292 q-30 -4 -46 6" stroke="#3b3b3b" stroke-width="6" fill="none" stroke-linecap="round"/>
  <path d="M288 292 q30 -4 46 6" stroke="#3b3b3b" stroke-width="6" fill="none" stroke-linecap="round"/>
  <circle cx="192" cy="196" r="98" fill="#ffffff" stroke="#3b3b3b" stroke-width="7"/>
  <path d="M116 132 L92 74 L152 104 Z" fill="#ffffff" stroke="#3b3b3b" stroke-width="7" stroke-linejoin="round"/>
  <path d="M268 132 L292 74 L232 104 Z" fill="#ffffff" stroke="#3b3b3b" stroke-width="7" stroke-linejoin="round"/>
  <path d="M136 186 q22 -16 44 0" stroke="#3b3b3b" stroke-width="7" fill="none" stroke-linecap="round"/>
  <path d="M204 186 q22 -16 44 0" stroke="#3b3b3b" stroke-width="7" fill="none" stroke-linecap="round"/>
  <circle cx="158" cy="196" r="9" fill="#3b3b3b"/>
  <circle cx="226" cy="196" r="9" fill="#3b3b3b"/>
  <path d="M138 212 q20 12 42 2" stroke="#9a9a9a" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M204 214 q20 10 42 -2" stroke="#9a9a9a" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M186 226 L198 226 L192 234 Z" fill="#3b3b3b"/>
  <path d="M160 254 L224 254" stroke="#3b3b3b" stroke-width="7" stroke-linecap="round"/>
  <path d="M104 226 L60 218 M104 240 L60 244" stroke="#3b3b3b" stroke-width="5" stroke-linecap="round"/>
  <path d="M280 226 L324 218 M280 240 L324 244" stroke="#3b3b3b" stroke-width="5" stroke-linecap="round"/>
  <text x="192" y="352" text-anchor="middle" font-size="46" font-weight="bold"
        font-family="Microsoft YaHei, SimHei, Noto Sans CJK SC, sans-serif" fill="#3b3b3b">今天不想上班</text>
</svg>`

const OUT = join(import.meta.dirname, '..', 'src', 'ai', 'probe-image.ts')

const png = await sharp(Buffer.from(SVG)).png({ compressionLevel: 9, palette: true }).toBuffer()
const sha256 = createHash('sha256').update(png).digest('hex')

const base64 = png.toString('base64')
const chunks: string[] = []
for (let i = 0; i < base64.length; i += 96) chunks.push(`  '${base64.slice(i, i + 96)}'`)

const header = `/**
 * 测试连接用的内置探测图。**本文件由 scripts/gen-probe-image.ts 生成，不要手改。**
 *
 * 它是编译进 \`dist/\` 的 base64 常量而不是磁盘上的一个文件——根 Dockerfile 的最终
 * 镜像只 COPY node_modules / dist / migrations / public 和 /shared，新开一个
 * \`api/assets/\` 目录不会进镜像，而改 Dockerfile 属部署事项（AGENTS.md §3 需求路由）。
 * 常量零部署改动，且不可能在运行时「文件不见了」。
 *
 * **不要改成读 \`docs/fixtures/\`**：那批是测试与评测用的，运行时依赖一个
 * .gitignore 里还排除着文件的目录，见 docs/fixtures.md。
 *
 * 选图理由（为什么不能是噪声图或纯色块）、以及它命中词表哪些词条，
 * 写在生成脚本的文件头注释里。
 *
 * PNG ${png.byteLength} 字节，384×384，sha256 ${sha256}
 */

const BASE64 = [
${chunks.join(',\n')},
].join('')

/**
 * 每次调用返回一个新 Buffer。**不缓存**：调用方（视觉探测）会把它交给
 * \`image/\` 那一层去拼 data URL，共享一个 Buffer 会让「谁不小心改了它」变成
 * 一个跨请求的 bug，而 13KB 的 base64 解码不值得为此冒险。
 */
export function probeImagePng(): Buffer {
  return Buffer.from(BASE64, 'base64')
}

/** 探测图的 sha256，测试里用来断言「编进去的还是那张图」。 */
export const PROBE_IMAGE_SHA256 = '${sha256}'
`

writeFileSync(OUT, header, 'utf-8')
process.stdout.write(`probe-image.ts 已生成：${png.byteLength} 字节，sha256 ${sha256}\n`)
