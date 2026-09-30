import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import type { AppConfigInput } from '../../src/config.ts'
import type { DanceInfo, MotionLibrary } from '../../src/library/motionLibrary.ts'
import { createDanceController } from '../../src/modes/controllers/dance.ts'
import type { ModeHost } from '../../src/modes/host.ts'
import { loadModePacks } from '../../src/modes/loader.ts'
import type { LoadedMode } from '../../src/modes/loader.ts'
import { flushJson } from '../../src/modes/jsonfile.ts'
import { ModeService } from '../../src/modes/service.ts'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import { MemorySecretStore } from '../../src/plugins/secrets.ts'

const MODES = path.resolve(__dirname, '../../../../modes')

const dance = (name: string, over: Partial<DanceInfo['meta']> = {}): DanceInfo => ({
  name,
  title: over.title ?? name,
  motion: { id: `motion:${name}`, url: `/asset/motions/dance/${name}/motion.vrma` },
  music: { id: `music:${name}`, url: `/asset/motions/dance/${name}/music.ogg` },
  meta: {
    title: name,
    offset: 0,
    bpm: 120,
    speed: 1,
    volume: 1,
    credit: '',
    enabled: true,
    ...over,
  },
})

type Sent = Record<string, unknown> & { type: string }
type Controller = ReturnType<typeof createDanceController>

interface Rig {
  service: ModeService
  ctl: Controller
  hub: EventEmitter & { sent: Sent[] }
  flags: { dancing: boolean; singing: boolean; sleeping: boolean }
  events: string[]
  alarms: string[]
  held: [string, boolean][]
  told: string[]
  dir: string
  clock: { now: number }
  /** What the stage does when it is sent a dance. */
  stage: { mode: 'auto' | 'silent' | 'error' | 'idle_at_once'; playMs: number }
  brain: { busy: boolean; tellFails: boolean }
  quiet: { answer: boolean; wait: Promise<void> | null }
  sleepMode: { state: 'IDLE' | 'ACTIVE' }
  lastPlay(): Sent
  stateFromStage(phase: string, extra?: Record<string, unknown>): void
}

const dirs: string[] = []
const rigs: Rig[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.service.dispose()
  vi.useRealTimers()
  await flushJson()
  for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'animatus-dance-'))
  dirs.push(dir)
  return dir
}

