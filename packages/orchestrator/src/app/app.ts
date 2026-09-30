/**
 * The orchestrator as one object: it builds every part from the configuration, connects them, and owns
 * their life cycle. Nothing in here decides anything on its own; the parts do (the inbox paces, the brain
 * answers, the speech director schedules, the supervisor keeps services alive). This file is the wiring.
 *
 *   Bilibili source ─▶ Router ─▶ Pacer ─▶ Brain ─▶ SpeechDirector ─▶ StageHub ─▶ stage page
 *                                          │            │
 *                                    LLM gateway   TTS service (a supervised plugin)
 *
 * Every failure a viewer could notice becomes an alarm the operator sees in the console (and a run-log
 * line); none of them stops the program.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  Emotion,
  InjectRequest,
  ModeAction,
  ModeRequest,
  ModeView,
  RunEvent,
  SayRequest,
  StatusView,
} from '@animatus/protocol'
import { CameraAdjust, NO_CAMERA_ADJUST, trustFor } from '@animatus/protocol'
import type { EventSource, ToolAuditEntry } from '@animatus/protocol'
import { Brain } from '../brain/brain.ts'
import type { LlmLike } from '../brain/brain.ts'
import { ChatLog } from '../brain/chatlog.ts'
import { parseConfig, secretRefs, toProviderConfig } from '../config.ts'
import type { AppConfig, LlmProviderEntry } from '../config.ts'
import { Blocklist, FORMATS, Pacer, Router, emptyBlocklist } from '../inbox/index.ts'
import type { BlockChecker, PacerState } from '../inbox/index.ts'
import { LlmError, LlmGateway, createLlmProvider } from '../llm/index.ts'
import type { ChatMessage } from '../llm/types.ts'
import type { LlmGatewayStats } from '../llm/index.ts'
import { MotionLibrary } from '../library/motionLibrary.ts'
import { PluginRegistry } from '../plugins/registry.ts'
import type { RegistryEntry } from '../plugins/registry.ts'
import {
  CompositeSecretStore,
  DpapiFileSecretStore,
  EnvFileSecretStore,
  EnvVarSecretStore,
  secretAliasesFrom,
} from '../plugins/secrets.ts'
import type { SecretStore } from '../plugins/secrets.ts'
import { Supervisor } from '../plugins/supervisor.ts'
import type { StatusEvent } from '../plugins/supervisor.ts'
import { BilibiliSource } from '../sources/bilibili/index.ts'
import type { BilibiliSourceEvent, BilibiliSourceOptions } from '../sources/bilibili/index.ts'
import { parseCookieHeader } from '../sources/bilibili/cookies.ts'
import { SpeechDirector } from '../speech/director.ts'
import { assetUrl } from '../stage/assets.ts'
import { launchStageWindow } from '../stage/launcher.ts'
import { createConsoleLogger } from '../stage/logger.ts'
import type { Logger } from '../stage/logger.ts'
import { stageOutput, stageReports } from '../stage/output.ts'
import { createStageServer } from '../stage/server.ts'
import type { StageHubEvents } from '../stage/hub.ts'
import type { StageServer } from '../stage/server.ts'
import { GptSovitsTts, TtsError } from '../tts/gptsovits.ts'
import { SwitchableTts } from '../tts/lazy.ts'
import { SpeechFilter } from '../tts/text.ts'
import type { TtsAdapter, VramMeasurement } from '@animatus/protocol'
import { AlarmBoard, RunLog, TraceBoard } from './board.ts'
import { AppError } from './errors.ts'
import { MemoryService } from '../memory/service.ts'
import { builtinControllers } from '../modes/controllers/index.ts'
import { GpuMeter } from '../modes/gpu.ts'
import type { ActivityFlags, LlmTextRequest, ModeHost } from '../modes/host.ts'
import { loadModePacks } from '../modes/loader.ts'
import type { LoadedMode } from '../modes/loader.ts'
import { loadMeasurements } from '../modes/measurements.ts'
import { ModeService } from '../modes/service.ts'
import { composeStage, resolveModeStage } from '../modes/stageProfile.ts'
import type { ComposedStage, ModeStage } from '../modes/stageProfile.ts'
import { createAuditSink } from '../tools/audit.ts'
import type { AuditSink } from '../tools/audit.ts'
import { registerBuiltinTools } from '../tools/builtin.ts'
import { ToolGate } from '../tools/gate.ts'
import { originOfBatch } from '../tools/origin.ts'
import { ToolRegistry } from '../tools/registry.ts'

/** Names the console's key page and `${secret:x}` references know, and the variables they are read from. */
export const WELL_KNOWN_SECRETS: Readonly<Record<string, string>> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  bili_cookie: 'BILI_COOKIE',
}

/** Plugin id to the built-in adapter that talks to it. Plugins with their own adapter module come later. */
const TTS_PLUGINS = new Set(['gptsovits', 'gptsovits-attach'])

export interface BilibiliLike {
  on(event: 'event', fn: (e: BilibiliSourceEvent) => void): unknown
  start(): Promise<void>
  stop(): Promise<void>
}

export interface AppOptions {
  config: AppConfig
  /** Replaces the secret store built from the configuration (tests). */
  secrets?: SecretStore
  /** Replaces the LLM gateway built from the configuration (tests). */
  llm?: LlmLike
  /** Replaces the speech backend that a supervised `tts` plugin would provide (tests). */
  tts?: TtsAdapter
  /** Builds the chat source (tests); the default is the Bilibili live-room source. */
  makeBilibili?: (options: BilibiliSourceOptions) => BilibiliLike
  logger?: Logger
  now?: () => number
  /** The stage's Vite build. Default: packages/stage/dist under the project root. */
  stageDir?: string
  /** Do not open the stage window even if the configuration names a browser. */
  noBrowser?: boolean
  /** How often the inbox is looked at. Default 500 ms, as in the legacy sender loop. */
  inboxTickMs?: number
  /** Folders holding mode packs, later ones overriding earlier ones. Default: modes/ and config/modes/ under the project root. */
  modesDirs?: string[]
  /** Mode controllers by mode id; default the ones that ship with the program. For tests and embedding. */
  controllers?: Readonly<Record<string, import('../modes/host.ts').ControllerFactory>>
  /** Where the plugin folders are. Default: plugins under the project root. */
  pluginsDir?: string
  /** `welcome.dev` for the stage. */
  dev?: boolean
  /** Start the console server too (`main.ts` does; the tests of the other parts do not). */
  console?: boolean
  /** The console's Vite build. Default: packages/console/dist under the project root. */
  consoleDir?: string
}

export type { ActivityFlags } from '../modes/host.ts'

export class App {
  readonly config: AppConfig
  readonly logger: Logger
  readonly secrets: SecretStore
  readonly registry: PluginRegistry
  readonly supervisor: Supervisor
  readonly stage: StageServer
  readonly motions: MotionLibrary | null
  readonly tts = new SwitchableTts()
  readonly director: SpeechDirector
  readonly chat: ChatLog
  readonly brain: Brain
  readonly router: Router
  readonly pacer: Pacer
  readonly runLog: RunLog
  readonly traces = new TraceBoard()
  readonly alarms: AlarmBoard
  readonly flags: ActivityFlags = { dancing: false, singing: false, sleeping: false }
  readonly gpu = new GpuMeter()
  readonly modes: ModeService
  /** What the character remembers between streams; null when `memory.enabled` is off. */
  readonly memory: MemoryService | null
  /** Every tool the model asks for goes through this and nothing else (see `tools/gate.ts`). */
  readonly tools: ToolGate
  private readonly toolAudit: AuditSink
  /** What became of the tools the model asked for, told to it at the start of its next reply. */
  private toolNotes: string[] = []
  private libraryDirs: Readonly<Record<string, string>> = {}
  private measurements: VramMeasurement[] = []
  private measurementTimer: NodeJS.Timeout | null = null
  readonly startedAt: number

