import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 运行期要读的仓库内文件。
 *
 * 两条路径都相对 **进程工作目录**，不是相对模块文件，因为这样开发态和镜像里正好一致：
 *
 *   开发：cwd = <repo>/api    → ../shared/vocab/...  = <repo>/shared/vocab/...
 *   镜像：cwd = /app          → ../shared/vocab/...  = /shared/vocab/...（Dockerfile 就是这么放的）
 *
 * 这个巧合是有意安排的，不是运气。挪动其中任何一侧都会断，所以启动时有一次显式检查
 * （assertRuntimeFilesPresent），断了就在启动瞬间报出来，而不是等第一次打标。
 */

/** 标签词表主源，SPEC §0.2。api 用它校验模型输出，web 用它做筛选选项。 */
export const VOCAB_PATH = resolve(process.cwd(), '../shared/vocab/vocab.json')

/** drizzle 迁移目录。migrate 命令和启动时的版本检查都读它。 */
export const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

/** SPA 构建产物。开发态不存在（web 跑在 Vite 上），所以不是必需文件。 */
export const WEB_DIST_DIR = resolve(process.cwd(), 'public')

export function assertRuntimeFilesPresent(): void {
  const missing: string[] = []
  if (!existsSync(VOCAB_PATH)) missing.push(`词表 ${VOCAB_PATH}`)
  if (!existsSync(MIGRATIONS_DIR)) missing.push(`迁移目录 ${MIGRATIONS_DIR}`)

  if (missing.length > 0) {
    throw new Error(
      `启动所需文件缺失：\n  - ${missing.join('\n  - ')}\n`
        + `这两条路径是相对 cwd 解析的（当前 cwd: ${process.cwd()}），`
        + `在 api/ 下跑或在镜像的 /app 下跑才对得上。见 src/paths.ts。`,
    )
  }
}
