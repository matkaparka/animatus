/**
 * The game controller inside the real mode service, with what it talks to made of fakes: a fake host (see fakeHost.ts), a fake
 * game agent, a scripted model and a voice the test can hold. The service reads the real packs of `modes/` and the real plugin
 * manifests of `plugins/`, so a change to a manifest that breaks the mode breaks these tests.
 *
 * Three kinds of agent (`worker`):
 *   'http'    the reference fake of the Worker protocol over a real socket (`../workers/fakes.ts`), with the real client;
 *   'legacy'  the older link over a real socket, through the adapter;
 *   'memory'  an agent in the test's own process (gameFakes.ts), for fake timers.
 * Sockets need real time, so with the first two the loops' waits are a hundred times shorter and a test waits with `until`
 * (`useGameRig({ fakeTimers: false })`); the client's time limits are shortened too. `jump` moves the host's clock (what the
 * mode measures gaps and staleness with), `tick` moves the timers and the clock together.
 */
import path from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { makeSource } from '@animatus/protocol'
import type { ModePanel } from '@animatus/protocol'
import type { AppConfigInput } from '../../src/config.ts'
import { createGameController } from '../../src/modes/controllers/game.ts'
import type { GameController } from '../../src/modes/controllers/game.ts'
import { makeWorkerClient } from '../../src/modes/game/client.ts'
import { parseGameSettings } from '../../src/modes/game/settings.ts'
import type { ControllerFactory, ModeHost, TellResult } from '../../src/modes/host.ts'
import { loadModePacks } from '../../src/modes/loader.ts'
import type { LoadedMode } from '../../src/modes/loader.ts'
import { ModeService } from '../../src/modes/service.ts'
import { PluginRegistry } from '../../src/plugins/registry.ts'
import { sleep as realSleep } from '../../src/stage/util.ts'
import type { ToolSpec } from '../../src/tools/registry.ts'
import type { WorkerApi } from '../../src/workers/index.ts'
import { fakeLegacy, fakeWorker } from '../workers/fakes.ts'
import { fakeHost } from './fakeHost.ts'
import type { FakeHost } from './fakeHost.ts'
import { MemoryWorker } from './gameFakes.ts'

export const MODES = path.resolve(__dirname, '../../../../modes')
export const PLUGINS = path.resolve(__dirname, '../../../../plugins')

export type WorkerKind = 'http' | 'legacy' | 'memory'

export interface RigOptions {
  worker?: WorkerKind
  /** `modes.game.config`. */
  settings?: Record<string, unknown>
  config?: AppConfigInput
  /** Options of the reference fake (`worker: 'http'`). */
  workerOver?: Parameters<typeof fakeWorker>[0]
  /** Options of the fake of the older link (`worker: 'legacy'`). */
  legacyOver?: Parameters<typeof fakeLegacy>[0]
  /** Which plugin manifest provides the `game` service; default the one that fits the kind of agent. */
  plugin?: 'game-attach' | 'game-attach-legacy' | 'game-demo'
  /** Also build the modes the game is exclusive with, and the dance, with controllers that do nothing. */
  others?: boolean
  /** Change the pack, for one that is broken. */
  pack?: (real: LoadedMode) => LoadedMode
  /** The agent's port is closed from the start (`worker: 'http'` or `'legacy'`). */
  down?: boolean
}

/** What the tests push into whichever agent there is. */
export type Urgency = 'immediate' | 'soon' | 'later'