async function rig(
  opts: {
    dances?: DanceInfo[]
    settings?: Record<string, unknown>
    config?: AppConfigInput
    noPack?: boolean
    /** Keep the files of an earlier rig (a restart). */
    dir?: string
  } = {}
): Promise<Rig> {
  const dir = opts.dir ?? (await tempDir())
  await mkdir(path.join(dir, 'no-plugins'), { recursive: true })
  const dances = opts.dances ?? [dance('aipao'), dance('otagei')]
  const config = parseConfig(
    { modes: { dance: { enabled: true, config: opts.settings ?? {} } }, ...opts.config },
    { root: dir }
  )
  const { modes: packs } = await loadModePacks([MODES])
  const pack = packs.find((p) => p.manifest.id === 'dance') as LoadedMode

  const hub = Object.assign(new EventEmitter(), { sent: [] as Sent[] })
  const clock = { now: 1_000_000 }
  const flags = { dancing: false, singing: false, sleeping: false }
  const events: string[] = []
  const alarms: string[] = []
  const held: [string, boolean][] = []
  const told: string[] = []
  const stage: Rig['stage'] = { mode: 'auto', playMs: 30_000 }
  const brain: Rig['brain'] = { busy: false, tellFails: false }
  const quiet: Rig['quiet'] = { answer: true, wait: null }
  const sleepMode: Rig['sleepMode'] = { state: 'IDLE' }

  const state = (id: unknown, phase: string, extra: Record<string, unknown> = {}) =>
    hub.emit('dance.state', { type: 'dance.state', dance_id: id, phase, ...extra })
  const stateFromStage = (phase: string, extra: Record<string, unknown> = {}) =>
    state([...hub.sent].reverse().find((m) => m.type === 'dance.play')?.dance_id, phase, extra)
  ;(hub as unknown as { send: (m: Sent) => boolean }).send = (m: Sent) => {
    hub.sent.push(m)
    if (m.type !== 'dance.play') return true
    const id = m.dance_id
    switch (stage.mode) {
      case 'auto':
        setTimeout(() => state(id, 'playing'), 5)
        setTimeout(() => state(id, 'idle', { reason: 'finished' }), stage.playMs)
        break
      case 'error':
        setTimeout(() => state(id, 'idle', { reason: 'error', error: 'no such motion' }), 5)
        break
      case 'idle_at_once':
        setTimeout(() => state(id, 'idle', { reason: 'stopped' }), 5)
        break
      case 'silent':
        break
    }
    return true
  }

  const motions = {
    current: { dances },
    refresh: async () => ({ dances }),
  } as unknown as MotionLibrary

  let service!: ModeService
  let ctl!: Controller
  const host: ModeHost = {
    config,
    hub: hub as unknown as ModeHost['hub'],
    motions,
    secrets: new MemorySecretStore(),
    flags,
    dataDir: dir,
    now: () => clock.now,
    log: () => {},
    event: (_k, text) => void events.push(text),
    alarm: (code, level, message) => void alarms.push(`${code}/${level}: ${message}`),
    clearAlarm: (code) => {
      const i = alarms.findIndex((a) => a.startsWith(`${code}/`))
      if (i >= 0) alarms.splice(i, 1)
    },
    stopSpeech: () => {},
    holdSpeech: (reason, on) => void held.push([reason, on]),
    setVoiceStyle: () => {},
    say: () => {},
    whenQuiet: async () => {
      if (quiet.wait) await quiet.wait
      return quiet.answer
    },
    busy: () => false,
    tellBrain: async (text) => {
      told.push(text)
      if (brain.tellFails) throw new Error('the model is away')
      return { status: 'done', sentences: 1 }
    },
    brainBusy: () => brain.busy,
    serviceUrl: () => null,
    modeState: (id) => (id === 'sleep' ? sleepMode.state : service.state(id)),
    enterMode: (id, o) => service.tryEnter(id, o),
    exitMode: async (id, reason) => void (await service.exit(id, reason)),
    prompt: (mode, name, vars) => service.prompt(mode, name, vars),
    libraryDir: () => null,
    assetUrl: (library, ...parts) => `/asset/${[library, ...parts].join('/')}`,
    llmText: async () => '',
    songLine: () => {},
  }

  service = new ModeService({
    config,
    packs: opts.noPack ? [] : [pack],
    registry: await PluginRegistry.scan(path.join(dir, 'no-plugins')),
    supervisor: {
      start: async () => ({}) as never,
      stop: async () => ({}) as never,
      getStatus: () => ({ status: 'stopped' }) as never,
    },
    pluginConfig: () => ({}),
    host,
    controllers: { dance: (h) => (ctl = createDanceController(h)) },
    gpu: { usedMb: () => null, totalMb: () => 12000 },
    measurements: () => [],
    resident: [],
    startTimeoutMs: 60_000,
    stopTimeoutMs: 60_000,
    settleTimeoutMs: 10,
    now: () => clock.now,
  })
  service.attach()
  const r: Rig = {
    service,
    ctl,
    hub,
    flags,
    events,
    alarms,
    held,
    told,
    dir,
    clock,
    stage,
    brain,
    quiet,
    sleepMode,
    lastPlay: () => [...hub.sent].reverse().find((m) => m.type === 'dance.play') as Sent,
    stateFromStage,
  }
  rigs.push(r)
  return r
}

/** Let promises and timers run for `ms` of pretend time. */
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

const sentTypes = (r: Rig) => r.hub.sent.map((m) => m.type)

