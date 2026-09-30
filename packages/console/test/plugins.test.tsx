import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PluginView } from '@animatus/protocol'
import { ApiClientError } from '../src/api.ts'
import { Plugins, allowedActions } from '../src/Plugins.tsx'
import { fakeApi, plugin } from './helpers.tsx'
import type { MockedApi } from './helpers.tsx'

const PLUGINS: PluginView[] = [
  plugin({
    id: 'speech',
    title: 'Speech synthesis',
    status: 'ready',
    pid: 4120,
    startedAt: Date.now() - 3_600_000,
    gpu: true,
    vram_mb_est: 3200,
    vram_mb_measured: 3410,
    health: { ok: true, ready: true, service: 'tts' },
  }),
  plugin({ id: 'image', title: 'Image generation', kind: 'image', status: 'stopped', gpu: true }),
  plugin({
    id: 'motion',
    title: 'Motion generation',
    kind: 'motion',
    status: 'ready',
    pid: 4188,
    gpu: false,
  }),
  plugin({
    id: 'singing',
    title: 'Singing voice',
    kind: 'singing',
    status: 'failed',
    restarts: 3,
    lastError: 'exited with code 1 after 3 restarts',
    gpu: true,
    vram_mb_est: 2500,
  }),
  plugin({
    id: 'search',
    title: 'Web search',
    kind: 'search',
    status: 'starting',
    pid: 4310,
    health: { ok: true, ready: false, service: 'search', detail: 'loading index' },
  }),
  plugin({ id: 'game', title: 'Game worker', kind: 'game', status: 'disabled', enabled: false }),
]

function renderPlugins(
  over: {
    api?: MockedApi
    plugins?: PluginView[]
    onChange?: (p: PluginView) => void
    onRefresh?: (p: PluginView[]) => void
  } = {}
) {
  const api = over.api ?? fakeApi()
  const onChange = over.onChange ?? vi.fn()
  const onRefresh = over.onRefresh ?? vi.fn()
  render(
    <Plugins
      api={api}
      plugins={over.plugins ?? PLUGINS}
      onChange={onChange}
      onRefresh={onRefresh}
    />
  )
  return { api, onChange, onRefresh }
}

const rowOf = (title: string) => within(screen.getByText(title).closest('tr') as HTMLElement)
const button = (row: ReturnType<typeof rowOf>, name: string) =>
  row.getByRole('button', { name }) as HTMLButtonElement

