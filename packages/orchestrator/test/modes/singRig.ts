/**
 * The sing controller run the way the program runs it: through the real `ModeService` (the real manager, the real
 * pack), against a fake song service over real HTTP, with a stage that answers `sing.play` and `sing.stop` the way
 * the real page does (and can be told to misbehave). Time is real: the controller's poll interval and timeouts are
 * set small in the settings, so a test waits fractions of a second, never for a fake clock.
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import type { AppConfigInput } from '../../src/config.ts'
import type { ModeHost } from '../../src/modes/host.ts'
import { createSingController } from '../../src/modes/controllers/sing.ts'
import { loadModePacks } from '../../src/modes/loader.ts'
import { ModeService } from '../../src/modes/service.ts'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import { MemorySecretStore } from '../../src/plugins/secrets.ts'
import { assetUrl } from '../../src/stage/assets.ts'
import { FakeSongService } from './singFakeService.ts'
import { flushJson } from '../../src/modes/jsonfile.ts'

export const MODES = path.resolve(__dirname, '../../../../modes')

export type Sent = Record<string, unknown> & { type: string }

/** What the fake stage does with a song. */
export interface StageBehavior {
  /** `auto`: loads, plays for `playMs`, ends. `silent`: never answers. `error`: fails at once with a reason. */
  mode: 'auto' | 'silent' | 'error' | 'idle_at_once'
  loadMs: number
  playMs: number
  fadeMs: number
  /** After `sing.stop` it never says it has stopped. */
  stopHangs: boolean
}

export interface Alarm {
  code: string
  level: string
  message: string
  subject?: string
}

export interface SingRig {
  service: ModeService
  ctl: ReturnType<typeof createSingController>
  fake: FakeSongService
  hub: EventEmitter & { sent: Sent[]; overlays: Sent[]; connected: boolean }
  flags: { dancing: boolean; singing: boolean; sleeping: boolean }
  events: string[]
  alarms: Alarm[]
  held: [string, boolean][]
  told: string[]
  songLines: string[]
  logs: string[]
  dir: string
  songsDir: string
  stage: StageBehavior
  /** The service is up (a URL) or not. */
  serviceUp: { value: boolean }
  brain: { busy: boolean }
  quiet: { answer: boolean; wait: Promise<void> | null }
  entered: { id: string; opts: unknown }[]
  /** Everything the stage was sent of one type. */
  sent(type: string): Sent[]
  /** A report of the stage about the song most recently sent. */
  report(phase: string, extra?: Record<string, unknown>): void
  alarmCodes(): string[]
}

const dirs: string[] = []
const rigs: SingRig[] = []
const fakes: FakeSongService[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.service.dispose().catch(() => undefined)
  for (const f of fakes.splice(0)) await f.close().catch(() => undefined)
  await flushJson()
  for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

export async function tempDir(prefix = 'sing'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `animatus-${prefix}-`))
  dirs.push(dir)
  return dir
}

