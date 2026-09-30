/**
 * What the console server needs from the orchestrator, and nothing else.
 *
 * The server owns transport and security: the token, Host and Origin checks, request validation, rate
 * limiting, WebSocket fan-out. A `ConsoleBackend` owns what the routes actually do. It is written against
 * the real modules (plugin supervisor, mode manager, secret store, speech director, inbox) and takes and
 * returns only the contract types from `@animatus/protocol`, so this file never imports orchestrator
 * internals.
 *
 * Rules for implementations:
 *  - Refuse with `ApiFailure(code, message, httpStatus)`. Any other error becomes a generic 500 and is
 *    logged; its message never reaches the client.
 *  - Secrets are write-only. `putSecret` receives a value and must never return, log or throw it.
 *  - Text put into `ApiFailure` messages reaches the browser: no paths, no stack traces, no values.
 *  - Push live events (run lines, traces, alarms, plugin and mode changes) with `server.publish()`.
 */
import type {
  InjectRequest,
  ModeAction,
  ModeRequest,
  ModeView,
  PluginAction,
  PluginView,
  RunEvent,
  SayRequest,
  SecretView,
  SpeechTraceView,
  StatusView,
} from '@animatus/protocol'

export type Awaitable<T> = T | Promise<T>

export type ConsoleLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Same shape as the stage server's logger, so either can be passed. `extra` never carries secrets. */
export type ConsoleLogger = (
  level: ConsoleLogLevel,
  msg: string,
  extra?: Record<string, unknown>
) => void

export const noopConsoleLogger: ConsoleLogger = () => {}

/**
 * A refusal the client should see: `code` is machine-readable (at most 64 characters), `message` is human
 * text (at most 600), `httpStatus` is 400..599. The server clamps all three, so a careless value cannot
 * produce a body the client fails to parse.
 */
export class ApiFailure extends Error {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, message: string, httpStatus = 400) {
    super(message)
    this.name = 'ApiFailure'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export interface ConsoleBackend {
  /** `GET /api/status`, and the payload of the `status` event pushed every two seconds. */
  status(): Awaitable<StatusView>

  /** `GET /api/plugins` */
  listPlugins(): Awaitable<PluginView[]>
  /** `POST /api/plugins/:id/{start|stop|restart}`. Resolves with the plugin as it is afterwards. */
  pluginAction(id: string, action: PluginAction): Awaitable<PluginView>
  /** `GET /api/plugins/:id/logs?lines=N`. Newest last. Must already be redacted. */
  pluginLogs(id: string, lines: number): Awaitable<string[]>

  /** `GET /api/modes` */
  listModes(): Awaitable<ModeView[]>
  /** `POST /api/modes/:id/{enter|exit}`. Resolves with the mode as it is afterwards. */
  modeAction(id: string, action: ModeAction, req: ModeRequest): Awaitable<ModeView>

  /** `GET /api/secrets`: names, whether each is set, where it lives. Never values. */
  listSecrets(): Awaitable<SecretView[]>
  /** `PUT /api/secrets/:name`. `value` is write-only: store it, never echo it. */
  putSecret(name: string, value: string): Awaitable<SecretView>
  /** `DELETE /api/secrets/:name`. Resolves with the state afterwards (a variable in the environment may still set it). */
  deleteSecret(name: string): Awaitable<SecretView>

  /** `POST /api/say`: straight to speech, no LLM. */
  say(req: SayRequest): Awaitable<void>
  /** `POST /api/inject`: a fake audience event. Always enters as an untrusted viewer event, never privileged. */
  inject(req: InjectRequest): Awaitable<void>
  /** `POST /api/stop`: cancel what is being said and everything queued. */
  stopSpeech(): Awaitable<void>

  /** `GET /api/events?limit=N`, oldest first. */
  recentEvents(limit: number): Awaitable<RunEvent[]>
  /** `GET /api/traces?limit=N`, oldest first. */
  recentTraces(limit: number): Awaitable<SpeechTraceView[]>

  /** `GET /api/config`: the sanitised configuration. The server masks values under key names that look like secrets, as a second line of defence. */
  config(): Awaitable<Record<string, unknown>>
}
