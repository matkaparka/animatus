/**
 * The plugin supervisor: starts, health-checks, restarts and stops the services plugin manifests
 * describe, and is the only place secrets are turned into environment variables of a child process.
 *
 * Lifecycle (`PluginStatus`):
 *
 *   disabled   the configuration does not enable the plugin
 *   stopped    nothing running (never started, stopped on request, or exited cleanly)
 *   starting   process launching or waiting for its first healthy answer (also while a restart waits out its backoff)
 *   ready      healthy
 *   unhealthy  `fail_threshold` consecutive failed health checks while ready; recovers to ready on its own
 *   stopping   being stopped
 *   failed     did not become ready in time, could not be started, or crashed more often than `max_restarts` allows
 *
 * Nothing is ever left behind: `stop` and `stopAll` kill the whole process tree, `guard: true` puts the
 * process under the job guard so a force-killed orchestrator takes its plugins with it, and an exit
 * hook kills the trees of anything still tracked when Node exits normally.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { PluginStatus, ServiceHealth } from '@animatus/protocol'
import { probeHealth } from './health.ts'
import {
  resolveProcessRuntime,
  resolveTemplate,
  type Interpreters,
  type PlaceholderContext,
} from './placeholders.ts'
import { PortAllocator } from './ports.ts'
import { describeMissingSettings } from './settings.ts'
import {
  IS_WINDOWS,
  LineSplitter,
  RingBuffer,
  batchInvocation,
  buildChildEnv,
  killTree,
  processGone,
  sleep,
  trackChild,
  untrackChild,
  type Invocation,
} from './proc.ts'
import type {
  PluginConfigEntry,
  PluginConfigMap,
  PluginRegistry,
  ProcessRuntime,
  RegistryEntry,
} from './registry.ts'
import { createRedactor, type Redactor, type SecretStore } from './secrets.ts'

export interface StatusEvent {
  id: string
  status: PluginStatus
  previous: PluginStatus
  /** Why: an exit code, a failed check, a restart notice. Never contains a secret value. */
  detail?: string
}

export interface PluginState {
  status: PluginStatus
  /** Root process of the plugin. With the job guard this is the guard (its child is the service). */
  pid?: number
  port?: number
  /** Base URL of the service while it is running: http://127.0.0.1:<port>, or the `external` URL. */
  url?: string
  /** Automatic restarts since the last manual start or since the service stayed ready for a minute. */
  restarts: number
  lastError?: string
  /** When the current process was spawned (epoch ms). */
  startedAt?: number
  /** The last health body the service reported. */
  health?: ServiceHealth
}

export type PluginSnapshot = PluginState & { id: string }

export type SupervisorLogger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  extra?: Record<string, unknown>
) => void

export interface SupervisorOptions {
  /** The scanned registry, or just its entries. */
  registry: PluginRegistry | readonly RegistryEntry[]
  /** `plugins:` section of the configuration. A plugin that is not listed, or not `enabled: true`, is disabled. */
  pluginConfig?: PluginConfigMap
  interpreters: Interpreters
  secrets: SecretStore
  /** `{data_dir}`. */
  dataDir: string
  /** The job guard: `python` runs `script` (plugins/_guard/job_guard.py). Only used on Windows, for manifests with `guard: true`. */
  guard: { script: string; python: string }
  log?: SupervisorLogger
  /** Shared with other components that hand out ports; a fresh one by default. */
  ports?: PortAllocator
  /** The environment children inherit from (minus secrets). Defaults to `process.env`. */
  baseEnv?: Readonly<Record<string, string | undefined>>
  /** Clock in epoch ms, for `startedAt` and start timeouts. */
  now?: () => number
  /** How long a service must stay ready before its restart counter resets (default 60 000). */
  restartResetMs?: number
  /** Health check period while a service is starting, capped by the manifest's interval (default 250). */
  startupPollMs?: number
  /** Lines of output kept per plugin (default 500). */
  logLines?: number
}

export class UnknownPluginError extends Error {
  readonly pluginId: string

  constructor(id: string) {
    super(`unknown plugin "${id}"`)
    this.name = 'UnknownPluginError'
    this.pluginId = id
  }
}

export class PluginDisabledError extends Error {
  readonly pluginId: string

