import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { registerServiceWorker } from './lib/pwa'
import './index.css'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root 不存在，index.html 被改坏了')

// PWA：把静态外壳缓存起来，装到主屏后冷启动更快、断网也能起来（任务《2026-10-01-手机PWA》）。
// **只在生产真的注册**（`lib/pwa.ts` 里那句 `import.meta.env.PROD`）——开发态注册会把
// HMR 挡在缓存后面。它是加速器，渲染不等它。
registerServiceWorker()

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
