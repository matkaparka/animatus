/**
 * The mode service: mode packs + controllers + the mode manager, wired to what the running program has
 * (plugins that provide services, the GPU meter, the measurements, the operator's configuration).
 *
 * It answers the console's questions (which modes exist, may each be entered now, why not), enters and leaves
 * modes with refusals that say why, decides which mode prompts go to the model (those of active modes, plus the
 * "you may ask for this" advertisements of modes that could be entered), and lets a controller look at a batch
 * before the model does.
 */
import { EventEmitter } from 'node:events'
import { ModePanel } from '@animatus/protocol'
import type { ModeManifest, ModeView, VerdictView, VramMeasurement } from '@animatus/protocol'
import { AppError } from '../app/errors.ts'
import { renderTemplate } from '../brain/prompt.ts'
import type { ModePrompt } from '../brain/prompt.ts'
import type { AppConfig } from '../config.ts'
import type { Batch, ChatCommandInput, SongCommand } from '../inbox/types.ts'
import type { PluginRegistry, RegistryEntry } from '../plugins/registry.ts'
import type { Supervisor } from '../plugins/supervisor.ts'
import { computeMatrix, hashConfig } from './admission.ts'
import type { Matrix, ServiceInfo, Verdict } from './admission.ts'
import type { ControllerFactory, ModeControllerFull, ModeHost } from './host.ts'
import type { LoadedMode } from './loader.ts'
import { ModeManager } from './manager.ts'
import type { EnterResult } from './manager.ts'

export interface ModeServiceDeps {
  config: AppConfig
  packs: readonly LoadedMode[]
  registry: PluginRegistry
  supervisor: Pick<Supervisor, 'start' | 'stop' | 'getStatus'>
  /** The plugin settings as they are now (the operator may change them at run time). */
  pluginConfig(id: string): Record<string, unknown>
  host: ModeHost
  controllers: Readonly<Record<string, ControllerFactory>>
  gpu: { usedMb(): number | null; totalMb(): number | null }
  measurements(): readonly VramMeasurement[]
  /** Probe marks (`enter:<id>`, `exit:<id>`). */
  mark?(label: string): void
  /** Service names that are always up. */
  resident: readonly string[]
  now?: () => number
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void
  /** Manager timeouts, for tests. */
  startTimeoutMs?: number
  stopTimeoutMs?: number
  settleTimeoutMs?: number
}

type Events = {
  change: [id: string]
  alarm: [code: string, message: string, id?: string]
}

const REFUSAL_STATUS: Record<string, number> = {
  unknown_mode: 404,
  no_controller: 409,
  blocked: 409,
  excluded: 409,
  no_fit: 409,
  failed: 409,
}

export class ModeService extends EventEmitter<Events> {
  readonly manager: ModeManager
  private readonly controllers = new Map<string, ModeControllerFull>()
  private readonly packs = new Map<string, LoadedMode>()
  private readonly enabled = new Set<string>()
  private readonly disposers: (() => void)[] = []
  private readonly startedAt: number
  private readonly log: NonNullable<ModeServiceDeps['log']>

  constructor(private readonly d: ModeServiceDeps) {
    super()
    this.log = d.log ?? (() => {})
    this.startedAt = (d.now ?? Date.now)()
    const manifests: ModeManifest[] = []
    for (const pack of d.packs) {
      this.packs.set(pack.manifest.id, pack)
      if (d.config.modes[pack.manifest.id]?.enabled !== true) continue
      const factory = d.controllers[pack.manifest.id]
      if (!factory) {
        this.emit(
          'alarm',
          'mode_no_controller',
          `mode "${pack.manifest.id}" is enabled but this program has no code for it`,
          pack.manifest.id
        )
        continue
      }
      this.enabled.add(pack.manifest.id)
      this.controllers.set(pack.manifest.id, factory(d.host))
      manifests.push(pack.manifest)
    }
    this.manager = new ModeManager({
      manifests,
      controllers: Object.fromEntries(this.controllers),
      ensureServices: (names, signal) => this.ensureServices(names, signal),
      releaseServices: (names) => this.releaseServices(names),
      resident: [...d.resident],
      matrix: () => this.matrix(),
      vramNow: () => d.gpu.usedMb(),
      ...(d.mark ? { mark: d.mark } : {}),
      ...(d.startTimeoutMs !== undefined ? { startTimeoutMs: d.startTimeoutMs } : {}),
      ...(d.stopTimeoutMs !== undefined ? { stopTimeoutMs: d.stopTimeoutMs } : {}),
      ...(d.settleTimeoutMs !== undefined ? { settleTimeoutMs: d.settleTimeoutMs } : {}),
      log: (level, msg, extra) => this.log(level, `modes: ${msg}`, extra),
    })
    this.manager.on('state', (id) => this.emit('change', id))
    this.manager.on('alarm', (code, message, id) => this.emit('alarm', code, message, id))
  }

