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
import type { Emotion, RunEvent, SayRequest, InjectRequest, StatusView } from '@animatus/protocol'
import { CameraAdjust, NO_CAMERA_ADJUST, trustFor } from '@animatus/protocol'
import { Brain } from '../brain/brain.ts'
import type { LlmLike } from '../brain/brain.ts'
import { ChatLog } from '../brain/chatlog.ts'
import { parseConfig, toProviderConfig } from '../config.ts'
import type { AppConfig, LlmProviderEntry } from '../config.ts'
import { Blocklist, Pacer, Router, emptyBlocklist } from '../inbox/index.ts'
import type { BlockChecker, PacerState } from '../inbox/index.ts'
import { LlmError, LlmGateway, createLlmProvider } from '../llm/index.ts'
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
import type { TtsAdapter } from '@animatus/protocol'
import { AlarmBoard, RunLog, TraceBoard } from './board.ts'

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
  /** Where the plugin folders are. Default: plugins under the project root. */
  pluginsDir?: string
  /** `welcome.dev` for the stage. */
  dev?: boolean
}

/** Flags the mode manager (dance, sing, sleep) will set; the pacer treats each as "busy". */
export interface ActivityFlags {
  dancing: boolean
  singing: boolean
  sleeping: boolean
}

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
      persona: () => this.personaText,
      motionTags: () => this.motions?.promptTagList() ?? [],
      resolveMotion: (tag) => this.motions?.pick(tag) ?? null,
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

    // ── inbox
    this.router = new Router(config.inbox, parts.blocklist, {
      now: this.now,
      log: (level, msg, extra) => this.logger(level, `inbox: ${msg}`, extra),
      onDrop: (reason, info) =>
        this.logger('debug', `inbox: dropped (${reason})`, { ...info, text: undefined }),
      onSongCommand: (cmd) =>
        this.runLog.add(
          'inbox',
          `song command "${cmd.kind}" ignored: the singing mode is not set up`
        ),
    })
    this.pacer = new Pacer(this.router, config.inbox)

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
    const app = new App(options, { secrets, registry, blocklist, words })
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
    this.brain.on('dance.request', (d) =>
      this.runLog.add('mode', `the model asked for a dance${d.name ? ` (${d.name})` : ''}`)
    )
    this.brain.on('motion.unknown', (m) =>
      this.runLog.add('llm', `motion tag "${m.tag}" names no clip`)
    )
    this.brain.on('error', (e) => {
      this.runLog.add('llm', `reply failed: ${e.message}`)
      this.alarms.raise('llm_failed', 'error', `the model could not answer: ${e.message}`)
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

    // plugins
    const onStatus = (ev: StatusEvent) => this.onPluginStatus(ev)
    this.supervisor.on('status', onStatus)
    this.disposers.push(() => void this.supervisor.off('status', onStatus))
  }

  private onPluginStatus(ev: StatusEvent): void {
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
    void this.brain
      .respond({ text: decision.text, source: 'viewer', trust: 'untrusted' })
      .catch((e) => this.logger('error', `brain: ${(e as Error).message}`))
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

  // ───────────────────────────── console-facing actions ─────────────────────────────

  /** Speak a line straight away, no model: it supersedes what is being said. */
  say(req: SayRequest): void {
    this.brain.cancelActive('say')
    const turn = this.director.beginTurn(`say-${++this.sayCounter}`)
    const emotion: Emotion = req.emotion
    turn.enqueue({
      text: req.text,
      emotion,
      style: req.style ?? emotion,
      ...(req.speed !== undefined ? { speed: req.speed } : {}),
    })
    turn.end()
    this.runLog.add('speech', `[${emotion}] ${req.text}`, 'privileged')
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
    return {
      type: 'scene.set' as const,
      model,
      layout: { char: s.layout.char, frame: s.layout.frame },
      background: s.background,
      lighting: s.lighting,
      camera: { ...s.camera, adjust: this.cameraAdjust ?? s.camera.adjust },
    }
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
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.logger('info', 'animatus stopping')
    if (this.inboxTimer) clearInterval(this.inboxTimer)
    this.brain.cancelActive('shutdown')
    this.director.dispose()
    for (const d of this.disposers.splice(0)) d()
    if (this.stateTimer) await this.flushStageState()
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

/** First line of an error's message, for log lines that must stay one line. */
const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split(/\r?\n/, 1)[0] ?? ''

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
