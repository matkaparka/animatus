/**
 * The console's view of a running orchestrator: everything the console routes do, expressed as calls on the
 * `App`. The server (`server.ts`) owns transport and security; this file only says what the answers are.
 *
 * Rules it keeps (see backend.ts): refuse with `ApiFailure`; never return, log or throw a secret value; put
 * nothing in a refusal that reaches the browser but names and limits.
 */
import {
  CONSOLE_API_VERSION,
  type ApprovalView,
  type ApprovalsResponse,
  type ConsoleEvent,
  type InjectRequest,
  type LlmProviderView,
  type ModeAction,
  type ModeRequest,
  type ModeView,
  type PluginAction,
  type PluginView,
  type RunEvent,
  type SayRequest,
  type SecretView,
  type SpeechTraceView,
  type StageView,
  type StatusView,
} from '@animatus/protocol'
import { SecretName } from '@animatus/protocol'
import { WELL_KNOWN_SECRETS, type App } from '../app/app.ts'
import { AppError } from '../app/errors.ts'
import { publicConfig, secretRefs } from '../config.ts'
import { PluginDisabledError, UnknownPluginError } from '../plugins/supervisor.ts'
import { SecretStoreError } from '../plugins/secrets.ts'
import {
  ApiFailure,
  type ApprovalsBackend,
  type ConsoleBackend,
  type MemoryBackend,
} from './backend.ts'
import { createMemoryBackend } from './memoryBackend.ts'

export interface AppBackendOptions {
  version?: string
}

export class AppBackend implements ConsoleBackend {
  private readonly version: string
  /** The memory routes; absent when `memory.enabled` is off. */
  readonly memory?: MemoryBackend

  constructor(
    private readonly app: App,
    options: AppBackendOptions = {}
  ) {
    this.version = options.version ?? '0.1.0'
    if (app.memory) this.memory = createMemoryBackend(app.memory)
  }

  // ─────────────────────────────── status ───────────────────────────────

  async status(): Promise<StatusView> {
    const app = this.app
    const hub = app.stage.hub.state
    const stage: StageView = {
      connected: hub.connected,
      url: app.stage.url,
      ...(hub.model
        ? {
            model: {
              status: hub.model.status,
              ...(hub.model.url ? { url: hub.model.url } : {}),
              ...(hub.model.error ? { error: hub.model.error } : {}),
            },
          }
        : {}),
      ...(hub.audio
        ? {
            audio: {
              state: hub.audio.state,
              contexts_created: hub.audio.contexts_created,
              contexts_open: hub.audio.contexts_open,
            },
          }
        : {}),
      ...(hub.stats
        ? {
            fps: hub.stats.fps,
            underruns_total: hub.stats.underruns_total,
            tpose_frames: hub.stats.tpose_frames,
          }
        : {}),
      ...(hub.lastReportAt > 0 ? { lastReportAt: hub.lastReportAt } : {}),
    }
    return {
      api: CONSOLE_API_VERSION,
      version: this.version,
      startedAt: app.startedAt,
      now: Date.now(),
      stage,
      speech: {
        speaking: app.director.speaking,
        pending: app.director.pending,
        held: app.director.held,
      },
      plugins: this.pluginViews(),
      modes: this.modeViews(),
      llm: this.llmView(),
      alarms: app.alarms.list(),
      approvals_pending: app.tools.pending().length,
    }
  }

  private llmView(): StatusView['llm'] {
    const stats = this.app.llmStats()
    const providers: LlmProviderView[] = (stats?.providers ?? []).map((p) => ({
      id: p.id,
      kind: p.kind,
      requests: p.requests,
      successes: p.successes,
      failures: p.failures,
      ...(p.lastError ? { lastError: { code: p.lastError.code, at: p.lastError.at } } : {}),
      ...(p.cooldownUntil !== undefined ? { cooldownUntil: p.cooldownUntil } : {}),
    }))
    return { providers, order: this.app.llmOrder() }
  }

  // ─────────────────────────────── plugins ───────────────────────────────

  private pluginView(id: string): PluginView {
    const entry = this.app.registry.get(id)
    if (!entry) throw new ApiFailure('unknown_plugin', `there is no plugin "${id}"`, 404)
    const state = this.app.supervisor.getStatus(id)
    const m = entry.manifest
    return {
      id,
      title: m.title,
      kind: m.kind,
      service: entry.service,
      enabled: this.app.config.plugins[id]?.enabled === true,
      status: state.status,
      ...(state.pid !== undefined ? { pid: state.pid } : {}),
      ...(state.url !== undefined ? { url: state.url } : {}),
      restarts: state.restarts,
      ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
      ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
      ...(state.health !== undefined ? { health: state.health } : {}),
      gpu: m.resources.gpu,
      vram_mb_est: m.resources.vram_mb_est,
      vram_mb_measured: null,
    }
  }

  private pluginViews(): PluginView[] {
    return this.app.registry.list().map((e) => this.pluginView(e.id))
  }

  listPlugins(): PluginView[] {
    return this.pluginViews()
  }

  async pluginAction(id: string, action: PluginAction): Promise<PluginView> {
    this.pluginView(id) // 404 for an unknown id, before anything is started
    try {
      if (action === 'start') await this.app.supervisor.start(id)
      else if (action === 'stop') await this.app.supervisor.stop(id)
      else await this.app.supervisor.restart(id)
    } catch (e) {
      if (e instanceof PluginDisabledError) {
        throw new ApiFailure(
          'plugin_disabled',
          `plugin "${id}" is disabled in the configuration`,
          409
        )
      }
      if (e instanceof UnknownPluginError)
        throw new ApiFailure('unknown_plugin', `there is no plugin "${id}"`, 404)
      throw e
    }
    return this.pluginView(id)
  }