  private readonly now: () => number
  private gateway: LlmGateway | null = null
  private readonly llmOverride: LlmLike | undefined
  private readonly ttsOverride: TtsAdapter | undefined
  private readonly makeBilibili: (options: BilibiliSourceOptions) => BilibiliLike
  private source: BilibiliLike | null = null
  private browser: ChildProcess | null = null
  private inboxTimer: NodeJS.Timeout | null = null
  private readonly disposers: (() => void)[] = []
  private readonly options: AppOptions
  private sayCounter = 0
  private turnSeen = false
  private started = false
  private stopped = false

  private constructor(
    options: AppOptions,
    parts: {
      secrets: SecretStore
      registry: PluginRegistry
      blocklist: BlockChecker
      words: string[]
      packs: LoadedMode[]
      packErrors: { dir: string; error: string }[]
    }
  ) {
    const config = options.config
    this.options = options
    this.config = config
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
    this.logger = options.logger ?? createConsoleLogger('info')
    this.secrets = parts.secrets
    this.registry = parts.registry
    this.llmOverride = options.llm
    this.ttsOverride = options.tts
    this.makeBilibili = options.makeBilibili ?? ((o) => new BilibiliSource(o))
    this.runLog = new RunLog(500, this.now)
    this.alarms = new AlarmBoard(this.now)

    // ── plugins
    const python = path.join(config.root, '.venv', 'Scripts', 'python.exe')
    this.supervisor = new Supervisor({
      registry: this.registry,
      pluginConfig: config.plugins,
      interpreters: { light: python },
      secrets: this.secrets,
      dataDir: config.paths.data_dir,
      guard: { script: path.join(config.root, 'plugins', '_guard', 'job_guard.py'), python },
      log: (level, msg, extra) => this.logger(level, `plugin: ${msg}`, extra),
    })

    // ── stage
    const libraries: Record<string, string> = {}
    if (config.paths.models) libraries.models = config.paths.models
    if (config.paths.motions) libraries.motions = config.paths.motions
    if (config.paths.songs) libraries.songs = config.paths.songs
    if (config.paths.asmr) libraries.asmr = config.paths.asmr
    if (config.paths.lipsync) libraries.lipsync = config.paths.lipsync
    // what the program makes for the stage to show (pictures a mode drew): always there, under data/
    libraries.generated = path.join(config.paths.data_dir, 'generated')
    this.libraryDirs = libraries
    this.stage = createStageServer({
      port: config.servers.stage_port,
      staticDir: options.stageDir ?? path.join(config.root, 'packages', 'stage', 'dist'),
      libraries,
      dev: options.dev ?? false,
      logger: this.logger,
    })
    this.motions = config.paths.motions
      ? new MotionLibrary(config.paths.motions, { logger: this.logger, now: this.now })
      : null

    // ── speech
    const filter = new SpeechFilter(parts.words)
    filter.onReplace = (word) =>
      this.runLog.add('speech', `sensitive word replaced (${word.length} characters)`)
    this.director = new SpeechDirector({
      tts: this.tts,
      stage: stageOutput(this.stage.hub),
      reports: stageReports(this.stage.hub),
      filter,
      lookahead: config.speech.lookahead,
      stageQueueMax: config.speech.stage_queue_max,
      log: (level, msg, extra) =>
        this.logger(level, `speech: ${msg}`, extra as Record<string, unknown> | undefined),
      now: this.now,
    })

    // ── brain
    this.chat = new ChatLog(path.join(config.paths.data_dir, 'chat'))
    this.brain = new Brain({
      llm: { stream: (req) => this.currentLlm().stream(req) },
      director: this.director,
      chat: this.chat,
      // the persona file, then the rules the streamer keeps in memory's persona/ folder (live: an edit there is in the next prompt)
      persona: () => {
        const extra = this.memory?.store.personaText() ?? ''
        return extra ? `${this.personaText}\n\n${extra}` : this.personaText
      },
      motionTags: () => this.motions?.promptTagList() ?? [],
      resolveMotion: (tag) => this.motions?.pick(tag) ?? null,
      modePrompts: () => this.modes.prompts(),
      memory: (input) => this.memory?.recall(input.text, input.viewers ?? []) ?? [],
      ...(config.tools.enabled
        ? {
            tools: (input) =>
              this.tools.usableBy(input.trust).map((t) => ({
                name: t.name,
                description: t.description,
                usage: t.usage,
                approval: this.tools.tierOf(t.name) === 'approval',
              })),
            notes: () => this.takeToolNotes(),
          }
        : {}),
      historyMessages: config.llm.history_messages,
      firstCommaMinChars: config.speech.first_comma_min_chars,
      ...(config.llm.temperature !== undefined ? { temperature: config.llm.temperature } : {}),
      ...(config.llm.max_output_tokens !== undefined
        ? { maxOutputTokens: config.llm.max_output_tokens }
        : {}),
      ...(config.llm.timeout_ms !== undefined ? { timeoutMs: config.llm.timeout_ms } : {}),
      log: (level, msg, extra) => this.logger(level, msg, extra),
      now: this.now,
    })

    // ── memory
    const mem = config.memory
    this.memory = mem.enabled
      ? new MemoryService({
          store: { root: mem.dir ?? path.join(config.paths.data_dir, 'memory') },
          recall: {
            maxLines: mem.recall.max_lines,
            maxChars: mem.recall.max_chars,
            perSpeaker: mem.recall.per_speaker,
            searchCacheDays: mem.recall.search_cache_days,
          },
          llmText: (req) =>
            this.llmText({
              tag: req.tag,
              system: req.system,
              user: req.user,
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              ...(req.maxOutputTokens !== undefined
                ? { maxOutputTokens: req.maxOutputTokens }
                : {}),
            }),
          isSensitive: (text) => filter.contains(text),
          // the text carries a viewer's name: it is not the program's own words, so it is not trusted
          tell: (text) =>
            void this.brain
              .respond({ text, source: 'system', trust: 'untrusted' })
              .catch((e) => this.logger('error', `brain: ${firstLine(e)}`)),
          alarm: (code, message) => void this.alarms.raise(code, 'warn', message, 'memory'),
          clearAlarm: (code) => void this.alarms.clear(code, 'memory'),
          log: (level, msg) => this.logger(level, msg),
          now: this.now,
          consolidateEveryHours: mem.consolidate.every_hours,
          consolidate: {
            maxViewers: mem.consolidate.max_viewers,
            minMessages: mem.consolidate.min_messages,
            maxFacts: mem.consolidate.max_facts,
            searchCacheDays: mem.recall.search_cache_days,
            streamNotes: mem.consolidate.stream_notes,
          },
        })
      : null

    // ── inbox
    this.router = new Router(config.inbox, parts.blocklist, {
      now: this.now,
      log: (level, msg, extra) => this.logger(level, `inbox: ${msg}`, extra),
      onDrop: (reason, info) =>
        this.logger('debug', `inbox: dropped (${reason})`, { ...info, text: undefined }),
      onChatCommand: (cmd) => this.memory?.chatCommand(cmd) === true || this.modes.chatCommand(cmd),
      onSongCommand: (cmd) =>
        void this.modes
          .songCommand(cmd)
          .then((taken) => {
            if (!taken)
              this.runLog.add(
                'inbox',
                `song command "${cmd.kind}" ignored: the singing mode is not set up`
              )
          })
          .catch((e) => this.logger('error', `modes: song command: ${firstLine(e)}`)),
    })
    this.pacer = new Pacer(this.router, config.inbox)

    // ── modes
    for (const e of parts.packErrors) {
      this.logger('warn', `mode pack skipped: ${path.basename(e.dir)}: ${e.error}`)
      this.alarms.raise(
        'mode_pack_invalid',
        'warn',
        `mode pack "${path.basename(e.dir)}" was skipped: ${e.error.split(/\r?\n/, 1)[0]}`,
        path.basename(e.dir)
      )
    }
    // a mode named in the configuration that has no pack is most likely a typo: say so instead of ignoring it
    const known = new Set(parts.packs.map((p) => p.manifest.id))
    for (const [id, entry] of Object.entries(config.modes)) {
      if (entry.enabled && !known.has(id))
        this.alarms.raise(
          'mode_unknown',
          'warn',
          `modes.${id} is switched on but there is no mode called "${id}" (check the spelling, or the modes folder)`,
          id
        )
    }
    this.modes = new ModeService({
      config,
      packs: parts.packs,
      registry: this.registry,
      supervisor: this.supervisor,
      pluginConfig: (id) => this.config.plugins[id]?.config ?? {},
      host: this.makeModeHost(),
      controllers: options.controllers ?? builtinControllers,
      gpu: this.gpu,
      measurements: () => this.measurements,
      resident: config.vram.resident,
      log: (level, msg, extra) =>
        this.logger(level, msg, extra as Record<string, unknown> | undefined),
    })

    // ── tools
    this.toolAudit = createAuditSink(
      path.join(config.paths.data_dir, 'tool-audit.jsonl'),
      (level, msg) => this.logger(level, msg)
    )
    const toolRegistry = new ToolRegistry()
    const mem2 = this.memory
    registerBuiltinTools(toolRegistry, {
      noteToStreamer: (text, origin) => this.noteToStreamer(text, origin),
      ...(mem2
        ? {
            remember: async (text: string) => {
              const r = await mem2.store.append(
                'world/agent-notes.md',
                { source: 'agent', text },
                { author: 'agent', header: '# What the character noted down' }
              )
              if (!r.ok) throw new Error(r.message)
              return r.duplicate ? ('already there' as const) : ('written' as const)
            },
          }
        : {}),
      modes: {
        has: (id) => this.modes.has(id),
        ids: () => this.modes.enabledIds(),
        enter: async (id) => {
          const v = await this.modeAction(id, 'enter', { replace: false, force: false })
          // a mode may start only once the speech is quiet, so "not yet" is a fair answer
          return `asked "${id}" to start; it is ${v.state} now`
        },
        exit: async (id) => {
          const v = await this.modes.exit(id, 'tool')
          return `asked "${id}" to end; it is ${v.state} now`
        },
      },
    })
    this.tools = new ToolGate({
      registry: toolRegistry,
      tiers: config.tools.tiers,
      ttlMs: config.tools.approval_ttl_sec * 1000,
      maxPending: config.tools.max_pending,
      perMinute: config.tools.per_minute,
      audit: (entry) => this.onToolAudit(entry),
      now: this.now,
    })

    this.wire()
  }

