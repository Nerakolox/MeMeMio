import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { type User, fetchMe } from '../lib/api'

type AuthContextValue = {
  user: User | null
  setUser: (user: User | null) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    fetchMe()
      .then((u) => {
        setUser(u)
        setChecked(true)
      })
      .catch(() => {
        // 401 UNAUTHENTICATED or network failure — either way, not logged in
        setChecked(true)
      })
  }, [])

  // Block render until /auth/me resolves — no flash of protected UI
  if (!checked) return null

  return <AuthContext.Provider value={{ user, setUser }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
