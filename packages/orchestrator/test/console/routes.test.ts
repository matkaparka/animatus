import { afterEach, describe, expect, it } from 'vitest'
import {
  ConfigResponse,
  EventsResponse,
  ModeView,
  ModesResponse,
  OkResponse,
  PluginView,
  PluginsResponse,
  SecretView,
  SecretsResponse,
  StatusView,
  TracesResponse,
} from '@animatus/protocol'
import { ApiFailure } from '../../src/console/backend.ts'
import { FakeBackend } from '../../src/console/fake.ts'
import { SECRET_VALUE, createCleanup, errorCode, rawSocket, startConsole } from './support.ts'
import type { Running } from './support.ts'

const cleanup = createCleanup()
afterEach(() => cleanup.run())

const start = (over: Parameters<typeof startConsole>[1] = {}) => startConsole(cleanup, over)

/** The backend's audit trail without the polling noise. */
const audited = (run: Running) =>
  run.backend.audit
    .filter((a) => a.op !== 'status')
    .map((a) => (a.target ? `${a.op} ${a.target}` : a.op))

describe('GET /api/status', () => {
  it('answers a StatusView with the security headers and no CORS', async () => {
    const run = await start()
    const res = await run.call('GET', '/api/status')
    expect(res.status).toBe(200)
    const status = StatusView.parse(res.json())
    expect(status.api).toBe(1)
    expect(status.plugins.map((p) => p.id)).toEqual([
      'speech',
      'motion',
      'image',
      'search',
      'singing',
      'game',
    ])
    expect(status.modes.map((m) => m.id)).toEqual(['commentary', 'dance', 'sing', 'draw', 'sleep'])
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    for (const name of Object.keys(res.headers))
      expect(name.startsWith('access-control-')).toBe(false)
  })

  it('is validated before it is sent: a backend that breaks the contract gets a 500, not a broken body', async () => {
    class Broken extends FakeBackend {
      override status() {
        return { api: 1, version: 3 } as never
      }
    }
    const run = await start({ backend: new Broken() })
    const res = await run.call('GET', '/api/status')
    expect(res.status).toBe(500)
    expect(errorCode(res)).toBe('internal_error')
    expect(res.text()).not.toContain('version')
    expect(run.logs.has('error', 'broke the console contract')).toBe(true)
  })
})