/** Run one whole dance to its end and past the closing-line window. */
async function danceThrough(
  r: Rig,
  req: Parameters<Controller['request']>[0] = { source: 'gift' }
) {
  r.brain.busy = true // the model "starts answering" at once, so the queue is released at the next poll
  expect(await r.ctl.request(req)).toBe('ok')
  await tick(100)
  await tick(r.stage.playMs)
  await tick(400)
  r.brain.busy = false
}

describe('requests', () => {
  it('a request that can happen is accepted, waits for the reply to be spoken, then the dance goes to the stage with the voice held', async () => {
    const r = await rig()
    let release!: () => void
    r.quiet.wait = new Promise((res) => (release = res))
    expect(await r.ctl.request({ source: 'console', name: 'aipao' })).toBe('ok')
    expect(r.ctl.status()).toMatchObject({ phase: 'pending', current: 'aipao' })
    expect(r.flags.dancing).toBe(true)
    await tick(50)
    expect(sentTypes(r)).not.toContain('dance.play') // the reply is still being spoken
    release()
    await tick(50)
    expect(r.lastPlay()).toMatchObject({
      type: 'dance.play',
      name: 'aipao',
      motion_url: '/asset/motions/dance/aipao/motion.vrma',
      music_url: '/asset/motions/dance/aipao/music.ogg',
    })
    expect(r.held).toEqual([['dance', true]])
    expect(r.ctl.status().phase).toBe('playing')
    expect(r.service.state('dance')).toBe('ACTIVE')
  })

  it('a second request while one is running is turned away as busy', async () => {
    const r = await rig()
    expect(await r.ctl.request({ source: 'gift', requester: 'ann' })).toBe('ok')
    expect(await r.ctl.request({ source: 'gift', requester: 'bob' })).toBe('busy')
    expect(await r.ctl.request({ source: 'console', name: 'otagei' })).toBe('busy')
  })

  it('picks another dance than the last one when there is a choice, and only ever an enabled one', async () => {
    const r = await rig({
      dances: [dance('a'), dance('b'), dance('off', { enabled: false })],
      settings: { cooldown_sec: 0 },
    })
    const picked: string[] = []
    for (let i = 0; i < 6; i++) {
      r.brain.busy = true
      expect(await r.ctl.request({ source: 'tag' })).toBe('ok')
      await tick(100)
      picked.push(r.ctl.status().current as string)
      r.stateFromStage('idle', { reason: 'finished' })
      await tick(400)
      expect(r.ctl.status().phase).toBe('idle')
    }
    expect(picked.every((n) => n === 'a' || n === 'b')).toBe(true)
    for (let i = 1; i < picked.length; i++) expect(picked[i]).not.toBe(picked[i - 1])
  })

  it('names: an unknown one is "notfound", a switched-off one is "none" for a viewer but allowed from the console', async () => {
    const r = await rig({ dances: [dance('a'), dance('off', { enabled: false })] })
    expect(await r.ctl.request({ source: 'tag', name: 'ghost' })).toBe('notfound')
    expect(await r.ctl.request({ source: 'tag', name: 'off' })).toBe('none')
    expect(await r.ctl.request({ source: 'gift', name: 'off' })).toBe('none')
    expect(await r.ctl.request({ source: 'console', name: 'off' })).toBe('ok')
    expect(r.ctl.status().current).toBe('off')
  })

  it('a dance folder added while the program runs can be asked for, and a library that cannot be read is no library', async () => {
    const list = [dance('aipao')]
    const r = await rig({ dances: list })
    expect(await r.ctl.request({ source: 'tag', name: 'newone' })).toBe('notfound')
    list.push(dance('newone'))
    expect(await r.ctl.request({ source: 'tag', name: 'newone' })).toBe('ok')
    expect(r.ctl.status().current).toBe('newone')
  })

  it('there is nothing to dance: no dances at all, or every one switched off', async () => {
    const none = await rig({ dances: [] })
    expect(await none.ctl.request({ source: 'gift' })).toBe('none')
    const off = await rig({ dances: [dance('x', { enabled: false })] })
    expect(await off.ctl.request({ source: 'tag' })).toBe('none')
  })

  it('does not dance while she is asleep, for a viewer or the model, but the console may', async () => {
    const r = await rig()
    r.flags.sleeping = true
    expect(await r.ctl.request({ source: 'gift' })).toBe('busy')
    r.flags.sleeping = false
    r.sleepMode.state = 'ACTIVE'
    expect(await r.ctl.request({ source: 'tag' })).toBe('busy')
    expect(await r.ctl.request({ source: 'console', name: 'aipao' })).toBe('ok')
  })

  it('a request whose reply is not spoken in time is dropped, and says why', async () => {
    const r = await rig({ settings: { pending_timeout_sec: 5 } })
    r.quiet.answer = false
    expect(await r.ctl.request({ source: 'gift' })).toBe('ok')
    await tick(200)
    expect(r.ctl.status().phase).toBe('idle')
    expect(r.flags.dancing).toBe(false)
    expect(r.events.join('\n')).toContain('dropped')
    expect(sentTypes(r)).not.toContain('dance.play')
    expect(await r.ctl.request({ source: 'gift' })).toBe('ok') // and a later one is not blocked
  })
})

