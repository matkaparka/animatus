import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ConsoleEvent } from '@animatus/protocol'
import { App } from '../src/App.tsx'
import { ApiClientError } from '../src/api.ts'
import type { Live, LiveOptions } from '../src/live.ts'
import { TOKEN, alarm, fakeApi, hello, mode, plugin, status } from './helpers.tsx'
import type { MockedApi } from './helpers.tsx'

/** A stand-in for the live connection that lets a test speak for the server. */
function fakeLive() {
  const instances: Array<{ options: LiveOptions; closed: boolean }> = []
  const factory = vi.fn((options: LiveOptions): Live => {
    const instance = { options, closed: false }
    instances.push(instance)
    return {
      close() {
        instance.closed = true
      },
      attempts: 0,
    }
  })
  const latest = () => instances[instances.length - 1] as { options: LiveOptions; closed: boolean }
  /** The console opens its socket once the first status is in; wait for that. */
  const ready = () => waitFor(() => expect(instances.length).toBeGreaterThan(0))
  return {
    factory,
    instances,
    latest,
    ready,
    send: async (event: ConsoleEvent) => {
      await ready()
      await act(async () => latest().options.onEvent(event))
    },
    state: async (s: 'connecting' | 'open' | 'waiting') => {
      await ready()
      await act(async () => latest().options.onState?.(s))
    },
  }
}

const WITH_DATA = () =>
  status({
    plugins: [
      plugin({ id: 'speech', title: 'Speech synthesis', status: 'ready' }),
      plugin({ id: 'image', title: 'Image generation', status: 'stopped' }),
    ],
    modes: [mode({ id: 'dance', title: 'Dance' })],
    alarms: [
      alarm({ id: 'a1', code: 'vram_not_measured', message: 'draw has never been measured' }),
    ],
  })

function renderApp(
  over: { api?: MockedApi; token?: string | null; onTokenRejected?: () => void } = {}
) {
  const api = over.api ?? fakeApi({ status: async () => WITH_DATA() })
  const live = fakeLive()
  const onTokenRejected = over.onTokenRejected ?? vi.fn()
  render(
    <App
      token={over.token === undefined ? TOKEN : over.token}
      api={api}
      createLive={live.factory}
      onTokenRejected={onTokenRejected}
    />
  )
  return { api, live, onTokenRejected }
}