  /** Reads the configuration's neighbours (secret store, plugins, word list) and builds the app. Nothing is started. */
  static async create(options: AppOptions): Promise<App> {
    const config = options.config
    const registry = await PluginRegistry.scan(
      options.pluginsDir ?? path.join(config.root, 'plugins')
    )
    for (const e of registry.errors()) {
      ;(options.logger ?? createConsoleLogger('info'))(
        'warn',
        `plugin folder skipped: ${path.basename(e.dir)}: ${e.error}`
      )
    }
    const secrets = options.secrets ?? createSecretStore(config, registry.list())

    let words: string[] = []
    if (config.speech.sensitive_words_file) {
      try {
        words = SpeechFilter.parseList(await readFile(config.speech.sensitive_words_file, 'utf8'))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    }
    const blockFile = config.sources.bilibili?.blocklist_file
    const blocklist: BlockChecker = blockFile ? Blocklist.fromFile(blockFile) : emptyBlocklist
    const { modes: packs, errors: packErrors } = await loadModePacks(
      options.modesDirs ?? [
        path.join(config.root, 'modes'),
        path.join(config.root, 'config', 'modes'),
      ]
    )
    const app = new App(options, { secrets, registry, blocklist, words, packs, packErrors })
    await app.loadPersona()
    return app
  }

  // ───────────────────────────── persona ─────────────────────────────

  private personaText = ''

  /** Re-reads persona.md (the console calls this after an edit). A missing file is an error the operator sees. */
  async loadPersona(): Promise<void> {
    const file = path.join(this.config.persona, 'persona.md')
    try {
      this.personaText = await readFile(file, 'utf8')
      this.alarms.clear('persona_missing')
    } catch (e) {
      this.personaText = ''
      this.alarms.raise(
        'persona_missing',
        'error',
        `cannot read ${path.basename(this.config.persona)}/persona.md: ${(e as Error).message.split('\n')[0]}`
      )
    }
  }

  // ───────────────────────────── LLM ─────────────────────────────

  private currentLlm(): LlmLike {
    if (this.llmOverride) return this.llmOverride
    if (this.gateway) return this.gateway
    return {
      stream: () =>
        (async function* () {
          throw new LlmError(
            'unavailable',
            'no model provider is set up (add one under llm.providers and its key in the console)',
            { providerId: '-' }
          )
        })(),
    }
  }

  /** Whether a model call can be attempted at all. */
  get llmUsable(): boolean {
    return this.llmOverride !== undefined || this.gateway !== null
  }

  llmStats(): LlmGatewayStats | null {
    return this.gateway ? this.gateway.stats() : null
  }

  /** Builds the gateway from the configuration and the secrets now in the store. Providers without their key are left out and flagged. */
  async reloadLlm(): Promise<void> {
    if (this.llmOverride) return
    const providers = []
    const ids: string[] = []
    for (const entry of this.config.llm.providers as LlmProviderEntry[]) {
      try {
        const resolved = await toProviderConfig(entry, this.secrets)
        providers.push(createLlmProvider(resolved))
        ids.push(entry.id)
        this.alarms.clear('llm_provider_unavailable', entry.id)
      } catch (e) {
        this.alarms.raise(
          'llm_provider_unavailable',
          'warn',
          `provider "${entry.id}" is not usable: ${(e as Error).message}`,
          entry.id
        )
      }
    }
    const previous = this.gateway
    if (providers.length === 0) {
      this.gateway = null
      this.llmOrderIds = []
      if (this.config.llm.providers.length === 0)
        this.alarms.raise(
          'llm_none',
          'warn',
          'no model provider is configured (llm.providers is empty)'
        )
      else
        this.alarms.raise('llm_none', 'error', 'none of the configured model providers can be used')
    } else {
      this.alarms.clear('llm_none')
      const order = (this.config.llm.order ?? ids).filter((id) => ids.includes(id))
      this.llmOrderIds = order.length > 0 ? order : ids
      this.gateway = new LlmGateway({
        providers,
        order: order.length > 0 ? order : ids,
        ...(this.config.llm.cooldown_ms ? { cooldownMs: this.config.llm.cooldown_ms } : {}),
        log: (level, msg, extra) => this.logger(level, `llm: ${msg}`, extra),
        now: this.now,
      })
    }
    void previous
  }

  // ───────────────────────────── wiring ─────────────────────────────

  private wire(): void {
    const hub = this.stage.hub
    const onHub = <E extends keyof StageHubEvents>(
      event: E,
      fn: (...args: StageHubEvents[E]) => void
    ) => {
      hub.on(event, fn as never)
      this.disposers.push(() => void hub.off(event, fn as never))
    }

    // stage
    onHub('connected', (info) => {
      this.runLog.add('stage', `stage connected (${info.hello.ua.slice(0, 80)})`)
      this.alarms.clear('stage_disconnected')
      this.director.kick()
    })
    onHub('disconnected', (info) => {
      this.runLog.add(
        'stage',
        `stage disconnected (${info.code}${info.replaced ? ', replaced by a newer page' : ''})`
      )
      if (!info.replaced)
        this.alarms.raise(
          'stage_disconnected',
          'warn',
          'the stage page is not connected: nothing is shown or heard'
        )
    })
    onHub('stage.error', (m) => {
      this.runLog.add('stage', `stage error ${m.code}: ${m.message}`)
      this.alarms.raise('stage_error', 'warn', `${m.code}: ${m.message}`)
    })
    onHub('model.state', (m) => {
      if (m.status === 'error')
        this.alarms.raise(
          'model_load_failed',
          'error',
          `the stage could not load the model: ${m.error ?? 'no details'}`
        )
      else if (m.status === 'ready') this.alarms.clear('model_load_failed')
    })
    onHub('error', (err) => this.logger('error', `stage hub: ${err.message}`))
    onHub('camera.adjusted', (m) => this.setCameraAdjust(m.adjust))

    // speech
    this.director.on('started', (_id, t) => this.traces.update(t))
    this.director.on('ended', (_id, _reason, t) => this.traces.update(t))
    this.director.on('failed', (id, err, text) => {
      this.runLog.add('speech', `could not speak "${text.slice(0, 60)}": ${err.message}`)
      this.alarms.raise('speech_failed', 'warn', `a sentence could not be spoken: ${err.message}`)
      this.logger('warn', `speech: ${id} failed`, { error: err.message })
      this.onSynthesisFailed(err)
    })
    this.director.on('started', () => {
      this.alarms.clear('speech_failed')
      this.synthTimeouts = 0
    })

    // brain
    this.brain.on('sentence', (s) =>
      this.runLog.add('speech', `[${s.emotion}${s.motion ? `+${s.motion.id}` : ''}] ${s.text}`)
    )
    this.brain.on('thinking', (t) => this.logger('debug', `brain: thinking ${t.text.length} chars`))
    this.brain.on('dance.request', (d) => {
      void this.modes.modelRequest('dance', d.name ? { name: d.name } : {})
    })
    this.brain.on('motion.unknown', (m) =>
      this.runLog.add('llm', `motion tag "${m.tag}" names no clip`)
    )
    this.brain.on('tool.call', (c) => {
      // the gate never throws; the outcome reaches the console, the audit trail and the model's next reply through onToolAudit
      void this.tools.request({
        tool: c.tool,
        args: c.args,
        origin: c.origin,
        turnId: c.turnId,
      })
    })
    this.brain.on('tool.ignored', (c) =>
      this.runLog.add('tool', `a tool block in the reply was not taken (${c.reason})`)
    )
    this.brain.on('error', (e) => {
      const why = describeLlmError(e)
      this.runLog.add('llm', `reply failed: ${why}`)
      this.alarms.raise('llm_failed', 'error', `the model could not answer: ${why}`)
    })
    this.brain.on('turn.start', () => (this.turnSeen = true))
    this.brain.on('turn.end', (s) => {
      if (s.status === 'done' && s.sentences > 0) this.alarms.clear('llm_failed')
      this.logger('info', `brain: ${s.turnId} ${s.status}`, {
        sentences: s.sentences,
        firstTokenMs: s.firstTokenMs,
        firstSentenceMs: s.firstSentenceMs,
        totalMs: s.totalMs,
      })
    })

    // modes
    const onModeChange = (id: string) => {
      const view = this.modes.viewOf(id)
      this.runLog.add('mode', `${id}: ${view.state}`)
      this.refreshModeStage()
      for (const fn of this.modeListeners) fn(view)
    }
    this.modes.on('change', onModeChange)
    this.modes.on('alarm', (code, message, id) => this.alarms.raise(code, 'error', message, id))
    this.disposers.push(() => void this.modes.off('change', onModeChange))

    // plugins
    const onStatus = (ev: StatusEvent) => {
      this.handlePluginStatus(ev)
      for (const fn of this.pluginListeners) fn(ev.id, ev.status)
    }
    this.supervisor.on('status', onStatus)
    this.disposers.push(() => void this.supervisor.off('status', onStatus))
  }

  private handlePluginStatus(ev: StatusEvent): void {
    const entry = this.registry.get(ev.id)
    this.runLog.add(
      'plugin',
      `${ev.id}: ${ev.previous} -> ${ev.status}${ev.detail ? ` (${ev.detail})` : ''}`
    )
    if (ev.status === 'failed')
      this.alarms.raise(
        'plugin_failed',
        'error',
        `${entry?.manifest.title ?? ev.id} failed: ${ev.detail ?? 'no details'}`,
        ev.id
      )
    else if (ev.status === 'ready') this.alarms.clear('plugin_failed', ev.id)
    if (entry?.service === 'tts') this.syncTts(entry, ev.status)
  }

  private ttsEpoch = 0
  private synthTimeouts = 0
  private ttsRestarting = false

  /**
   * Attach the speech backend while its plugin is ready, detach it otherwise. A freshly started synthesiser
   * answers its first request slowly (kernels are compiled on first use: 7 s in the first real run, under 1 s
   * afterwards), so one throw-away sentence is spoken to it before it is attached; until then the pacer holds
   * the audience's messages instead of letting the first ones time out.
   */
  private syncTts(entry: RegistryEntry, status: StatusEvent['status']): void {
    if (this.ttsOverride) return
    const epoch = ++this.ttsEpoch
    if (status === 'ready') {
      const url = this.supervisor.getStatus(entry.id).url
      if (!url) return
      if (!TTS_PLUGINS.has(entry.id)) {
        this.alarms.raise(
          'tts_adapter_missing',
          'error',
          `no adapter is built in for the speech plugin "${entry.id}"`,
          entry.id
        )
        return
      }
      let adapter: TtsAdapter
      try {
        adapter = this.makeGsv(url)
      } catch (e) {
        this.tts.attach(null)
        this.alarms.raise(
          'tts_config',
          'error',
          `the speech backend cannot be set up: ${(e as Error).message}`
        )
        return
      }
      this.alarms.clear('tts_config')
      void this.warmUp(adapter).then(() => {
        if (epoch !== this.ttsEpoch) return // the service changed state again while it was warming up
        this.tts.attach(adapter)
        this.synthTimeouts = 0
        this.alarms.clear('tts_unavailable')
        this.director.kick()
      })
    } else if (status !== 'unhealthy' && status !== 'starting') {
      this.tts.attach(null)
      if (status === 'failed' || status === 'stopped')
        this.alarms.raise(
          'tts_unavailable',
          'error',
          'the speech service is not running: sentences cannot be spoken'
        )
    }
  }

  /** Speak one short line into the void so the first real sentence does not pay for the cold start. Never throws. */
  private async warmUp(adapter: TtsAdapter): Promise<void> {
    const t0 = this.now()
    this.runLog.add('plugin', 'speech service is up; warming it up')
    try {
      const lang = this.config.tts.text_lang
      const text = lang.startsWith('zh')
        ? '你好。'
        : lang.startsWith('ja')
          ? 'こんにちは。'
          : 'Hello.'
      const stream = await adapter.synthesize({ text, style: this.config.tts.default_style })
      for await (const chunk of stream.chunks) void chunk
      this.alarms.clear('tts_warmup_failed')
      this.runLog.add(
        'plugin',
        `speech service warmed up in ${((this.now() - t0) / 1000).toFixed(1)} s`
      )
    } catch (e) {
      // Attach anyway: real sentences will then fail one by one, loudly, instead of the service never being used.
      this.alarms.raise(
        'tts_warmup_failed',
        'warn',
        `the speech service did not answer its warm-up sentence: ${(e as Error).message}`
      )
    }
  }

  /**
   * A speech server that has stopped answering (two timeouts in a row, no sentence played in between) is
   * restarted when the supervisor owns its process; otherwise the operator is told.
   */
  private onSynthesisFailed(err: Error): void {
    if (!(err instanceof TtsError) || err.code !== 'timeout') return
    if (++this.synthTimeouts < 2 || this.ttsRestarting) return
    const entry = this.registry.enabledByService('tts', this.config.plugins)[0]
    if (!entry || entry.manifest.runtime.type !== 'process') {
      this.alarms.raise(
        'tts_hung',
        'error',
        'the speech service keeps timing out; restart it by hand'
      )
      return
    }
    this.ttsRestarting = true
    this.synthTimeouts = 0
    this.alarms.raise(
      'tts_hung',
      'error',
      `${entry.manifest.title} stopped answering; restarting it`,
      entry.id
    )
    this.tts.attach(null)
    void this.supervisor
      .restart(entry.id)
      .catch((e) =>
        this.logger('error', `restarting the speech service failed: ${(e as Error).message}`)
      )
      .finally(() => {
        this.ttsRestarting = false
        this.alarms.clear('tts_hung', entry.id)
      })
  }

  private makeGsv(baseUrl: string): TtsAdapter {
    const t = this.config.tts
    const styles = Object.fromEntries(
      Object.entries(t.styles).map(([k, v]) => [
        k,
        {
          refAudio: v.ref_audio,
          refText: v.ref_text,
          ...(v.speed !== undefined ? { speed: v.speed } : {}),
        },
      ])
    )
    return new GptSovitsTts({
      baseUrl,
      styles,
      defaultStyle: t.default_style,
      textLang: t.text_lang,
      promptLang: t.prompt_lang,
      splitMethod: t.split_method,
      requestTimeoutMs: t.request_timeout_ms,
    })
  }

  // ───────────────────────────── inbox ─────────────────────────────

  get busyState(): PacerState {
    return {
      // Nothing is taken from the audience while the page, the model or the voice is missing.
      connected: this.stage.hub.connected && this.llmUsable && this.tts.attached,
      speaking: this.director.speaking || this.director.pending > 0,
      // A reply that started and failed between two ticks still counts as "the brain got busy" for the pacer.
      processing: this.brain.processing || this.turnSeen,
      dancing: this.flags.dancing,
      singing: this.flags.singing,
      sleeping: this.flags.sleeping,
      queued: this.brain.queued,
    }
  }

  /** One look at the inbox: expire what is stale, and hand the next batch to the brain when the pacer says so. */
  tickInbox(): void {
    this.router.tick()
    const decision = this.pacer.decide(this.busyState, this.now())
    this.turnSeen = false
    if (decision.action !== 'send') return
    this.runLog.add('inbox', `to the brain: ${decision.text}`, 'untrusted')
    void this.send(decision.text, decision.batch)
  }

  /** The modes may add lines to the prompt of this reply (a dance gift: "you are about to dance"); then the model is asked. */
  private async send(
    text: string,
    batch: Parameters<ModeService['batchExtras']>[0]
  ): Promise<void> {
    let extras: string[] = []
    try {
      extras = await this.modes.batchExtras(batch)
    } catch (e) {
      this.logger('error', `modes: ${(e as Error).message}`)
    }
    const viewers = this.recordBatch(batch)
    // the reply is judged by its least trusted line: what the audience wrote among a moderator's lines makes it an audience reply
    const origin = originOfBatch(batch.parts)
    const staff = staffNote(origin)
    if (staff) extras = [...extras, staff]
    await this.brain
      .respond({
        text,
        source: origin.kind === 'moderator' || origin.kind === 'host' ? origin.kind : 'viewer',
        trust: origin.trust,
        origin,
        ...(extras.length > 0 ? { extras } : {}),
        ...(viewers.length > 0 ? { viewers } : {}),
      })
      .catch((e) => this.logger('error', `brain: ${(e as Error).message}`))
  }

  // ───────────────────────────── tools ─────────────────────────────

  /** A private note for the streamer: a line in the run log and a quiet alarm in the console. Nothing is spoken. */
  private noteToStreamer(text: string, origin: EventSource): void {
    const who = origin.name ? `${origin.kind} ${origin.name}` : origin.kind
    this.runLog.add('tool', `note for you (${who}): ${text}`, origin.trust)
    this.alarms.raise('agent_note', 'info', text, 'note')
  }

  /** The gate decided something: the run log, the trail on disk, and a line for the model's next reply. */
  private onToolAudit(e: ToolAuditEntry): void {
    this.toolAudit.write(e)
    const who = e.origin.name ? `${e.origin.kind} ${e.origin.name}` : e.origin.kind
    const line = `${e.decision} ${e.tool}${e.reason ? ` (${e.reason})` : ''} from ${who}`
    this.runLog.add('tool', line, e.origin.trust)
    const note = toolNote(e)
    if (note) {
      this.toolNotes.push(note)
      if (this.toolNotes.length > 8) this.toolNotes.splice(0, this.toolNotes.length - 8)
    }
  }

  /** The notes for the next reply, once: what became of the tools it asked for since. */
  private takeToolNotes(): string[] {
    if (this.toolNotes.length === 0) return []
    const lines = this.toolNotes
    this.toolNotes = []
    return [
      'What became of the tools you asked for (from the program, not from viewers):\n' +
        lines.map((l) => `- ${l}`).join('\n'),
    ]
  }

  /** Called when a tool call is queued, decided or expires. Returns the unsubscribe. */
  onApprovalsChange(fn: () => void): () => void {
    this.tools.on('change', fn)
    return () => void this.tools.off('change', fn)
  }

  /**
   * Who wrote what is in this batch: for the brain (what is remembered about them) and, when memory is on, for the
   * inbox and for the facts that need no model (someone joined the crew).
   */
  private recordBatch(
    batch: Parameters<ModeService['batchExtras']>[0]
  ): { uid: number; name: string }[] {
    const viewers = new Map<number, string>()
    for (const part of batch.parts) {
      if (part.uid === undefined || part.uid <= 0 || part.uname === undefined) continue
      viewers.set(part.uid, part.uname)
      if (!this.memory) continue
      if (part.kind === 'danmaku' || part.kind === 'sleep') {
        const prefix =
          part.kind === 'sleep'
            ? FORMATS.sleepPrefix + part.uname + '：'
            : FORMATS.danmaku(part.uname, '')
        if (this.config.memory.record_chat && part.text.startsWith(prefix))
          this.memory.record({
            kind: 'chat',
            uid: part.uid,
            name: part.uname,
            text: part.text.slice(prefix.length),
          })
      } else if (part.kind === 'guard') {
        this.memory.noteViewer(
          part.uid,
          part.uname,
          part.text
            .replace(/^【[^】]*】/, '')
            .replace(part.uname, '')
            .trim()
        )
      }
    }
    return [...viewers].map(([uid, name]) => ({ uid, name }))
  }

  private onSourceEvent(e: BilibiliSourceEvent): void {
    switch (e.type) {
      case 'danmaku':
        this.runLog.add(
          'viewer',
          `${e.uname}: ${e.text}`,
          trustFor(e.admin ? 'moderator' : 'viewer')
        )
        this.router.onDanmaku({
          uid: e.uid,
          uname: e.uname,
          msg: e.text,
          dmType: e.dmType,
          admin: e.admin,
          roomOwnerUid: e.roomOwnerUid,
        })
        break
      case 'gift':
        this.runLog.add('viewer', `${e.uname} sent ${e.gift} x${e.num}`, 'untrusted')
        this.router.onGift({
          uid: e.uid,
          uname: e.uname,
          gift: e.gift,
          num: e.num,
          coinType: e.coinType,
          totalCoin: e.totalCoin,
        })
        break
      case 'guard':
        this.runLog.add(
          'viewer',
          `${e.uname} joined the crew (level ${e.level}, ${e.num} months)`,
          'untrusted'
        )
        this.router.onGuard({ uid: e.uid, uname: e.uname, level: e.level, num: e.num })
        break
      case 'superchat':
        this.runLog.add('viewer', `${e.uname} (paid ${e.price}): ${e.text}`, 'untrusted')
        this.router.onSuperChat({ uid: e.uid, uname: e.uname, price: e.price, msg: e.text })
        break
      case 'alarm':
        this.alarms.raise(
          `bilibili_${e.code}`,
          e.code === 'connection_lost' ? 'error' : 'warn',
          e.message,
          'bilibili'
        )
        break
      case 'status':
        this.runLog.add('inbox', `chat source: ${e.state}${e.detail ? ` (${e.detail})` : ''}`)
        if (e.state === 'open') this.alarms.clear('bilibili_connection_lost', 'bilibili')
        break
      case 'enter':
        break
    }
  }

  // ───────────────────────────── what the console reads and does ─────────────────────────────

  private llmOrderIds: string[] = []
  private readonly pluginListeners = new Set<(id: string, status: StatusEvent['status']) => void>()
  private readonly modeListeners = new Set<(mode: ModeView) => void>()
  private consoleServer: { openUrl: string; stop(): Promise<void> } | null = null

  /** The provider ids in the order they are tried right now. */
  llmOrder(): string[] {
    return [...this.llmOrderIds]
  }

  /** Called when a plugin changes state. Returns the unsubscribe. */
  onPluginStatus(fn: (id: string, status: StatusEvent['status']) => void): () => void {
    this.pluginListeners.add(fn)
    return () => void this.pluginListeners.delete(fn)
  }

  /** Called when a mode changes state. Returns the unsubscribe. */
  onModeChange(fn: (mode: ModeView) => void): () => void {
    this.modeListeners.add(fn)
    return () => void this.modeListeners.delete(fn)
  }

  modeViews(): ModeView[] {
    return this.modes.views()
  }

  /** Enter, leave or act on a mode from the console. Entering goes through the mode's own request, so a dance waits for the speech to end. */
  async modeAction(id: string, action: ModeAction, req: ModeRequest): Promise<ModeView> {
    if (action === 'exit') return this.modes.exit(id, 'console')
    if (!this.modes.has(id)) return this.modes.enter(id, req) // says why it cannot be entered
    // what the mode understands of the details (which dance, tuning numbers) is up to its controller
    const r = await this.modes.consoleRequest(id, {
      ...req.params,
      replace: req.replace,
      force: req.force,
    })
    if (!r.ok) throw new AppError('refused', r.reason ?? 'the mode did not start', 409)
    return this.modes.viewOf(id)
  }

  // ───────────────────────────── what a mode may use ─────────────────────────────

  /** True while a reply is being written, queued or spoken. */
  private busyNow(): boolean {
    return (
      this.brain.processing ||
      this.brain.queued > 0 ||
      this.director.speaking ||
      this.director.pending > 0
    )
  }

  /** Resolves when nothing has been busy for a moment (so a gap between two sentences does not count), false on timeout. */
  private async whenQuiet(timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    let quietFor = 0
    while (this.now() < deadline && !this.stopped) {
      quietFor = this.busyNow() ? 0 : quietFor + 1
      if (quietFor >= 3) return true
      await new Promise((r) => setTimeout(r, 150))
    }
    return false
  }

  private makeModeHost(): ModeHost {
    const app = this
    return {
      config: this.config,
      hub: this.stage.hub,
      motions: this.motions,
      secrets: this.secrets,
      flags: this.flags,
      dataDir: this.config.paths.data_dir,
      now: () => this.now(),
      log: (level, msg, extra) => this.logger(level, msg, extra),
      event: (kind, text, trust) => void this.runLog.add(kind, text, trust),
      alarm: (code, level, message, subject) =>
        void this.alarms.raise(code, level, message, subject),
      clearAlarm: (code, subject) => void this.alarms.clear(code, subject),
      stopSpeech: (reason) => {
        this.brain.cancelActive(reason)
        this.director.cancelAll(reason)
      },
      holdSpeech: (reason, on) => this.director.hold(reason, on),
      setVoiceStyle: (style) => this.director.setStyleOverride(style),
      say: (o) => this.sayLine(o),
      whenQuiet: (ms) => this.whenQuiet(ms),
      busy: () => this.busyNow(),
      tellBrain: async (text, opts) => {
        const summary = await this.brain.respond({
          text,
          source: 'system',
          // untrusted unless the mode says the text is the program's own words (see ModeHost.tellBrain)
          trust: opts?.fromProgram === true && !opts.images ? 'privileged' : 'untrusted',
          ...(opts?.extras ? { extras: opts.extras } : {}),
          ...(opts?.images ? { images: opts.images } : {}),
          ...(opts?.preempt ? { preempt: true } : {}),
        })
        return {
          status: summary.status,
          sentences: summary.sentences,
          ...(summary.error ? { error: firstLine(summary.error) } : {}),
        }
      },
      brainBusy: () => this.brain.processing,
      serviceUrl: (service) => app.modes.serviceUrl(service),
      modeState: (id) => app.modes.state(id),
      enterMode: (id, opts) => app.modes.tryEnter(id, opts),
      exitMode: async (id, reason) => void (await app.modes.exit(id, reason)),
      prompt: (modeId, name, vars) => app.modes.prompt(modeId, name, vars),
      libraryDir: (library) => app.libraryDirs[library] ?? null,
      assetUrl: (library, ...parts) => assetUrl(library, ...parts),
      llmText: (req) => app.llmText(req),
      songLine: (text) => this.router.addSongLine(text),
    }
  }

  /** One question to the model, answered as text (see `ModeHost.llmText`). */
  private async llmText(req: LlmTextRequest): Promise<string> {
    const messages: ChatMessage[] = [
      ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
      { role: 'user', content: req.user },
    ]
    let out = ''
    for await (const d of this.currentLlm().stream({
      messages,
      tag: req.tag,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })) {
      if (d.type === 'text') out += d.text
    }
    return out
  }

  /** Re-read the probe's measurements (a new one takes effect within half a minute, without a restart). */
  async reloadMeasurements(): Promise<void> {
    const { measurements, problems } = await loadMeasurements(
      path.join(this.config.paths.data_dir, 'vram-measured.json')
    )
    this.measurements = measurements
    if (problems.length > 0) this.alarms.raise('vram_measurements', 'warn', problems[0] as string)
    else this.alarms.clear('vram_measurements')
  }

  /** A secret was written or deleted: whatever was built from it is rebuilt. */
  async secretsChanged(name: string): Promise<void> {
    const uses = (v: unknown): boolean =>
      typeof v === 'string'
        ? secretRefs(v).includes(name)
        : Array.isArray(v)
          ? v.some(uses)
          : v !== null && typeof v === 'object'
            ? Object.values(v).some(uses)
            : false
    if (uses(this.config.llm.providers)) await this.reloadLlm()
  }

  /** The address to open the console at, token included. Print it once; never log it. */
  get consoleUrl(): string | null {
    return this.consoleServer?.openUrl ?? null
  }

  // ───────────────────────────── console-facing actions ─────────────────────────────

  /** Speak a line straight away, no model: it supersedes what is being said. */
  say(req: SayRequest): void {
    this.sayLine({
      text: req.text,
      emotion: req.emotion,
      ...(req.style ? { style: req.style } : {}),
      ...(req.speed !== undefined ? { speed: req.speed } : {}),
    })
  }

  private sayLine(o: import('../modes/host.ts').SayOptions): void {
    this.brain.cancelActive('say')
    const turn = this.director.beginTurn(`say-${++this.sayCounter}`)
    const emotion: Emotion = o.emotion ?? 'neutral'
    turn.enqueue({
      text: o.text,
      emotion,
      style: o.style ?? emotion,
      ...(o.speed !== undefined ? { speed: o.speed } : {}),
      ...(o.subtitle !== undefined ? { subtitle: o.subtitle } : {}),
      ...(o.motion !== undefined ? { motion: o.motion } : {}),
    })
    turn.end()
    this.runLog.add('speech', `[${emotion}] ${o.text}`, 'privileged')
  }

  private fakeUid = 900_000_000

  /** A fake audience event: it goes through the same router as a real one and is always an untrusted viewer. */
  inject(req: InjectRequest): void {
    const uid = ++this.fakeUid
    const uname = req.name
    this.runLog.add('viewer', `(injected) ${uname}: ${req.text || req.kind}`, 'untrusted')
    switch (req.kind) {
      case 'danmaku':
        this.router.onDanmaku({ uid, uname, msg: req.text || 'hello', dmType: 0 })
        break
      case 'gift':
        this.router.onGift({
          uid,
          uname,
          gift: req.gift ?? 'gift',
          num: req.count,
          coinType: 'gold',
          totalCoin: Math.round((req.price ?? 1) * 1000),
        })
        break
      case 'guard':
        this.router.onGuard({
          uid,
          uname,
          level: Math.min(3, Math.max(1, Number(req.gift) || 3)),
          num: req.count,
        })
        break
      case 'superchat':
        this.router.onSuperChat({ uid, uname, price: req.price ?? 30, msg: req.text || 'hello' })
        break
    }
  }

  /** Cancel what is being said and everything queued. */
  stopSpeech(): void {
    this.brain.cancelActive('console stop')
    this.director.cancelAll('console stop')
  }

  // ───────────────────────────── life cycle ─────────────────────────────

  /** The scene snapshot the stage gets on connect: model, layout, camera, background, lighting. */
  sceneMessage() {
    const s = this.config.stage
    const model = s.model
      ? {
          url: `/asset/models/${s.model.split(/[\\/]/).map(encodeURIComponent).join('/')}`,
          name: s.model.slice(0, 80),
        }
      : null
    const shown = this.composed
    return {
      type: 'scene.set' as const,
      model,
      layout: shown ? shown.layout : { char: s.layout.char, frame: s.layout.frame },
      background: shown ? shown.background : s.background,
      lighting: s.lighting,
      camera: { ...s.camera, adjust: this.cameraAdjust ?? s.camera.adjust },
    }
  }

  // ───────────────────────────── what the active modes do to the stage ─────────────────────────────

  /** The stage as the active modes want it; null while none wants anything, then the configuration applies. */
  private composed: ComposedStage | null = null

  /**
   * Put together the stage for the configuration plus the modes that are active now (layout, background, look),
   * and send it if it differs from what the stage has. Called whenever a mode changes state.
   */
  private refreshModeStage(): void {
    const s = this.config.stage
    const active = this.modes
      .active()
      .filter((id) => this.modes.state(id) === 'ACTIVE')
      .map((id) => this.modes.manifest(id))
      .filter((m) => m !== undefined)
      .sort((a, b) => a.priority - b.priority)
    const stack: ModeStage[] = []
    const seen = new Set<string>()
    for (const m of active) {
      seen.add(m.id)
      const { stage, problems } = resolveModeStage(m, s.presets)
      if (problems.length > 0)
        this.alarms.raise(
          'mode_stage_preset',
          'warn',
          `mode "${m.id}": ${problems.join('; ')}`,
          m.id
        )
      else this.alarms.clear('mode_stage_preset', m.id)
      stack.push(stage)
    }
    for (const id of this.modes.ids()) if (!seen.has(id)) this.alarms.clear('mode_stage_preset', id)
    const next =
      stack.length === 0
        ? null
        : composeStage(
            { layout: { char: s.layout.char, frame: s.layout.frame }, background: s.background },
            stack
          )
    if (JSON.stringify(next) === JSON.stringify(this.composed)) return
    this.composed = next
    this.stage.hub.setScene(this.sceneMessage())
    this.stage.hub.setLook({ type: 'look.set', ...(next?.look ?? {}) })
  }

  // ───────────────────────────── the operator's mouse on the stage ─────────────────────────────

  private cameraAdjust: CameraAdjust | null = null
  private stateTimer: NodeJS.Timeout | null = null

  private get stateFile(): string {
    return path.join(this.config.paths.data_dir, 'stage-state.json')
  }

  /** What the operator did with the mouse survives a restart: it is read back here and sent in every scene snapshot. */
  private async loadStageState(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.stateFile, 'utf8')) as { camera_adjust?: unknown }
      const parsed = CameraAdjust.safeParse(raw.camera_adjust)
      if (parsed.success) this.cameraAdjust = parsed.data
      else if (raw.camera_adjust !== undefined)
        this.logger(
          'warn',
          'stage-state.json holds a camera adjustment that is not valid; ignoring it'
        )
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger('warn', `stage-state.json could not be read: ${firstLine(e)}`)
      }
    }
  }

  private saveStageState(): void {
    if (this.stateTimer) clearTimeout(this.stateTimer)
    this.stateTimer = setTimeout(() => void this.flushStageState(), 300)
    this.stateTimer.unref?.()
  }

  private async flushStageState(): Promise<void> {
    if (this.stateTimer) clearTimeout(this.stateTimer)
    this.stateTimer = null
    try {
      await mkdir(this.config.paths.data_dir, { recursive: true })
      const tmp = `${this.stateFile}.tmp`
      await writeFile(
        tmp,
        JSON.stringify({ camera_adjust: this.cameraAdjust ?? NO_CAMERA_ADJUST }, null, 2),
        'utf8'
      )
      await rename(tmp, this.stateFile)
    } catch (e) {
      this.logger('warn', `stage-state.json could not be written: ${firstLine(e)}`)
    }
  }

  /** The stage reported that the operator moved the camera (or, from the console, the framing is reset). */
  setCameraAdjust(adjust: CameraAdjust): void {
    this.cameraAdjust = adjust
    const deg = (r: number) => Math.round((r * 180) / Math.PI)
    this.runLog.add(
      'stage',
      `camera moved by hand: turn ${deg(adjust.yaw)}°/${deg(adjust.pitch)}°, zoom x${adjust.zoom.toFixed(2)}`
    )
    this.stage.hub.setScene(this.sceneMessage())
    this.saveStageState()
  }

  /** Back to the framing the configuration gives. */
  resetCamera(): void {
    this.setCameraAdjust(NO_CAMERA_ADJUST)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.logger('info', `animatus starting (stage :${this.config.servers.stage_port})`)
    await mkdir(this.libraryDirs.generated as string, { recursive: true }).catch((e) =>
      this.logger('warn', `data/generated could not be made: ${firstLine(e)}`)
    )
    await this.stage.start()
    const hub = this.stage.hub
    await this.loadStageState()
    hub.setScene(this.sceneMessage())
    hub.setLook({ type: 'look.set' })
    const sub = this.config.stage.subtitle
    hub.setOverlay({
      type: 'overlay.set',
      id: 'subtitle',
      visible: sub.enabled,
      variant: sub.style,
      ...(sub.name ? { text: sub.name } : {}),
    })
    if (this.motions) {
      try {
        const scan = await this.motions.refresh(true)
        hub.setLibrary(this.motions.toLibrarySet())
        this.logger(
          'info',
          `motion library: ${scan.talk.length} talk, ${scan.tags.size} tags, ${scan.dances.length} dances`
        )
      } catch (e) {
        this.alarms.raise(
          'motion_library',
          'error',
          `the motion library could not be read: ${(e as Error).message}`
        )
      }
    }
    if (this.ttsOverride) this.tts.attach(this.ttsOverride)
    else if (this.registry.enabledByService('tts', this.config.plugins).length === 0) {
      this.alarms.raise(
        'tts_none',
        'error',
        'no speech plugin is enabled (plugins.gptsovits or plugins.gptsovits-attach): nothing can be spoken'
      )
    }
    await this.reloadLlm()
    await this.gpu.start()
    await this.reloadMeasurements()
    this.measurementTimer = setInterval(() => void this.reloadMeasurements(), 30_000)
    this.measurementTimer.unref?.()
    this.modes.attach()
    await this.memory
      ?.start()
      .catch((e) => this.alarms.raise('memory', 'error', `memory could not start: ${firstLine(e)}`))

    // Services start in the background: a speech server takes a minute to load and must not hold everything up.
    for (const entry of this.registry.enabled(this.config.plugins)) {
      void this.supervisor
        .start(entry.id)
        .catch((e) =>
          this.alarms.raise(
            'plugin_failed',
            'error',
            `${entry.id}: ${(e as Error).message}`,
            entry.id
          )
        )
    }

    const bili = this.config.sources.bilibili
    if (bili?.enabled) {
      const source = this.makeBilibili({
        roomId: bili.room_id,
        getCookies: async () => {
          if (!bili.cookie_secret) return {}
          const raw = await this.secrets.get(bili.cookie_secret)
          return raw ? parseCookieHeader(raw) : {}
        },
        logger: (level, msg, extra) => this.logger(level, `bilibili: ${msg}`, extra),
      })
      source.on('event', (e) => this.onSourceEvent(e))
      this.source = source
      void source
        .start()
        .catch((e) =>
          this.alarms.raise(
            'bilibili_connection_lost',
            'error',
            `the chat source could not start: ${(e as Error).message}`,
            'bilibili'
          )
        )
    }

    this.inboxTimer = setInterval(() => {
      try {
        this.tickInbox()
      } catch (e) {
        this.logger('error', `inbox tick failed: ${(e as Error).message}`)
      }
    }, this.options.inboxTickMs ?? 500)
    this.inboxTimer.unref?.()

    const b = this.config.stage.browser
    if (b && !this.options.noBrowser) {
      try {
        this.browser = launchStageWindow({
          executable: b.executable,
          profileDir: b.profile_dir,
          windowSize: b.window_size,
          ...(b.debug_port !== undefined ? { debugPort: b.debug_port } : {}),
          url: `${this.stage.url}/`,
          logger: this.logger,
        })
      } catch (e) {
        this.alarms.raise(
          'stage_window',
          'error',
          `the stage window could not be opened: ${(e as Error).message}`
        )
      }
    }
    this.logger('info', `stage: ${this.stage.url}/`)
    if (this.options.console) await this.startConsole()
  }

  private async startConsole(): Promise<void> {
    try {
      const { AppBackend } = await import('../console/appBackend.ts')
      const { createConsoleServer } = await import('../console/server.ts')
      const backend = new AppBackend(this)
      const server = createConsoleServer({
        port: this.config.servers.console_port,
        staticDir:
          this.options.consoleDir ?? path.join(this.config.root, 'packages', 'console', 'dist'),
        backend,
        assetOrigin: `http://127.0.0.1:${this.config.servers.stage_port}`,
        logger: this.logger,
      })
      await server.start()
      backend.onEvent((event) => server.publish(event))
      this.consoleServer = server
      this.logger(
        'info',
        `console: ${server.url}/ (the address with its token is printed once, below)`
      )
    } catch (e) {
      this.alarms.raise('console', 'error', `the console could not be started: ${firstLine(e)}`)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.logger('info', 'animatus stopping')
    if (this.inboxTimer) clearInterval(this.inboxTimer)
    this.brain.cancelActive('shutdown')
    if (this.measurementTimer) clearInterval(this.measurementTimer)
    await this.modes.dispose()
    await this.memory?.stop().catch(() => undefined)
    await this.toolAudit.flush()
    this.gpu.stop()
    this.director.dispose()
    for (const d of this.disposers.splice(0)) d()
    if (this.stateTimer) await this.flushStageState()
    await this.consoleServer?.stop().catch(() => undefined)
    await this.source?.stop().catch(() => undefined)
    await this.supervisor
      .stopAll()
      .catch((e) => this.logger('warn', `stopping plugins: ${(e as Error).message}`))
    if (this.browser && this.browser.exitCode === null) this.browser.kill()
    await this.stage.stop().catch(() => undefined)
  }

  // ───────────────────────────── status ─────────────────────────────

  /** A cut-down status for logs and tests; the console builds the full `StatusView` from these parts. */
  summary(): Pick<StatusView, 'api' | 'version' | 'startedAt' | 'now'> & { runEvents: RunEvent[] } {
    return {
      api: 1,
      version: '0.1.0',
      startedAt: this.startedAt,
      now: this.now(),
      runEvents: this.runLog.recent(20),
    }
  }
}