  constructor(id: string) {
    super(`plugin "${id}" is disabled`)
    this.name = 'PluginDisabledError'
    this.pluginId = id
  }
}

type SupervisorEvents = { status: [StatusEvent] }

interface Run {
  abort: AbortController
  child?: ChildProcess
  pid?: number
  port?: number
  exited: Promise<void>
  markExited: () => void
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  /** Set when the supervisor itself ends this process: its exit is then not a crash. */
  stopping: boolean
  everReady: boolean
  flushers: Array<() => void>
}

interface Slot {
  entry: RegistryEntry
  enabled: boolean
  config: Record<string, unknown>
  status: PluginStatus
  run?: Run
  /** The port an `auto` plugin keeps across restarts, so URLs handed to adapters stay valid. */
  stickyPort?: number
  port?: number
  url?: string
  pid?: number
  restarts: number
  lastError?: string
  startedAt?: number
  health?: ServiceHealth
  logs: RingBuffer<string>
  redactor: Redactor
  waiters: Array<() => void>
  restartTimer?: NodeJS.Timeout
  resetTimer?: NodeJS.Timeout
  stopping?: Promise<void>
}

interface Launch extends Invocation {
  cwd: string
  env: Record<string, string>
  port: number
}

/** Statuses a `start()` call waits for. */
const SETTLED: ReadonlySet<PluginStatus> = new Set<PluginStatus>([
  'ready',
  'failed',
  'stopped',
  'disabled',
])

/** Python services print to a pipe: without these, output is block-buffered and non-ASCII text can crash `print` under a legacy code page. */
const CHILD_ENV_DEFAULTS = { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } as const