describe('plugins', () => {
  it('lists them', async () => {
    const run = await start()
    const res = await run.call('GET', '/api/plugins')
    expect(res.status).toBe(200)
    const { plugins } = PluginsResponse.parse(res.json())
    expect(plugins.find((p) => p.id === 'speech')).toMatchObject({
      status: 'ready',
      gpu: true,
      vram_mb_est: 3200,
      vram_mb_measured: 3410,
    })
    expect(plugins.find((p) => p.id === 'image')).toMatchObject({
      status: 'stopped',
      vram_mb_est: null,
      vram_mb_measured: null,
    })
  })

  it('start, stop and restart reach the backend and answer with the plugin as it is afterwards', async () => {
    const run = await start()
    const started = await run.call('POST', '/api/plugins/image/start')
    expect(started.status).toBe(200)
    expect(PluginView.parse(started.json())).toMatchObject({ id: 'image', status: 'ready' })
    expect(PluginView.parse(started.json()).pid).toBeGreaterThan(0)

    const again = await run.call('POST', '/api/plugins/image/start')
    expect(again.status).toBe(409)
    expect(errorCode(again)).toBe('already_running')

    const restarted = await run.call('POST', '/api/plugins/image/restart')
    expect(restarted.status).toBe(200)
    expect(PluginView.parse(restarted.json()).status).toBe('ready')

    const stopped = await run.call('POST', '/api/plugins/image/stop')
    expect(stopped.status).toBe(200)
    expect(PluginView.parse(stopped.json())).toMatchObject({ id: 'image', status: 'stopped' })

    const stoppedAgain = await run.call('POST', '/api/plugins/image/stop')
    expect(stoppedAgain.status).toBe(409)
    expect(errorCode(stoppedAgain)).toBe('not_running')

    expect(audited(run)).toEqual([
      'plugin.start image',
      'plugin.start image',
      'plugin.restart image',
      'plugin.stop image',
      'plugin.stop image',
    ])
  })

  it('refuses a disabled plugin, an unknown one and a malformed id', async () => {
    const run = await start()
    const disabled = await run.call('POST', '/api/plugins/game/start')
    expect(disabled.status).toBe(409)
    expect(errorCode(disabled)).toBe('plugin_disabled')

    const unknown = await run.call('POST', '/api/plugins/nothing/start')
    expect(unknown.status).toBe(404)
    expect(errorCode(unknown)).toBe('not_found')

    for (const bad of [
      'Upper',
      '9lives',
      'with_underscore',
      '%2e%2e',
      'a'.repeat(49),
      '%00',
      '%E0%A4%A',
    ]) {
      const res = await run.call('POST', `/api/plugins/${bad}/start`)
      expect([400, 404], bad).toContain(res.status)
      expect(res.text(), bad).not.toContain('<title>')
    }
    expect((await run.call('POST', '/api/plugins/Upper/start')).status).toBe(400)
    expect(errorCode(await run.call('POST', '/api/plugins/Upper/start'))).toBe('invalid_id')
    expect(errorCode(await run.call('POST', '/api/plugins/%E0%A4%A/start'))).toBe('invalid_path')
  })

  it('an action route accepts no body other than an empty one', async () => {
    const run = await start()
    expect((await run.call('POST', '/api/plugins/image/start', { body: {} })).status).toBe(200)
    const res = await run.call('POST', '/api/plugins/image/stop', { body: { force: true } })
    expect(res.status).toBe(400)
    expect(errorCode(res)).toBe('unexpected_body')
  })

  it('serves the logs as plain text, capped, newest last', async () => {
    const run = await start()
    const all = await run.call('GET', '/api/plugins/singing/logs')
    expect(all.status).toBe(200)
    expect(all.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(all.headers['x-content-type-options']).toBe('nosniff')
    const lines = all.text().trimEnd().split('\n')
    expect(lines.at(-1)).toContain('restart limit reached')
    expect(lines.length).toBeGreaterThanOrEqual(3)

    const two = await run.call('GET', '/api/plugins/singing/logs?lines=2')
    expect(two.text().trimEnd().split('\n')).toEqual(lines.slice(-2))

    const huge = await run.call('GET', '/api/plugins/singing/logs?lines=99999999')
    expect(huge.status).toBe(200) // capped, not refused

    for (const bad of ['lines=0', 'lines=-1', 'lines=abc', 'lines=1.5', 'lines=1e3']) {
      const res = await run.call('GET', `/api/plugins/singing/logs?${bad}`)
      expect(res.status, bad).toBe(400)
      expect(errorCode(res)).toBe('invalid_query')
    }
    expect((await run.call('GET', '/api/plugins/nothing/logs')).status).toBe(404)
  })

  it('caps the number of log lines and the length of each line whatever the backend returns', async () => {
    class Chatty extends FakeBackend {
      override pluginLogs() {
        return [
          ...Array.from({ length: 3000 }, (_, i) => `line ${i}`),
          `x${'y'.repeat(10_000)}`,
          'has\nnewline',
        ]
      }
    }
    const run = await start({ backend: new Chatty() })
    const res = await run.call('GET', '/api/plugins/speech/logs?lines=1000')
    const lines = res.text().trimEnd().split('\n')
    expect(lines).toHaveLength(1000)
    expect(lines.every((l) => l.length <= 4000)).toBe(true)
    expect(lines.at(-1)).toBe('has newline')
  })
})

describe('modes', () => {
  it('lists them with their admission verdicts', async () => {
    const run = await start()
    const res = await run.call('GET', '/api/modes')
    expect(res.status).toBe(200)
    const { modes } = ModesResponse.parse(res.json())
    expect(modes.find((m) => m.id === 'draw')?.admission).toMatchObject({
      ok: false,
      measured: false,
    })
    expect(modes.find((m) => m.id === 'draw')?.admission?.reasons[0]).toContain('not measured')
    expect(modes.find((m) => m.id === 'dance')?.admission?.ok).toBe(true)
    expect(modes.find((m) => m.id === 'commentary')?.pairs.draw?.ok).toBe(false)
    expect(modes.find((m) => m.id === 'sleep')).toMatchObject({ priority: 100, preempts: true })
  })

  it('enter with no body uses the defaults; exclusions need `replace`', async () => {
    const run = await start()
    const dance = await run.call('POST', '/api/modes/dance/enter')
    expect(dance.status).toBe(200)
    expect(ModeView.parse(dance.json())).toMatchObject({ id: 'dance', state: 'ACTIVE' })

    const sing = await run.call('POST', '/api/modes/sing/enter')
    expect(sing.status).toBe(409)
    expect(errorCode(sing)).toBe('excluded')
    expect(sing.json<{ error: { message: string } }>().error.message).toContain('dance')

    const replaced = await run.call('POST', '/api/modes/sing/enter', { body: { replace: true } })
    expect(replaced.status).toBe(200)
    expect(ModeView.parse(replaced.json()).state).toBe('ACTIVE')
    const states = Object.fromEntries(
      ModesResponse.parse((await run.call('GET', '/api/modes')).json()).modes.map((m) => [
        m.id,
        m.state,
      ])
    )
    expect(states).toMatchObject({ dance: 'IDLE', sing: 'ACTIVE', commentary: 'ACTIVE' })
  })

  it('a mode that does not fit is refused with the reason, unless forced', async () => {
    const run = await start()
    const refused = await run.call('POST', '/api/modes/draw/enter')
    expect(refused.status).toBe(409)
    expect(errorCode(refused)).toBe('no_fit')
    expect(refused.json<{ error: { message: string } }>().error.message).toContain(
      '7488 MiB usable'
    )
    const forced = await run.call('POST', '/api/modes/draw/enter', { body: { force: true } })
    expect(forced.status).toBe(200)
  })

  it('a preempting mode interrupts the others and blocks them while it lasts; exit is idempotent', async () => {
    const run = await start()
    expect((await run.call('POST', '/api/modes/sleep/enter')).status).toBe(200)
    const states = Object.fromEntries(
      ModesResponse.parse((await run.call('GET', '/api/modes')).json()).modes.map((m) => [
        m.id,
        m.state,
      ])
    )
    expect(states).toMatchObject({ sleep: 'ACTIVE', commentary: 'IDLE' })
    const blocked = await run.call('POST', '/api/modes/dance/enter')
    expect(blocked.status).toBe(409)
    expect(errorCode(blocked)).toBe('blocked')
    expect(ModeView.parse((await run.call('POST', '/api/modes/sleep/exit')).json()).state).toBe(
      'IDLE'
    )
    expect(ModeView.parse((await run.call('POST', '/api/modes/sleep/exit')).json()).state).toBe(
      'IDLE'
    )
    expect((await run.call('POST', '/api/modes/dance/enter')).status).toBe(200)
  })

  it('act takes details for the running mode; the details are checked like everything else', async () => {
    const run = await start()
    await run.call('POST', '/api/modes/dance/enter', { body: { params: { name: 'aipao' } } })
    const acted = await run.call('POST', '/api/modes/dance/act', {
      body: { params: { action: 'tune', speed: 1.2 } },
    })
    expect(acted.status).toBe(200)
    expect(ModeView.parse(acted.json())).toMatchObject({ id: 'dance', state: 'ACTIVE' })
    const nested = await run.call('POST', '/api/modes/dance/act', {
      body: { params: { a: { b: 1 } } },
    })
    expect(nested.status).toBe(400)
    expect(errorCode(nested)).toBe('invalid_request')
    expect((await run.call('POST', '/api/modes/nothing/act')).status).toBe(404)
  })

  it('validates the body, the id and the mode', async () => {
    const run = await start()
    const badType = await run.call('POST', '/api/modes/dance/enter', { body: { replace: 'yes' } })
    expect(badType.status).toBe(400)
    expect(errorCode(badType)).toBe('invalid_request')
    expect(badType.json<{ error: { message: string } }>().error.message).toContain('replace')

    const unknownField = await run.call('POST', '/api/modes/dance/enter', {
      body: { replaced: true },
    })
    expect(unknownField.status).toBe(400)
    expect(errorCode(unknownField)).toBe('unknown_field')

    expect((await run.call('POST', '/api/modes/nothing/enter')).status).toBe(404)
    expect(errorCode(await run.call('POST', '/api/modes/Bad_Id/enter'))).toBe('invalid_id')
    expect((await run.call('POST', '/api/modes/dance/enter', { body: [] })).status).toBe(400)
  })
})

describe('secrets', () => {
  it('lists names, a set flag and the source, and nothing else', async () => {
    const run = await start()
    const res = await run.call('GET', '/api/secrets')
    expect(res.status).toBe(200)
    const { secrets } = SecretsResponse.parse(res.json())
    expect(secrets.map((s) => s.name)).toEqual([
      'bilibili_cookie',
      'gemini',
      'openai_compat',
      'search_api',
    ])
    expect(secrets.find((s) => s.name === 'gemini')).toEqual({
      name: 'gemini',
      set: true,
      source: 'dpapi',
    })
    expect(secrets.find((s) => s.name === 'openai_compat')).toEqual({
      name: 'openai_compat',
      set: false,
      source: 'dpapi',
    })
    expect(
      res
        .json<{ secrets: Array<Record<string, unknown>> }>()
        .secrets.every((s) => Object.keys(s).sort().join() === 'name,set,source')
    ).toBe(true)
  })

  it('put stores a value and answers without it; delete clears it', async () => {
    const run = await start()
    const put = await run.call('PUT', '/api/secrets/openai_compat', {
      body: { value: 'not-a-real-value-1' },
    })
    expect(put.status).toBe(200)
    expect(SecretView.parse(put.json())).toEqual({
      name: 'openai_compat',
      set: true,
      source: 'dpapi',
    })
    expect(put.text()).not.toContain('not-a-real-value-1')

    const listed = SecretsResponse.parse((await run.call('GET', '/api/secrets')).json()).secrets
    expect(listed.find((s) => s.name === 'openai_compat')?.set).toBe(true)

    const deleted = await run.call('DELETE', '/api/secrets/openai_compat')
    expect(deleted.status).toBe(200)
    expect(SecretView.parse(deleted.json())).toMatchObject({ name: 'openai_compat', set: false })
    expect(audited(run)).toEqual([
      'secret.put openai_compat',
      'listSecrets',
      'secret.delete openai_compat',
    ])
  })

  it('a key that comes from the environment cannot be changed or deleted here', async () => {
    const run = await start()
    const put = await run.call('PUT', '/api/secrets/search_api', { body: { value: 'x' } })
    expect(put.status).toBe(409)
    expect(errorCode(put)).toBe('read_only')
    expect((await run.call('DELETE', '/api/secrets/search_api')).status).toBe(409)
    expect((await run.call('DELETE', '/api/secrets/nothing_here')).status).toBe(404)
  })

  it('validates the name and the body', async () => {
    const run = await start()
    for (const name of [
      'Gemini',
      '9lives',
      'has-dash',
      'has.dot',
      'a'.repeat(49),
      '..%2fx',
      '%00',
    ]) {
      const res = await run.call('PUT', `/api/secrets/${name}`, { body: { value: 'v' } })
      expect(res.status, name).toBe(400)
      expect(['invalid_name', 'invalid_path']).toContain(errorCode(res))
    }
    const cases: Array<[string, unknown, string]> = [
      ['empty value', { value: '' }, 'invalid_request'],
      ['value too long', { value: 'v'.repeat(4097) }, 'invalid_request'],
      ['value of the wrong type', { value: 12345 }, 'invalid_request'],
      ['no value', {}, 'invalid_request'],
      ['an extra field', { value: 'v', note: 'n' }, 'unknown_field'],
      ['an array', [], 'invalid_body'],
      ['null', null, 'invalid_body'],
    ]
    for (const [label, body, code] of cases) {
      const res = await run.call('PUT', '/api/secrets/gemini', { body })
      expect(res.status, label).toBe(400)
      expect(errorCode(res), label).toBe(code)
    }
    const none = await run.call('PUT', '/api/secrets/gemini')
    expect(none.status).toBe(400)
    expect(errorCode(none)).toBe('body_required')
    // nothing above reached the backend
    expect(audited(run)).toEqual([])
  })
})

describe('say, inject and stop', () => {
  it('say reaches the backend, speaks, and shows up in the events and the trace table', async () => {
    const run = await start()
    const res = await run.call('POST', '/api/say', {
      body: { text: 'Hello there', emotion: 'happy', speed: 1.25, style: 'whisper' },
    })
    expect(res.status).toBe(200)
    expect(OkResponse.parse(res.json())).toEqual({ ok: true })
    expect(audited(run)).toEqual(['say'])
    const status = StatusView.parse((await run.call('GET', '/api/status')).json())
    expect(status.speech.speaking).toBe(true)
    const events = EventsResponse.parse((await run.call('GET', '/api/events')).json()).events
    expect(events.at(-1)).toMatchObject({ kind: 'speech' })
    expect(events.at(-1)?.text).toContain('Hello there')
    const traces = TracesResponse.parse((await run.call('GET', '/api/traces')).json()).traces
    expect(traces.at(-1)).toMatchObject({ text: 'Hello there', liveMotion: 'used' })
  })

  it('say fills in the defaults and refuses anything the schema refuses', async () => {
    const run = await start()
    expect((await run.call('POST', '/api/say', { body: { text: 'x' } })).status).toBe(200)
    const bad: Array<[string, unknown, string]> = [
      ['empty text', { text: '' }, 'invalid_request'],
      ['text too long', { text: 'x'.repeat(501) }, 'invalid_request'],
      ['unknown emotion', { text: 'x', emotion: 'whisper' }, 'invalid_request'],
      ['speed too high', { text: 'x', speed: 3 }, 'invalid_request'],
      ['speed too low', { text: 'x', speed: 0.1 }, 'invalid_request'],
      ['style too long', { text: 'x', style: 's'.repeat(33) }, 'invalid_request'],
      ['a typo in a field name', { text: 'x', speeed: 1 }, 'unknown_field'],
      ['no text', {}, 'invalid_request'],
      ['an array', ['x'], 'invalid_body'],
    ]
    for (const [label, body, code] of bad) {
      const res = await run.call('POST', '/api/say', { body })
      expect(res.status, label).toBe(400)
      expect(errorCode(res), label).toBe(code)
    }
    expect(audited(run)).toEqual(['say'])
    expect(errorCode(await run.call('POST', '/api/say'))).toBe('body_required')
  })

  it('inject puts an untrusted viewer event into the stream', async () => {
    const run = await start()
    expect((await run.call('POST', '/api/inject', { body: {} })).status).toBe(200)
    const gift = await run.call('POST', '/api/inject', {
      body: { kind: 'gift', name: 'amber_fox', gift: 'rocket', count: 3 },
    })
    expect(gift.status).toBe(200)
    const events = EventsResponse.parse(
      (await run.call('GET', '/api/events?limit=100')).json()
    ).events
    const viewer = events.filter(
      (e) => e.kind === 'viewer' && e.text.includes('amber_fox sent 3 x rocket')
    )
    expect(viewer).toHaveLength(1)
    expect(viewer[0]?.trust).toBe('untrusted')
    expect(
      events.some((e) => e.kind === 'viewer' && e.text === 'tester: ' && e.trust === 'untrusted')
    ).toBe(true)
  })

  it('inject refuses what the schema refuses', async () => {
    const run = await start()
    const bad: Array<[string, unknown]> = [
      ['unknown kind', { kind: 'nope' }],
      ['count zero', { count: 0 }],
      ['count too high', { count: 1000 }],
      ['count not whole', { count: 1.5 }],
      ['empty name', { name: '' }],
      ['name too long', { name: 'n'.repeat(41) }],
      ['text too long', { text: 't'.repeat(201) }],
      ['negative price', { kind: 'superchat', price: -1 }],
    ]
    for (const [label, body] of bad) {
      const res = await run.call('POST', '/api/inject', { body })
      expect(res.status, label).toBe(400)
      expect(errorCode(res), label).toBe('invalid_request')
    }
    expect(audited(run)).toEqual([])
  })

  it('stop cancels what is being said', async () => {
    const run = await start()
    await run.call('POST', '/api/say', { body: { text: 'first' } })
    await run.call('POST', '/api/say', { body: { text: 'second' } })
    let status = StatusView.parse((await run.call('GET', '/api/status')).json())
    expect(status.speech).toMatchObject({ speaking: true, pending: 1 })
    const res = await run.call('POST', '/api/stop')
    expect(res.status).toBe(200)
    expect(OkResponse.parse(res.json())).toEqual({ ok: true })
    status = StatusView.parse((await run.call('GET', '/api/status')).json())
    expect(status.speech).toMatchObject({ speaking: false, pending: 0 })
    expect((await run.call('POST', '/api/stop', { body: {} })).status).toBe(200)
    const withBody = await run.call('POST', '/api/stop', { body: { now: true } })
    expect(withBody.status).toBe(400)
    expect(errorCode(withBody)).toBe('unexpected_body')
  })
})

describe('events, traces and config', () => {
  it('events: newest last, limit honoured, capped, garbage refused', async () => {
    const run = await start()
    for (let i = 0; i < 5; i++)
      await run.call('POST', '/api/inject', { body: { text: `line ${i}` } })
    const all = EventsResponse.parse((await run.call('GET', '/api/events')).json()).events
    expect(all.length).toBeGreaterThan(5)
    const one = EventsResponse.parse((await run.call('GET', '/api/events?limit=1')).json()).events
    expect(one).toEqual(all.slice(-1))
    expect((await run.call('GET', '/api/events?limit=99999')).status).toBe(200)
    for (const bad of ['limit=0', 'limit=-3', 'limit=x', 'limit=2.5']) {
      expect((await run.call('GET', `/api/events?${bad}`)).status, bad).toBe(400)
    }
  })

  it('a backend that returns more than was asked is trimmed to the limit', async () => {
    class Generous extends FakeBackend {
      override recentEvents() {
        return Array.from({ length: 50 }, (_, i) => ({
          ts: i,
          kind: 'system' as const,
          text: `e${i}`,
        }))
      }
    }
    const run = await start({ backend: new Generous() })
    const events = EventsResponse.parse(
      (await run.call('GET', '/api/events?limit=5')).json()
    ).events
    expect(events.map((e) => e.text)).toEqual(['e45', 'e46', 'e47', 'e48', 'e49'])
  })

  it('traces: a trace is updated in place, not repeated', async () => {
    const run = await start()
    await run.call('POST', '/api/say', { body: { text: 'one' } })
    await run.call('POST', '/api/say', { body: { text: 'two' } })
    const traces = TracesResponse.parse((await run.call('GET', '/api/traces')).json()).traces
    expect(traces.map((t) => t.text)).toEqual(['one', 'two'])
    expect(traces[0]?.id).not.toBe(traces[1]?.id)
    expect((await run.call('GET', '/api/traces?limit=0')).status).toBe(400)
  })

  it('config: the backend object comes back wrapped, and values under secret-looking keys are masked', async () => {
    class Leaky extends FakeBackend {
      override config() {
        return {
          llm: {
            api_key: SECRET_VALUE,
            model: 'm',
            max_tokens: 300,
            nested: { authToken: SECRET_VALUE, hotkey: 'ctrl+alt+p' },
          },
          bili_cookie: SECRET_VALUE,
          empty_password: '',
        }
      }
    }
    const run = await start({ backend: new Leaky() })
    const res = await run.call('GET', '/api/config')
    expect(res.status).toBe(200)
    expect(res.text()).not.toContain(SECRET_VALUE)
    const { config } = ConfigResponse.parse(res.json())
    expect(config).toMatchObject({
      llm: {
        api_key: '[redacted]',
        model: 'm',
        max_tokens: 300,
        nested: { authToken: '[redacted]', hotkey: 'ctrl+alt+p' },
      },
      bili_cookie: '[redacted]',
      empty_password: '',
    })
  })

  it('config: the plain fake configuration is served as it is', async () => {
    const run = await start()
    const { config } = ConfigResponse.parse((await run.call('GET', '/api/config')).json())
    expect(config).toMatchObject({
      llm: { order: ['primary', 'fallback'] },
      secrets: { gemini: { set: true }, openai_compat: { set: false } },
    })
    expect(JSON.stringify(config)).not.toContain('seed-value')
  })
})

describe('routing', () => {
  it('unknown routes are 404 with an ApiError body', async () => {
    const run = await start()
    for (const p of [
      '/api/nope',
      '/api/',
      '/api',
      '/api/plugins/',
      '/api/plugins/x/y/z',
      '/api/plugins/image',
      '/api/modes/dance',
      '/api//status',
      '/api/status/',
      '/api/secrets/',
    ]) {
      const res = await run.call('GET', p)
      expect([404, 400], p).toContain(res.status)
      if (res.status === 404) expect(errorCode(res)).toBe('not_found')
      expect(res.text(), p).not.toContain('<title>')
    }
    expect((await run.call('GET', '/api/nope')).status).toBe(404)
  })

  it('a wrong method is 405 with an Allow header', async () => {
    const run = await start()
    const cases: Array<[string, string, string]> = [
      ['DELETE', '/api/status', 'GET'],
      ['POST', '/api/status', 'GET'],
      ['GET', '/api/say', 'POST'],
      ['POST', '/api/plugins', 'GET'],
      ['GET', '/api/plugins/image/start', 'POST'],
      ['POST', '/api/plugins/image/logs', 'GET'],
      ['PUT', '/api/stop', 'POST'],
      ['PATCH', '/api/secrets/gemini', 'PUT, DELETE'],
      ['POST', '/api/secrets/gemini', 'PUT, DELETE'],
      ['GET', '/api/secrets/gemini', 'PUT, DELETE'],
      ['OPTIONS', '/api/status', 'GET'],
      ['HEAD', '/api/status', 'GET'],
      ['GET', '/api/modes/dance/enter', 'POST'],
    ]
    for (const [method, p, allow] of cases) {
      const res = await run.call(method, p)
      expect(res.status, `${method} ${p}`).toBe(405)
      expect(res.headers.allow, `${method} ${p}`).toBe(allow)
      if (method !== 'HEAD') expect(errorCode(res)).toBe('method_not_allowed')
    }
    expect(audited(run)).toEqual([])
  })
})

describe('request bodies', () => {
  const say = JSON.stringify({ text: 'hello' })

  it('accepts application/json with or without a charset, nothing else', async () => {
    const run = await start()
    for (const type of [
      'application/json',
      'application/json; charset=utf-8',
      'Application/JSON',
    ]) {
      const res = await run.call('POST', '/api/say', {
        rawBody: say,
        headers: { 'Content-Type': type },
      })
      expect(res.status, type).toBe(200)
    }
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'application/jsonp',
      'application/json-patch+json',
      'multipart/form-data',
    ]) {
      const res = await run.call('POST', '/api/say', {
        rawBody: say,
        headers: { 'Content-Type': type },
      })
      expect(res.status, type).toBe(415)
      expect(errorCode(res)).toBe('unsupported_media_type')
    }
    const missing = await run.call('POST', '/api/say', { rawBody: say })
    expect(missing.status).toBe(415)
  })

  it('refuses invalid JSON and invalid UTF-8 without quoting the input', async () => {
    const run = await start()
    const headers = { 'Content-Type': 'application/json' }
    for (const raw of [
      '{"text": "quoted-marker-abc"',
      'not json quoted-marker-abc',
      '{"text": quoted-marker-abc}',
      "{'text': 'quoted-marker-abc'}",
      '',
    ]) {
      const res = await run.call('POST', '/api/say', { rawBody: raw, headers })
      expect(res.status, raw).toBe(400)
      expect(res.text(), raw).not.toContain('quoted-marker-abc')
    }
    const invalidUtf8 = await run.call('POST', '/api/say', {
      rawBody: Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]),
      headers,
    })
    expect(invalidUtf8.status).toBe(400)
    expect(errorCode(invalidUtf8)).toBe('invalid_json')
  })

  it('refuses a body over 64 KiB (413) by its declared size and by what actually arrives', async () => {
    const run = await start()
    const big = JSON.stringify({ text: 'x'.repeat(70 * 1024) })
    const declared = await run.call('POST', '/api/say', {
      rawBody: big,
      headers: { 'Content-Type': 'application/json' },
    })
    expect(declared.status).toBe(413)
    expect(errorCode(declared)).toBe('payload_too_large')

    // chunked: no Content-Length to look at, the server has to count
    const body = JSON.stringify({ text: 'y'.repeat(80 * 1024) })
    const raw = await rawSocket(
      run.port,
      `POST /api/say HTTP/1.1\r\nHost: 127.0.0.1:${run.port}\r\nAuthorization: Bearer ${run.token}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
        `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`
    )
    expect(raw).toMatch(/^HTTP\/1\.1 413/)
    expect(raw).toContain('payload_too_large')

    // a body just under the limit is fine
    const under = JSON.stringify({ text: 'z'.repeat(400), speed: 1 })
    expect(
      (
        await run.call('POST', '/api/say', {
          rawBody: under,
          headers: { 'Content-Type': 'application/json' },
        })
      ).status
    ).toBe(200)
    // and the server is still healthy
    expect((await run.call('GET', '/api/status')).status).toBe(200)
    expect(audited(run)).toEqual(['say'])
  })

  it('a declared size over the limit is refused at once, without waiting for a body that may never come', async () => {
    const run = await start()
    const raw = await rawSocket(
      run.port,
      `POST /api/say HTTP/1.1\r\nHost: 127.0.0.1:${run.port}\r\nAuthorization: Bearer ${run.token}\r\nContent-Type: application/json\r\nContent-Length: 99999999\r\nConnection: close\r\n\r\n`,
      1500
    )
    expect(raw).toMatch(/^HTTP\/1\.1 413/)
    expect(raw).toContain('payload_too_large')
    const nonsense = await rawSocket(
      run.port,
      `POST /api/say HTTP/1.1\r\nHost: 127.0.0.1:${run.port}\r\nAuthorization: Bearer ${run.token}\r\nContent-Type: application/json\r\nContent-Length: -5\r\nConnection: close\r\n\r\n`,
      1500
    )
    expect(nonsense).toMatch(/^HTTP\/1\.1 400/)
  })

  it('a big body with no token is refused before anything is read into memory', async () => {
    const run = await start()
    const res = await run.call('POST', '/api/say', {
      token: null,
      rawBody: JSON.stringify({ text: 'x'.repeat(70 * 1024) }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(401)
    expect(audited(run)).toEqual([])
  })

  it('does not read a body on GET routes and ignores a body on DELETE', async () => {
    const run = await start()
    const res = await run.call('GET', '/api/status', {
      rawBody: '{"junk":true}',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect((await run.call('DELETE', '/api/secrets/gemini', { rawBody: 'whatever' })).status).toBe(
      200
    )
  })
})

describe('what a backend can do to the answer', () => {
  it('an ApiFailure passes through, with the status, code and message clamped to what the contract allows', async () => {
    class Refusing extends FakeBackend {
      override say() {
        throw new ApiFailure('c'.repeat(100), 'm'.repeat(1000), 418)
      }
      override inject() {
        throw new ApiFailure('bad_status', 'the status is not an error status', 200)
      }
    }
    const run = await start({ backend: new Refusing() })
    const teapot = await run.call('POST', '/api/say', { body: { text: 'x' } })
    expect(teapot.status).toBe(418)
    const body = teapot.json<{ error: { code: string; message: string } }>()
    expect(body.error.code).toHaveLength(64)
    expect(body.error.message).toHaveLength(600)
    expect(errorCode(teapot)).toBe('c'.repeat(63) + '…')

    const odd = await run.call('POST', '/api/inject', { body: {} })
    expect(odd.status).toBe(500)
    expect(errorCode(odd)).toBe('bad_status')
  })

  it('any other error is a generic 500: nothing of it reaches the client, all of it reaches the log', async () => {
    class Crashing extends FakeBackend {
      override pluginAction(): never {
        throw new Error('boom at a private location')
      }
      override listModes(): never {
        // a rejected promise where the fake answers synchronously: the server awaits either
        return Promise.reject(new TypeError('rejected asynchronously')) as never
      }
    }
    const run = await start({ backend: new Crashing() })
    const sync = await run.call('POST', '/api/plugins/speech/restart')
    expect(sync.status).toBe(500)
    expect(errorCode(sync)).toBe('internal_error')
    expect(sync.text()).not.toContain('boom')
    expect(sync.text()).not.toContain('private location')
    const async_ = await run.call('GET', '/api/modes')
    expect(async_.status).toBe(500)
    expect(async_.text()).not.toContain('rejected asynchronously')
    expect(run.logs.text()).toContain('boom at a private location')
    expect(run.logs.has('error', 'console request failed')).toBe(true)
    // the server carries on
    expect((await run.call('GET', '/api/plugins')).status).toBe(200)
  })

  it('a list that breaks the contract is a 500, not a broken body', async () => {
    class Garbled extends FakeBackend {
      override listPlugins() {
        return [{ id: 1 }] as never
      }
      override recentTraces() {
        return 'nope' as never
      }
    }
    const run = await start({ backend: new Garbled() })
    for (const p of ['/api/plugins', '/api/traces']) {
      const res = await run.call('GET', p)
      expect(res.status, p).toBe(500)
      expect(errorCode(res)).toBe('internal_error')
    }
  })
})
