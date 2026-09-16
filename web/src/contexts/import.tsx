import { createContext, useContext, type ReactNode } from 'react'
import { useImportQueue, type ImportQueue } from '../features/import/use-import-queue'

/**
 * 导入队列挂在应用级，不在 `/import` 路由里。
 *
 * 理由：导入是异步的、要跑很久，**用户应该能切到搜索页继续用**（import-ux.md §9）。
 * 队列状态如果在页面组件里，路由一离开就被卸载，SSE 也随清理函数关掉，
 * 回来时进度就归零了。挂在这里，切走再回来看到的还是同一批。
 *
 * 它是 `state-navigation.md §3` 说的第三类本地状态——「进行中的导入」，
 * 与服务端派生的数据不同，本来就该有一份本地正本。
 */
const ImportContext = createContext<ImportQueue | null>(null)

export function ImportProvider({ children }: { children: ReactNode }) {
  const queue = useImportQueue()
  return <ImportContext.Provider value={queue}>{children}</ImportContext.Provider>
}

export function useImport(): ImportQueue {
  const ctx = useContext(ImportContext)
  if (!ctx) throw new Error('useImport must be used inside ImportProvider')
  return ctx
}
