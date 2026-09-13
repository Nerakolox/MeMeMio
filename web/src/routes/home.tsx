import { useEffect, useState } from 'react'
import { ApiError, fetchHealth } from '../lib/api'
import { emotionOptions, sceneOptions, tagOptions, vocabulary } from '../lib/vocab'

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; startedAt: string; vocabVersion: string }
  | { kind: 'error'; message: string; code: string; requestId: string }

/**
 * 骨架页。它只做一件事：证明 web → Vite proxy → api → 词表 这条链路是通的。
 * 有了真正的搜索页之后这里会被替换掉。
 */
export function HomePage() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    fetchHealth()
      .then((data) => {
        if (!alive) return
        setHealth({ kind: 'ok', startedAt: data.startedAt, vocabVersion: data.vocabVersion })
      })
      .catch((err: unknown) => {
        if (!alive) return
        if (err instanceof ApiError) {
          setHealth({
            kind: 'error',
            code: err.code,
            message: err.message,
            requestId: err.requestId,
          })
          return
        }
        setHealth({
          kind: 'error',
          code: 'NETWORK',
          message: '连不上服务端，确认 api 是否已启动',
          requestId: '无',
        })
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <section>
      <h1>骨架自检</h1>

      <h2>api</h2>
      {health.kind === 'loading' && <p>检查中…</p>}
      {health.kind === 'ok' && (
        <ul>
          <li>状态：ok</li>
          <li>启动时间：{health.startedAt}</li>
          <li>服务端词表版本：{health.vocabVersion}</li>
        </ul>
      )}
      {health.kind === 'error' && (
        <ul className="error">
          <li>错误码：{health.code}</li>
          <li>{health.message}</li>
          {/* requestId 必须露出来，报问题时它是唯一能对上服务端日志的东西 */}
          <li>requestId：{health.requestId}</li>
        </ul>
      )}

      <h2>词表（web 侧编译期打进产物）</h2>
      <ul>
        <li>版本：{vocabulary.version}（{vocabulary.status}）</li>
        <li>
          情绪 {emotionOptions.length} · 场景 {sceneOptions.length} · 标签 {tagOptions.length}
        </li>
      </ul>
      {/* 两个版本号应当一致；不一致说明镜像里的 shared/ 和构建时的不是同一份 */}
    </section>
  )
}
