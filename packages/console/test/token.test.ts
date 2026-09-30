import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOKEN_STORAGE_KEY, browserEnv, forgetToken, takeToken } from '../src/token.ts'
import type { TokenEnv } from '../src/token.ts'
import { TOKEN } from './helpers.tsx'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

function fakeEnv(
  hash: string,
  storage: TokenEnv['storage'] = memoryStorage(),
  extra: { pathname?: string; search?: string } = {}
) {
  const replaceState = vi.fn()
  const env: TokenEnv = {
    location: { hash, pathname: extra.pathname ?? '/', search: extra.search ?? '' },
    history: { replaceState },
    storage,
  }
  return { env, replaceState }
}

describe('takeToken with a stand-in environment', () => {
  it('reads the token from the fragment and removes the fragment from the address bar', () => {
    const storage = memoryStorage()
    const { env, replaceState } = fakeEnv(`#token=${TOKEN}`, storage, {
      pathname: '/console/',
      search: '?tab=run',
    })
    expect(takeToken(env)).toBe(TOKEN)
    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/console/?tab=run')
    expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe(TOKEN)
  })

  it('other fragment parameters go with it; only the token counts', () => {
    const { env, replaceState } = fakeEnv(`#x=1&token=${TOKEN}&y=2`)
    expect(takeToken(env)).toBe(TOKEN)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
  })

  it('a malformed token is not used, and the fragment is removed all the same', () => {
    for (const bad of ['short', 'has space in it now', 'semi;colon;token', '', 'x'.repeat(200)]) {
      const storage = memoryStorage()
      const { env, replaceState } = fakeEnv(`#token=${encodeURIComponent(bad)}`, storage)
      expect(takeToken(env), bad).toBeNull()
      expect(replaceState, bad).toHaveBeenCalledWith(null, '', '/')
      expect(storage.data.size).toBe(0)
    }
  })

  it('without a fragment it falls back to the token this tab remembered, and leaves the address alone', () => {
    const storage = memoryStorage({ [TOKEN_STORAGE_KEY]: TOKEN })
    const { env, replaceState } = fakeEnv('', storage)
    expect(takeToken(env)).toBe(TOKEN)
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('a fragment that is not about a token is left alone', () => {
    const { env, replaceState } = fakeEnv('#section-2')
    expect(takeToken(env)).toBeNull()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('a token in the fragment beats the remembered one, and replaces it', () => {
    const storage = memoryStorage({ [TOKEN_STORAGE_KEY]: 'old-token-value-abcdefgh' })
    const { env } = fakeEnv(`#token=${TOKEN}`, storage)
    expect(takeToken(env)).toBe(TOKEN)
    expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe(TOKEN)
  })

  it('a remembered value that is not a token is ignored', () => {
    const { env } = fakeEnv('', memoryStorage({ [TOKEN_STORAGE_KEY]: 'not a token!' }))
    expect(takeToken(env)).toBeNull()
  })

  it('no token anywhere: null', () => {
    expect(takeToken(fakeEnv('').env)).toBeNull()
    expect(takeToken(fakeEnv('', null).env)).toBeNull()
  })

  it('unusable storage does not get in the way (wrapped in try/catch)', () => {
    const broken: TokenEnv['storage'] = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    const { env } = fakeEnv(`#token=${TOKEN}`, broken)
    expect(takeToken(env)).toBe(TOKEN)
    expect(takeToken(fakeEnv('', broken).env)).toBeNull()
    expect(() => forgetToken(fakeEnv('', broken).env)).not.toThrow()
  })

  it('a history that refuses to rewrite the address does not stop the token being read', () => {
    const { env } = fakeEnv(`#token=${TOKEN}`)
    env.history.replaceState = () => {
      throw new Error('sandboxed')
    }
    expect(takeToken(env)).toBe(TOKEN)
  })

  it('forgetToken drops the remembered token', () => {
    const storage = memoryStorage({ [TOKEN_STORAGE_KEY]: TOKEN })
    forgetToken(fakeEnv('', storage).env)
    expect(storage.data.size).toBe(0)
  })
})

describe('takeToken in the page', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
  })
  afterEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  it('reads #token= from location.hash and strips it from the real address', () => {
    window.history.replaceState(null, '', `/#token=${TOKEN}`)
    expect(window.location.hash).toBe(`#token=${TOKEN}`)
    expect(takeToken()).toBe(TOKEN)
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(TOKEN)
    expect(window.location.href).not.toContain('token')
  })

  it('remembers it for a reload in sessionStorage, and never in localStorage', () => {
    window.history.replaceState(null, '', `/#token=${TOKEN}`)
    takeToken()
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN)
    expect(window.localStorage.length).toBe(0)
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN)
    // a reload: the address has no fragment any more
    expect(takeToken()).toBe(TOKEN)
  })

  it('finds nothing on a bare address', () => {
    expect(takeToken()).toBeNull()
  })

  it('browserEnv survives a browser that refuses to hand out sessionStorage', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('site data is blocked')
      },
    })
    try {
      expect(browserEnv().storage).toBeNull()
      window.history.replaceState(null, '', `/#token=${TOKEN}`)
      expect(takeToken()).toBe(TOKEN)
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor)
      else Reflect.deleteProperty(window, 'sessionStorage')
    }
  })
})
