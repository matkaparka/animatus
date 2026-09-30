/**
 * A `ModeHost` made of fakes that write down what a controller did, for testing a mode controller on its own.
 *
 *   const f = fakeHost({ modes: { sing: { enabled: true, config: { ... } } } })
 *   const c = createSingController(f.host)
 *   c.attach?.()
 *   await c.enter(ctx)
 *   expect(f.hub.sent).toContainEqual(expect.objectContaining({ type: 'sing.play' }))
 *   f.stage('sing.state', { song_id: 'x', phase: 'playing' })        // what the stage reports
 *
 * Time is `f.clock.now`, moved by hand. Real timers still run, so a controller that waits with `setTimeout` needs
 * `vi.useFakeTimers()` in the test, as the dance tests do.
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import type { AppConfigInput } from '../../src/config.ts'
import type { MotionLibrary } from '../../src/library/motionLibrary.ts'
import type { LlmTextRequest, ModeContext, ModeHost, SayOptions } from '../../src/modes/host.ts'
import { flushJson } from '../../src/modes/jsonfile.ts'
import type { ToolSpec } from '../../src/tools/registry.ts'
import { MemorySecretStore } from '../../src/plugins/secrets.ts'
import { assetUrl } from '../../src/stage/assets.ts'

export type Sent = Record<string, unknown> & { type: string }

export interface FakeHostOptions {
  /** Merged into the configuration (`modes`, `plugins`, `inbox`, ...). */
  config?: AppConfigInput
  /** Dances and other files the controller reads through `host.motions`. */
  motions?: MotionLibrary | null
  /** Folders behind asset libraries (`songs`, `asmr`, `generated`). `generated` and the data folder are made for you. */
  libraries?: Record<string, string>
  /** The state other modes are in (`sleep`, ...). Default IDLE. */
  modeStates?: Record<string, 'IDLE' | 'STARTING' | 'ACTIVE' | 'STOPPING'>
  /** Where the fake `serviceUrl` sends each service name; missing means the service is not up. */
  services?: Record<string, string>
}

export interface FakeHost {
  host: ModeHost
  /** A stand-in for the stage hub: records what a controller sends and lets the test play the stage's reports. */
  hub: EventEmitter & {
    sent: Sent[]
    looks: Sent[]
    overlays: Sent[]
    scenes: Sent[]
    send(m: Sent): boolean
    setLook(m: Sent): void
    setOverlay(m: Sent): void
    setScene(m: Sent): void
  }
  /** Plays a report of the stage (`dance.state`, `sing.state`, `sleep.state`, `playback.ended`, ...). */
  stage(type: string, msg: Record<string, unknown>): void
  clock: { now: number }
  dataDir: string
  flags: { dancing: boolean; singing: boolean; sleeping: boolean }
  events: string[]
  alarms: { code: string; level: string; message: string; subject?: string }[]
  said: SayOptions[]
  told: { text: string; opts: Parameters<ModeHost['tellBrain']>[1] }[]
  held: [string, boolean][]
  /** Every `setVoiceStyle` call, in order. */
  voiceStyles: (string | null)[]
  stopped: string[]
  songLines: string[]
  /** The tools registered and not yet taken away. */
  tools: ToolSpec[]
  entered: { id: string; opts: unknown }[]
  exited: { id: string; reason: string }[]
  logs: { level: string; msg: string }[]
  /** What `llmText` answers: a string, a list of answers used in turn, or a function; throw to fail. */
  llm: {
    answer: string | string[] | ((req: LlmTextRequest) => string | Promise<string>)
    requests: LlmTextRequest[]
  }
  /** `whenQuiet`: false makes it report a timeout. */
  quiet: { answer: boolean; wait: Promise<void> | null }
  brain: { busy: boolean; failTell: boolean }
  modeStates: Record<string, 'IDLE' | 'STARTING' | 'ACTIVE' | 'STOPPING'>
  /** Prompt files by `mode/name`; `host.prompt` fills `{{vars}}` in them. */
  prompts: Record<string, string>
  /** A context to hand to `controller.enter` / `exit`. */
  ctx(id?: string): ModeContext
}

const dirs: string[] = []
let hooked = false

