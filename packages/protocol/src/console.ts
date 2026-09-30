/**
 * Console API v1: what the console frontend and the orchestrator's console server exchange.
 *
 * The console is the only place anything is configured or approved. It is served on its own port, bound
 * to 127.0.0.1, and every request carries the start-up token; the stage page can never obtain it.
 *
 *   HTTP   Authorization: Bearer <token>            all /api/* routes (JSON)
 *   WS     /api/ws, subprotocol `animatus.console.v1` plus `token.<token>` (browsers cannot set headers)
 *   Both   Origin must be the console's own origin; Host must be 127.0.0.1:<port> or localhost:<port>
 *
 * Secrets are write-only: `PUT /api/secrets/:name` stores one, nothing ever returns a value.
 */
import { z } from 'zod'
import { Emotion, Id } from './common.ts'
import { ModeState } from './mode.ts'
import { PluginStatus, ServiceHealth } from './plugin.ts'

export const CONSOLE_API_VERSION = 1 as const
export const CONSOLE_SUBPROTOCOL = 'animatus.console.v1'
/** The WebSocket endpoint of the console server. */
export const CONSOLE_WS_PATH = '/api/ws'
/** The second subprotocol a browser offers carries the token: `token.<token>`. */
export const CONSOLE_TOKEN_PROTOCOL_PREFIX = 'token.'
/** Largest JSON request body the console server accepts. */
export const CONSOLE_MAX_BODY_BYTES = 64 * 1024
/** How often the server pushes a `status` event to connected consoles. */
export const CONSOLE_STATUS_INTERVAL_MS = 2000

/**
 * The per-launch token. Restricted to characters that are legal in a URL fragment and in an HTTP header
 * token (so it can travel as a WebSocket subprotocol) without any escaping.
 */
export const ConsoleToken = z
  .string()
  .regex(/^[A-Za-z0-9._~-]{8,128}$/, 'token has an invalid shape')

// ───────────────────────────────── views ─────────────────────────────────

export const AlarmLevel = z.enum(['info', 'warn', 'error'])

export const Alarm = z.object({
  id: Id,
  ts: z.number(),
  level: AlarmLevel,
  /** Machine-readable, for example `cookie_invalid`, `mode_start_failed`, `vram_not_released`. */
  code: z.string().max(64),
  message: z.string().max(600),
  /** The plugin, mode or component it concerns. */
  subject: z.string().max(64).optional(),
})
export type Alarm = z.infer<typeof Alarm>

export const PluginView = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  service: z.string(),
  enabled: z.boolean(),
  status: PluginStatus,
  pid: z.number().int().optional(),
  url: z.string().optional(),
  restarts: z.number().int().min(0).default(0),
  startedAt: z.number().optional(),
  lastError: z.string().optional(),
  health: ServiceHealth.optional(),
  gpu: z.boolean().default(false),
  vram_mb_est: z.number().nullable().default(null),
  /** Measured peak for the current settings, when there is one. */
  vram_mb_measured: z.number().nullable().default(null),
})
export type PluginView = z.infer<typeof PluginView>

export const VerdictView = z.object({
  ok: z.boolean(),
  totalMb: z.number(),
  budgetMb: z.number(),
  measured: z.boolean(),
  reasons: z.array(z.string()),
})
export type VerdictView = z.infer<typeof VerdictView>

export const ModeView = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  state: ModeState,
  since: z.number(),
  priority: z.number(),
  preempts: z.boolean().default(false),
  exclusive_with: z.array(z.string()),
  services: z.array(z.string()),
  hotkey: z.string().optional(),
  /** Whether it can be entered now, alone and next to the currently active modes, and why not. */
  admission: VerdictView.optional(),
  /** Modes that cannot run together with this one because of memory, keyed by mode id. */
  pairs: z.record(z.string(), VerdictView).default({}),
})
export type ModeView = z.infer<typeof ModeView>

export const StageView = z.object({
  connected: z.boolean(),
  model: z
    .object({ status: z.string(), url: z.string().optional(), error: z.string().optional() })
    .optional(),
  audio: z
    .object({ state: z.string(), contexts_created: z.number(), contexts_open: z.number() })
    .optional(),
  fps: z.number().optional(),
  underruns_total: z.number().optional(),
  tpose_frames: z.number().optional(),
  lastReportAt: z.number().optional(),
})
export type StageView = z.infer<typeof StageView>

export const LlmProviderView = z.object({
  id: z.string(),
  kind: z.string(),
  requests: z.number().int(),
  successes: z.number().int(),
  failures: z.number().int(),
  lastError: z.object({ code: z.string(), at: z.number() }).optional(),
  cooldownUntil: z.number().optional(),
})
export type LlmProviderView = z.infer<typeof LlmProviderView>

export const SpeechView = z.object({
  speaking: z.boolean(),
  pending: z.number().int(),
  held: z.boolean(),
})
export type SpeechView = z.infer<typeof SpeechView>

export const StatusView = z.object({
  api: z.literal(CONSOLE_API_VERSION),
  version: z.string(),
  startedAt: z.number(),
  now: z.number(),
  stage: StageView,
  speech: SpeechView,
  plugins: z.array(PluginView),
  modes: z.array(ModeView),
  llm: z.object({ providers: z.array(LlmProviderView), order: z.array(z.string()) }),
  vram: z
    .object({
      adapter: z.string(),
      budgetMb: z.number(),
      usedMb: z.number().nullable(),
    })
    .optional(),
  alarms: z.array(Alarm),
})
export type StatusView = z.infer<typeof StatusView>