describe('the dance itself', () => {
  it('finishing on the stage leaves the mode, tells the model, and releases the queue once it answers', async () => {
    const r = await rig({ dances: [dance('aipao')], settings: { outro_window_sec: 5 } })
    await r.ctl.request({ source: 'gift', requester: 'ann' })
    await tick(100)
    expect(r.ctl.status().phase).toBe('playing')
    await tick(30_000) // the fake stage finishes the dance
    await tick(50)
    expect(r.service.state('dance')).toBe('IDLE')
    expect(r.held).toEqual([
      ['dance', true],
      ['dance', false],
    ])
    expect(r.told).toEqual([
      '【系统】You have just finished a dance "aipao" (requested by ann). Say one closing line in character.',
    ])
    // the queue stays closed (dancing flag set) until the model starts answering...
    expect(r.ctl.status().phase).toBe('after')
    expect(r.flags.dancing).toBe(true)
    r.brain.busy = true
    await tick(400)
    expect(r.ctl.status().phase).toBe('idle')
    expect(r.flags.dancing).toBe(false)
  })

  it('the queue is released after the window even if the model never answers', async () => {
    const r = await rig({ settings: { outro_window_sec: 2 } })
    await r.ctl.request({ source: 'tag', name: 'otagei' })
    await tick(100)
    await tick(30_000)
    await tick(50)
    expect(r.ctl.status().phase).toBe('after')
    r.clock.now += 2_500
    await tick(400)
    expect(r.ctl.status().phase).toBe('idle')
    expect(r.flags.dancing).toBe(false)
  })

  it('a failure to tell the model is logged and does not stop the queue from being released', async () => {
    const r = await rig({ settings: { outro_window_sec: 1 } })
    r.brain.tellFails = true
    await r.ctl.request({ source: 'gift' })
    await tick(100)
    await tick(30_000)
    await tick(50)
    r.clock.now += 1_500
    await tick(400)
    expect(r.ctl.status().phase).toBe('idle')
  })

  it('cut short from the console: the stage is told to fade out, there is no closing line, the cooldown starts', async () => {
    const r = await rig()
    await r.ctl.request({ source: 'gift' })
    await tick(100)
    await r.service.exit('dance', 'console')
    expect(r.hub.sent.find((m) => m.type === 'dance.stop')).toMatchObject({ fade_s: 0.5 })
    expect(r.told).toEqual([])
    expect(r.ctl.status().phase).toBe('idle')
    expect(r.flags.dancing).toBe(false)
    expect(r.held).toEqual([
      ['dance', true],
      ['dance', false],
    ])
    expect(await r.ctl.request({ source: 'gift' })).toBe('cooldown')
  })

  it('the stage stopping it on its own (not "finished") also skips the closing line', async () => {
    const r = await rig()
    await r.ctl.request({ source: 'gift' })
    await tick(100)
    r.stateFromStage('idle', { reason: 'stopped' })
    await tick(50)
    expect(r.told).toEqual([])
    expect(r.service.state('dance')).toBe('IDLE')
    expect(r.ctl.status().phase).toBe('idle')
  })

  it('a trial run from the tuning panel says nothing afterwards and leaves no cooldown behind', async () => {
    const r = await rig()
    expect(await r.ctl.onConsoleRequest!({ action: 'play', name: 'aipao', trial: true })).toEqual({
      ok: true,
    })
    await tick(100)
    await tick(30_000)
    await tick(50)
    expect(r.told).toEqual([])
    expect(r.ctl.status()).toMatchObject({ phase: 'idle', cooldownLeft: 0 })
    expect(await r.ctl.request({ source: 'gift' })).toBe('ok')
  })

  it('the cooldown holds viewers and the model off, not the operator', async () => {
    const r = await rig({ settings: { cooldown_sec: 60, outro_window_sec: 1 } })
    await danceThrough(r)
    expect(r.ctl.status().phase).toBe('idle')
    expect(r.ctl.status().cooldownLeft).toBeGreaterThan(50)
    expect(await r.ctl.request({ source: 'tag' })).toBe('cooldown')
    expect(await r.ctl.request({ source: 'console', name: 'otagei' })).toBe('ok')
  })

  it('the cooldown runs out with time', async () => {
    const r = await rig({ settings: { cooldown_sec: 60 } })
    await r.ctl.request({ source: 'console' })
    await tick(100)
    await r.service.exit('dance', 'console')
    expect(await r.ctl.request({ source: 'gift' })).toBe('cooldown')
    r.clock.now += 61_000
    expect(await r.ctl.request({ source: 'gift' })).toBe('ok')
  })

  it('the stage does not answer: the entry fails, an alarm is raised, the stage is told to stop, nothing is left held, no cooldown starts', async () => {
    const r = await rig({ settings: { start_timeout_sec: 5 } })
    r.stage.mode = 'silent'
    await r.ctl.request({ source: 'gift' })
    await tick(6_000)
    expect(r.ctl.status().phase).toBe('idle')
    expect(r.flags.dancing).toBe(false)
    expect(r.service.state('dance')).toBe('IDLE')
    expect(r.alarms).toHaveLength(1)
    expect(r.alarms[0]).toContain('dance_failed/warn')
    expect(r.alarms[0]).toContain('did not answer in time')
    expect(sentTypes(r)).toContain('dance.stop')
    expect(r.held).toEqual([
      ['dance', true],
      ['dance', false],
    ])
    expect(r.events.join('\n')).toContain('could not start')
    expect(r.ctl.status().cooldownLeft).toBe(0)
  })

  it("the stage ends it at once with an error: the alarm carries the stage's words", async () => {
    const r = await rig()
    r.stage.mode = 'error'
    await r.ctl.request({ source: 'gift' })
    await tick(100)
    expect(r.alarms[0]).toContain('no such motion')
    expect(r.ctl.status().phase).toBe('idle')
    expect(r.told).toEqual([])
  })

  it('the stage ends it at once without a word: the alarm says what the stage reported', async () => {
    const r = await rig()
    r.stage.mode = 'idle_at_once'
    await r.ctl.request({ source: 'gift' })
    await tick(100)
    expect(r.alarms[0]).toContain('the stage ended the dance at once (stopped)')
  })

  it('a later success clears the alarm', async () => {
    const r = await rig({ settings: { cooldown_sec: 0 } })
    r.stage.mode = 'error'
    await r.ctl.request({ source: 'gift' })
    await tick(100)
    expect(r.alarms).toHaveLength(1)
    r.stage.mode = 'auto'
    await r.ctl.request({ source: 'gift' })
    await tick(100)
    expect(r.alarms).toEqual([])
  })

  it('ignores dance states that belong to another dance', async () => {
    const r = await rig()
    await r.ctl.request({ source: 'gift' })
    await tick(100)
    r.hub.emit('dance.state', {
      type: 'dance.state',
      dance_id: 'dance-999',
      phase: 'idle',
      reason: 'finished',
    })
    await tick(50)
    expect(r.ctl.status().phase).toBe('playing')
  })

  it("applies the operator's saved tuning on top of the dance's own numbers", async () => {
    const r = await rig({ dances: [dance('aipao', { offset: 1, speed: 1 })] })
    await r.ctl.request({ source: 'console', name: 'aipao' })
    await tick(100)
    expect(r.lastPlay()).toMatchObject({ offset: 1, speed: 1 })
    expect(await r.ctl.onConsoleRequest!({ action: 'tune', offset: 2.5, speed: 1.2 })).toEqual({
      ok: true,
    })
    expect(r.hub.sent.find((m) => m.type === 'dance.tune')).toMatchObject({
      offset: 2.5,
      speed: 1.2,
    })
    await r.service.exit('dance', 'console')
    await tick(50)
    await r.ctl.request({ source: 'console', name: 'aipao' })
    await tick(100)
    expect(r.lastPlay()).toMatchObject({ offset: 2.5, speed: 1.2 })
  })

  it('what the panel sends is clamped to what the stage accepts', async () => {
    const r = await rig({ dances: [dance('aipao')] })
    await r.ctl.request({ source: 'console', name: 'aipao' })
    await tick(100)
    await r.ctl.onConsoleRequest!({ action: 'tune', offset: 999, speed: 99 })
    await r.service.exit('dance', 'console')
    await tick(50)
    await r.ctl.request({ source: 'console', name: 'aipao' })
    await tick(100)
    expect(r.lastPlay()).toMatchObject({ offset: 30, speed: 3 })
  })
})

