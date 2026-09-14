import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const shared = fileURLToPath(new URL('../shared', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 词表主源在仓库根的 shared/，web 在**编译期**把它打进产物。
      // 不维护第二份标签列表 —— 见 web/agents/rules/project-structure.md
      '@shared': shared,
    },
  },
  server: {
    port: 5173,
    fs: {
      // shared/ 在项目根之外，dev server 要显式放行
      allow: ['..'],
    },
    proxy: {
      // 本地前后端不同域（5173 vs 3000），靠这条把 /api 转过去，
      // 这样 cookie 仍然是同域的 —— 生产是真同域，不需要任何 CORS 配置。
      // 见 docs/environments.md §3、SPEC §0.1
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
      '/auth': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
