/**
 * A rig for the sleep controller: the real `ModeService` and the real pack from `modes/`, a host made of fakes that write
 * down what the controller did, and a stage page that follows the real stage's rules (see sleepStageModel.ts). Time is
 * vitest's fake timers, so a test moves it with `tick`. Shared by the scenario tests and the randomized ones.
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { StageDownstream } from '@animatus/protocol'
import { parseConfig } from '../../src/config.ts'
import type { AppConfigInput } from '../../src/config.ts'
import { FORMATS } from '../../src/inbox/formats.ts'
import { createSleepController } from '../../src/modes/controllers/sleep.ts'
import type { SleepDeps } from '../../src/modes/controllers/sleep.ts'
import type { TrackFile } from '../../src/modes/controllers/sleepTracks.ts'
import type { ModeHost } from '../../src/modes/host.ts'
import { flushJson } from '../../src/modes/jsonfile.ts'
import { loadModePacks } from '../../src/modes/loader.ts'
import type { LoadedMode } from '../../src/modes/loader.ts'
import { ModeService } from '../../src/modes/service.ts'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import { MemorySecretStore } from '../../src/plugins/secrets.ts'
import { assetUrl } from '../../src/stage/assets.ts'
import { DEFAULT_SLEEP_STAGE, SleepStageModel } from './sleepStageModel.ts'
import type { SleepPhase, SleepStageOpts } from './sleepStageModel.ts'

export const MODES = path.resolve(__dirname, '../../../../modes')

export type Sent = Record<string, unknown> & { type: string }
export type Controller = ReturnType<typeof createSleepController>
export type Phase = SleepPhase

// ─────────────────────────────── the stage page, and the socket to it ───────────────────────────────

export interface StageOpts extends SleepStageOpts {
  /** false: no page is connected, `hub.send` says so. */
  connected: boolean
}

export class FakeHub extends EventEmitter {
  delivered: Sent[] = []
  attempted: Sent[] = []
  readonly stage: SleepStageModel
  private up: boolean
  constructor({ connected, ...opts }: StageOpts) {
    super()
    this.up = connected
    this.stage = new SleepStageModel(opts, (m) => void this.emit('sleep.state', m))
  }
  get connected(): boolean {
    return this.up
  }
  /** Like the real hub: an invalid message throws, no stage is `false`. */
  send(m: Sent): boolean {
    StageDownstream.parse(m)
    this.attempted.push(m)
    if (!this.up) return false
    this.delivered.push(m)
    this.stage.handle(m)
    return true
  }
  connectStage(): void {
    this.up = true
    this.emit('connected', { sessionId: 'x', hello: {} })
  }
  disconnectStage(): void {
    this.up = false
    this.stage.reset()
    this.emit('disconnected', { sessionId: 'x', code: 1006, reason: 'gone', replaced: false })
  }
}

// ─────────────────────────────── the rig ───────────────────────────────

export const file = (key: string, over: Partial<TrackFile> = {}): TrackFile => {
  const segs = key.split('/')
  return {
    key,
    title: key,
    parts: [...segs.slice(0, -1), `${segs.at(-1)}.mp3`],
    ext: '.mp3',
    durationS: 600,
    captions: [{ text: `${key} line`, start: 1, end: 3 }],
    notes: [],
    ...over,
  }
}

export interface RigOpts {
  tracks?: TrackFile[]
  settings?: Record<string, unknown>
  config?: AppConfigInput
  stage?: Partial<StageOpts>
  /** `paths.asmr` is not set. */
  noLibrary?: boolean
  random?: () => number
  /** Keep the files of an earlier rig (a restart). */
  dir?: string
}

