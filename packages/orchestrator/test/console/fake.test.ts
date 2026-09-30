import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleEvent, ModeView, PluginView, StatusView } from '@animatus/protocol'
import type { ConsoleEvent as ConsoleEventType } from '@animatus/protocol'
import { ApiFailure } from '../../src/console/backend.ts'
import { FakeBackend } from '../../src/console/fake.ts'
import { SECRET_VALUE } from './support.ts'

const backends: FakeBackend[] = []
const make = (options: ConstructorParameters<typeof FakeBackend>[0] = {}) => {
  const backend = new FakeBackend(options)
  backends.push(backend)
  return backend
}
afterEach(() => {
  vi.useRealTimers()
  for (const backend of backends.splice(0)) backend.dispose()
})

const failure = (fn: () => unknown): ApiFailure => {
  try {
    fn()
  } catch (err) {
    if (err instanceof ApiFailure) return err
    throw err
  }
  throw new Error('expected an ApiFailure')
}

describe('the seed data', () => {
  it('is a valid status, with plugins in different states and modes with different verdicts', () => {
    const status = StatusView.parse(make().status())
    expect(new Set(status.plugins.map((p) => p.status))).toEqual(
      new Set(['ready', 'stopped', 'starting', 'failed', 'disabled'])
    )
    const draw = status.modes.find((m) => m.id === 'draw')
    expect(draw?.admission?.ok).toBe(false)
    expect(draw?.admission?.reasons.join(' ')).toMatch(/not measured/)
    expect(status.modes.filter((m) => m.admission?.ok)).not.toHaveLength(0)
    expect(status.modes.some((m) => Object.values(m.pairs).some((p) => !p.ok))).toBe(true)
    expect(status.plugins.find((p) => p.id === 'image')?.vram_mb_est).toBeNull()
    expect(status.plugins.find((p) => p.id === 'speech')).toMatchObject({
      vram_mb_est: 3200,
      vram_mb_measured: 3410,
    })
    expect(status.alarms.map((a) => a.level)).toEqual(['warn', 'error'])
  })

  it('hands out copies: changing an answer does not change the backend', () => {
    const backend = make()
    const first = backend.listPlugins()
    first[0]!.title = 'changed'
    first.pop()
    expect(backend.listPlugins()[0]?.title).toBe('Speech synthesis')
    expect(backend.listPlugins()).toHaveLength(6)
  })

  it('uses the clock it is given', () => {
    const backend = make({ now: () => 1_000_000 })
    expect(backend.status().now).toBe(1_000_000)
    expect(backend.status().startedAt).toBeLessThan(1_000_000)
  })
})

describe('plugins', () => {
  it('walks through the real transitions and emits an event for each', () => {
    const backend = make()
    const events: ConsoleEventType[] = []
    backend.onEvent((e) => events.push(e))
    const started = backend.pluginAction('image', 'start')
    expect(PluginView.parse(started).status).toBe('ready')
    const plugins = events
      .filter((e) => e.type === 'plugin')
      .map((e) => (e.type === 'plugin' ? e.plugin.status : ''))
    expect(plugins).toEqual(['starting', 'ready'])
    expect(backend.pluginAction('image', 'stop').status).toBe('stopped')
    const statuses = events
      .filter((e) => e.type === 'plugin')
      .map((e) => (e.type === 'plugin' ? e.plugin.status : ''))
    expect(statuses).toEqual(['starting', 'ready', 'stopping', 'stopped'])
  })

  it('refuses what cannot be done, with a reason', () => {
    const backend = make()
    expect(failure(() => backend.pluginAction('speech', 'start'))).toMatchObject({
      code: 'already_running',
      httpStatus: 409,
    })
    expect(failure(() => backend.pluginAction('image', 'stop'))).toMatchObject({
      code: 'not_running',
      httpStatus: 409,
    })
    expect(failure(() => backend.pluginAction('singing', 'stop'))).toMatchObject({
      code: 'not_running',
    })
    expect(failure(() => backend.pluginAction('game', 'start'))).toMatchObject({
      code: 'plugin_disabled',
    })
    expect(failure(() => backend.pluginAction('nothing', 'start'))).toMatchObject({
      code: 'not_found',
      httpStatus: 404,
    })
    expect(failure(() => backend.pluginLogs('nothing', 5))).toMatchObject({ code: 'not_found' })
  })

  it('a failed plugin can be started again and loses its error', () => {
    const backend = make()
    const view = backend.pluginAction('singing', 'start')
    expect(view.status).toBe('ready')
    expect(view.lastError).toBeUndefined()
  })

  it('logs grow with actions and are trimmed to what is asked', () => {
    const backend = make()
    const before = backend.pluginLogs('image', 100).length
    backend.pluginAction('image', 'start')
    const after = backend.pluginLogs('image', 100)
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)).toContain('ready')
    expect(backend.pluginLogs('image', 1)).toHaveLength(1)
  })

  it('realtime: starting, then ready; stopping, then stopped', async () => {
    vi.useFakeTimers()
    const backend = make({ realtime: true })
    const started = backend.pluginAction('image', 'start')
    expect(started.status).toBe('starting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(backend.listPlugins().find((p) => p.id === 'image')?.status).toBe('ready')
    expect(backend.pluginAction('image', 'stop').status).toBe('stopping')
    await vi.advanceTimersByTimeAsync(500)
    expect(backend.listPlugins().find((p) => p.id === 'image')?.status).toBe('stopped')
  })
})

