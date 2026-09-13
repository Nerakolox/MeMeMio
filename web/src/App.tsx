import { Link, Route, Routes } from 'react-router-dom'
import { HomePage } from './routes/home'
import { NotFoundPage } from './routes/not-found'

/**
 * 路由骨架。`*` 这条不是摆设 —— 它验证的是「刷新任意深层 URL 不 404」：
 * 生产环境由 api 做 SPA fallback（api/src/server.ts 的 mountWebDist），
 * 本地由 Vite dev server 做。少了任何一边，直接访问子路由就会白屏。
 */
export function App() {
  return (
    <div className="app">
      <header className="app__header">
        <Link to="/">Mememio</Link>
      </header>
      <main className="app__main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  )
}
