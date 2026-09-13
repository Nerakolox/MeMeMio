import { Link, useLocation } from 'react-router-dom'

export function NotFoundPage() {
  const location = useLocation()
  return (
    <section>
      <h1>页面不存在</h1>
      <p>
        <code>{location.pathname}</code> 没有对应的页面。
      </p>
      <Link to="/">回首页</Link>
    </section>
  )
}
