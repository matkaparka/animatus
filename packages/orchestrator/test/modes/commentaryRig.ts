/**
 * The commentary controller inside the real mode service, with what it talks to made of fakes: a fake host (see
 * fakeHost.ts), a fake capture service (fakeCapture.ts) and a scripted model. Fake timers drive the loop; `tick`
 * moves the timers and the host's clock together, `jump` moves only the clock (wall time passing between passes).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { ModeManifest } from '@animatus/protocol'
import type { ModePanel } from '@animatus/protocol'
import type { AppConfigInput } from '../../src/config.ts'
import { createCommentaryController } from '../../src/modes/controllers/commentary.ts'
import type { CommentaryController } from '../../src/modes/controllers/commentary.ts'
import type { ControllerFactory, LlmTextRequest } from '../../src/modes/host.ts'
import { flushJson } from '../../src/modes/jsonfile.ts'
import { loadModePacks } from '../../src/modes/loader.ts'
import type { LoadedMode } from '../../src/modes/loader.ts'
import { ModeService } from '../../src/modes/service.ts'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import { FakeCapture } from './fakeCapture.ts'
import { fakeHost } from './fakeHost.ts'
import type { FakeHost } from './fakeHost.ts'

export const MODES = path.resolve(__dirname, '../../../../modes')
export const PLUGINS = path.resolve(__dirname, '../../../../plugins')

/** What the scripted model answers to each of the mode's own questions. Replace a member to change the answer. */
export interface Model {
  identify: (req: LlmTextRequest) => string | Promise<string>
  analyze: (req: LlmTextRequest) => string | Promise<string>
  summary: (req: LlmTextRequest) => string | Promise<string>
}

export const identification = (game: string, confidence = 0.9, scene = 'a forest at dusk') =>
  JSON.stringify({ game, scene, confidence })
export const analysis = (scene: string, switched = false) =>
  JSON.stringify({ scene, switch: switched })

export interface RigOptions {
  settings?: Record<string, unknown>
  /** Keep the data folder of an earlier rig, as after a restart. */
  dataDir?: string
  /** Written to the state file before the mode is built. */
  stateFile?: string
  /** Add stand-in modes that exclude commentary (dance, sing, draw, sleep, game). */
  others?: boolean
  /** Change the mode pack, for a pack that is broken. */
  pack?: (real: LoadedMode) => LoadedMode
  config?: AppConfigInput
  /**
   * Talk to the fake capture service over a real socket with the real client, like the program does. Sockets need real
   * time, so the loop's waits are made a hundred times shorter and a test waits with `until` instead of `tick`
   * (use `useCommentaryRig({ fakeTimers: false })`).
   */
  http?: boolean
}

export interface Rig {
  service: ModeService
  readonly ctl: CommentaryController
  f: FakeHost
  fake: FakeCapture
  model: Model
  /** The capture plugin as the supervisor sees it. */
  svc: { status: string; url: string; started: number; stopped: number }
  /** Whether a reply is being written or spoken; the mode leaves the voice to it. */
  busy: { value: boolean }
  /** Held promises that keep a call of the host pending until the test releases it. */
  gates: { tell: Promise<void> | null }
  stateFile: string
  tick(ms: number): Promise<void>
  jump(ms: number): void
  enter(): ReturnType<ModeService['enter']>
  exit(reason?: string): ReturnType<ModeService['exit']>
  act(req: Record<string, unknown>): ReturnType<ModeService['consoleRequest']>
  panel(): ModePanel | undefined
  llm(tag: string): LlmTextRequest[]
  saved(): Promise<Record<string, unknown>>
  /** The commentary prompt the model would get with its next reply, or undefined when the mode adds none. */
  prompt(): string | undefined
  alarms(): string[]
}

const cleanups: (() => Promise<void>)[] = []

/** Call once at the top of a test file: fake timers before each test (unless told not to), everything torn down after. */
export function useCommentaryRig(opts: { fakeTimers?: boolean } = {}): void {
  beforeEach(() => {
    if (opts.fakeTimers !== false)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
    vi.useRealTimers()
    await flushJson()
  })
}

/** Waits (in real time) until the condition holds. */
export async function until(cond: () => boolean, ms = 4000, what = 'the condition'): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The loop's waits, a hundred times shorter. */
const quickSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, Math.max(1, ms / 100))
    signal.addEventListener('abort', done, { once: true })
  })

const standIn = (id: string, extra: Record<string, unknown> = {}): LoadedMode => ({
  manifest: ModeManifest.parse({ id, title: id, ...extra }),
  dir: '/nowhere',
  prompts: new Map(),
  activePrompt: null,
})