  pluginLogs(id: string, lines: number): string[] {
    this.pluginView(id)
    return this.app.supervisor.logs(id, lines)
  }

  // ─────────────────────────────── modes ───────────────────────────────

  private modeViews(): ModeView[] {
    return this.app.modeViews()
  }

  listModes(): ModeView[] {
    return this.modeViews()
  }

  async modeAction(id: string, action: ModeAction, req: ModeRequest): Promise<ModeView> {
    try {
      return await this.app.modeAction(id, action, req)
    } catch (e) {
      if (e instanceof AppError) throw new ApiFailure(e.code, e.message, e.httpStatus)
      throw e
    }
  }

  // ─────────────────────────────── secrets ───────────────────────────────

  /** Every secret name worth showing: the well-known ones, those the configuration refers to and those a plugin asks for. */
  private async secretNames(): Promise<string[]> {
    const names = new Set<string>(Object.keys(WELL_KNOWN_SECRETS))
    const walk = (v: unknown): void => {
      if (typeof v === 'string') for (const n of secretRefs(v)) names.add(n)
      else if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(this.app.config.llm)
    walk(this.app.config.sources)
    for (const e of this.app.registry.list()) for (const s of e.manifest.secrets) names.add(s.name)
    for (const { name } of await this.app.secrets.names()) names.add(name)
    return [...names].filter((n) => SecretName.safeParse(n).success).sort()
  }

  private async secretView(name: string): Promise<SecretView> {
    const listed = (await this.app.secrets.names()).find((n) => n.name === name)
    const set = (await this.app.secrets.get(name)) !== undefined
    return { name, set, source: set ? (listed?.source ?? 'environment') : 'unset' }
  }

  async listSecrets(): Promise<SecretView[]> {
    return Promise.all((await this.secretNames()).map((n) => this.secretView(n)))
  }

  async putSecret(name: string, value: string): Promise<SecretView> {
    if (!SecretName.safeParse(name).success)
      throw new ApiFailure('invalid_name', 'that is not a valid secret name', 400)
    try {
      await this.app.secrets.set(name, value)
    } catch (e) {
      if (e instanceof SecretStoreError)
        throw new ApiFailure(
          `secret_${e.code}`.slice(0, 64),
          e.message,
          e.code === 'read_only' ? 409 : 400
        )
      throw e
    }
    await this.app.secretsChanged(name)
    return this.secretView(name)
  }

  async deleteSecret(name: string): Promise<SecretView> {
    if (!SecretName.safeParse(name).success)
      throw new ApiFailure('invalid_name', 'that is not a valid secret name', 400)
    try {
      await this.app.secrets.delete(name)
    } catch (e) {
      if (e instanceof SecretStoreError)
        throw new ApiFailure(`secret_${e.code}`.slice(0, 64), e.message, 400)
      throw e
    }
    await this.app.secretsChanged(name)
    return this.secretView(name)
  }

  // ─────────────────────────────── approvals ───────────────────────────────

  readonly approvals: ApprovalsBackend = {
    list: (): ApprovalsResponse => ({
      pending: this.app.tools.pending(),
      recent: this.app.tools.recent(),
    }),
    decide: async (id: string, action: 'approve' | 'deny'): Promise<ApprovalView> => {
      const r = action === 'approve' ? await this.app.tools.approve(id) : this.app.tools.deny(id)
      if (!r.ok)
        throw new ApiFailure(`approval_${r.code}`, r.message, r.code === 'not_found' ? 404 : 409)
      return r.view
    },
  }

  // ─────────────────────────────── actions ───────────────────────────────

  say(req: SayRequest): void {
    this.app.say(req)
  }

  inject(req: InjectRequest): void {
    this.app.inject(req)
  }

  stopSpeech(): void {
    this.app.stopSpeech()
  }

  // ─────────────────────────────── records ───────────────────────────────

  recentEvents(limit: number): RunEvent[] {
    return this.app.runLog.recent(limit)
  }

  recentTraces(limit: number): SpeechTraceView[] {
    return this.app.traces.recent(limit)
  }

  config(): Record<string, unknown> {
    return publicConfig(this.app.config)
  }

  // ─────────────────────────────── live events ───────────────────────────────

  /** Everything the run page shows live. Wire it to `server.publish`. Returns the unsubscribe. */
  onEvent(listener: (event: ConsoleEvent) => void): () => void {
    const app = this.app
    const offs = [
      app.runLog.subscribe((event) => listener({ type: 'run', event })),
      app.traces.subscribe((trace) => listener({ type: 'trace', trace })),
      app.alarms.subscribe((alarm) => listener({ type: 'alarm', alarm })),
      app.onPluginStatus((id) => {
        try {
          listener({ type: 'plugin', plugin: this.pluginView(id) })
        } catch {
          // a plugin that vanished between the event and the lookup is not worth a message
        }
      }),
      app.onModeChange((mode) => listener({ type: 'mode', mode })),
      app.onApprovalsChange(() =>
        listener({ type: 'approvals', pending: app.tools.pending().length })
      ),
    ]
    return () => offs.forEach((off) => off())
  }
}