  /** Let the controllers subscribe to what they need. */
  attach(): void {
    for (const [id, c] of this.controllers) {
      try {
        const off = c.attach?.()
        if (typeof off === 'function') this.disposers.push(off)
      } catch (e) {
        this.log('error', `modes: ${id} could not attach: ${(e as Error).message}`)
        this.emit(
          'alarm',
          'mode_attach_failed',
          `mode "${id}" could not start listening: ${(e as Error).message.split(/\r?\n/, 1)[0]}`,
          id
        )
      }
    }
  }

  async dispose(): Promise<void> {
    for (const off of this.disposers.splice(0)) off()
    await this.manager.exitAll('shutdown').catch(() => undefined)
  }

  // ─────────────────────────────── admission ───────────────────────────────

  private serviceInfos(): ServiceInfo[] {
    const byService = new Map<string, RegistryEntry>()
    for (const e of this.d.registry.list()) {
      const enabled = this.d.config.plugins[e.id]?.enabled === true
      const current = byService.get(e.service)
      // one plugin per service counts: the enabled one, else the first
      if (!current || (enabled && this.d.config.plugins[current.id]?.enabled !== true))
        byService.set(e.service, e)
    }
    return [...byService.values()].map((e) => ({
      name: e.service,
      gpu: e.manifest.resources.gpu,
      estMb: e.manifest.resources.vram_mb_est,
      configHash: hashConfig(this.d.pluginConfig(e.id), e.manifest.resources.config_keys),
    }))
  }

  /** The compatibility matrix for the modes that are enabled, with the settings and measurements as they are now. */
  matrix(): Matrix {
    const budget = this.d.config.vram.budget_mb ?? this.d.gpu.totalMb() ?? 12000
    return computeMatrix({
      modes: [...this.enabled].map((id) => (this.packs.get(id) as LoadedMode).manifest),
      services: this.serviceInfos(),
      measurements: [...this.d.measurements()],
      budgetMb: budget,
      marginMb: this.d.config.vram.margin_mb,
      resident: [...this.d.resident],
    })
  }

  // ─────────────────────────────── services ───────────────────────────────

  private providerOf(service: string): RegistryEntry | undefined {
    return this.d.registry.enabledByService(service, this.d.config.plugins)[0]
  }

  private async ensureServices(names: string[], signal: AbortSignal): Promise<void> {
    for (const name of names) {
      const entry = this.providerOf(name)
      if (!entry)
        throw new Error(`the "${name}" service is not set up: enable a plugin that provides it`)
      if (this.d.supervisor.getStatus(entry.id).status === 'ready') continue
      if (signal.aborted) throw new Error('aborted')
      const state = await this.d.supervisor.start(entry.id)
      if (state.status !== 'ready') {
        throw new Error(
          `${entry.manifest.title} did not become ready (${state.status}${state.lastError ? `: ${state.lastError}` : ''})`
        )
      }
    }
  }

  private async releaseServices(names: string[]): Promise<void> {
    for (const name of names) {
      const entry = this.providerOf(name)
      // Only a process we started is ours to stop; a service the operator runs himself is left alone.
      if (entry && entry.manifest.runtime.type === 'process') await this.d.supervisor.stop(entry.id)
    }
  }

  /** Base URL of the ready plugin that provides a service, or null. */
  serviceUrl(service: string): string | null {
    const entry = this.providerOf(service)
    if (!entry) return null
    const s = this.d.supervisor.getStatus(entry.id)
    return s.status === 'ready' ? (s.url ?? null) : null
  }

  // ─────────────────────────────── views ───────────────────────────────

  private verdictView(v: Verdict): VerdictView {
    return {
      ok: v.ok,
      totalMb: v.totalMb,
      budgetMb: v.budgetMb,
      measured: v.measured,
      reasons: v.reasons,
    }
  }