describe('the console', () => {
  it('tuning without a dance is refused; a request that cannot happen is answered with the reason', async () => {
    const r = await rig()
    expect(await r.ctl.onConsoleRequest!({ action: 'tune', speed: 2 })).toEqual({
      ok: false,
      reason: 'no dance is playing',
    })
    expect(await r.ctl.onConsoleRequest!({ name: 'ghost' })).toEqual({
      ok: false,
      reason: 'notfound',
    })
    expect(await r.ctl.onConsoleRequest!({ name: 'aipao' })).toEqual({ ok: true })
    expect(await r.ctl.onConsoleRequest!({ name: 'otagei' })).toEqual({ ok: false, reason: 'busy' })
  })

  it('goes through the service the way the console does', async () => {
    const r = await rig()
    expect(await r.service.consoleRequest('dance', { name: 'otagei' })).toEqual({ ok: true })
    await tick(100)
    expect(r.service.state('dance')).toBe('ACTIVE')
    expect(r.lastPlay()).toMatchObject({ name: 'otagei' })
  })
})

describe('the console panel', () => {
  const panel = (r: Rig) => r.service.viewOf('dance').panel!
  const rowOf = (r: Rig, name: string) => panel(r).sections[0]!.rows.find((x) => x.id === name)!

  it('lists every dance folder, switched off ones marked, with play and trial buttons; tuning and stop are off until something runs', async () => {
    const r = await rig({
      dances: [dance('aipao', { bpm: 141 }), dance('old', { enabled: false })],
    })
    await tick(20)
    const p = panel(r)
    expect(p.status).toBe('ready')
    expect(p.sections[0]!.rows.map((x) => x.id)).toEqual(['aipao', 'old'])
    expect(rowOf(r, 'aipao').detail).toContain('141 BPM')
    expect(rowOf(r, 'old').detail).toContain('switched off')
    expect(rowOf(r, 'aipao').actions.map((a) => [a.id, a.disabled])).toEqual([
      ['play', undefined],
      ['trial', undefined],
    ])
    const [stop, tune] = p.actions
    expect(stop).toMatchObject({ id: 'stop', disabled: 'no dance is running' })
    expect(tune).toMatchObject({ id: 'tune', disabled: 'no dance is playing' })
    expect(tune!.inputs.map((i) => i.name)).toEqual(['offset', 'speed'])
  })

  it('while a dance runs: the row is marked, the buttons say why they are off, stop and tune work, and the panel shows the tuned numbers', async () => {
    const r = await rig({ dances: [dance('aipao', { offset: 1, speed: 1 }), dance('otagei')] })
    await tick(20)
    expect(await r.ctl.onConsoleRequest!({ action: 'play', row: 'aipao' })).toEqual({ ok: true })
    await tick(100)
    const p = panel(r)
    expect(p.status).toContain('dancing "aipao"')
    expect(rowOf(r, 'aipao').active).toBe(true)
    expect(rowOf(r, 'otagei').active).toBe(false)
    expect(rowOf(r, 'otagei').actions[0]!.disabled).toBe('a dance is already running')
    expect(p.actions.map((a) => [a.id, a.disabled])).toEqual([
      ['stop', undefined],
      ['tune', undefined],
    ])
    expect(await r.ctl.onConsoleRequest!({ action: 'tune', offset: 2, speed: 1.1 })).toEqual({
      ok: true,
    })
    const tune = panel(r).actions.find((a) => a.id === 'tune')!
    expect(tune.inputs.map((i) => i.value)).toEqual([2, 1.1])
    expect(await r.ctl.onConsoleRequest!({ action: 'stop' })).toEqual({ ok: true })
    await tick(50)
    expect(r.hub.sent.find((m) => m.type === 'dance.stop')).toBeTruthy()
    expect(panel(r).status).toContain('resting')
    expect(await r.ctl.onConsoleRequest!({ action: 'stop' })).toEqual({
      ok: false,
      reason: 'no dance is running',
    })
  })

  it('a trial button plays without a closing line; stop withdraws a dance that is still waiting for the speech', async () => {
    const r = await rig()
    await tick(20)
    expect(await r.ctl.onConsoleRequest!({ action: 'trial', row: 'otagei' })).toEqual({ ok: true })
    await tick(100)
    await tick(30_000)
    await tick(50)
    expect(r.told).toEqual([])
    expect(r.ctl.status().cooldownLeft).toBe(0)

    let spoken!: () => void
    r.quiet.wait = new Promise((res) => (spoken = res))
    expect(await r.ctl.onConsoleRequest!({ action: 'play', row: 'aipao' })).toEqual({ ok: true })
    expect(panel(r).status).toContain('waiting for the reply')
    expect(await r.ctl.onConsoleRequest!({ action: 'stop' })).toEqual({ ok: true })
    spoken()
    await tick(200)
    expect(r.hub.sent.filter((m) => m.type === 'dance.play')).toHaveLength(1) // only the trial
    expect(r.flags.dancing).toBe(false)
  })
})