/** Removes the temporary data folders; installed the first time `fakeHost` is used. */
function installCleanup(): void {
  if (hooked) return
  hooked = true
  afterEach(async () => {
    await flushJson()
    for (const d of dirs.splice(0))
      await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
}

export async function fakeHost(opts: FakeHostOptions = {}): Promise<FakeHost> {
  installCleanup()
  const dir = await mkdtemp(path.join(tmpdir(), 'animatus-modehost-'))
  dirs.push(dir)
  const dataDir = path.join(dir, 'data')
  const libraries: Record<string, string> = {
    generated: path.join(dataDir, 'generated'),
    ...opts.libraries,
  }
  const config = parseConfig({ paths: { data_dir: dataDir }, ...opts.config }, { root: dir })

  const hub = Object.assign(new EventEmitter(), {
    sent: [] as Sent[],
    looks: [] as Sent[],
    overlays: [] as Sent[],
    scenes: [] as Sent[],
    send(m: Sent) {
      hub.sent.push(m)
      return true
    },
    setLook(m: Sent) {
      hub.looks.push(m)
    },
    setOverlay(m: Sent) {
      hub.overlays.push(m)
    },
    setScene(m: Sent) {
      hub.scenes.push(m)
    },
  })

  const f: FakeHost = {
    host: undefined as unknown as ModeHost,
    hub,
    stage: (type, msg) => void hub.emit(type, { type, ...msg }),
    clock: { now: 1_000_000 },
    dataDir,
    flags: { dancing: false, singing: false, sleeping: false },
    events: [],
    alarms: [],
    said: [],
    told: [],
    held: [],
    voiceStyles: [],
    stopped: [],
    songLines: [],
    tools: [],
    entered: [],
    exited: [],
    logs: [],
    llm: { answer: '', requests: [] },
    quiet: { answer: true, wait: null },
    brain: { busy: false, failTell: false },
    modeStates: { ...opts.modeStates },
    prompts: {},
    ctx: (id = 'test') => ({
      id,
      manifest: { id } as ModeContext['manifest'],
      signal: new AbortController().signal,
      log: () => {},
    }),
  }
  let llmCalls = 0
  f.host = {
    config,
    hub: hub as unknown as ModeHost['hub'],
    motions: opts.motions ?? null,
    secrets: new MemorySecretStore(),
    flags: f.flags,
    dataDir,
    now: () => f.clock.now,
    log: (level, msg) => void f.logs.push({ level, msg }),
    event: (_kind, text) => void f.events.push(text),
    alarm: (code, level, message, subject) =>
      void f.alarms.push({ code, level, message, ...(subject !== undefined ? { subject } : {}) }),
    clearAlarm: (code, subject) => {
      const i = f.alarms.findIndex(
        (a) => a.code === code && (subject === undefined || a.subject === subject)
      )
      if (i >= 0) f.alarms.splice(i, 1)
    },
    stopSpeech: (reason) => void f.stopped.push(reason),
    holdSpeech: (reason, on) => void f.held.push([reason, on]),
    setVoiceStyle: (style) => void f.voiceStyles.push(style),
    say: (o) => void f.said.push(o),
    whenQuiet: async () => {
      if (f.quiet.wait) await f.quiet.wait
      return f.quiet.answer
    },
    busy: () => false,
    tellBrain: async (text, o) => {
      f.told.push({ text, opts: o })
      if (f.brain.failTell) throw new Error('the model is away')
      return { status: 'done', sentences: 1 }
    },
    brainBusy: () => f.brain.busy,
    serviceUrl: (service) => opts.services?.[service] ?? null,
    modeState: (id) => f.modeStates[id] ?? 'IDLE',
    enterMode: async (id, o) => {
      f.entered.push({ id, opts: o })
      return { ok: true }
    },
    exitMode: async (id, reason) => void f.exited.push({ id, reason }),
    prompt: (mode, name, vars = {}) => {
      const t = f.prompts[`${mode}/${name}`]
      return t === undefined
        ? null
        : t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '')
    },
    libraryDir: (library) => libraries[library] ?? null,
    assetUrl: (library, ...parts) => assetUrl(library, ...parts),
    llmText: async (req) => {
      f.llm.requests.push(req)
      const a = f.llm.answer
      if (typeof a === 'function') return a(req)
      if (Array.isArray(a)) return a[Math.min(llmCalls++, a.length - 1)] ?? ''
      return a
    },
    songLine: (text) => void f.songLines.push(text),
    registerTool: (spec) => {
      f.tools.push(spec as never)
      return () => void f.tools.splice(f.tools.indexOf(spec as never), 1)
    },
  }
  return f
}