  private view(id: string, matrix: Matrix): ModeView {
    const pack = this.packs.get(id) as LoadedMode
    const m = pack.manifest
    const base = {
      id,
      title: m.title,
      ...(m.description ? { description: m.description } : {}),
      priority: m.priority,
      preempts: m.preempts,
      exclusive_with: m.exclusive_with,
      services: m.requires.services,
      ...(m.triggers.hotkey ? { hotkey: m.triggers.hotkey } : {}),
    }
    if (!this.enabled.has(id)) {
      const enabledInConfig = this.d.config.modes[id]?.enabled === true
      return {
        ...base,
        state: 'IDLE',
        since: this.startedAt,
        admission: {
          ok: false,
          totalMb: 0,
          budgetMb: matrix.alone[id]?.budgetMb ?? 0,
          measured: true,
          reasons: [
            enabledInConfig
              ? 'this program has no code for the mode yet'
              : 'switched off in the configuration (modes.' + id + '.enabled)',
          ],
        },
        pairs: {},
      }
    }
    const slot = this.manager.snapshot().find((s) => s.id === id)
    const alone = matrix.alone[id]
    const panel = this.panelOf(id)
    const pairs: Record<string, VerdictView> = {}
    for (const [other, verdict] of Object.entries(matrix.pairs[id] ?? {})) {
      if (!verdict.ok) pairs[other] = this.verdictView(verdict)
    }
    return {
      ...base,
      state: slot?.state ?? 'IDLE',
      since: slot?.since ?? this.startedAt,
      ...(alone ? { admission: this.verdictView(alone) } : {}),
      pairs,
      ...(panel ? { panel } : {}),
    }
  }

  /** The controller's panel, checked; a controller that throws or answers nonsense shows no panel and is logged. */
  private panelOf(id: string): ModePanel | undefined {
    const c = this.controllers.get(id)
    if (!c?.panel) return undefined
    try {
      const raw = c.panel()
      if (!raw) return undefined
      const parsed = ModePanel.safeParse(raw)
      if (parsed.success) return parsed.data
      this.log(
        'warn',
        `modes: ${id} gave a panel the console cannot show: ${parsed.error.issues[0]?.message}`
      )
    } catch (e) {
      this.log('warn', `modes: ${id} could not make its panel: ${(e as Error).message}`)
    }
    return undefined
  }

  views(): ModeView[] {
    const matrix = this.matrix()
    return [...this.packs.keys()].sort().map((id) => this.view(id, matrix))
  }

  viewOf(id: string): ModeView {
    if (!this.packs.has(id)) throw new AppError('unknown_mode', `there is no mode "${id}"`, 404)
    return this.view(id, this.matrix())
  }

  has(id: string): boolean {
    return this.enabled.has(id)
  }

  /** The manifest of a mode pack, enabled or not. */
  manifest(id: string): ModeManifest | undefined {
    return this.packs.get(id)?.manifest
  }

  /** Every mode pack that was found. */
  ids(): string[] {
    return [...this.packs.keys()]
  }

  active(): string[] {
    return this.manager.active()
  }

  // ─────────────────────────────── acting ───────────────────────────────

  private refuse(id: string, r: Exclude<EnterResult, { ok: true }>): never {
    const status = REFUSAL_STATUS[r.code] ?? 409
    let message: string
    switch (r.code) {
      case 'unknown_mode':
        message = `there is no mode "${id}"`
        break
      case 'no_controller':
        message = `mode "${id}" is not available in this program`
        break
      case 'blocked':
        message = r.reason
        break
      case 'excluded':
        message = r.reason
        break
      case 'no_fit':
        message = r.reasons.join(' | ').slice(0, 500) || 'it does not fit in GPU memory'
        break
      case 'failed':
        message = r.reason
        break
    }
    throw new AppError(
      r.code === 'unknown_mode' && this.packs.has(id) ? 'not_enabled' : r.code,
      message,
      status
    )
  }

  async enter(id: string, opts: { replace?: boolean; force?: boolean } = {}): Promise<ModeView> {
    if (!this.packs.has(id)) throw new AppError('unknown_mode', `there is no mode "${id}"`, 404)
    if (!this.enabled.has(id))
      throw new AppError('not_enabled', `mode "${id}" is not enabled (modes.${id}.enabled)`, 409)
    const r = await this.manager.enter(id, opts)
    if (!r.ok) this.refuse(id, r)
    return this.viewOf(id)
  }

  async exit(id: string, reason = 'requested'): Promise<ModeView> {
    if (!this.packs.has(id)) throw new AppError('unknown_mode', `there is no mode "${id}"`, 404)
    await this.manager.exit(id, reason)
    return this.viewOf(id)
  }

  /** Enter without throwing, for controllers and triggers. */
  async tryEnter(
    id: string,
    opts: { replace?: boolean; force?: boolean } = {}
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!this.enabled.has(id)) return { ok: false, reason: `mode "${id}" is not enabled` }
    const r = await this.manager.enter(id, opts)
    if (r.ok) return { ok: true }
    try {
      this.refuse(id, r)
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
    return { ok: false }
  }