describe('the table', () => {
  it('one row per plugin with status, pid, restarts and health', () => {
    renderPlugins()
    expect(screen.getAllByRole('row')).toHaveLength(PLUGINS.length + 1)
    const speech = rowOf('Speech synthesis')
    expect(speech.getAllByText('ready')).toHaveLength(2) // the status, and the health it reports
    expect(speech.getByText('4120')).toBeTruthy()
    const singing = rowOf('Singing voice')
    expect(singing.getByText('failed')).toBeTruthy()
    expect(singing.getByText('3')).toBeTruthy()
    expect(singing.getByText('exited with code 1 after 3 restarts')).toBeTruthy()
    const search = rowOf('Web search')
    expect(search.getByText('loading')).toBeTruthy()
    expect(search.getByText('loading index')).toBeTruthy()
    expect(rowOf('Game worker').getByText(/disabled in the configuration/)).toBeTruthy()
  })

  it('GPU memory: the estimate next to the measurement, and "not measured" wherever a figure is null', () => {
    renderPlugins()
    const speech = rowOf('Speech synthesis')
    expect(speech.getByText('3200 MiB')).toBeTruthy()
    expect(speech.getByText('3410 MiB')).toBeTruthy()
    expect(speech.queryByText('not measured')).toBeNull()
    // never measured at all
    expect(rowOf('Image generation').getAllByText('not measured')).toHaveLength(2)
    // an estimate with no measurement yet
    const singing = rowOf('Singing voice')
    expect(singing.getByText('2500 MiB')).toBeTruthy()
    expect(singing.getAllByText('not measured')).toHaveLength(1)
    // a plugin that does not use the GPU does not pretend to have a figure
    expect(rowOf('Motion generation').getByText('CPU only')).toBeTruthy()
    expect(rowOf('Motion generation').queryByText('not measured')).toBeNull()
  })

  it('the buttons follow the state: what can be done now is enabled, the rest is not', () => {
    renderPlugins()
    const speech = rowOf('Speech synthesis')
    expect([
      button(speech, 'start Speech synthesis').disabled,
      button(speech, 'stop Speech synthesis').disabled,
      button(speech, 'restart Speech synthesis').disabled,
    ]).toEqual([true, false, false])
    const image = rowOf('Image generation')
    expect([
      button(image, 'start Image generation').disabled,
      button(image, 'stop Image generation').disabled,
      button(image, 'restart Image generation').disabled,
    ]).toEqual([false, true, true])
    const singing = rowOf('Singing voice')
    expect([
      button(singing, 'start Singing voice').disabled,
      button(singing, 'stop Singing voice').disabled,
    ]).toEqual([false, true])
    const search = rowOf('Web search')
    expect([
      button(search, 'start Web search').disabled,
      button(search, 'stop Web search').disabled,
      button(search, 'restart Web search').disabled,
    ]).toEqual([true, false, true])
    const game = rowOf('Game worker')
    expect(
      ['start', 'stop', 'restart'].map((a) => button(game, `${a} Game worker`).disabled)
    ).toEqual([true, true, true])
  })

  it('allowedActions covers every state', () => {
    expect(allowedActions('ready')).toEqual({ start: false, stop: true, restart: true })
    expect(allowedActions('unhealthy')).toEqual({ start: false, stop: true, restart: true })
    expect(allowedActions('stopped')).toEqual({ start: true, stop: false, restart: false })
    expect(allowedActions('failed')).toEqual({ start: true, stop: false, restart: false })
    expect(allowedActions('starting')).toEqual({ start: false, stop: true, restart: false })
    for (const s of ['stopping', 'disabled'] as const)
      expect(allowedActions(s)).toEqual({ start: false, stop: false, restart: false })
  })

  it('says so when there are no plugins', () => {
    renderPlugins({ plugins: [] })
    expect(screen.getByText('No plugins are configured.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('explains what "not measured" means', () => {
    renderPlugins()
    expect(screen.getByText(/until the probe has measured the service/)).toBeTruthy()
  })
})

describe('start, stop, restart', () => {
  it('start asks the orchestrator and hands the plugin as it is afterwards on', async () => {
    const { api, onChange } = renderPlugins()
    fireEvent.click(button(rowOf('Image generation'), 'start Image generation'))
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    expect(api.pluginAction).toHaveBeenCalledWith('image', 'start')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'image', status: 'ready' }))
  })

  it('stop and restart ask for those', async () => {
    const { api } = renderPlugins()
    fireEvent.click(button(rowOf('Speech synthesis'), 'stop Speech synthesis'))
    await waitFor(() => expect(api.pluginAction).toHaveBeenCalledWith('speech', 'stop'))
    fireEvent.click(button(rowOf('Motion generation'), 'restart Motion generation'))
    await waitFor(() => expect(api.pluginAction).toHaveBeenCalledWith('motion', 'restart'))
  })

  it("a refusal is shown with the plugin's name, in the server's words", async () => {
    const pluginAction = vi
      .fn()
      .mockRejectedValue(new ApiClientError('already_running', 'image is already ready', 409))
    const { onChange } = renderPlugins({ api: fakeApi({ pluginAction }) })
    fireEvent.click(button(rowOf('Image generation'), 'start Image generation'))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Image generation: image is already ready'
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it("shows what is under way on the button and holds the row's other buttons until it is done", async () => {
    let release: (p: PluginView) => void = () => undefined
    const pluginAction = vi.fn(() => new Promise<PluginView>((resolve) => (release = resolve)))
    renderPlugins({ api: fakeApi({ pluginAction }) })
    const image = rowOf('Image generation')
    fireEvent.click(button(image, 'start Image generation'))
    await waitFor(() =>
      expect(image.getByRole('button', { name: 'start Image generation' }).textContent).toBe(
        'start...'
      )
    )
    expect(button(image, 'logs of Image generation').disabled).toBe(false)
    // other rows are not held
    expect(button(rowOf('Speech synthesis'), 'stop Speech synthesis').disabled).toBe(false)
    release(plugin({ id: 'image', status: 'ready' }))
    await waitFor(() =>
      expect(image.getByRole('button', { name: 'start Image generation' }).textContent).toBe(
        'start'
      )
    )
  })

  it('Refresh reads the list again and hands it on', async () => {
    const fresh = [plugin({ id: 'only', title: 'Only' })]
    const { api, onRefresh } = renderPlugins({ api: fakeApi({ plugins: async () => fresh }) })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(fresh))
    expect(api.plugins).toHaveBeenCalledTimes(1)
  })

  it('a refresh that fails says so', async () => {
    const plugins = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError('network', 'Cannot reach the orchestrator. Is it running?', 0)
      )
    renderPlugins({ api: fakeApi({ plugins }) })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Cannot reach the orchestrator/)
  })
})