const MAX_LOG_LINE = 2000
/** How long to wait for a process to disappear after `taskkill`. */
const KILL_WAIT_MS = 5000

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class Supervisor extends EventEmitter<SupervisorEvents> {
  private readonly slots = new Map<string, Slot>()
  private readonly options: SupervisorOptions
  private readonly ports: PortAllocator
  private readonly now: () => number
  private readonly restartResetMs: number
  private readonly startupPollMs: number
  private readonly log: SupervisorLogger

  constructor(options: SupervisorOptions) {
    super()
    this.options = options
    this.ports = options.ports ?? new PortAllocator()
    this.now = options.now ?? Date.now
    this.restartResetMs = options.restartResetMs ?? 60_000
    this.startupPollMs = options.startupPollMs ?? 250
    this.log = options.log ?? (() => undefined)
    const entries = 'list' in options.registry ? options.registry.list() : [...options.registry]
    for (const entry of entries) {
      const configured = options.pluginConfig?.[entry.id]
      const enabled = configured?.enabled === true
      this.slots.set(entry.id, {
        entry,
        enabled,
        config: { ...(configured?.config ?? {}) },
        status: enabled ? 'stopped' : 'disabled',
        restarts: 0,
        logs: new RingBuffer<string>(options.logLines ?? 500),
        redactor: createRedactor([]),
        waiters: [],
      })
      const runtime = entry.manifest.runtime
      // Keep automatic ports away from ports some manifest wants for itself.
      if (runtime.type === 'process' && typeof runtime.port === 'number')
        this.ports.reserve(runtime.port)
    }
  }

  // ───────────────────────────────── public API ─────────────────────────────────

  ids(): string[] {
    return [...this.slots.keys()].sort()
  }

  has(id: string): boolean {
    return this.slots.has(id)
  }

  getStatus(id: string): PluginState {
    return this.state(this.slot(id))
  }

  /** The state of every plugin, sorted by id. */
  snapshot(): PluginSnapshot[] {
    return this.ids().map((id) => ({ id, ...this.state(this.slot(id)) }))
  }

  /** The newest output lines of a plugin (stdout and stderr merged, secrets masked, oldest first). */
  logs(id: string, limit?: number): string[] {
    return this.slot(id).logs.toArray(limit)
  }

  /**
   * Starts a plugin and resolves once it settles: `ready`, or `failed` / `stopped` when it gave up.
   * Rejects for an unknown or disabled plugin. Calling it while the plugin is starting or running joins
   * the attempt in progress. A manual start resets the restart counter.
   */
  async start(id: string): Promise<PluginState> {
    const slot = this.slot(id)
    if (!slot.enabled) throw new PluginDisabledError(id)
    if (slot.stopping) await slot.stopping
    if (slot.status === 'ready' || slot.status === 'unhealthy') return this.state(slot)
    if (slot.status !== 'starting') {
      slot.restarts = 0
      slot.lastError = undefined
      this.begin(slot)
    }
    return this.settled(slot)
  }

  /** Stops a plugin (polite request, grace period, then the process tree is killed). Never rejects because of the process. */
  async stop(id: string): Promise<PluginState> {
    const slot = this.slot(id)
    await this.stopSlot(slot)
    return this.state(slot)
  }

  async restart(id: string): Promise<PluginState> {
    await this.stop(id)
    return this.start(id)
  }

  /** Stops every plugin. For shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => this.stopSlot(slot)))
  }

  /**
   * Applies new settings of one plugin. Disabling stops it; enabling makes it startable. `config` is
   * read at the next (re)start.
   */
  async configure(id: string, entry: PluginConfigEntry): Promise<void> {
    const slot = this.slot(id)
    slot.config = { ...(entry.config ?? {}) }
    const enabled = entry.enabled === true
    if (enabled === slot.enabled) return
    slot.enabled = enabled
    if (!enabled) {
      await this.stopSlot(slot)
      this.setStatus(slot, 'disabled', 'disabled by configuration')
    } else if (slot.status === 'disabled') {
      this.setStatus(slot, 'stopped', 'enabled by configuration')
    }
  }

  // ─────────────────────────────────── state ───────────────────────────────────

  private slot(id: string): Slot {
    const slot = this.slots.get(id)
    if (!slot) throw new UnknownPluginError(id)
    return slot
  }

  private state(slot: Slot): PluginState {
    const state: PluginState = { status: slot.status, restarts: slot.restarts }
    if (slot.pid !== undefined) state.pid = slot.pid
    if (slot.port !== undefined) state.port = slot.port
    if (slot.url !== undefined) state.url = slot.url
    if (slot.lastError !== undefined) state.lastError = slot.lastError
    if (slot.startedAt !== undefined) state.startedAt = slot.startedAt
    if (slot.health !== undefined) state.health = slot.health
    return state
  }

  private setStatus(slot: Slot, status: PluginStatus, detail?: string): void {
    const previous = slot.status
    if (previous === status) return
    slot.status = status
    if (previous === 'ready') this.clearResetTimer(slot)
    if (status === 'ready') this.armResetTimer(slot)
    const event: StatusEvent = { id: slot.entry.id, status, previous }
    if (detail !== undefined) event.detail = detail
    this.log(
      status === 'failed' ? 'error' : 'info',
      `plugin ${slot.entry.id}: ${previous} -> ${status}`,
      detail ? { detail } : undefined
    )
    try {
      this.emit('status', event)
    } catch (err) {
      this.log('error', `a status listener of plugin ${slot.entry.id} threw`, {
        error: errorText(err),
      })
    }
    if (SETTLED.has(status)) {
      const waiters = slot.waiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }

  private settled(slot: Slot): Promise<PluginState> {
    // An in-process plugin is ready before `begin` even returns: there is nothing left to wait for.
    if (SETTLED.has(slot.status)) return Promise.resolve(this.state(slot))
    return new Promise((resolve) => {
      slot.waiters.push(() => resolve(this.state(slot)))
    })
  }

  private armResetTimer(slot: Slot): void {
    this.clearResetTimer(slot)
    slot.resetTimer = setTimeout(() => {
      slot.resetTimer = undefined
      slot.restarts = 0
    }, this.restartResetMs)
  }

  private clearResetTimer(slot: Slot): void {
    clearTimeout(slot.resetTimer)
    slot.resetTimer = undefined
  }

  private clearRuntime(slot: Slot): void {
    slot.pid = undefined
    slot.port = undefined
    slot.url = undefined
    slot.health = undefined
    slot.startedAt = undefined
  }

  /** Runs a task nobody awaits. A bug inside it is logged instead of becoming an unhandled rejection that takes the orchestrator down. */
  private background(task: Promise<unknown>): void {
    task.catch((err: unknown) =>
      this.log('error', 'a plugin supervisor task failed', { error: errorText(err) })
    )
  }

  private note(slot: Slot, text: string): void {
    slot.logs.push(`[supervisor] ${slot.redactor.apply(text)}`.slice(0, MAX_LOG_LINE))
  }

  private line(slot: Slot, text: string): void {
    const masked = slot.redactor.apply(text)
    slot.logs.push(masked.length > MAX_LOG_LINE ? `${masked.slice(0, MAX_LOG_LINE)}...` : masked)
  }

  // ─────────────────────────────────── launching ───────────────────────────────────

  /** Starts an attempt: a fresh Run, status `starting`, and the asynchronous launch. */
  private begin(slot: Slot): void {
    let markExited = () => {}
    const exited = new Promise<void>((resolve) => {
      markExited = resolve
    })
    const run: Run = {
      abort: new AbortController(),
      exited,
      markExited,
      stopping: false,
      everReady: false,
      flushers: [],
    }
    slot.run = run
    this.setStatus(slot, 'starting')
    this.background(this.launch(slot, run))
  }

  private async launch(slot: Slot, run: Run): Promise<void> {
    const runtime = slot.entry.manifest.runtime
    try {
      if (runtime.type === 'inprocess') {
        this.setStatus(slot, 'ready', 'in-process plugin')
        return
      }
      const missing = describeMissingSettings(slot.entry.id, slot.entry.manifest, slot.config)
      if (missing) throw new Error(missing)
      if (runtime.type === 'external') {
        slot.url = this.resolveExternalUrl(slot, runtime.url)
        slot.startedAt = this.now()
        this.background(this.monitor(slot, run))
        return
      }
      const launch = await this.prepare(slot, runtime)
      if (run.abort.signal.aborted) return
      this.spawnChild(slot, run, launch)
      this.background(this.monitor(slot, run))
    } catch (err) {
      if (!run.abort.signal.aborted) await this.fail(slot, run, errorText(err))
    }
  }

  /** `runtime.url` of an external plugin, with `{config.<key>}` filled in; it has to end up an http(s) URL. */
  private resolveExternalUrl(slot: Slot, template: string): string {
    const { manifest } = slot.entry
    const url = resolveTemplate(
      template,
      {
        env: 'external',
        pluginDir: slot.entry.dir,
        dataDir: this.options.dataDir,
        config: slot.config,
        interpreters: this.options.interpreters,
        declaredSecrets: manifest.secrets,
        secrets: {},
      },
      'runtime.url',
      'command'
    )
    if (!/^https?:\/\/[^\s/]/i.test(url)) {
      throw new Error(`runtime.url must be an http(s) URL, got "${url.slice(0, 80)}"`)
    }
    return url.replace(/\/+$/, '')
  }

  /** Secrets, port, placeholders, environment: everything needed to spawn, or an Error that says what is missing. */
  private async prepare(slot: Slot, runtime: ProcessRuntime): Promise<Launch> {
    const { manifest } = slot.entry
    const store = this.options.secrets

    const secrets: Record<string, string | undefined> = {}
    for (const ref of manifest.secrets) secrets[ref.name] = await store.get(ref.name)
    for (const ref of manifest.secrets) {
      if (ref.required && secrets[ref.name] === undefined) {
        throw new Error(
          `required secret "${ref.name}" is not set (it is passed to the plugin as ${ref.env})`
        )
      }
    }

    // Everything the store holds: masked in this plugin's output, and kept out of the inherited environment.
    const material = await this.secretMaterial()
    slot.redactor = createRedactor([
      ...material.values,
      ...Object.values(secrets).filter((value): value is string => value !== undefined),
    ])

    const port =
      slot.stickyPort ?? (runtime.port === 'auto' ? await this.ports.allocate() : runtime.port)
    if (runtime.port === 'auto') slot.stickyPort = port

    const context: PlaceholderContext = {
      env: runtime.env,
      pluginDir: slot.entry.dir,
      dataDir: this.options.dataDir,
      port,
      config: slot.config,
      interpreters: this.options.interpreters,
      declaredSecrets: manifest.secrets,
      secrets,
    }
    const resolved = resolveProcessRuntime(runtime, context)

    const injected: Record<string, string> = {}
    for (const ref of manifest.secrets) {
      const value = secrets[ref.name]
      if (value !== undefined) injected[ref.env] = value
    }
    const env = buildChildEnv({
      base: this.options.baseEnv ?? process.env,
      strip: [...material.envNames, 'NoDefaultCurrentDirectoryInExePath'],
      defaults: CHILD_ENV_DEFAULTS,
      envVars: resolved.envVars,
      secrets: injected,
    })

    const cwd = await stat(resolved.cwd).catch(() => undefined)
    if (!cwd?.isDirectory())
      throw new Error(`the working directory does not exist: ${resolved.cwd}`)

    return {
      ...this.invocation(runtime, resolved.command, slot.config),
      cwd: resolved.cwd,
      env,
      port,
    }
  }

  private invocation(
    runtime: ProcessRuntime,
    command: string[],
    config: Readonly<Record<string, unknown>>
  ): Invocation {
    const [file, ...args] = command
    if (file === undefined) throw new Error('runtime.command is empty')
    if (runtime.guard && IS_WINDOWS) {
      const { python: light, script } = this.options.guard
      const own = ownInterpreter(runtime.env, config, this.options.interpreters)
      const python = guardInterpreter(light, own, existsSync)
      if (python === null)
        throw new Error(
          `the job guard needs a Python interpreter, and ${light}${own && own !== light ? ` and ${own}` : ''} ${own && own !== light ? 'do' : 'does'} not exist (run \`uv sync\` in the repository folder)`
        )
      if (!existsSync(script)) throw new Error(`the job guard script does not exist: ${script}`)
      return {
        file: python,
        args: [script, '--parent-pid', String(process.pid), '--', file, ...args],
        verbatim: false,
      }
    }
    return batchInvocation(command) ?? { file, args, verbatim: false }
  }

  /** What the store knows: values (to mask in logs) and the environment names those secrets may live under. */
  private async secretMaterial(): Promise<{ values: string[]; envNames: Set<string> }> {
    const store = this.options.secrets
    const values: string[] = []
    const envNames = new Set<string>(store.envNames?.() ?? [])
    for (const slot of this.slots.values())
      for (const ref of slot.entry.manifest.secrets) envNames.add(ref.env)
    try {
      for (const { name } of await store.names()) {
        envNames.add(name)
        try {
          const value = await store.get(name)
          if (value !== undefined) values.push(value)
        } catch (err) {
          this.log('warn', 'a secret could not be read while preparing a plugin', {
            error: errorText(err),
          })
        }
      }
    } catch (err) {
      this.log('warn', 'the secret store could not list its names', { error: errorText(err) })
    }
    return { values, envNames }
  }

  private spawnChild(slot: Slot, run: Run, launch: Launch): void {
    const child = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: lead a process group so the whole tree can be killed. Windows children must not be detached.
      detached: !IS_WINDOWS,
    })
    run.child = child
    run.port = launch.port
    slot.port = launch.port
    slot.url = `http://127.0.0.1:${launch.port}`
    slot.startedAt = this.now()

    for (const [stream, name] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ] as const) {
      if (!stream) continue
      const splitter = new LineSplitter(undefined, () => slot.redactor.maxLength - 1)
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        for (const line of splitter.push(chunk)) this.line(slot, line)
      })
      stream.on('error', (err) =>
        this.log('debug', `${name} of plugin ${slot.entry.id} failed`, { error: err.message })
      )
      run.flushers.push(() => {
        const rest = splitter.flush()
        if (rest !== undefined) this.line(slot, rest)
      })
    }

    child.once('error', (err) => {
      // 'error' before a pid exists means the process could not be created at all.
      if (child.pid !== undefined)
        return this.log('warn', `process of plugin ${slot.entry.id} reported an error`, {
          error: err.message,
        })
      run.markExited()
      this.background(this.fail(slot, run, `cannot start the process: ${err.message}`))
    })
    child.once('exit', (code, signal) => this.onExit(slot, run, code, signal))

    if (child.pid !== undefined) {
      run.pid = child.pid
      slot.pid = child.pid
      trackChild(child.pid)
      this.note(slot, `started process ${child.pid} on port ${launch.port}`)
      this.log('info', `plugin ${slot.entry.id} spawned`, { pid: child.pid, port: launch.port })
    }
  }

  // ─────────────────────────────────── monitoring ───────────────────────────────────

  /** Polls the health check for the lifetime of a Run. */
  private async monitor(slot: Slot, run: Run): Promise<void> {
    const health = slot.entry.manifest.health
    const baseUrl = slot.url
    if (baseUrl === undefined) return
    const begun = this.now()
    let failures = 0
    while (!run.abort.signal.aborted && slot.run === run) {
      const result = await probeHealth(health, baseUrl, run.abort.signal)
      if (run.abort.signal.aborted || slot.run !== run) return
      // What a service reports about itself is shown in the console: mask secrets it may have put there.
      if (result.health) slot.health = slot.redactor.applyDeep(result.health)
      else if (result.ok) slot.health = undefined
      const why = result.detail ? `: ${slot.redactor.apply(result.detail)}` : ''

      if (slot.status === 'starting') {
        if (result.ok) {
          failures = 0
          run.everReady = true
          this.note(slot, 'ready')
          this.setStatus(slot, 'ready')
        } else if (this.now() - begun >= health.start_timeout_ms) {
          await this.fail(
            slot,
            run,
            `did not become ready within ${health.start_timeout_ms} ms${why}`
          )
          return
        }
      } else if (slot.status === 'ready' || slot.status === 'unhealthy') {
        if (result.ok) {
          failures = 0
          if (slot.status === 'unhealthy') this.setStatus(slot, 'ready', 'health check recovered')
        } else if (run.pid !== undefined && processGone(run.pid)) {
          // The process is dead and its exit event is on the way: that is a crash, not an unhealthy service.
        } else {
          failures++
          if (failures >= health.fail_threshold && slot.status === 'ready') {
            this.setStatus(slot, 'unhealthy', `${failures} failed health checks in a row${why}`)
          }
        }
      }

      const wait =
        slot.status === 'starting'
          ? Math.min(health.interval_ms, this.startupPollMs)
          : health.interval_ms
      await sleep(wait, run.abort.signal)
    }
  }

  // ─────────────────────────────────── exits and failures ───────────────────────────────────

  private onExit(slot: Slot, run: Run, code: number | null, signal: NodeJS.Signals | null): void {
    run.exit = { code, signal }
    if (run.pid !== undefined) untrackChild(run.pid)
    for (const flush of run.flushers) flush()
    run.markExited()
    // Grandchildren can keep the pipes open after the root has gone; do not wait for them.
    setTimeout(() => {
      run.child?.stdout?.destroy()
      run.child?.stderr?.destroy()
    }, 250).unref()

    const reason = signal ? `killed by signal ${signal}` : `exited with code ${code}`
    this.note(slot, reason)
    if (run.stopping || slot.run !== run) return

    // An exit nobody asked for.
    slot.run = undefined
    run.abort.abort()
    this.clearRuntime(slot)
    if (!run.everReady) slot.stickyPort = undefined
    const { policy, max_restarts: maxRestarts, backoff_ms: backoff } = slot.entry.manifest.restart
    const failure = code !== 0 || signal !== null || !run.everReady
    const restart = policy === 'always' || (policy === 'on-failure' && failure)
    if (!restart) {
      if (failure) {
        slot.lastError = slot.redactor.apply(reason)
        this.setStatus(slot, 'failed', slot.lastError)
      } else this.setStatus(slot, 'stopped', reason)
      return
    }
    slot.lastError = slot.redactor.apply(reason)
    if (slot.restarts >= maxRestarts) {
      const message = `${reason}; gave up after ${slot.restarts} restart${slot.restarts === 1 ? '' : 's'}`
      slot.lastError = slot.redactor.apply(message)
      this.setStatus(slot, 'failed', slot.lastError)
      return
    }
    const attempt = ++slot.restarts
    const delay = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0
    const detail = `${reason}; restarting in ${delay} ms (attempt ${attempt} of ${maxRestarts})`
    this.note(slot, detail)
    this.setStatus(slot, 'starting', detail)
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = undefined
      this.begin(slot)
    }, delay)
  }

  /** Gives up on an attempt: kills whatever is left of it, then reports `failed`. */
  private async fail(slot: Slot, run: Run, message: string): Promise<void> {
    if (slot.run !== run) return
    run.stopping = true
    run.abort.abort()
    slot.lastError = slot.redactor.apply(message)
    this.note(slot, `giving up: ${message}`)
    await this.terminate(slot, run, false)
    if (slot.run !== run) return // a stop() or start() took over meanwhile
    slot.run = undefined
    this.clearRuntime(slot)
    if (!run.everReady) slot.stickyPort = undefined
    this.setStatus(slot, 'failed', slot.lastError)
  }

  // ─────────────────────────────────────── stopping ───────────────────────────────────────

  private stopSlot(slot: Slot): Promise<void> {
    if (!slot.stopping) {
      slot.stopping = this.doStop(slot).finally(() => {
        slot.stopping = undefined
      })
    }
    return slot.stopping
  }

  private async doStop(slot: Slot): Promise<void> {
    if (slot.status === 'disabled') return
    const run = slot.run
    slot.run = undefined
    clearTimeout(slot.restartTimer)
    slot.restartTimer = undefined
    if (
      !run &&
      slot.status !== 'starting' &&
      slot.status !== 'ready' &&
      slot.status !== 'unhealthy'
    ) {
      // Nothing runs. `failed` becomes `stopped` so the failure is acknowledged.
      this.setStatus(slot, 'stopped', 'stopped by request')
      return
    }
    this.setStatus(slot, 'stopping')
    if (run) {
      run.stopping = true
      run.abort.abort()
      await this.terminate(slot, run, true)
    }
    this.clearRuntime(slot)
    this.setStatus(slot, 'stopped', 'stopped by request')
  }

  /**
   * Ends a process. With `polite` the manifest's stop request goes first and the process gets `grace_ms`
   * to leave on its own; whatever is still alive then has its whole tree killed.
   */
  private async terminate(slot: Slot, run: Run, polite: boolean): Promise<void> {
    const child = run.child
    if (!child || run.pid === undefined || run.exit) return
    const runtime = slot.entry.manifest.runtime
    if (polite && runtime.type === 'process' && runtime.stop.http && run.port !== undefined) {
      const { method, path } = runtime.stop.http
      const timeout = Math.min(Math.max(runtime.stop.grace_ms, 200), 3000)
      void sendRequest(`http://127.0.0.1:${run.port}${path}`, method, timeout)
      this.note(slot, `asked the service to stop (${method} ${path})`)
      await this.waitForExit(run, runtime.stop.grace_ms)
    }
    if (!run.exit) {
      this.note(slot, `killing process tree ${run.pid}`)
      await killTree(run.pid)
      if (!(await this.waitForExit(run, KILL_WAIT_MS))) {
        this.log(
          'warn',
          `process ${run.pid} of plugin ${slot.entry.id} did not exit after taskkill`
        )
      }
    }
  }

  private async waitForExit(run: Run, ms: number): Promise<boolean> {
    if (run.exit) return true
    const timer = new AbortController()
    await Promise.race([run.exited, sleep(ms, timer.signal)])
    timer.abort() // cancels the pending sleep
    return run.exit !== undefined
  }
}