export interface Rig {
  service: ModeService
  readonly ctl: GameController
  f: FakeHost
  worker: WorkerKind
  http: Awaited<ReturnType<typeof fakeWorker>> | null
  legacy: Awaited<ReturnType<typeof fakeLegacy>> | null
  mem: MemoryWorker | null
  /** The plugin as the supervisor sees it. */
  svc: { status: string; url: string; started: number; stopped: number; failStart: string | null }
  /** Whether a reply is being written or spoken (`host.busy()`); the mode leaves the voice to it. */
  busy: { value: boolean }
  /** Held promises that keep a call of the host pending until the test releases it. */
  gates: { tell: Promise<void> | null }
  /** What the model's answer to a comment is; the default is a done answer with one sentence. */
  brain: { answer: ((text: string, n: number) => TellResult | Promise<TellResult>) | null }
  /** Comments handed to the model at the same moment: never more than one. */
  tells: { inflight: number; max: number }
  /** Every wait the loops asked for, in milliseconds (before they are made shorter). */
  sleeps: number[]
  push(kind: string, text: string, urgency?: Urgency): void
  tick(ms: number): Promise<void>
  jump(ms: number): void
  enter(): ReturnType<ModeService['enter']>
  exit(reason?: string): ReturnType<ModeService['exit']>
  act(req: Record<string, unknown>): ReturnType<ModeService['consoleRequest']>
  panel(): ModePanel | undefined
  /** The `game_command` tool the way the gate runs a free one: arguments checked by its schema, then run. */
  callTool(args: unknown): Promise<string | void>
  tool(): ToolSpec | undefined
  /** The active prompt the model would get with its next reply, or undefined when the mode adds none. */
  prompt(): string | undefined
  alarms(): string[]
  /** The events a test can see the agent's side of: directives it received. */
  directives(): string[]
  /** Requests that reached the agent so far (whatever kind of agent it is). */
  requests(): number
}

const cleanups: (() => Promise<void> | void)[] = []

/** Call once at the top of a test file: fake timers before each test (unless told not to), everything torn down after. */
export function useGameRig(opts: { fakeTimers?: boolean } = {}): void {
  beforeEach(() => {
    if (opts.fakeTimers !== false)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
    vi.useRealTimers()
  })
}

/** Waits (in real time) until the condition holds. */
export async function until(cond: () => boolean, ms = 5000, what = 'the condition'): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Lets real time pass, for the things that must not happen. */
export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** The loops' waits, a hundred times shorter. */
const quickSleep = (ms: number, signal: AbortSignal): Promise<unknown> =>
  realSleep(Math.max(1, ms / 100), signal)