export async function singRig(
  opts: {
    settings?: Record<string, unknown>
    config?: AppConfigInput
    stage?: Partial<StageBehavior>
    /** Keep the folders and the fake service of an earlier rig (a restart of the program). */
    previous?: SingRig
    /** No `paths.songs` at all. */
    noSongsPath?: boolean
    /** The folder `paths.songs` names, when it is not the one the fake service keeps songs in. */
    servedDir?: string
    /** A stand-in for the dance mode (same manifest, no code) so that the two can be told to exclude each other. */
    withDance?: boolean
    /** Arranges the fake service before the controller looks at it for the first time. */
    arrange?: (fake: FakeSongService) => void
  } = {}
): Promise<SingRig> {
  const dir = opts.previous?.dir ?? (await tempDir())
  const songsDir = opts.previous?.songsDir ?? path.join(dir, 'songs')
  await mkdir(songsDir, { recursive: true })
  await mkdir(path.join(dir, 'no-plugins'), { recursive: true })
  const fake = opts.previous?.fake ?? (await FakeSongService.start(songsDir))
  if (!opts.previous) fakes.push(fake)
  const config = parseConfig(
    {
      paths: {
        data_dir: path.join(dir, 'data'),
        ...(opts.noSongsPath ? {} : { songs: opts.servedDir ?? songsDir }),
      },
      plugins: { singing: { enabled: true } },
      modes: {
        sing: {
          enabled: true,
          config: {
            poll_sec: 0.1,
            request_timeout_sec: 1,
            request_slack_sec: 0.3,
            call_timeout_sec: 0.5,
            quiet_timeout_sec: 1,
            start_timeout_sec: 1,
            stop_timeout_sec: 1,
            watchdog_extra_sec: 1,
            retry_after_sec: 1,
            outro_window_sec: 0.5,
            service_alarm_after_sec: 1,
            ...opts.settings,
          },
        },
        ...(opts.withDance ? { dance: { enabled: true } } : {}),
      },
      ...opts.config,
    },
    { root: dir }
  )
  opts.arrange?.(fake)
  const { modes: packs } = await loadModePacks([MODES])
  const wanted = packs.filter(
    (p) => p.manifest.id === 'sing' || (opts.withDance && p.manifest.id === 'dance')
  )

  const hub = Object.assign(new EventEmitter(), {
    sent: [] as Sent[],
    overlays: [] as Sent[],
    connected: true,
  })
  const stage: StageBehavior = {
    mode: 'auto',
    loadMs: 5,
    playMs: 300,
    fadeMs: 10,
    stopHangs: false,
    ...opts.stage,
  }
  const flags = { dancing: false, singing: false, sleeping: false }
  const events: string[] = []
  const alarms: Alarm[] = []
  const held: [string, boolean][] = []
  const told: string[] = []
  const songLines: string[] = []
  const logs: string[] = []
  const brain = { busy: false }
  const quiet: SingRig['quiet'] = { answer: true, wait: null }
  const serviceUp = { value: true }
  const entered: SingRig['entered'] = []
  const timers = new Set<NodeJS.Timeout>()
  let lastId: string | undefined

  const emit = (song_id: string | undefined, phase: string, extra: Record<string, unknown> = {}) =>
    hub.emit('sing.state', { type: 'sing.state', song_id, phase, ...extra })
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
    return t
  }
  let ending: NodeJS.Timeout | null = null
  let stagePhase: 'idle' | 'loading' | 'playing' = 'idle'
  ;(hub as unknown as { send: (m: Sent) => boolean }).send = (m: Sent) => {
    hub.sent.push(m)
    if (m.type === 'sing.play') {
      if (!hub.connected) return false
      const id = m.song_id as string
      lastId = id
      stagePhase = 'loading'
      emit(id, 'loading')
      switch (stage.mode) {
        case 'auto':
          later(stage.loadMs, () => {
            stagePhase = 'playing'
            emit(id, 'playing')
          })
          ending = later(stage.loadMs + stage.playMs, () => {
            stagePhase = 'idle'
            emit(id, 'idle', { reason: 'done' })
          })
          break
        case 'error':
          later(5, () => {
            stagePhase = 'idle'
            emit(id, 'idle', { reason: 'error', error: 'no such track' })
          })
          break
        case 'idle_at_once':
          later(5, () => {
            stagePhase = 'idle'
            emit(id, 'idle', { reason: 'cancelled' })
          })
          break
        case 'silent':
          break
      }
      return true
    }
    if (m.type === 'sing.stop') {
      if (!hub.connected) return false
      if (stagePhase === 'idle' || !lastId || stage.stopHangs) return true
      const id = lastId
      if (ending) clearTimeout(ending)
      ending = null
      emit(id, 'ending')
      later(stage.fadeMs, () => {
        stagePhase = 'idle'
        emit(id, 'idle', { reason: 'stopped' })
      })
    }
    return true
  }
  ;(hub as unknown as { setOverlay: (m: Sent) => void }).setOverlay = (m: Sent) =>
    void hub.overlays.push(m)

  let service!: ModeService
  let ctl!: SingRig['ctl']
  const host: ModeHost = {
    config,
    hub: hub as unknown as ModeHost['hub'],
    motions: null,
    secrets: new MemorySecretStore(),
    flags,
    dataDir: config.paths.data_dir,
    now: () => Date.now(),
    log: (level, msg) => void logs.push(`${level}: ${msg}`),
    event: (_k, text) => void events.push(text),
    alarm: (code, level, message, subject) => {
      alarms.push({ code, level, message, ...(subject !== undefined ? { subject } : {}) })
    },
    clearAlarm: (code, subject) => {
      for (let i = alarms.length - 1; i >= 0; i--)
        if (alarms[i]!.code === code && (subject === undefined || alarms[i]!.subject === subject))
          alarms.splice(i, 1)
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
    },
    brainBusy: () => brain.busy,
    serviceUrl: (s) => (s === 'singing' && serviceUp.value ? fake.url : null),
    modeState: (id) => service.state(id),
    enterMode: (id, o) => {
      entered.push({ id, opts: o })
      return service.tryEnter(id, o)
    },
    exitMode: async (id, reason) => void (await service.exit(id, reason)),
    prompt: (mode, name, vars) => service.prompt(mode, name, vars),
    libraryDir: (library) => (library === 'songs' ? (config.paths.songs ?? null) : null),
    assetUrl: (library, ...parts) => assetUrl(library, ...parts),
    llmText: async () => '',
    songLine: (text) => void songLines.push(text),
  }

  service = new ModeService({
    config,
    packs: wanted,
    registry: await PluginRegistry.scan(path.join(dir, 'no-plugins')),
    supervisor: {
      start: async () => ({}) as never,
      stop: async () => ({}) as never,
      getStatus: () => ({ status: 'ready' }) as never,
    },
    pluginConfig: () => ({}),
    host,
    controllers: {
      sing: (h) => (ctl = createSingController(h)),
      ...(opts.withDance ? { dance: () => ({ enter: async () => {}, exit: async () => {} }) } : {}),
    },
    gpu: { usedMb: () => null, totalMb: () => 12000 },
    measurements: () => [],
    resident: [],
    startTimeoutMs: 20_000,
    stopTimeoutMs: 20_000,
    settleTimeoutMs: 10,
  })
  service.on(
    'alarm',
    (code, message, id) =>
      void alarms.push({ code, level: 'error', message, ...(id ? { subject: id } : {}) })
  )
  service.attach()
  const rig: SingRig = {
    service,
    ctl,
    fake,
    hub,
    flags,
    events,
    alarms,
    held,
    told,
    songLines,
    logs,
    dir,
    songsDir,
    stage,
    serviceUp,
    brain,
    quiet,
    entered,
    sent: (type) => hub.sent.filter((m) => m.type === type),
    report: (phase, extra = {}) => emit(lastId, phase, extra),
    alarmCodes: () => alarms.map((a) => a.code),
  }
  rigs.push(rig)
  const dispose = service.dispose.bind(service)
  service.dispose = async () => {
    for (const t of timers) clearTimeout(t)
    timers.clear()
    await dispose()
  }
  return rig
}