/**
 * The gateway's summary ("all LLM providers failed: primary=bad_request (HTTP 400)") says which provider failed
 * and how; the first provider's own words say why ("Request contains an invalid argument"). Both are scrubbed.
 */
function describeLlmError(e: Error): string {
  const attempts = e instanceof LlmError ? e.attempts : undefined
  const why = attempts?.find((a) => a.detail)?.detail
  return why && !e.message.includes(why) ? `${e.message}. ${why}` : e.message
}

/** First line of an error's message, for log lines that must stay one line. */
const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split(/\r?\n/, 1)[0] ?? ''

/**
 * A note for the system prompt when a reply answers staff only. The model cannot tell a moderator's line from a
 * viewer's in the text (and must not be able to: a marker in the text could be typed by anyone), so the program says it
 * here, from the platform's own flags. It names no one: a name is chosen by a person and does not belong in a system prompt.
 */
function staffNote(origin: EventSource): string | null {
  if (origin.kind === 'moderator')
    return 'The message below comes from a room moderator: staff, not the audience. When they ask for something a tool can do, ask for that tool (the streamer still has to say yes).'
  if (origin.kind === 'host')
    return 'The message below comes from the streamer, in their own chat. When they ask for something a tool can do, ask for that tool (they still have to say yes in the console).'
  return null
}