export async function gameRig(opts: RigOptions = {}): Promise<Rig> {
  const kind = opts.worker ?? 'http'
  const settings = {
    ...(kind === 'legacy' ? { protocol: 'legacy' } : {}),
    ...opts.settings,
  }
  const cfg = parseGameSettings(settings)
  const others = opts.others ? ['dance', 'sing', 'draw', 'sleep', 'commentary'] : []
  const plugin =
    opts.plugin ??
    (kind === 'legacy' || cfg.protocol === 'legacy' ? 'game-attach-legacy' : 'game-attach')

  const f = await fakeHost({
    config: {
      modes: {
        game: { enabled: true, config: settings },
        ...Object.fromEntries(others.map((id) => [id, { enabled: true }])),
      },
      plugins: { [plugin]: { enabled: true } },
      ...opts.config,
    },
  })
  // the stage page is there unless a test says otherwise
  ;(f.hub as unknown as { connected: boolean }).connected = true

  let http: Rig['http'] = null
  let legacy: Rig['legacy'] = null
  let mem: MemoryWorker | null = null
  let url = 'http://memory.test'
  if (kind === 'http') {
    http = await fakeWorker(opts.workerOver)
    url = http.url
    cleanups.push(() => http?.close())
  } else if (kind === 'legacy') {
    legacy = await fakeLegacy(opts.legacyOver)
    url = legacy.url
    cleanups.push(() => legacy?.close())
  } else mem = new MemoryWorker()
  if (opts.down) {
    await (http ?? legacy)?.close()
  }

  const svc: Rig['svc'] = { status: 'ready', url, started: 0, stopped: 0, failStart: null }
  const busy = { value: false }
  const gates: Rig['gates'] = { tell: null }
  const brain: Rig['brain'] = { answer: null }
  const tells = { inflight: 0, max: 0 }
  const sleeps: number[] = []
  let tellCount = 0

  const realTime = kind !== 'memory'
  const makeClient = (_url: string, ms: number): WorkerApi =>
    mem ? mem.client(ms, cfg.name) : makeWorkerClient(cfg, _url, Math.max(60, Math.round(ms / 25)))
  const sleep = (ms: number, signal: AbortSignal): Promise<unknown> => {
    sleeps.push(ms)
    return (realTime ? quickSleep : realSleep)(ms, signal)
  }

  const { modes: packs } = await loadModePacks([MODES])
  const wanted = ['game', ...others]
  const real = packs.find((p) => p.manifest.id === 'game') as LoadedMode
  const supervisor = {
    start: async () => {
      svc.started++
      if (svc.failStart !== null) return { status: 'failed', lastError: svc.failStart } as never
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

  let ctl!: GameController
  const controllers: Record<string, ControllerFactory> = {
    game: (h) => (ctl = createGameController(h, { makeClient, sleep })),
  }
  for (const id of others) controllers[id] = () => ({ enter: async () => {}, exit: async () => {} })
  const service: ModeService = new ModeService({
    config: f.host.config,
    packs: packs
      .filter((p) => wanted.includes(p.manifest.id))
      .map((p) => (p === real && opts.pack ? opts.pack(real) : p)),
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
  const h: ModeHost = f.host
  h.serviceUrl = (name) => service.serviceUrl(name)
  h.modeState = (id) => service.state(id)
  h.enterMode = (id, o) => service.tryEnter(id, o)
  h.exitMode = async (id, reason) => void (await service.exit(id, reason))
  h.prompt = (mode, name, vars) => service.prompt(mode, name, vars)
  h.busy = () => busy.value
  // the real one gives up at the time limit and says so (false); the fake of fakeHost.ts waits for the gate however long it lasts
  h.whenQuiet = async (ms) => {
    const gate = f.quiet.wait
    if (gate) {
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<false>((res) => (timer = setTimeout(() => res(false), ms)))
      const quiet = await Promise.race([gate.then(() => true as const), late])
      clearTimeout(timer)
      if (!quiet) return false
    }
    return f.quiet.answer
  }
  h.tellBrain = async (text, o) => {
    f.told.push({ text, opts: o })
    const n = ++tellCount
    tells.inflight++
    tells.max = Math.max(tells.max, tells.inflight)
    try {
      if (gates.tell) await gates.tell
      if (f.brain.failTell) throw new Error('the model is away')
      return brain.answer ? await brain.answer(text, n) : { status: 'done', sentences: 1 }
    } finally {
      tells.inflight--
    }
  }
  service.attach()
  cleanups.push(() => service.dispose())

  const tool = () => f.tools.find((t) => t.name === 'game_command')
  return {
    service,
    get ctl() {
      return ctl
    },
    f,
    worker: kind,
    http,
    legacy,
    mem,
    svc,
    busy,
    gates,
    brain,
    tells,
    sleeps,
    push: (k, text, urgency = 'later') => {
      if (mem) mem.push(k, text, urgency)
      else if (http) http.push(k, text, urgency)
      else legacy?.push(k, text, urgency)
    },
    tick: async (ms) => {
      f.clock.now += ms
      await vi.advanceTimersByTimeAsync(ms)
    },
    jump: (ms) => {
      f.clock.now += ms
    },
    enter: () => service.enter('game'),
    exit: (reason = 'console') => service.exit('game', reason),
    act: (req) => service.consoleRequest('game', req),
    panel: () => service.viewOf('game').panel,
    tool,
    callTool: async (args) => {
      const spec = tool()
      if (!spec) throw new Error('unknown_tool')
      const parsed = spec.schema.safeParse(args)
      if (!parsed.success) throw new Error(`bad_args: ${parsed.error.issues[0]?.message}`)
      return spec.run(parsed.data as never, {
        origin: makeSource('viewer', { name: 'ann' }),
        now: () => f.clock.now,
      })
    },
    prompt: () => service.prompts().find((p) => p.id === 'game')?.text,
    alarms: () => f.alarms.map((a) => a.code),
    directives: () => mem?.directives ?? http?.s.directives ?? legacy?.s.commands ?? [],
    requests: () => mem?.calls.length ?? http?.s.requests.length ?? legacy?.s.requests.length ?? 0,
  }
}

/** The last message the model was told, or fails. */
export function lastTold(r: Rig): string {
  const t = r.f.told.at(-1)
  expect(t, 'the model was told nothing').toBeDefined()
  return (t as { text: string }).text
}