describe('without a token', () => {
  it('explains how to open the console, and does nothing else', () => {
    const { api, live } = renderApp({ token: null })
    expect(screen.getByRole('heading', { name: 'Animatus console' })).toBeTruthy()
    expect(screen.getByText(/the address the orchestrator printed when it started/)).toBeTruthy()
    expect(screen.getByText('#token=')).toBeTruthy()
    expect(screen.getByText(/restart the orchestrator to get a fresh one/)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(api.status).not.toHaveBeenCalled()
    expect(live.factory).not.toHaveBeenCalled()
  })

  it('an empty token counts as none', () => {
    const { live } = renderApp({ token: '' })
    expect(screen.getByText(/the address the orchestrator printed/)).toBeTruthy()
    expect(live.factory).not.toHaveBeenCalled()
  })
})

describe('with a token', () => {
  it('loads the status, the recent events and the traces, and connects the live socket with the token', async () => {
    const { api, live } = renderApp()
    await screen.findByRole('heading', { name: 'Stage' })
    await live.ready()
    expect(api.status).toHaveBeenCalledTimes(1)
    expect(api.events).toHaveBeenCalledWith(200)
    expect(api.traces).toHaveBeenCalledWith(50)
    expect(live.factory).toHaveBeenCalledTimes(1)
    expect(live.latest().options.token).toBe(TOKEN)
    // alarms from the status show up
    expect(await screen.findByText('vram_not_measured')).toBeTruthy()
  })

  it('shows the version and the state of the live connection', async () => {
    const { live } = renderApp()
    await screen.findByText('v0.1.0')
    expect(screen.getByTitle('State of the live connection').textContent).toBe('connecting')
    await live.send(hello)
    expect(screen.getByTitle('State of the live connection').textContent).toBe('live')
    await live.state('waiting')
    expect(screen.getByTitle('State of the live connection').textContent).toBe('offline')
    expect(screen.getByText(/live connection is down and is being retried/)).toBeTruthy()
    await live.send(hello)
    expect(screen.getByTitle('State of the live connection').textContent).toBe('live')
    expect(screen.queryByText(/live connection is down/)).toBeNull()
  })

  it('has seven tabs, Run first, and switches between them', async () => {
    renderApp()
    await screen.findByRole('heading', { name: 'Stage' })
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Run',
      'Plugins',
      'Modes',
      'Approvals',
      'Memory',
      'Settings',
      'Keys',
    ])
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
      'false',
      'false',
    ])
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    expect(screen.getByRole('tab', { name: 'Plugins' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('heading', { name: 'Plugins', level: 2 })).toBeTruthy()
    expect(screen.getByRole('tabpanel', { name: 'Plugins' })).toBeTruthy()
    // the Run page is still there but hidden
    expect(document.getElementById('panel-run')?.hidden).toBe(true)
    expect(document.getElementById('panel-plugins')?.hidden).toBe(false)
    // pages nobody has opened are not built yet
    expect(document.getElementById('panel-keys')).toBeNull()
  })

  it('the Approvals tab shows how many wait, follows the server’s word on changes, and loads its list when opened', async () => {
    const api = fakeApi({ status: async () => status({ approvals_pending: 2 }) })
    const { live } = renderApp({ api })
    const tab = () => screen.getByRole('tab', { name: /^Approvals/ })
    await waitFor(() =>
      expect(within(tab()).getByTitle('Waiting for your yes').textContent).toBe('2')
    )
    await live.send({ type: 'approvals', pending: 0 })
    expect(within(tab()).queryByTitle('Waiting for your yes')).toBeNull()
    await live.send({ type: 'approvals', pending: 5 })
    expect(within(tab()).getByTitle('Waiting for your yes').textContent).toBe('5')

    expect(api.approvals).not.toHaveBeenCalled() // nobody has opened the page
    fireEvent.click(tab())
    expect(await screen.findByRole('heading', { name: 'Approvals', level: 2 })).toBeTruthy()
    await waitFor(() => expect(api.approvals).toHaveBeenCalledTimes(1))
    // the page read an empty list: the tab says nothing waits
    await waitFor(() => expect(within(tab()).queryByTitle('Waiting for your yes')).toBeNull())
    // and a change announced by the server makes it read again
    await live.send({ type: 'approvals', pending: 1 })
    await waitFor(() => expect(api.approvals).toHaveBeenCalledTimes(2))
  })

  it('the Plugins and Modes tabs show what the status says', async () => {
    renderApp()
    await screen.findByRole('heading', { name: 'Stage' })
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    expect(await screen.findByText('Speech synthesis')).toBeTruthy()
    expect(screen.getByText('Image generation')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Modes' }))
    expect(await screen.findByRole('article', { name: 'Dance' })).toBeTruthy()
  })

  it('opening Settings and Keys loads their data', async () => {
    const api = fakeApi({
      status: async () => WITH_DATA(),
      config: async () => ({ hello: 'world' }),
      secrets: async () => [{ name: 'gemini', set: true, source: 'dpapi' }],
    })
    renderApp({ api })
    await screen.findByRole('heading', { name: 'Stage' })
    expect(api.config).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    await screen.findByText('hello')
    fireEvent.click(screen.getByRole('tab', { name: 'Keys' }))
    await screen.findByText('gemini')
    expect(api.config).toHaveBeenCalledTimes(1)
    expect(api.secrets).toHaveBeenCalledTimes(1)
  })

  it('what you typed on a page is still there when you come back to it', async () => {
    renderApp()
    await screen.findByRole('heading', { name: 'Stage' })
    const say = () =>
      within(screen.getByRole('form', { name: 'Say a line' })).getByLabelText(
        'Text'
      ) as HTMLTextAreaElement
    fireEvent.change(say(), { target: { value: 'half a sentence' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }))
    expect(say().value).toBe('half a sentence')
  })
})

