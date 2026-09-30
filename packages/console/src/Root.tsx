import { useEffect, useState } from 'react'
import { App } from './App.tsx'
import type { AppProps } from './App.tsx'
import { browserEnv, forgetToken, takeToken } from './token.ts'
import type { TokenEnv } from './token.ts'

export interface RootProps extends Omit<AppProps, 'token' | 'onTokenRejected'> {
  /** The token read when the page loaded (see `takeToken`), or null. */
  initialToken: string | null
  /** For tests. Default: the real address bar and session storage. */
  env?: TokenEnv
}

/**
 * Holds the token and follows the address bar. A browser treats an address that differs from the open page
 * only after the `#` as "the same page": paste the new address printed by a restarted orchestrator into a tab
 * that still has the old console open and nothing reloads. Without listening for that, the tab would go on
 * with the old token and the new one would sit unread in the address bar.
 */
export function Root({ initialToken, env, ...app }: RootProps) {
  const [token, setToken] = useState(initialToken)

  useEffect(() => {
    const onHashChange = () => {
      const current = env ?? browserEnv()
      // Only a fragment that carries a token is news; takeToken would otherwise hand back the remembered one.
      if (!current.location.hash.includes('token=')) return
      const next = takeToken(current)
      if (next !== null) setToken(next)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [env])

  return <App {...app} token={token} onTokenRejected={() => forgetToken(env ?? browserEnv())} />
}
