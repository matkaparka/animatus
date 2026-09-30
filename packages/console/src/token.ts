/**
 * The console's token: read once from the URL fragment (`#token=...`, which the browser never sends to a
 * server), kept in memory, remembered for a reload in `sessionStorage` (per tab, gone when the tab
 * closes), and removed from the address bar straight away so it is not left in the history, a screenshot
 * or a copied link. Never `localStorage`.
 */
import { ConsoleToken } from '@animatus/protocol'

/** A reload convenience only. */
export const TOKEN_STORAGE_KEY = 'animatus.console.token'

export interface TokenEnv {
  location: { hash: string; pathname: string; search: string }
  history: { replaceState(data: unknown, unused: string, url?: string | URL | null): void }
  /** `null` when session storage is not available (private windows, blocked site data). */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

export function browserEnv(): TokenEnv {
  let storage: TokenEnv['storage'] = null
  try {
    // Even reading the property can throw when site data is blocked.
    storage = window.sessionStorage
  } catch {
    storage = null
  }
  return { location: window.location, history: window.history, storage }
}

function fragmentParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
}

function remember(storage: TokenEnv['storage'], token: string): void {
  try {
    storage?.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // quota, blocked storage: the page still works, a reload just asks for the link again
  }
}

function recall(storage: TokenEnv['storage']): string | null {
  try {
    const value = storage?.getItem(TOKEN_STORAGE_KEY) ?? null
    return value !== null && ConsoleToken.safeParse(value).success ? value : null
  } catch {
    return null
  }
}

/**
 * The token for this page load, or null when there is none. A token in the fragment wins and is stripped
 * from the address bar (a malformed one is stripped too, and ignored). Without one, the tab's remembered
 * token is used.
 */
export function takeToken(env: TokenEnv = browserEnv()): string | null {
  const params = fragmentParams(env.location.hash)
  if (params.has('token')) {
    // Whatever the outcome, the fragment must not stay in the address bar.
    try {
      env.history.replaceState(null, '', `${env.location.pathname}${env.location.search}`)
    } catch {
      // a sandboxed frame may refuse; nothing else to do
    }
    const candidate = params.get('token') ?? ''
    if (ConsoleToken.safeParse(candidate).success) {
      remember(env.storage, candidate)
      return candidate
    }
  }
  return recall(env.storage)
}

/** Drops the remembered token, for when the server no longer accepts it. */
export function forgetToken(env: TokenEnv = browserEnv()): void {
  try {
    env.storage?.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // nothing to do
  }
}