export interface Rig {
  service: ModeService
  ctl: Controller
  hub: FakeHub
  flags: { dancing: boolean; singing: boolean; sleeping: boolean }
  events: string[]
  alarms: { code: string; level: string; message: string }[]
  held: [string, boolean][]
  styles: (string | null)[]
  stopped: string[]
  said: { text: string; style?: string }[]
  logs: string[]
  clock: { now: number }
  dir: string
  /** What the folder holds, and how reading it goes. */
  library: {
    tracks: TrackFile[]
    skipped: { path: string; reason: string }[]
    gate: Promise<void> | null
    fails: string | null
    hangs: boolean
    reads: number
  }
  /** Speech: `busy` is what `host.busy()` says; `wait` is what `whenQuiet` waits for. */
  speech: { busy: boolean; wait: Promise<void> | null; answer: boolean }
  plays(): Sent[]
  lastPlay(): Sent
  types(): string[]
  /** Something reaches the model: the reply is being made and spoken until `finish` is called. */
  reply(): Promise<{ lines: string[]; finish(): void }>
  /** What the stage reports about the track it was last sent. */
  report(phase: Phase, extra?: Record<string, unknown>): void
}

const dirs: string[] = []
const rigs: Rig[] = []

/** Call once at the top of a test file: fake timers for every test, and everything a rig made is cleaned up after it. */
export function installSleepRig(): void {
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
}

export const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

export const WHISPER = { ref_audio: 'C:/ref/whisper.wav', ref_text: 'a whisper' }
export const NEUTRAL = { ref_audio: 'C:/ref/neutral.wav', ref_text: 'normal speech' }
/** Tracks that end after a second, for the tests that follow a playlist; the others last a minute. */
export const SHORT = { trackMs: 1000 }

/** What the pacer hands over in sleep mode: the newest chat line, marked as a sleep reply. */
export const sleepBatch = () => {
  const text = `${FORMATS.sleepPrefix}Zed42：goodnight moonbeam`
  return { text, parts: [{ prio: 4, kind: 'sleep', text, uname: 'Zed42', uid: 7 }] }
}

