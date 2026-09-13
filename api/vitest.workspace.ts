import { defineWorkspace } from 'vitest/config'

/**
 * 两组测试，边界是「要不要数据库」：
 *
 *   unit        —— src/lib/ 里的纯函数。不连库，随时能跑。
 *   integration —— tests/ 里的集成测试。连**真 Postgres**，会建 <库名>_test 并清表。
 *
 * 分开不是为了跑得快，是为了「Docker 没起」和「代码写错了」这两件事红得不一样。
 * 见 api/agents/rules/testing.md §1。
 */
export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['src/**/*.test.ts'],
      // app.ts 会经过 env.ts，缺变量就 exit(1)，所以这组也要先把 .env 读进来
      setupFiles: ['./tests/setup-env.ts'],
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/**/*.test.ts'],
      globalSetup: ['./tests/global-setup.ts'],
      // worker 是独立进程，global-setup 里加载的 .env 传不过来，每个进程自己加载一次
      setupFiles: ['./tests/setup-env.ts'],
      // 共用一个测试库，用例靠 beforeEach 清表隔离，所以整个 project 串行跑
      // （fileParallelism 只能配在根层，project 层用 singleFork 达到同样效果）
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  },
])