describe('what the model and the audience are told', () => {
  it('advertises the dances before she has danced, the cooldown after, nothing while it runs or while she sleeps', async () => {
    const r = await rig({ settings: { cooldown_sec: 300, outro_window_sec: 1 } })
    await tick(20) // the first refresh of the dance list
    let p = r.service.prompts()
    expect(p).toHaveLength(1)
    expect(p[0]!.id).toBe('dance:available')
    expect(p[0]!.text).toContain('aipao (aipao), otagei (otagei)')

    r.flags.sleeping = true
    expect(r.service.prompts()).toEqual([])
    r.flags.sleeping = false

    await r.ctl.request({ source: 'gift' })
    await tick(100)
    // while it runs, the mode's own prompt is the one that goes out
    expect(r.service.prompts()).toEqual([
      { id: 'dance', text: 'You are dancing right now. Say nothing until it is over.' },
    ])
    await tick(30_000)
    await tick(50)
    r.brain.busy = true
    await tick(400)
    p = r.service.prompts()
    expect(p).toHaveLength(1)
    expect(p[0]!.id).toBe('dance:cooldown')
    expect(p[0]!.text).toContain('5 more minute')
  })

  it('says nothing about dancing when there is no dance to do', async () => {
    const r = await rig({ dances: [] })
    await tick(20)
    expect(r.service.prompts()).toEqual([])
  })

  it('a gift that means "dance": the model is told what will happen, and the dance starts by itself after the reply', async () => {
    const r = await rig()
    let spoken!: () => void
    r.quiet.wait = new Promise((res) => (spoken = res)) // the reply that thanks for the gift is still being spoken
    const lines = await r.service.batchExtras({
      text: 'ann sent a gift',
      parts: [
        { kind: 'dance', uname: 'ann' },
        { kind: 'chat', text: 'hi' },
      ],
    } as never)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('You are about to dance')
    await tick(100)
    expect(r.ctl.status().phase).toBe('pending')
    spoken()
    await tick(100)
    expect(r.ctl.status().phase).toBe('playing')
    expect(r.told).toEqual([])
    expect(r.events.some((e) => e.includes('dance gift from ann -> ok'))).toBe(true)
  })

  it('a gift during a dance, during the cooldown, or with no dance to do, gets the matching line instead', async () => {
    const r = await rig({ settings: { cooldown_sec: 120 } })
    const gift = (uname: string) =>
      r.service.batchExtras({ text: '', parts: [{ kind: 'dance', uname }] } as never)
    expect((await gift('ann'))[0]).toContain('You are about to dance')
    expect((await gift('bob'))[0]).toContain('already about to dance')
    await tick(100)
    await r.service.exit('dance', 'console')
    const cd = (await gift('cy'))[0]!
    expect(cd).toContain('danced a moment ago')
    expect(cd).toContain('2 more minute')

    const empty = await rig({ dances: [] })
    const none = await empty.service.batchExtras({
      text: '',
      parts: [{ kind: 'dance', uname: 'x' }],
    } as never)
    expect(none[0]).toContain('no dance you can do')
  })

  it("the model's tag starts a dance, by name or at random, and an unknown name does nothing", async () => {
    const r = await rig({ settings: { cooldown_sec: 0 } })
    await r.service.modelRequest('dance', { name: 'ghost' })
    expect(r.ctl.status().phase).toBe('idle')
    await r.service.modelRequest('dance', { name: 'otagei' })
    expect(r.ctl.status()).toMatchObject({ phase: 'pending', current: 'otagei' })
    await tick(100)
    expect(r.lastPlay()).toMatchObject({ name: 'otagei' })
  })
})