describe('modes', () => {
  it('follows the admission verdict, exclusions and preemption', () => {
    const backend = make()
    expect(
      failure(() => backend.modeAction('draw', 'enter', { replace: false, force: false })).code
    ).toBe('no_fit')
    expect(backend.modeAction('dance', 'enter', { replace: false, force: false }).state).toBe(
      'ACTIVE'
    )
    expect(
      failure(() => backend.modeAction('sing', 'enter', { replace: false, force: false })).code
    ).toBe('excluded')
    expect(backend.modeAction('sing', 'enter', { replace: true, force: false }).state).toBe(
      'ACTIVE'
    )
    expect(backend.listModes().find((m) => m.id === 'dance')?.state).toBe('IDLE')
    expect(backend.modeAction('sleep', 'enter', { replace: false, force: false }).state).toBe(
      'ACTIVE'
    )
    expect(
      backend
        .listModes()
        .filter((m) => m.state === 'ACTIVE')
        .map((m) => m.id)
    ).toEqual(['sleep'])
    expect(
      failure(() => backend.modeAction('dance', 'enter', { replace: false, force: false })).code
    ).toBe('blocked')
    expect(backend.modeAction('dance', 'enter', { replace: false, force: true }).state).toBe(
      'ACTIVE'
    )
  })

  it('entering an active mode and leaving an idle one change nothing', () => {
    const backend = make()
    const active = backend.modeAction('commentary', 'enter', { replace: false, force: false })
    expect(active.state).toBe('ACTIVE')
    expect(backend.modeAction('dance', 'exit', { replace: false, force: false }).state).toBe('IDLE')
    expect(
      ModeView.parse(backend.modeAction('commentary', 'exit', { replace: false, force: false }))
        .state
    ).toBe('IDLE')
  })

  it('emits a mode event for every change', () => {
    const backend = make()
    const seen: string[] = []
    backend.onEvent((e) => e.type === 'mode' && seen.push(`${e.mode.id}:${e.mode.state}`))
    backend.modeAction('dance', 'enter', { replace: false, force: false })
    backend.modeAction('sing', 'enter', { replace: true, force: false })
    expect(seen).toEqual(['dance:ACTIVE', 'dance:IDLE', 'sing:ACTIVE'])
  })

  it('unknown mode: 404', () => {
    expect(
      failure(() => make().modeAction('nothing', 'enter', { replace: false, force: false }))
    ).toMatchObject({ code: 'not_found', httpStatus: 404 })
  })
})

