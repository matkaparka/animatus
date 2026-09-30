import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ConsoleEvent,
  PluginView,
  RunEvent,
  SecretView,
  SpeechTraceView,
  StatusView,
} from '@animatus/protocol'
import { ApiFailure } from '../../src/console/backend.ts'
import { AppBackend } from '../../src/console/appBackend.ts'
import { danmaku, installCleanup, onCleanup, rig, until } from '../app/rig.ts'

installCleanup()

const REPO_PLUGINS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../plugins'
)

async function fakeGsv() {
  const server: Server = createServer((req, res) => {
    if (req.url === '/docs') return void res.writeHead(200).end('docs')
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  onCleanup(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const failure = async (p: Promise<unknown> | (() => unknown)): Promise<ApiFailure> => {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    expect(e).toBeInstanceOf(ApiFailure)
    return e as ApiFailure
  }
  throw new Error('expected an ApiFailure')
}

describe('the console backend over a running app', () => {
  it('reports a status that satisfies the contract and follows the stage and the alarms', async () => {
    const r = await rig()
    const backend = new AppBackend(r.app)
    const before = StatusView.parse(await backend.status())
    expect(before.stage.connected).toBe(false)
    expect(before.speech).toEqual({ speaking: false, pending: 0, held: false })
    expect(before.llm).toEqual({ providers: [], order: [] })

    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.app.alarms.raise('test_alarm', 'warn', 'something to look at')
    const after = StatusView.parse(await backend.status())
    expect(after.stage.connected).toBe(true)
    expect(after.alarms.map((a) => a.code)).toContain('test_alarm')
  })

  it('lists plugins from the registry and the supervisor, and starts and stops them', async () => {
    const url = await fakeGsv()
    const r = await rig({
      noTts: true,
      pluginsDir: REPO_PLUGINS,
      config: {
        plugins: { 'gptsovits-attach': { enabled: true, config: { url } } },
        tts: { styles: { neutral: { ref_audio: 'a.wav', ref_text: 'x' } } },
      },
    })
    const backend = new AppBackend(r.app)
    await until(
      () => r.app.supervisor.getStatus('gptsovits-attach').status === 'ready',
      5000,
      'the plugin to be ready'
    )

    const views = backend.listPlugins().map((p) => PluginView.parse(p))
    const attach = views.find((p) => p.id === 'gptsovits-attach')
    const own = views.find((p) => p.id === 'gptsovits')
    expect(attach).toMatchObject({
      enabled: true,
      status: 'ready',
      service: 'tts',
      kind: 'tts',
      url,
      gpu: true,
    })
    expect(own).toMatchObject({ enabled: false, status: 'disabled' })

    expect((await backend.pluginAction('gptsovits-attach', 'stop')).status).toBe('stopped')
    expect((await backend.pluginAction('gptsovits-attach', 'start')).status).toBe('ready')
    expect((await backend.pluginAction('gptsovits-attach', 'restart')).status).toBe('ready')
    expect(Array.isArray(backend.pluginLogs('gptsovits-attach', 20))).toBe(true)
  })

  it('refuses an unknown plugin with 404 and a disabled one with 409, naming nothing but the id', async () => {
    const r = await rig({ noTts: true, pluginsDir: REPO_PLUGINS })
    const backend = new AppBackend(r.app)
    const unknown = await failure(backend.pluginAction('nope', 'start'))
    expect([unknown.code, unknown.httpStatus]).toEqual(['unknown_plugin', 404])
    const disabled = await failure(backend.pluginAction('gptsovits', 'start'))
    expect([disabled.code, disabled.httpStatus]).toEqual(['plugin_disabled', 409])
    expect(() => backend.pluginLogs('nope', 5)).toThrow(ApiFailure)
  })

  it('keeps secrets write-only: names and where they live, never a value', async () => {
    const r = await rig()
    const backend = new AppBackend(r.app)
    const before = (await backend.listSecrets()).map((s) => SecretView.parse(s))
    expect(before.find((s) => s.name === 'gemini')).toEqual({
      name: 'gemini',
      set: false,
      source: 'unset',
    })

    const secret = ['a', 'quite', 'long', 'secret', 'value', '12345'].join('-')
    const put = SecretView.parse(await backend.putSecret('gemini', secret))
    expect(put).toMatchObject({ name: 'gemini', set: true })
    const shown = JSON.stringify([
      put,
      await backend.listSecrets(),
      await backend.status(),
      await backend.config(),
    ])
    expect(shown).not.toContain(secret)

    const gone = await backend.deleteSecret('gemini')
    expect(gone.set).toBe(false)
    expect((await failure(backend.putSecret('Not A Name', 'x'))).code).toBe('invalid_name')
    expect((await failure(backend.deleteSecret('../x'))).httpStatus).toBe(400)
  })

  it('a key that arrives through the console makes a configured provider usable, without a restart', async () => {
    const r = await rig({
      app: { llm: undefined },
      config: {
        llm: {
          providers: [{ kind: 'gemini', id: 'primary', model: 'm', api_key: '${secret:gemini}' }],
        },
      },
    })
    const backend = new AppBackend(r.app)
    expect(r.app.llmUsable).toBe(false)
    expect(r.app.alarms.has('llm_provider_unavailable', 'primary')).toBe(true)
    await backend.putSecret('gemini', 'test-key-for-the-console-test-1234')
    expect(r.app.llmUsable).toBe(true)
    expect(r.app.alarms.has('llm_provider_unavailable', 'primary')).toBe(false)
    const status = StatusView.parse(await backend.status())
    expect(status.llm.order).toEqual(['primary'])
    expect(status.llm.providers.map((p) => p.id)).toEqual(['primary'])
    await backend.deleteSecret('gemini')
    expect(r.app.llmUsable).toBe(false)
  })

  it('say, inject and stop reach the app; the records come back through the contract', async () => {
    const r = await rig()
    const backend = new AppBackend(r.app)
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)

    backend.say({ text: 'A line from the console.', emotion: 'happy' })
    await until(() => stage.begins.length >= 1, 4000, 'the spoken line')
    backend.inject({ kind: 'danmaku', name: 'tester', text: 'hello from the console', count: 1 })
    await until(() => r.llm.requests.length >= 1, 5000, 'the model to be asked')
    backend.stopSpeech()

    const events = backend.recentEvents(50).map((e) => RunEvent.parse(e))
    expect(
      events.some((e) => e.kind === 'speech' && e.text.includes('A line from the console.'))
    ).toBe(true)
    expect(events.some((e) => e.kind === 'viewer' && e.trust === 'untrusted')).toBe(true)
    const traces = backend.recentTraces(20).map((t) => SpeechTraceView.parse(t))
    expect(traces.length).toBeGreaterThanOrEqual(1)
  })

  it('shows the configuration as the console may see it: references, not values', async () => {
    const r = await rig({
      config: {
        llm: { providers: [{ kind: 'gemini', id: 'p', model: 'm', api_key: '${secret:gemini}' }] },
      },
    })
    const cfg = new AppBackend(r.app).config()
    expect(JSON.stringify(cfg)).toContain('${secret:gemini}')
    expect(cfg.root).toBeUndefined()
  })

  it('pushes live events: run lines, traces, alarms and plugin changes', async () => {
    const url = await fakeGsv()
    const r = await rig({
      noTts: true,
      pluginsDir: REPO_PLUGINS,
      config: {
        plugins: { 'gptsovits-attach': { enabled: true, config: { url } } },
        tts: { styles: { neutral: { ref_audio: 'a.wav', ref_text: 'x' } } },
      },
    })
    const backend = new AppBackend(r.app)
    const seen: string[] = []
    const off = backend.onEvent((e) => seen.push(ConsoleEvent.parse(e).type))
    await until(() => r.app.supervisor.getStatus('gptsovits-attach').status === 'ready', 5000)
    await backend.pluginAction('gptsovits-attach', 'restart')
    r.app.alarms.raise('x_alarm', 'info', 'hello')
    r.app.runLog.add('system', 'a line')
    expect(new Set(seen)).toEqual(new Set(['plugin', 'alarm', 'run']))
    off()
    const n = seen.length
    r.app.runLog.add('system', 'after unsubscribing')
    expect(seen).toHaveLength(n)
  })

  it('modes: none are set up yet, and asking for one is a 404 rather than a crash', async () => {
    const r = await rig()
    const backend = new AppBackend(r.app)
    expect(backend.listModes()).toEqual([])
    const f = await failure(backend.modeAction('dance', 'enter', { replace: false, force: false }))
    expect([f.code, f.httpStatus]).toEqual(['unknown_mode', 404])
  })
})

describe('the console over HTTP, with the token', () => {
  it('the app starts the console server, answers /api/status with the token and refuses without it', async () => {
    const r = await rig({
      app: { console: true, consoleDir: path.join(process.cwd(), 'no-console-build') },
    })
    const openUrl = r.app.consoleUrl
    expect(openUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/)
    const [base, token] = (openUrl as string).split('/#token=') as [string, string]

    const ok = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } })
    expect(ok.status).toBe(200)
    const status = StatusView.parse(await ok.json())
    expect(status.api).toBe(1)

    expect((await fetch(`${base}/api/status`)).status).toBe(401)
    expect(
      (await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer wrong' } })).status
    ).toBe(401)

    // the address with the token is not in the log the operator can read, nor in what the console shows
    const shown = JSON.stringify([r.app.runLog.recent(500), r.app.alarms.list(), status])
    expect(shown).not.toContain(token)

    const say = await fetch(`${base}/api/say`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'said through the http route', emotion: 'happy' }),
    })
    expect(say.status).toBe(200)
    await until(
      () => r.app.runLog.recent(50).some((e) => e.text.includes('said through the http route')),
      3000
    )
  })

  it('a second app does not need the console: no server, no address', async () => {
    const r = await rig()
    expect(r.app.consoleUrl).toBeNull()
    void danmaku
  })
})