export async function commentaryRig(opts: RigOptions = {}): Promise<Rig> {
  const others = opts.others ? ['dance', 'sing', 'draw', 'sleep', 'game'] : []
  const f = await fakeHost({
    config: {
      modes: {
        commentary: { enabled: true, config: { window: 'Some Game', ...opts.settings } },
        ...Object.fromEntries(others.map((id) => [id, { enabled: true }])),
      },
      plugins: { screencap: { enabled: true } },
      ...opts.config,
    },
  })
  if (opts.dataDir) (f.host as { dataDir: string }).dataDir = opts.dataDir
  const stateFile = path.join(f.host.dataDir, 'commentary-state.json')
  if (opts.stateFile !== undefined) {
    await mkdir(f.host.dataDir, { recursive: true })
    await writeFile(stateFile, opts.stateFile)
  }
  cleanups.push(() =>
    rm(path.dirname(f.dataDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  )
  ;(f.hub as unknown as { connected: boolean }).connected = true

  const fake = new FakeCapture()
  const svc = { status: 'ready', url: 'http://capture.test', started: 0, stopped: 0 }
  if (opts.http) {
    const served = await fake.serve()
    svc.url = served.url
    cleanups.push(served.close)
  }
  const busy = { value: false }
  const gates: Rig['gates'] = { tell: null }
  let counter = 0
  const model: Model = {
    identify: () => identification('Some Game'),
    analyze: () => analysis(`note ${++counter}`),
    summary: () => 'They explored a forest and began to build.',
  }

  const { modes: packs } = await loadModePacks([MODES])
  const real = packs.find((p) => p.manifest.id === 'commentary') as LoadedMode
  const supervisor = {
    start: async () => {
      svc.started++
      svc.status = 'ready'
      return { status: svc.status, url: svc.url } as never
    },
    stop: async () => {
      svc.stopped++
      svc.status = 'stopped'
      return { status: svc.status } as never
    },
    getStatus: () =>
      ({ status: svc.status, ...(svc.status === 'ready' ? { url: svc.url } : {}) }) as never,
  }

  let ctl!: CommentaryController
  const controllers: Record<string, ControllerFactory> = {
    commentary: (h) =>
      (ctl = createCommentaryController(
        h,
        opts.http ? { sleep: quickSleep } : { makeClient: () => fake.client() }
      )),
  }
  for (const id of others) controllers[id] = () => ({ enter: async () => {}, exit: async () => {} })
  const service: ModeService = new ModeService({
    config: f.host.config,
    packs: [
      opts.pack ? opts.pack(real) : real,
      ...others.map((id) => standIn(id, id === 'sleep' ? { preempts: true, priority: 100 } : {})),
    ],
    registry: await PluginRegistry.scan(PLUGINS),
    supervisor,
    pluginConfig: () => ({}),
    host: f.host,
    controllers,
    gpu: { usedMb: () => null, totalMb: () => 12000 },
    measurements: () => [],
    resident: [],
    startTimeoutMs: 60_000,
    stopTimeoutMs: 60_000,
    settleTimeoutMs: 10,
    now: () => f.clock.now,
  })

  // what the real host does for a mode, on top of the fake one
  f.host.serviceUrl = (name) => service.serviceUrl(name)
  f.host.modeState = (id) => service.state(id)
  f.host.enterMode = (id, o) => service.tryEnter(id, o)
  f.host.exitMode = async (id, reason) => void (await service.exit(id, reason))
  f.host.prompt = (mode, name, vars) => service.prompt(mode, name, vars)
  f.host.busy = () => busy.value
  f.host.tellBrain = async (text, o) => {
    f.told.push({ text, opts: o })
    if (f.brain.failTell) throw new Error('the model is away')
    if (gates.tell) await gates.tell
    return { status: 'done', sentences: 1 }
  }
  f.host.llmText = async (req) => {
    f.llm.requests.push(req)
    const handler =
      req.tag === 'commentary-identify'
        ? model.identify
        : req.tag === 'commentary-analyze'
          ? model.analyze
          : req.tag === 'commentary-summary'
            ? model.summary
            : () => {
                throw new Error(`the mode made a model call nobody expected: ${req.tag}`)
              }
    const answer = Promise.resolve(handler(req))
    const signal = req.signal
    if (!signal) return answer
    if (signal.aborted) throw new Error('aborted')
    return Promise.race([
      answer,
      new Promise<string>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      ),
    ])
  }
  service.attach()
  cleanups.push(() => service.dispose())

  return {
    service,
    get ctl() {
      return ctl
    },
    f,
    fake,
    model,
    svc,
    busy,
    gates,
    stateFile,
    tick: async (ms) => {
      f.clock.now += ms
      await vi.advanceTimersByTimeAsync(ms)
    },
    jump: (ms) => {
      f.clock.now += ms
    },
    enter: () => service.enter('commentary'),
    exit: (reason = 'console') => service.exit('commentary', reason),
    act: (req) => service.consoleRequest('commentary', req),
    panel: () => service.viewOf('commentary').panel,
    llm: (tag) => f.llm.requests.filter((r) => r.tag === tag),
    saved: async () => {
      await flushJson()
      return JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>
    },
    prompt: () => service.prompts().find((p) => p.id === 'commentary')?.text,
    alarms: () => f.alarms.map((a) => a.code),
  }
}