describe('secrets', () => {
  it('keeps a value without ever returning it, in any output the backend has', () => {
    const backend = make()
    const events: ConsoleEventType[] = []
    backend.onEvent((e) => events.push(e))
    const view = backend.putSecret('openai_compat', SECRET_VALUE)
    expect(view).toEqual({ name: 'openai_compat', set: true, source: 'dpapi' })
    const everything = JSON.stringify([
      view,
      backend.listSecrets(),
      backend.status(),
      backend.listPlugins(),
      backend.listModes(),
      backend.recentEvents(500),
      backend.recentTraces(500),
      backend.config(),
      backend.pluginLogs('speech', 500),
      events,
      backend.audit,
    ])
    expect(everything).not.toContain(SECRET_VALUE)
    expect(everything).not.toContain('seed-value')
  })

  it('a key from the environment is read-only; a deleted key is not set any more; unknown names are 404', () => {
    const backend = make()
    expect(failure(() => backend.putSecret('search_api', 'x'))).toMatchObject({
      code: 'read_only',
      httpStatus: 409,
    })
    expect(failure(() => backend.deleteSecret('search_api'))).toMatchObject({ code: 'read_only' })
    expect(backend.deleteSecret('gemini')).toEqual({ name: 'gemini', set: false, source: 'dpapi' })
    expect(backend.listSecrets().find((s) => s.name === 'gemini')?.set).toBe(false)
    expect(failure(() => backend.deleteSecret('nothing'))).toMatchObject({ code: 'not_found' })
    // a name nobody declared can still be set: it starts to exist
    expect(backend.putSecret('brand_new', 'value')).toEqual({
      name: 'brand_new',
      set: true,
      source: 'dpapi',
    })
  })

  it('the configuration says which keys are set, not what they are', () => {
    const backend = make()
    expect(backend.config().secrets).toEqual({
      bilibili_cookie: { set: false },
      gemini: { set: true },
      openai_compat: { set: false },
      search_api: { set: true },
    })
  })
})

