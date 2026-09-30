import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { Live, LiveOptions } from '../src/live.ts'
import { Root } from '../src/Root.tsx'
import { TOKEN_STORAGE_KEY } from '../src/token.ts'
import type { TokenEnv } from '../src/token.ts'
import { TOKEN, fakeApi, status } from './helpers.tsx'

const NEW_TOKEN = 'a-brand-new-token-9876543210zyx'

const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  })

/** A live connection that never connects, and remembers which tokens it was asked to use. */
function fakeLive() {
  const tokens: string[] = []
  const closed: string[] = []
  const factory = vi.fn((options: LiveOptions): Live => {
    tokens.push(options.token)
    return { close: () => void closed.push(options.token), attempts: 0 }
  })
  return { factory, tokens, closed }
}

/** Paste an address into the tab that differs from the open page only after the #: no reload, one event. */
function pasteFragment(hash: string) {
  window.history.replaceState(null, '', `/${hash}`)
  act(() => {
    window.dispatchEvent(new Event('hashchange'))
  })
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})
afterEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

describe('Root follows the address bar', () => {
  it('a page opened without a token picks one up when an address with a token is pasted into the same tab', async () => {
    const live = fakeLive()
    render(
      <Root
        initialToken={null}
        api={fakeApi({ status: async () => status() })}
        createLive={live.factory}
      />
    )
    expect(screen.getByText(/the address the orchestrator printed when it started/)).toBeTruthy()
    expect(live.factory).not.toHaveBeenCalled()

    pasteFragment(`#token=${TOKEN}`)
    expect(await screen.findByRole('heading', { name: 'Stage' })).toBeTruthy()
    await waitFor(() => expect(live.tokens).toEqual([TOKEN]))
    // read once, then gone from the address bar, remembered for this tab only
    expect(window.location.hash).toBe('')
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN)
    expect(window.localStorage.length).toBe(0)
  })

  it('a console that no longer works switches to the new token, and starts over with it', async () => {
    const seenAuth: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>).Authorization ?? ''
        seenAuth.push(auth)
        if (auth !== `Bearer ${NEW_TOKEN}`)
          return json(
            { error: { code: 'unauthorized', message: 'A valid bearer token is required.' } },
            401
          )
        if (url.startsWith('/api/status')) return json(status())
        if (url.startsWith('/api/events')) return json({ events: [] })
        if (url.startsWith('/api/traces')) return json({ traces: [] })
        return json({ error: { code: 'not_found', message: 'No such route.' } }, 404)
      })
    )
    const live = fakeLive()
    render(<Root initialToken={TOKEN} createLive={live.factory} />)
    // the old token is refused
    expect(await screen.findByText(/did not accept this console's token/)).toBeTruthy()
    expect(live.tokens).toEqual([]) // a refused token never gets a socket

    // the orchestrator was restarted; its new address is pasted into the same tab
    pasteFragment(`#token=${NEW_TOKEN}`)
    expect(await screen.findByRole('heading', { name: 'Stage' })).toBeTruthy()
    expect(screen.queryByText(/did not accept this console's token/)).toBeNull()
    await waitFor(() => expect(live.tokens).toEqual([NEW_TOKEN]))
    expect(seenAuth).toContain(`Bearer ${NEW_TOKEN}`)
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(NEW_TOKEN)
  })

  it('a rejected token is forgotten, so a reload does not try it again', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ error: { code: 'unauthorized', message: 'A valid bearer token is required.' } }, 401)
      )
    )
    render(<Root initialToken={TOKEN} createLive={fakeLive().factory} />)
    await screen.findByText(/did not accept this console's token/)
    await waitFor(() => expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull())
  })

  it('a fragment that is not about a token is none of its business', async () => {
    const live = fakeLive()
    render(
      <Root
        initialToken={TOKEN}
        api={fakeApi({ status: async () => status() })}
        createLive={live.factory}
      />
    )
    await screen.findByRole('heading', { name: 'Stage' })
    await waitFor(() => expect(live.tokens).toEqual([TOKEN]))
    pasteFragment('#section-2')
    expect(window.location.hash).toBe('#section-2')
    expect(live.tokens).toEqual([TOKEN])
  })

  it('a fragment with a malformed token changes nothing, and is removed from the address bar', async () => {
    const live = fakeLive()
    render(
      <Root
        initialToken={TOKEN}
        api={fakeApi({ status: async () => status() })}
        createLive={live.factory}
      />
    )
    await screen.findByRole('heading', { name: 'Stage' })
    await waitFor(() => expect(live.tokens).toEqual([TOKEN]))
    pasteFragment('#token=short')
    expect(window.location.hash).toBe('')
    expect(live.tokens).toEqual([TOKEN])
    expect(screen.getByRole('heading', { name: 'Stage' })).toBeTruthy()
  })

  it('the same token again does not restart anything', async () => {
    const live = fakeLive()
    render(
      <Root
        initialToken={TOKEN}
        api={fakeApi({ status: async () => status() })}
        createLive={live.factory}
      />
    )
    await screen.findByRole('heading', { name: 'Stage' })
    await waitFor(() => expect(live.tokens).toEqual([TOKEN]))
    pasteFragment(`#token=${TOKEN}`)
    expect(live.tokens).toEqual([TOKEN])
    expect(window.location.hash).toBe('')
  })

  it('stops listening when it goes away', () => {
    const storage: TokenEnv['storage'] = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    const replaceState = vi.fn()
    const env: TokenEnv = {
      location: { hash: `#token=${NEW_TOKEN}`, pathname: '/', search: '' },
      history: { replaceState },
      storage,
    }
    const view = render(
      <Root initialToken={null} env={env} api={fakeApi()} createLive={fakeLive().factory} />
    )
    view.unmount()
    window.dispatchEvent(new Event('hashchange'))
    expect(replaceState).not.toHaveBeenCalled()
  })
})
