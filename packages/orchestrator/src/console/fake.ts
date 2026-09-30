/**
 * An in-memory `ConsoleBackend` with made-up data: plugins in different states, modes with different
 * admission verdicts (one of them blocked, with a reason), a secret store that keeps values in memory and
 * never returns them, and say / inject / stop that do something visible.
 *
 * It exists for the console server's tests and for `npm run console:demo`, which shows the console without
 * an orchestrator. Nothing here is real: names, numbers and log lines are invented.
 */
import { ModeView, PluginView, StatusView } from '@animatus/protocol'
import type {
  Alarm,
  ConsoleEvent,
  InjectRequest,
  ModeAction,
  ModeRequest,
  PluginAction,
  RunEvent,
  SayRequest,
  SecretView,
  SpeechTraceView,
  VerdictView,
} from '@animatus/protocol'
import { ApiFailure } from './backend.ts'
import type { ConsoleBackend } from './backend.ts'

export interface FakeBackendOptions {
  /** Clock. Default `Date.now`. */
  now?: () => number
  /**
   * Behave like the real thing over time: plugins pass through `starting` and `stopping`, speech traces
   * fill in step by step. Default false: every change is immediate, so tests are deterministic.
   */
  realtime?: boolean
}

interface FakeSecret {
  source: string
  /** The value lives here and nowhere else; nothing returns it. */
  value?: string
  /** Comes from the process environment: cannot be written or deleted from the console. */
  readOnly?: boolean
}

interface Utterance {
  startsAt: number
  endsAt: number
}

const BUDGET_MB = 8000
const RUN_EVENTS_KEPT = 500
const TRACES_KEPT = 100
const LOG_LINES_KEPT = 500

const fits = (totalMb: number, measured: boolean, reasons: string[] = []): VerdictView => ({
  ok: true,
  totalMb,
  budgetMb: BUDGET_MB,
  measured,
  reasons,
})
const noFit = (totalMb: number, reasons: string[]): VerdictView => ({
  ok: false,
  totalMb,
  budgetMb: BUDGET_MB,
  measured: false,
  reasons,
})

const clone = <T>(value: T): T => structuredClone(value)

export class FakeBackend implements ConsoleBackend {
  /**
   * What was asked of this backend, in order: the operation and its target (a plugin, mode or secret
   * name), never a value. Tests use it to see that a route really reached the backend.
   */
  readonly audit: Array<{ op: string; target?: string }> = []

  private readonly now: () => number
  private readonly realtime: boolean
  private readonly startedAt: number
  private readonly plugins = new Map<string, PluginView>()
  private readonly logs = new Map<string, string[]>()
  private readonly modes = new Map<string, ModeView>()
  private readonly secrets = new Map<string, FakeSecret>()
  private readonly runEvents: RunEvent[] = []
  private readonly traces: SpeechTraceView[] = []
  private readonly alarms: Alarm[] = []
  private readonly listeners = new Set<(event: ConsoleEvent) => void>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private utterances: Utterance[] = []
  private nextPid = 5000
  private nextId = 1
  private held = false

  constructor(options: FakeBackendOptions = {}) {
    this.now = options.now ?? Date.now
    this.realtime = options.realtime ?? false
    const now = this.now()
    this.startedAt = now - 45 * 60_000
    this.seedPlugins(now)
    this.seedModes(now)
    this.seedSecrets()
    this.seedAlarms(now)
    this.pushRun('system', 'demo backend ready (all data here is made up)')
    this.pushRun('viewer', 'amber_fox: hello!', 'untrusted')
  }

  // ─────────────────────────────── events out ───────────────────────────────