/**
 * What the model is told next turn about a decision of the tool gate. A refusal says only that it was refused and, for
 * the reasons it can do something about, why: it must not turn into a way to learn how the gate works from the outside.
 */
function toolNote(e: ToolAuditEntry): string | null {
  const name = e.tool
  switch (e.decision) {
    case 'ran':
      return `${name}: done${e.reason ? ` (${e.reason})` : ''}`
    case 'queued':
      return `${name}: waiting for the streamer's yes`
    case 'approved':
      return `${name}: the streamer said yes${e.reason ? ` (${e.reason})` : ''}`
    case 'denied':
      return `${name}: the streamer said no`
    case 'expired':
      return `${name}: nobody answered in time, dropped`
    case 'failed':
      return `${name}: it did not work${e.reason ? ` (${e.reason})` : ''}`
    case 'rejected': {
      const why = (e.reason ?? '').split(':')[0]
      if (why === 'bad_args') return `${name}: the arguments were not valid`
      if (why === 'unknown_tool') return `${name}: there is no such tool`
      if (why === 'rate_limited') return `${name}: too many requests, wait a bit`
      return `${name}: not allowed here`
    }
  }
}

/** The secret store the operator's keys live in: Windows DPAPI first (writable), then config/.env, then the environment. */
export function createSecretStore(
  config: AppConfig,
  plugins: Iterable<RegistryEntry>
): SecretStore {
  const aliases = { ...WELL_KNOWN_SECRETS, ...secretAliasesFrom(plugins) }
  const stores: SecretStore[] = []
  if (process.platform === 'win32')
    stores.push(new DpapiFileSecretStore(path.join(config.paths.data_dir, 'secrets.dpapi.json')))
  stores.push(new EnvFileSecretStore(path.join(config.root, 'config', '.env'), { aliases }))
  stores.push(new EnvVarSecretStore({ aliases }))
  return new CompositeSecretStore(stores)
}

export { parseConfig }