describe('what arrives over the live connection', () => {
  it("run events appear in the stream, the audience's marked untrusted", async () => {
    const { live } = renderApp()
    await screen.findByRole('heading', { name: 'Stage' })
    await live.send({
      type: 'run',
      event: { ts: Date.now(), kind: 'viewer', text: 'amber_fox: hello!', trust: 'untrusted' },
    })
    await live.send({
      type: 'run',
      event: { ts: Date.now(), kind: 'system', text: 'nothing special' },
    })
    const stream = screen.getByRole('list', { name: 'Live events' })
    expect(within(stream).getByText('amber_fox: hello!')).toBeTruthy()
    expect(within(stream).getAllByText('untrusted')).toHaveLength(1)
    expect(within(stream).getByText('nothing special')).toBeTruthy()
  })

  it('a trace shows up and is then updated in place', async () => {
    const { live } = renderApp()
    await screen.findByRole('heading', { name: 'Stage' })
    await live.send({ type: 'trace', trace: { id: 't1', turn: 'u1', text: 'Hello there' } })
    expect(screen.getAllByRole('row')).toHaveLength(2)
    await live.send({
      type: 'trace',
      trace: {
        id: 't1',
        turn: 'u1',
        text: 'Hello there',
        audioSec: 1.5,
        synthMs: 200,
        liveMotion: 'used',
      },
    })
    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(screen.getByText('1.5 s')).toBeTruthy()
    expect(screen.getByText('used')).toBeTruthy()
  })

  it('alarms, newest first', async () => {
    const { live } = renderApp()
    await screen.findByText('vram_not_measured')
    await live.send({
      type: 'alarm',
      alarm: alarm({
        id: 'a2',
        ts: Date.now() + 10_000,
        level: 'error',
        code: 'plugin_failed',
        message: 'singing exited',
      }),
    })
    const codes = screen
      .getAllByRole('listitem')
      .filter((li) => li.className.startsWith('alarm '))
      .map((li) => li.querySelector('strong')?.textContent)
    expect(codes).toEqual(['plugin_failed', 'vram_not_measured'])
  })

  it('a plugin event changes the row, a mode event changes the card, a status event replaces everything', async () => {
    const { live } = renderApp()
    await screen.findByRole('heading', { name: 'Stage' })
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Modes' }))
    const imageRow = () => within(screen.getByText('Image generation').closest('tr') as HTMLElement)
    expect(imageRow().getByText('stopped')).toBeTruthy()
    await live.send({
      type: 'plugin',
      plugin: plugin({ id: 'image', title: 'Image generation', status: 'ready', pid: 777 }),
    })
    expect(imageRow().getByText('ready')).toBeTruthy()
    expect(imageRow().getByText('777')).toBeTruthy()

    expect(within(screen.getByRole('article', { name: 'Dance' })).getByText('IDLE')).toBeTruthy()
    await live.send({ type: 'mode', mode: mode({ id: 'dance', title: 'Dance', state: 'ACTIVE' }) })
    expect(within(screen.getByRole('article', { name: 'Dance' })).getByText('ACTIVE')).toBeTruthy()

    await live.send({
      type: 'status',
      status: status({
        plugins: [plugin({ id: 'only', title: 'Only one', status: 'failed' })],
        modes: [],
      }),
    })
    expect(screen.queryByText('Image generation')).toBeNull()
    expect(screen.getByText('Only one')).toBeTruthy()
  })

  it('a plugin action on the page updates the row at once', async () => {
    const api = fakeApi({
      status: async () => WITH_DATA(),
      pluginAction: async () =>
        plugin({ id: 'image', title: 'Image generation', status: 'ready', pid: 4242 }),
    })
    renderApp({ api })
    await screen.findByRole('heading', { name: 'Stage' })
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    const row = within((await screen.findByText('Image generation')).closest('tr') as HTMLElement)
    expect(row.getByText('stopped')).toBeTruthy()
    fireEvent.click(row.getByRole('button', { name: 'start Image generation' }))
    await waitFor(() => expect(api.pluginAction).toHaveBeenCalledWith('image', 'start'))
    await waitFor(() =>
      expect(
        within(screen.getByText('Image generation').closest('tr') as HTMLElement).getByText('4242')
      ).toBeTruthy()
    )
    expect(
      within(screen.getByText('Image generation').closest('tr') as HTMLElement).getByText('ready')
    ).toBeTruthy()
  })

  it('after a reconnect the history is read again, but not on the first hello', async () => {
    const { api, live } = renderApp()
    await screen.findByRole('heading', { name: 'Stage' })
    await live.send(hello)
    expect(api.events).toHaveBeenCalledTimes(1)
    await live.state('waiting')
    await live.send(hello)
    await waitFor(() => expect(api.events).toHaveBeenCalledTimes(2))
    expect(api.status).toHaveBeenCalledTimes(3) // loaded, probed while offline, loaded again
  })
})