describe('remembering across restarts', () => {
  it('the cooldown and the last dance survive a restart', async () => {
    const first = await rig({ settings: { cooldown_sec: 600, outro_window_sec: 1 } })
    await danceThrough(first, { source: 'gift', name: 'aipao' })
    vi.useRealTimers() // the file is written by real I/O
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(path.join(first.dir, 'dance-state.json'), 'utf8'))
      expect(saved).toMatchObject({ last_name: 'aipao', last_end_at: first.clock.now })
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

    const second = await rig({ dir: first.dir, settings: { cooldown_sec: 600 } })
    expect(await second.ctl.request({ source: 'gift' })).toBe('cooldown')
    expect(second.ctl.status()).toMatchObject({ lastName: 'aipao' })
    expect(second.ctl.status().cooldownLeft).toBeGreaterThan(590)
  })

  it('a state file that is torn, or holds something else than an object, or has nonsense numbers, is ignored', async () => {
    for (const content of [
      '{oops',
      'null',
      '"a string"',
      '[1,2]',
      '{"last_end_at":"soon","tuning":{"aipao":{"offset":"x","speed":null}}}',
    ]) {
      const dir = await tempDir()
      await writeFile(path.join(dir, 'dance-state.json'), content)
      const r = await rig({ dir, dances: [dance('aipao')] })
      expect(await r.ctl.request({ source: 'gift' }), content).toBe('ok')
      await tick(100)
      expect(r.lastPlay(), content).toMatchObject({ offset: 0, speed: 1 })
    }
  })
})

describe('without the pack', () => {
  it('a mode whose pack is missing has no controller and nothing is advertised', async () => {
    const r = await rig({ noPack: true })
    expect(r.service.prompts()).toEqual([])
    expect(r.service.has('dance')).toBe(false)
  })
})