  /** Subscribes to every event this backend produces (wire it to `server.publish`). Returns the unsubscribe. */
  onEvent(listener: (event: ConsoleEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Pushes a scripted event to the subscribers. */
  emit(event: ConsoleEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  /** Raises an alarm: kept for `status().alarms` and pushed as an `alarm` event. */
  raiseAlarm(input: {
    level: Alarm['level']
    code: string
    message: string
    subject?: string
  }): Alarm {
    const alarm: Alarm = { id: `alarm-${this.nextId++}`, ts: this.now(), ...input }
    this.alarms.push(alarm)
    if (this.alarms.length > 50) this.alarms.shift()
    this.emit({ type: 'alarm', alarm })
    return alarm
  }

  /**
   * For the demo: every so often a viewer line arrives, sometimes the character answers, once in a while an
   * alarm is raised. Returns the function that stops it.
   */
  startScript(intervalMs = 1500): () => void {
    const names = ['amber_fox', 'quiet_owl', 'north_star', 'byte_crab']
    const lines = [
      'hello!',
      'what are you up to today?',
      'can you dance?',
      'first time here',
      'lol',
      'play something calm',
    ]
    let n = 0
    const timer = setInterval(() => {
      n++
      const name = names[n % names.length] as string
      const text = lines[n % lines.length] as string
      this.pushRun('viewer', `${name}: ${text}`, 'untrusted')
      if (n % 3 === 0) {
        this.pushRun('llm', `reply to ${name} (scripted)`)
        void this.say({ text: `Thanks for the message, ${name}.`, emotion: 'happy' })
      }
      if (n % 25 === 0) {
        this.raiseAlarm({
          level: 'warn',
          code: 'scripted_alarm',
          message: 'A scripted alarm from the demo backend.',
          subject: 'demo',
        })
      }
    }, intervalMs)
    timer.unref()
    this.timers.add(timer)
    return () => {
      clearInterval(timer)
      this.timers.delete(timer)
    }
  }

  /** Cancels every timer this backend started (realtime transitions, the script). */
  dispose(): void {
    for (const timer of this.timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.timers.clear()
  }

  // ─────────────────────────────── ConsoleBackend ───────────────────────────────

  status(): StatusView {
    const now = this.now()
    this.audit.push({ op: 'status' })
    return StatusView.parse({
      api: 1,
      version: '0.1.0-fake',
      startedAt: this.startedAt,
      now,
      stage: {
        connected: true,
        model: { status: 'ready' },
        audio: { state: 'running', contexts_created: 1, contexts_open: 1 },
        fps: 60,
        underruns_total: 0,
        tpose_frames: 0,
        lastReportAt: now - 400,
      },
      speech: this.speechState(now),
      plugins: [...this.plugins.values()].map(clone),
      modes: [...this.modes.values()].map(clone),
      llm: {
        providers: [
          {
            id: 'primary',
            kind: 'openai-compatible',
            requests: 42,
            successes: 40,
            failures: 2,
            lastError: { code: 'timeout', at: now - 5 * 60_000 },
          },
          { id: 'fallback', kind: 'gemini', requests: 0, successes: 0, failures: 0 },
        ],
        order: ['primary', 'fallback'],
      },
      vram: { adapter: 'Example GPU (made up)', budgetMb: BUDGET_MB, usedMb: 3900 },
      alarms: this.alarms.map(clone),
    })
  }

  listPlugins(): PluginView[] {
    this.audit.push({ op: 'listPlugins' })
    return [...this.plugins.values()].map(clone)
  }

  pluginAction(id: string, action: PluginAction): PluginView {
    this.audit.push({ op: `plugin.${action}`, target: id })
    const plugin = this.plugins.get(id)
    if (!plugin) throw new ApiFailure('not_found', `there is no plugin called ${id}`, 404)
    if (plugin.status === 'disabled' || !plugin.enabled) {
      throw new ApiFailure(
        'plugin_disabled',
        `${id} is disabled in the configuration; enable it there first`,
        409
      )
    }
    if (action === 'start' && (plugin.status === 'ready' || plugin.status === 'starting')) {
      throw new ApiFailure('already_running', `${id} is already ${plugin.status}`, 409)
    }
    if (action === 'stop' && (plugin.status === 'stopped' || plugin.status === 'failed')) {
      throw new ApiFailure('not_running', `${id} is not running`, 409)
    }
    this.log(id, `[info] ${action} requested from the console`)
    if (action === 'stop') {
      this.setPlugin(id, { status: 'stopping' })
      this.later(400, () => this.becomeStopped(id))
      if (!this.realtime) this.becomeStopped(id)
    } else {
      this.setPlugin(id, {
        status: 'starting',
        pid: undefined,
        lastError: undefined,
        health: { ok: true, ready: false, service: plugin.service, detail: 'loading' },
      })
      this.later(900, () => this.becomeReady(id))
      if (!this.realtime) this.becomeReady(id)
    }
    return clone(this.plugins.get(id) as PluginView)
  }

  pluginLogs(id: string, lines: number): string[] {
    this.audit.push({ op: 'plugin.logs', target: id })
    if (!this.plugins.has(id))
      throw new ApiFailure('not_found', `there is no plugin called ${id}`, 404)
    return (this.logs.get(id) ?? []).slice(-lines)
  }

  listModes(): ModeView[] {
    this.audit.push({ op: 'listModes' })
    return [...this.modes.values()].map(clone)
  }

  modeAction(id: string, action: ModeAction, req: ModeRequest): ModeView {
    this.audit.push({ op: `mode.${action}`, target: id })
    const mode = this.modes.get(id)
    if (!mode) throw new ApiFailure('not_found', `there is no mode called ${id}`, 404)

    if (action === 'exit') {
      if (mode.state !== 'IDLE') this.setMode(id, 'IDLE')
      return clone(this.modes.get(id) as ModeView)
    }
    if (mode.state === 'ACTIVE') return clone(mode)

    const active = [...this.modes.values()].filter(
      (m) => m.id !== id && (m.state === 'ACTIVE' || m.state === 'STARTING')
    )
    if (!req.force && mode.admission && !mode.admission.ok) {
      throw new ApiFailure(
        'no_fit',
        mode.admission.reasons.join(' ') || `${id} does not fit in memory`,
        409
      )
    }
    if (mode.preempts) {
      for (const other of active) this.setMode(other.id, 'IDLE')
    } else {
      const blocker = active.find((m) => m.preempts)
      if (blocker && !req.force) {
        throw new ApiFailure('blocked', `${blocker.id} is active and blocks other modes`, 409)
      }
      const conflicts = active.filter(
        (m) => mode.exclusive_with.includes(m.id) || m.exclusive_with.includes(id)
      )
      if (conflicts.length > 0 && !req.force) {
        if (!req.replace) {
          throw new ApiFailure(
            'excluded',
            `${id} excludes ${conflicts.map((m) => m.id).join(', ')} (active)`,
            409
          )
        }
        for (const other of conflicts) this.setMode(other.id, 'IDLE')
      }
      if (!req.force) {
        for (const other of active) {
          const pair = mode.pairs[other.id]
          if (pair && !pair.ok && this.modes.get(other.id)?.state !== 'IDLE') {
            throw new ApiFailure(
              'no_fit',
              pair.reasons.join(' ') || `${id} and ${other.id} do not fit together`,
              409
            )
          }
        }
      }
    }
    this.setMode(id, 'ACTIVE')
    return clone(this.modes.get(id) as ModeView)
  }

  listSecrets(): SecretView[] {
    this.audit.push({ op: 'listSecrets' })
    return [...this.secrets.keys()].sort().map((name) => this.secretView(name))
  }

  putSecret(name: string, value: string): SecretView {
    this.audit.push({ op: 'secret.put', target: name })
    const existing = this.secrets.get(name)
    if (existing?.readOnly) {
      throw new ApiFailure(
        'read_only',
        'this key comes from the process environment and cannot be changed here',
        409
      )
    }
    this.secrets.set(name, { source: existing?.source ?? 'dpapi', value })
    this.pushRun('system', `key ${name} was set from the console`)
    return this.secretView(name)
  }

  deleteSecret(name: string): SecretView {
    this.audit.push({ op: 'secret.delete', target: name })
    const existing = this.secrets.get(name)
    if (!existing) throw new ApiFailure('not_found', `there is no key called ${name}`, 404)
    if (existing.readOnly && existing.value !== undefined) {
      throw new ApiFailure(
        'read_only',
        'this key comes from the process environment and cannot be deleted here',
        409
      )
    }
    this.secrets.set(name, { source: existing.source })
    this.pushRun('system', `key ${name} was deleted from the console`)
    return this.secretView(name)
  }

  say(req: SayRequest): void {
    this.audit.push({ op: 'say' })
    const now = this.now()
    const audioSec =
      Math.round(Math.min(20, Math.max(0.8, req.text.length / 14 / (req.speed ?? 1))) * 10) / 10
    const last = this.utterances[this.utterances.length - 1]
    const startsAt = Math.max(now, last?.endsAt ?? now)
    this.utterances.push({ startsAt, endsAt: startsAt + audioSec * 1000 })
    const id = `say-${this.nextId++}`
    this.pushRun('speech', `say (${req.emotion}${req.style ? `, ${req.style}` : ''}): ${req.text}`)
    this.recordTrace({ id, turn: `console-${id}`, text: req.text }, audioSec, req.text.length)
  }

  inject(req: InjectRequest): void {
    this.audit.push({ op: 'inject' })
    const line =
      req.kind === 'danmaku'
        ? `${req.name}: ${req.text}`
        : req.kind === 'gift'
          ? `${req.name} sent ${req.count} x ${req.gift ?? 'a gift'}`
          : req.kind === 'guard'
            ? `${req.name} became a guard (level ${req.gift ?? '?'})`
            : `${req.name} sent a superchat (${req.price ?? 0}): ${req.text}`
    // Injected events are always untrusted viewer events, like the real ones.
    this.pushRun('viewer', line, 'untrusted')
    this.pushRun('inbox', `queued a ${req.kind} event (injected from the console)`)
  }

  stopSpeech(): void {
    this.audit.push({ op: 'stop' })
    this.utterances = []
    this.held = false
    this.pushRun('speech', 'speech stopped from the console')
  }

  recentEvents(limit: number): RunEvent[] {
    this.audit.push({ op: 'recentEvents' })
    return this.runEvents.slice(-limit).map(clone)
  }

  recentTraces(limit: number): SpeechTraceView[] {
    this.audit.push({ op: 'recentTraces' })
    return this.traces.slice(-limit).map(clone)
  }

  config(): Record<string, unknown> {
    this.audit.push({ op: 'config' })
    return {
      version: '0.1.0-fake',
      llm: {
        order: ['primary', 'fallback'],
        providers: [
          {
            id: 'primary',
            kind: 'openai-compatible',
            base_url: 'http://127.0.0.1:1234/v1',
            model: 'example-model',
            max_tokens: 400,
          },
          { id: 'fallback', kind: 'gemini', model: 'example-flash' },
        ],
      },
      speech: { default_style: 'neutral', max_queue: 4 },
      stage: { layout: 'default', background: 'plain' },
      vram: { budget_mb: BUDGET_MB, margin_mb: 512 },
      // Which secrets are set, never what they are.
      secrets: Object.fromEntries(
        [...this.secrets].map(([name, s]) => [name, { set: s.value !== undefined }])
      ),
    }
  }

  // ─────────────────────────────── seeds ───────────────────────────────

  private seedPlugins(now: number): void {
    const add = (plugin: Record<string, unknown>, logs: string[] = []): void => {
      const parsed = PluginView.parse(plugin)
      this.plugins.set(parsed.id, parsed)
      this.logs.set(parsed.id, logs)
    }
    add(
      {
        id: 'speech',
        title: 'Speech synthesis',
        kind: 'tts',
        service: 'tts',
        enabled: true,
        status: 'ready',
        pid: 4120,
        url: 'http://127.0.0.1:5901',
        startedAt: now - 40 * 60_000,
        health: { ok: true, ready: true, service: 'tts', version: '0.1.0', vram_mb: 3300 },
        gpu: true,
        vram_mb_est: 3200,
        vram_mb_measured: 3410,
      },
      [
        '[info] model loaded in 6.2 s',
        '[info] listening on 127.0.0.1:5901',
        '[info] synthesized 3 sentences',
      ]
    )
    add(
      {
        id: 'motion',
        title: 'Motion generation',
        kind: 'motion',
        service: 'motion',
        enabled: true,
        status: 'ready',
        pid: 4188,
        url: 'http://127.0.0.1:5902',
        startedAt: now - 40 * 60_000,
        health: { ok: true, ready: true, service: 'motion' },
        gpu: false,
      },
      ['[info] listening on 127.0.0.1:5902']
    )
    add(
      {
        id: 'image',
        title: 'Image generation',
        kind: 'image',
        service: 'image',
        enabled: true,
        status: 'stopped',
        gpu: true,
      },
      ['[info] stopped by the console']
    )
    add(
      {
        id: 'search',
        title: 'Web search',
        kind: 'search',
        service: 'search',
        enabled: true,
        status: 'starting',
        pid: 4310,
        startedAt: now - 8_000,
        health: { ok: true, ready: false, service: 'search', detail: 'loading index' },
      },
      ['[info] starting', '[info] loading index']
    )
    add(
      {
        id: 'singing',
        title: 'Singing voice',
        kind: 'singing',
        service: 'singing',
        enabled: true,
        status: 'failed',
        restarts: 3,
        lastError: 'exited with code 1 after 3 restarts',
        gpu: true,
        vram_mb_est: 2500,
      },
      [
        '[error] cannot load the voice model',
        '[error] exited with code 1',
        '[warn] restart limit reached',
      ]
    )
    add(
      {
        id: 'game',
        title: 'Game worker',
        kind: 'game',
        service: 'game',
        enabled: false,
        status: 'disabled',
      },
      []
    )
  }

  private seedModes(now: number): void {
    const add = (mode: Record<string, unknown>): void => {
      const parsed = ModeView.parse(mode)
      this.modes.set(parsed.id, parsed)
    }
    add({
      id: 'commentary',
      title: 'Commentary',
      description: 'Talks about what is happening in chat.',
      state: 'ACTIVE',
      since: now - 30 * 60_000,
      priority: 30,
      exclusive_with: [],
      services: ['tts'],
      admission: fits(3400, true),
      pairs: {
        draw: noFit(9800, [
          'commentary + draw: about 9800 MiB needed, 7488 MiB usable of 8000 (not measured)',
        ]),
      },
    })
    add({
      id: 'dance',
      title: 'Dance',
      description: 'Plays a dance with music on the stage.',
      state: 'IDLE',
      since: now - 45 * 60_000,
      priority: 50,
      exclusive_with: ['sing'],
      services: ['tts', 'motion'],
      hotkey: 'ctrl+alt+d',
      admission: fits(3600, false, [
        'dance: fits on estimates only (about 3600 of 7488 MiB); not measured',
      ]),
    })
    add({
      id: 'sing',
      title: 'Sing',
      description: 'Sings a song with lyrics on the stage.',
      state: 'IDLE',
      since: now - 45 * 60_000,
      priority: 50,
      exclusive_with: ['dance', 'draw'],
      services: ['tts', 'singing'],
      hotkey: 'ctrl+alt+s',
      admission: fits(5900, true),
      pairs: {
        draw: noFit(0, ['sing and draw exclude each other (declared in the mode manifests)']),
      },
    })
    add({
      id: 'draw',
      title: 'Draw on request',
      description: 'Draws what viewers ask for and shows it in a frame.',
      state: 'IDLE',
      since: now - 45 * 60_000,
      priority: 50,
      exclusive_with: ['sing'],
      services: ['tts', 'image'],
      hotkey: 'ctrl+alt+p',
      admission: noFit(9800, [
        'draw: about 9800 MiB needed, 7488 MiB usable of 8000 (not measured)',
      ]),
    })
    add({
      id: 'sleep',
      title: 'Sleep',
      description: 'A long, quiet whisper track. Interrupts everything else.',
      state: 'IDLE',
      since: now - 45 * 60_000,
      priority: 100,
      preempts: true,
      exclusive_with: [],
      services: ['tts'],
      hotkey: 'ctrl+alt+n',
      admission: fits(3300, true),
    })
  }

  private seedSecrets(): void {
    this.secrets.set('gemini', { source: 'dpapi', value: 'seed-value-1' })
    this.secrets.set('openai_compat', { source: 'dpapi' })
    this.secrets.set('bilibili_cookie', { source: 'dpapi' })
    this.secrets.set('search_api', { source: 'environment', value: 'seed-value-2', readOnly: true })
  }

  private seedAlarms(now: number): void {
    this.alarms.push(
      {
        id: `alarm-${this.nextId++}`,
        ts: now - 20 * 60_000,
        level: 'warn',
        code: 'vram_not_measured',
        message: 'draw has never been measured; admission uses a conservative estimate.',
        subject: 'draw',
      },
      {
        id: `alarm-${this.nextId++}`,
        ts: now - 5 * 60_000,
        level: 'error',
        code: 'plugin_failed',
        message: 'singing exited with code 1 after 3 restarts.',
        subject: 'singing',
      }
    )
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private secretView(name: string): SecretView {
    const secret = this.secrets.get(name)
    return { name, set: secret?.value !== undefined, source: secret?.source ?? 'dpapi' }
  }

  private speechState(now: number): { speaking: boolean; pending: number; held: boolean } {
    this.utterances = this.utterances.filter((u) => u.endsAt > now)
    return {
      speaking: this.utterances.some((u) => u.startsAt <= now),
      pending: this.utterances.filter((u) => u.startsAt > now).length,
      held: this.held,
    }
  }

  private log(id: string, line: string): void {
    const lines = this.logs.get(id) ?? []
    lines.push(`${new Date(this.now()).toISOString()} ${line}`)
    if (lines.length > LOG_LINES_KEPT) lines.shift()
    this.logs.set(id, lines)
  }

  private pushRun(kind: RunEvent['kind'], text: string, trust?: RunEvent['trust']): void {
    const event: RunEvent = {
      ts: this.now(),
      kind,
      text: text.slice(0, 400),
      ...(trust ? { trust } : {}),
    }
    this.runEvents.push(event)
    if (this.runEvents.length > RUN_EVENTS_KEPT) this.runEvents.shift()
    this.emit({ type: 'run', event })
  }

  private recordTrace(
    base: { id: string; turn: string; text: string },
    audioSec: number,
    length: number
  ): void {
    const steps: Array<Partial<SpeechTraceView>> = [
      { audioSec, synthMs: 120 + length * 3 },
      { sendMs: 140 + length * 3 },
      { startMs: 260 + length * 3, liveMotion: 'used' },
    ]
    let trace: SpeechTraceView = { ...base }
    const publish = (): void => {
      const index = this.traces.findIndex((t) => t.id === trace.id)
      if (index === -1) {
        this.traces.push(trace)
        if (this.traces.length > TRACES_KEPT) this.traces.shift()
      } else {
        this.traces[index] = trace
      }
      this.emit({ type: 'trace', trace })
    }
    if (!this.realtime) {
      for (const step of steps) trace = { ...trace, ...step }
      publish()
      return
    }
    publish()
    steps.forEach((step, i) => {
      this.later(200 * (i + 1), () => {
        trace = { ...trace, ...step }
        publish()
      })
    })
  }

  private later(ms: number, fn: () => void): void {
    if (!this.realtime) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    timer.unref()
    this.timers.add(timer)
  }

  private setPlugin(id: string, patch: Partial<PluginView>): void {
    const current = this.plugins.get(id) as PluginView
    const next: PluginView = { ...current, ...patch }
    this.plugins.set(id, next)
    this.pushRun('plugin', `${id}: ${next.status}`)
    this.emit({ type: 'plugin', plugin: clone(next) })
  }

  private becomeReady(id: string): void {
    const current = this.plugins.get(id)
    if (!current || current.status !== 'starting') return
    this.log(id, '[info] ready')
    this.setPlugin(id, {
      status: 'ready',
      pid: this.nextPid++,
      startedAt: this.now(),
      lastError: undefined,
      health: { ok: true, ready: true, service: current.service },
    })
  }

  private becomeStopped(id: string): void {
    const current = this.plugins.get(id)
    if (!current || current.status !== 'stopping') return
    this.log(id, '[info] stopped')
    this.setPlugin(id, { status: 'stopped', pid: undefined, health: undefined })
  }

  private setMode(id: string, state: ModeView['state']): void {
    const current = this.modes.get(id) as ModeView
    const next: ModeView = { ...current, state, since: this.now() }
    this.modes.set(id, next)
    this.pushRun('mode', `${id}: ${state}`)
    this.emit({ type: 'mode', mode: clone(next) })
  }
}