describe('speech', () => {
  it('say queues speech that takes time; stop clears it', () => {
    let now = 1_000
    const backend = make({ now: () => now })
    backend.say({
      text: 'a fairly long sentence to be spoken slowly by the fake voice',
      emotion: 'happy',
    })
    backend.say({ text: 'second', emotion: 'neutral' })
    expect(backend.status().speech).toMatchObject({ speaking: true, pending: 1 })
    now += 30_000
    expect(backend.status().speech).toMatchObject({ speaking: false, pending: 0 })
    backend.say({ text: 'again', emotion: 'neutral' })
    backend.stopSpeech()
    expect(backend.status().speech).toMatchObject({ speaking: false, pending: 0 })
    expect(backend.recentEvents(1)[0]?.text).toContain('stopped')
  })

  it('a slower voice takes longer', () => {
    let now = 0
    const backend = make({ now: () => now })
    backend.say({ text: 'x'.repeat(140), emotion: 'neutral', speed: 0.5 })
    now += 15_000
    expect(backend.status().speech.speaking).toBe(true)
    now += 6_000
    expect(backend.status().speech.speaking).toBe(false)
  })

  it('traces are complete and updated in place; in realtime they fill in step by step', async () => {
    const backend = make()
    backend.say({ text: 'one', emotion: 'neutral' })
    backend.say({ text: 'two', emotion: 'neutral' })
    const traces = backend.recentTraces(10)
    expect(traces).toHaveLength(2)
    expect(traces[0]).toMatchObject({ text: 'one', liveMotion: 'used' })
    expect(traces[0]?.audioSec).toBeGreaterThan(0)
    expect(traces[0]?.startMs).toBeGreaterThan(traces[0]?.sendMs ?? 0)

    vi.useFakeTimers()
    const live = make({ realtime: true })
    const seen: string[] = []
    live.onEvent((e) => e.type === 'trace' && seen.push(Object.keys(e.trace).sort().join(',')))
    live.say({ text: 'hello', emotion: 'neutral' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toHaveLength(4)
    expect(seen[0]).toBe('id,text,turn')
    expect(seen[3]).toContain('liveMotion')
    expect(live.recentTraces(10)).toHaveLength(1) // updated in place
  })

  it('inject puts an untrusted viewer event and an inbox note into the stream', () => {
    const backend = make()
    const events: ConsoleEventType[] = []
    backend.onEvent((e) => events.push(e))
    backend.inject({ kind: 'danmaku', name: 'amber_fox', text: 'hello', count: 1 })
    backend.inject({ kind: 'gift', name: 'quiet_owl', text: '', gift: 'rocket', count: 2 })
    backend.inject({ kind: 'guard', name: 'north_star', text: '', gift: '3', count: 1 })
    backend.inject({ kind: 'superchat', name: 'byte_crab', text: 'nice', price: 30, count: 1 })
    const runs = events.flatMap((e) => (e.type === 'run' ? [e.event] : []))
    const viewer = runs.filter((e) => e.kind === 'viewer')
    expect(viewer.map((e) => e.trust)).toEqual(['untrusted', 'untrusted', 'untrusted', 'untrusted'])
    expect(viewer.map((e) => e.text)).toEqual([
      'amber_fox: hello',
      'quiet_owl sent 2 x rocket',
      'north_star became a guard (level 3)',
      'byte_crab sent a superchat (30): nice',
    ])
    expect(runs.filter((e) => e.kind === 'inbox')).toHaveLength(4)
  })
})

describe('events', () => {
  it('every event it emits is a valid ConsoleEvent', () => {
    const backend = make()
    const events: ConsoleEventType[] = []
    backend.onEvent((e) => events.push(e))
    backend.say({ text: 'hello', emotion: 'neutral' })
    backend.inject({ kind: 'danmaku', name: 'n', text: 't', count: 1 })
    backend.pluginAction('image', 'start')
    backend.modeAction('dance', 'enter', { replace: false, force: false })
    backend.putSecret('openai_compat', 'value')
    backend.raiseAlarm({ level: 'warn', code: 'demo', message: 'm', subject: 's' })
    expect(events.length).toBeGreaterThan(8)
    for (const event of events)
      expect(ConsoleEvent.safeParse(event).success, JSON.stringify(event)).toBe(true)
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set(['run', 'trace', 'plugin', 'mode', 'alarm'])
    )
  })

  it('onEvent unsubscribes; emit reaches every subscriber; the ring buffers are bounded', () => {
    const backend = make()
    const a: ConsoleEventType[] = []
    const b: ConsoleEventType[] = []
    const offA = backend.onEvent((e) => a.push(e))
    backend.onEvent((e) => b.push(e))
    backend.emit({ type: 'hello', api: 1, now: 1 })
    offA()
    backend.emit({ type: 'hello', api: 1, now: 2 })
    expect([a.length, b.length]).toEqual([1, 2])
    for (let i = 0; i < 700; i++)
      backend.inject({ kind: 'danmaku', name: 'n', text: `t${i}`, count: 1 })
    expect(backend.recentEvents(10_000)).toHaveLength(500)
    // every inject adds a viewer line and then an inbox note
    expect(backend.recentEvents(3).map((e) => e.kind)).toEqual(['inbox', 'viewer', 'inbox'])
  })

  it('the script produces untrusted viewer lines and stops when told to; dispose() cancels every timer', async () => {
    vi.useFakeTimers()
    const backend = make()
    const events: ConsoleEventType[] = []
    backend.onEvent((e) => events.push(e))
    const stop = backend.startScript(100)
    await vi.advanceTimersByTimeAsync(1000)
    const viewer = events.flatMap((e) =>
      e.type === 'run' && e.event.kind === 'viewer' ? [e.event] : []
    )
    expect(viewer.length).toBeGreaterThanOrEqual(9)
    expect(viewer.every((e) => e.trust === 'untrusted')).toBe(true)
    stop()
    const count = events.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.length).toBe(count)
    backend.startScript(100)
    backend.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.length).toBe(count)
  })

  it('records what it was asked, by name and never by value', () => {
    const backend = make()
    backend.putSecret('openai_compat', SECRET_VALUE)
    backend.pluginAction('image', 'start')
    backend.say({ text: 'x', emotion: 'neutral' })
    expect(backend.audit).toEqual([
      { op: 'secret.put', target: 'openai_compat' },
      { op: 'plugin.start', target: 'image' },
      { op: 'say' },
    ])
  })
})