describe('the logs drawer', () => {
  it('opens for one plugin, loads its lines and shows them as text', async () => {
    const pluginLogs = vi.fn(async () => [
      '[info] model loaded',
      '\u001b[31m[error] red text\u001b[0m',
      '<img src=x onerror=alert(1)>',
    ])
    const { api } = renderPlugins({ api: fakeApi({ pluginLogs }) })
    fireEvent.click(button(rowOf('Speech synthesis'), 'logs of Speech synthesis'))
    const dialog = await screen.findByRole('dialog', { name: 'Logs of Speech synthesis' })
    await waitFor(() => expect(within(dialog).getByText(/model loaded/)).toBeTruthy())
    expect(api.pluginLogs).toHaveBeenCalledWith('speech', 200)
    const pre = dialog.querySelector('pre') as HTMLElement
    // colour codes are stripped, and markup in a log line is text, not markup
    expect(pre.textContent).toBe(
      '[info] model loaded\n[error] red text\n<img src=x onerror=alert(1)>'
    )
    expect(pre.querySelector('img')).toBeNull()
  })

  it('shows a note for an empty log, and an error when it cannot be read', async () => {
    const pluginLogs = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        new ApiClientError('not_found', 'there is no plugin called speech', 404)
      )
    renderPlugins({ api: fakeApi({ pluginLogs }) })
    fireEvent.click(button(rowOf('Speech synthesis'), 'logs of Speech synthesis'))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText('(no log lines)')).toBeTruthy())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'there is no plugin called speech'
    )
  })

  it('the number of lines can be changed, and Refresh reloads', async () => {
    const { api } = renderPlugins({ api: fakeApi({ pluginLogs: async () => ['a'] }) })
    fireEvent.click(button(rowOf('Speech synthesis'), 'logs of Speech synthesis'))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(api.pluginLogs).toHaveBeenCalledTimes(1))
    fireEvent.change(within(dialog).getByLabelText('Lines'), { target: { value: '500' } })
    await waitFor(() => expect(api.pluginLogs).toHaveBeenLastCalledWith('speech', 500))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.pluginLogs).toHaveBeenCalledTimes(3))
  })

  it('closes with the button and with Escape', async () => {
    renderPlugins({ api: fakeApi({ pluginLogs: async () => ['a'] }) })
    fireEvent.click(button(rowOf('Speech synthesis'), 'logs of Speech synthesis'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button(rowOf('Speech synthesis'), 'logs of Speech synthesis'))
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