describe('when the orchestrator does not accept the token', () => {
  it('a 401 on the first load ends in the explanation and forgets the token', async () => {
    const status401 = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError('unauthorized', 'A valid bearer token is required.', 401)
      )
    const api = fakeApi({ status: status401 })
    const { live, onTokenRejected } = renderApp({ api })
    expect(await screen.findByText(/did not accept this console's token/)).toBeTruthy()
    expect(onTokenRejected).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByText(/most likely restarted/)).toBeTruthy()
    // the server counts refusals per address (ten a minute and it stops answering): a stale token costs one
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(status401).toHaveBeenCalledTimes(1)
    expect(api.events).not.toHaveBeenCalled()
    expect(api.traces).not.toHaveBeenCalled()
    expect(live.factory).not.toHaveBeenCalled()
  })

  it('a socket that cannot connect is checked once: the token turns out to be stale, and it all stops', async () => {
    let calls = 0
    const status = vi.fn(async () => {
      calls++
      if (calls === 1) return WITH_DATA()
      throw new ApiClientError('unauthorized', 'A valid bearer token is required.', 401)
    })
    const { live, onTokenRejected } = renderApp({ api: fakeApi({ status }) })
    await screen.findByRole('heading', { name: 'Stage' })
    await live.state('waiting')
    expect(await screen.findByText(/did not accept this console's token/)).toBeTruthy()
    expect(onTokenRejected).toHaveBeenCalledTimes(1)
    expect(live.latest().closed).toBe(true)
  })

  it('the probe is rationed: a socket that keeps failing does not turn into a stream of requests', async () => {
    const { api, live } = renderApp()
    await screen.findByRole('heading', { name: 'Stage' })
    const before = api.status.mock.calls.length
    for (let i = 0; i < 6; i++) await live.state('waiting')
    expect(api.status.mock.calls.length - before).toBe(1)
  })

  it('a 429 says the orchestrator is refusing for a while, and does not give up the token', async () => {
    const status429 = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(
          'rate_limited',
          'Too many failed attempts. Try again in 60 seconds.',
          429
        )
      )
    const { live, onTokenRejected } = renderApp({ api: fakeApi({ status: status429 }) })
    expect(await screen.findByText(/Too many failed attempts from this computer/)).toBeTruthy()
    await live.ready()
    expect(onTokenRejected).not.toHaveBeenCalled()
    expect(live.latest().closed).toBe(false)
    // and when the socket does connect after all, the banner goes away
    await live.send(hello)
    expect(screen.queryByText(/Too many failed attempts from this computer/)).toBeNull()
  })

  it('a server that is not there (no answer at all) is not a rejected token', async () => {
    const down = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError('network', 'Cannot reach the orchestrator. Is it running?', 0)
      )
    const { live, onTokenRejected } = renderApp({
      api: fakeApi({ status: down, events: down, traces: down }),
    })
    await waitFor(() => expect(down).toHaveBeenCalled())
    await live.state('waiting')
    expect(onTokenRejected).not.toHaveBeenCalled()
    expect(screen.getByRole('tablist')).toBeTruthy()
    expect(screen.getByText(/live connection is down/)).toBeTruthy()
  })
})

describe('closing', () => {
  it('the live connection is closed when the page goes away', async () => {
    const api = fakeApi({ status: async () => WITH_DATA() })
    const live = fakeLive()
    const view = render(<App token={TOKEN} api={api} createLive={live.factory} />)
    await screen.findByRole('heading', { name: 'Stage' })
    await live.ready()
    view.unmount()
    expect(live.latest().closed).toBe(true)
  })
})