  state(id: string): 'IDLE' | 'STARTING' | 'ACTIVE' | 'STOPPING' {
    return this.manager.state(id)
  }

  // ─────────────────────────────── prompts and hooks ───────────────────────────────

  /** Prompts of the modes that are active right now, then the advertisements of the modes that could be entered. */
  prompts(): ModePrompt[] {
    const out: ModePrompt[] = []
    for (const id of this.manager.active()) {
      const text = this.packs.get(id)?.activePrompt
      if (!text) continue
      let vars: Record<string, string> = {}
      try {
        vars = this.controllers.get(id)?.promptVars?.() ?? {}
      } catch (e) {
        this.log('warn', `modes: ${id} could not give its prompt values: ${(e as Error).message}`)
      }
      out.push({ id, text: renderTemplate(text, vars) })
    }
    for (const [id, c] of this.controllers) {
      if (this.manager.active().includes(id)) continue
      let ad: ReturnType<NonNullable<ModeControllerFull['advertise']>> = null
      try {
        ad = c.advertise?.() ?? null
      } catch (e) {
        this.log('warn', `modes: ${id} could not advertise: ${(e as Error).message}`)
      }
      if (!ad) continue
      const text = this.packs.get(id)?.prompts.get(ad.prompt)
      if (text) out.push({ id: `${id}:${ad.prompt}`, text: renderTemplate(text, ad.vars ?? {}) })
    }
    return out
  }

  /** A prompt file of a pack with its variables filled in. */
  prompt(modeId: string, name: string, vars: Record<string, string> = {}): string | null {
    const text = this.packs.get(modeId)?.prompts.get(name)
    return text === undefined ? null : renderTemplate(text, vars)
  }

  /** Let every controller look at a batch first; what they return goes into that reply's prompt. */
  async batchExtras(batch: Batch): Promise<string[]> {
    const lines: string[] = []
    await Promise.all(
      [...this.controllers].map(async ([id, c]) => {
        if (!c.onBatch) return
        try {
          lines.push(...(await c.onBatch(batch)))
        } catch (e) {
          this.log('error', `modes: ${id} failed on a batch: ${(e as Error).message}`)
        }
      })
    )
    return lines
  }

  /**
   * A chat message that starts with a command word of a mode that is ACTIVE goes to that mode. True when the mode took
   * it as its command; a mode that is not active leaves its words as ordinary chat. Longer command words win over
   * shorter ones (`/画` before `画`).
   */
  chatCommand(cmd: ChatCommandInput): boolean {
    const text = cmd.text.trim()
    const candidates: { id: string; prefix: string }[] = []
    for (const id of this.manager.active()) {
      if (this.manager.state(id) !== 'ACTIVE') continue
      for (const prefix of this.packs.get(id)?.manifest.triggers.danmaku_prefix ?? [])
        if (text.startsWith(prefix)) candidates.push({ id, prefix })
    }
    candidates.sort((a, b) => b.prefix.length - a.prefix.length)
    for (const { id, prefix } of candidates) {
      const c = this.controllers.get(id)
      if (!c?.onChatCommand) continue
      try {
        if (c.onChatCommand({ ...cmd, prefix, argument: text.slice(prefix.length).trim() }))
          return true
      } catch (e) {
        this.log('error', `modes: ${id} failed on a chat command: ${(e as Error).message}`)
      }
    }
    return false
  }

  /** A song command from chat goes to the modes that handle songs. True when one took it. */
  async songCommand(command: SongCommand): Promise<boolean> {
    let taken = false
    for (const [id, c] of this.controllers) {
      if (!c.onSongCommand) continue
      try {
        if (await c.onSongCommand(command)) taken = true
      } catch (e) {
        this.log('error', `modes: ${id} failed on a song command: ${(e as Error).message}`)
      }
    }
    return taken
  }

  /** The model asked for a mode with a tag. */
  async modelRequest(id: string, request: { name?: string }): Promise<void> {
    const c = this.controllers.get(id)
    if (!c?.onModelRequest) return
    try {
      await c.onModelRequest(request)
    } catch (e) {
      this.log('error', `modes: ${id} failed on a request from the model: ${(e as Error).message}`)
    }
  }

  /** The operator asked for a mode from the console, with details the mode understands. */
  async consoleRequest(
    id: string,
    request: Record<string, unknown>
  ): Promise<{ ok: boolean; reason?: string }> {
    const c = this.controllers.get(id)
    if (!c?.onConsoleRequest)
      return this.tryEnter(id, { replace: request.replace === true, force: request.force === true })
    return c.onConsoleRequest(request)
  }
}