// ─────────────────────────────── requests ───────────────────────────────

/** "Say this line": straight to speech, no LLM. */
export const SayRequest = z.object({
  text: z.string().min(1).max(500),
  style: z.string().max(32).optional(),
  emotion: Emotion.default('neutral'),
  speed: z.number().min(0.5).max(2).optional(),
})
export type SayRequest = z.infer<typeof SayRequest>

/** Put a fake audience event into the inbox, to test the whole path without a live room. */
export const InjectRequest = z.object({
  kind: z.enum(['danmaku', 'gift', 'guard', 'superchat']).default('danmaku'),
  name: z.string().min(1).max(40).default('tester'),
  text: z.string().max(200).default(''),
  /** gift name, or guard level 1..3, or price in yuan, depending on kind */
  gift: z.string().max(40).optional(),
  count: z.number().int().min(1).max(999).default(1),
  price: z.number().min(0).max(100000).optional(),
})
export type InjectRequest = z.infer<typeof InjectRequest>

export const SecretName = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
export type SecretName = z.infer<typeof SecretName>
export const SecretPut = z.object({ value: z.string().min(1).max(4096) })
export type SecretPut = z.infer<typeof SecretPut>

export const SecretView = z.object({
  name: SecretName,
  set: z.boolean(),
  /** Where the value lives (never the value): `dpapi`, `env-file`, `environment`. */
  source: z.string(),
})
export type SecretView = z.infer<typeof SecretView>

/** Details a mode understands (which dance to play, tuning numbers). A mode ignores what it does not know. */
export const ModeParams = z
  .record(z.string().min(1).max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 16, 'at most 16 parameters')
export type ModeParams = z.infer<typeof ModeParams>

export const ModeRequest = z.object({
  replace: z.boolean().default(false),
  force: z.boolean().default(false),
  params: ModeParams.optional(),
})

export type ModeRequest = z.infer<typeof ModeRequest>

/** `POST /api/plugins/:id/<action>` */
export const PluginAction = z.enum(['start', 'stop', 'restart'])
export type PluginAction = z.infer<typeof PluginAction>

/** `POST /api/modes/:id/<action>`: enter and exit, or `act` (something the running mode understands, for example tuning) */
export const ModeAction = z.enum(['enter', 'exit', 'act'])
export type ModeAction = z.infer<typeof ModeAction>

// ─────────────────────────────── live events ───────────────────────────────

/** One line of the run page's event stream. */
export const RunEvent = z.object({
  ts: z.number(),
  kind: z.enum(['viewer', 'system', 'speech', 'llm', 'tool', 'mode', 'plugin', 'stage', 'inbox']),
  text: z.string().max(400),
  /** For viewer-sourced lines: shown as untrusted. */
  trust: z.enum(['untrusted', 'trusted', 'privileged']).optional(),
})
export type RunEvent = z.infer<typeof RunEvent>

export const SpeechTraceView = z.object({
  id: z.string(),
  turn: z.string(),
  text: z.string(),
  audioSec: z.number().optional(),
  /** Milliseconds from enqueue to each step. */
  synthMs: z.number().optional(),
  sendMs: z.number().optional(),
  startMs: z.number().optional(),
  liveMotion: z.enum(['used', 'late', 'failed', 'skipped']).optional(),
})
export type SpeechTraceView = z.infer<typeof SpeechTraceView>

export const ConsoleEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), api: z.literal(CONSOLE_API_VERSION), now: z.number() }),
  z.object({ type: z.literal('status'), status: StatusView }),
  z.object({ type: z.literal('run'), event: RunEvent }),
  z.object({ type: z.literal('trace'), trace: SpeechTraceView }),
  z.object({ type: z.literal('alarm'), alarm: Alarm }),
  z.object({ type: z.literal('plugin'), plugin: PluginView }),
  z.object({ type: z.literal('mode'), mode: ModeView }),
])
export type ConsoleEvent = z.infer<typeof ConsoleEvent>

/** The error body of every failing /api route. */
export const ApiError = z.object({
  error: z.object({ code: z.string().max(64), message: z.string().max(600) }),
})
export type ApiError = z.infer<typeof ApiError>

// ─────────────────────────────── responses ───────────────────────────────
//
// Single resources come back as themselves (`StatusView`, `PluginView`, `ModeView`, `SecretView`).
// Lists are wrapped in an object, never a bare array, so a field can be added later without breaking a
// client. `GET /api/plugins/:id/logs` is the one text response (`text/plain`, one line per log line).
// The server validates every body with these schemas before it sends it.

/** The answer of routes that only do something: say, inject, stop. */
export const OkResponse = z.object({ ok: z.literal(true) })
export type OkResponse = z.infer<typeof OkResponse>

export const PluginsResponse = z.object({ plugins: z.array(PluginView) })
export const ModesResponse = z.object({ modes: z.array(ModeView) })
export const SecretsResponse = z.object({ secrets: z.array(SecretView) })
/** Oldest first. */
export const EventsResponse = z.object({ events: z.array(RunEvent) })
/** Oldest first. A trace is updated in place as its sentence progresses; the `id` stays the same. */
export const TracesResponse = z.object({ traces: z.array(SpeechTraceView) })
/** The sanitised configuration. Nothing in it may be a secret value. */
export const ConfigResponse = z.object({ config: z.record(z.string(), z.unknown()) })