/** The Python a plugin runs on, when it is a Python plugin: what `{python}` in its command means. */
export function ownInterpreter(
  env: ProcessRuntime['env'],
  config: Readonly<Record<string, unknown>>,
  interpreters: Interpreters
): string | undefined {
  if (env === 'light') return interpreters.light
  if (env === 'audio') return interpreters.audio
  if (env === 'external') {
    const python = config.python
    return typeof python === 'string' && python !== '' ? python : undefined
  }
  return undefined
}

/**
 * The interpreter that runs the job guard: the shared light one when it is installed, else the plugin's own. The guard
 * is standard library only, so any Python 3.7 or newer will do, and a plugin that brings its own (GPT-SoVITS) does not
 * make the person install the light environment just for this. Null when neither exists.
 */
export function guardInterpreter(
  light: string,
  own: string | undefined,
  exists: (path: string) => boolean
): string | null {
  if (exists(light)) return light
  if (own !== undefined && exists(own)) return own
  return null
}

/** Fire-and-forget HTTP request to a service on loopback. Errors are ignored: the service may die before it answers. */
function sendRequest(url: string, method: 'GET' | 'POST', timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const req = httpRequest(
      url,
      { method, agent: false, headers: { connection: 'close', 'content-length': '0' } },
      (res) => {
        res.resume()
        res.once('end', () => resolve())
        res.once('error', () => resolve())
      }
    )
    const timer = setTimeout(() => req.destroy(), timeoutMs)
    req.once('error', () => {
      clearTimeout(timer)
      resolve()
    })
    req.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    req.end()
  })
}