/** A folder that is removed after the test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'animatus-sleep-'))
  dirs.push(dir)
  return dir
}

export async function rig(opts: RigOpts = {}): Promise<Rig> {
  const dir = opts.dir ?? (await tempDir())
  await mkdir(path.join(dir, 'no-plugins'), { recursive: true })
  const config = parseConfig(
    {
      modes: { sleep: { enabled: true, config: opts.settings ?? {} } },
      tts: { styles: { neutral: NEUTRAL, whisper: WHISPER }, default_style: 'neutral' },
      ...opts.config,
    },
    { root: dir }
  )
  const { modes: packs, errors } = await loadModePacks([MODES])
  expect(errors).toEqual([])
  const pack = packs.find((p) => p.manifest.id === 'sleep') as LoadedMode

  const hub = new FakeHub({ ...DEFAULT_SLEEP_STAGE, connected: true, ...opts.stage })
  const clock = { now: 1_000_000 }
  const flags = { dancing: false, singing: false, sleeping: false }
  const events: string[] = []
  const alarms: Rig['alarms'] = []
  const held: [string, boolean][] = []
  const styles: (string | null)[] = []
  const stopped: string[] = []
  const said: Rig['said'] = []
  const logs: string[] = []
  const speech: Rig['speech'] = { busy: false, wait: null, answer: true }
  const library: Rig['library'] = {
    tracks: opts.tracks ?? [file('rain'), file('ocean'), file('waves')],
    skipped: [],
    gate: null,
    fails: null,
    hangs: false,
    reads: 0,
  }

  let service!: ModeService
  const host: ModeHost = {
    config,
    hub: hub as unknown as ModeHost['hub'],
    motions: null,
    secrets: new MemorySecretStore(),
    flags,
    dataDir: dir,
    now: () => clock.now,
    log: (level, msg) => void logs.push(`${level}: ${msg}`),
    event: (_k, text) => void events.push(text),
    alarm: (code, level, message) => {
      const i = alarms.findIndex((a) => a.code === code)
      if (i >= 0) alarms.splice(i, 1)
      alarms.push({ code, level, message })
    },
    clearAlarm: (code) => {
      const i = alarms.findIndex((a) => a.code === code)
      if (i >= 0) alarms.splice(i, 1)
    },
    stopSpeech: (reason) => void stopped.push(reason),
    holdSpeech: (reason, on) => void held.push([reason, on]),
    setVoiceStyle: (s) => void styles.push(s),
    say: (o) => void said.push({ text: o.text, ...(o.style ? { style: o.style } : {}) }),
    whenQuiet: async () => {
      if (speech.wait) await speech.wait
      return speech.answer
    },
    busy: () => speech.busy,
    tellBrain: async () => ({ status: 'done', sentences: 1 }),
    brainBusy: () => false,
    serviceUrl: () => null,
    modeState: (id) => service.state(id),
    enterMode: (id, o) => service.tryEnter(id, o),
    exitMode: async (id, reason) => void (await service.exit(id, reason)),
    prompt: (mode, name, vars) => service.prompt(mode, name, vars),
    libraryDir: (l) => (l === 'asmr' && !opts.noLibrary ? 'C:/path/to/asmr' : null),
    assetUrl: (library, ...parts) => assetUrl(library, ...parts),
    llmText: async () => '',
    songLine: () => {},
    registerTool: () => () => {},
  }

  const deps: SleepDeps = {
    scan: async () => {
      library.reads++
      if (library.hangs) return new Promise(() => {})
      if (library.gate) await library.gate
      if (library.fails) throw new Error(library.fails)
      return { tracks: [...library.tracks], skipped: [...library.skipped] }
    },
    // no disk under fake timers, unless the test brought files of its own (a restart)
    ...(opts.dir ? {} : { readState: async () => ({}) }),
    ...(opts.random ? { random: opts.random } : {}),
  }
  let ctl!: Controller
  service = new ModeService({
    config,
    packs: [pack],
    registry: await PluginRegistry.scan(path.join(dir, 'no-plugins')),
    supervisor: {
      start: async () => ({}) as never,
      stop: async () => ({}) as never,
      getStatus: () => ({ status: 'stopped' }) as never,
    },
    pluginConfig: () => ({}),
    host,
    controllers: { sleep: (h) => (ctl = createSleepController(h, deps)) },
    gpu: { usedMb: () => null, totalMb: () => 12000 },
    measurements: () => [],
    resident: [],
    startTimeoutMs: 60_000,
    stopTimeoutMs: 60_000,
    settleTimeoutMs: 10,
    now: () => clock.now,
  })
  service.attach()

  const plays = () => hub.delivered.filter((m) => m.type === 'sleep.play')
  const r: Rig = {
    service,
    ctl,
    hub,
    flags,
    events,
    alarms,
    held,
    styles,
    stopped,
    said,
    logs,
    clock,
    dir,
    library,
    speech,
    plays,
    lastPlay: () => plays().at(-1) as Sent,
    types: () => hub.delivered.map((m) => m.type),
    async reply() {
      speech.busy = true
      let finish!: () => void
      speech.wait = new Promise<void>((res) => {
        finish = () => {
          speech.busy = false
          speech.wait = null
          res()
        }
      })
      const lines = await service.batchExtras(sleepBatch() as never)
      return { lines, finish }
    },
    report(phase, extra = {}) {
      hub.emit('sleep.state', {
        type: 'sleep.state',
        track_id: hub.attempted.filter((m) => m.type === 'sleep.play').at(-1)?.track_id,
        phase,
        ...extra,
      })
    },
  }
  rigs.push(r)
  await tick(0) // the first look at the folder
  return r
}

/** Lets real time pass (fake timers leave `setImmediate` alone) until the folder has been read `n` times. */
export async function untilRead(r: Rig, n: number): Promise<void> {
  for (let i = 0; i < 10_000 && r.library.reads < n; i++)
    await new Promise((res) => setImmediate(res))
  expect(r.library.reads).toBeGreaterThanOrEqual(n)
}

/** Enter the mode and let the first track start. */
export async function enterAndPlay(r: Rig): Promise<void> {
  await r.service.enter('sleep')
  await tick(50)
}

export const panel = (r: Rig) => r.service.viewOf('sleep').panel!
export const rowOf = (r: Rig, key: string) => panel(r).sections[0]!.rows.find((x) => x.id === key)!
export const urls = (r: Rig) => r.plays().map((m) => String(m.url).split('/').at(-1))
