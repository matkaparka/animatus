/**
 * Plugin contract.
 *
 * A plugin is a service the orchestrator supervises (start, health-check, restart, stop) and calls
 * through a small TypeScript adapter. Plugins never talk to each other; every call goes through the
 * orchestrator, which is also the only holder of secrets and injects exactly the ones a manifest lists.
 *
 * A plugin directory looks like:
 *
 *   plugins/<id>/plugin.yaml     this manifest
 *   plugins/<id>/adapter.ts      optional in-process adapter implementing the interface of its `kind`
 *   plugins/<id>/...             service code, if the plugin ships any
 */
import { z } from 'zod'
import { Id } from './common.ts'

/** What interface the adapter implements. */
export const PluginKind = z.enum([
  'tts',
  'motion',
  'image',
  'singing',
  'game',
  'music-source',
  'search',
  'llm',
  'custom',
])
export type PluginKind = z.infer<typeof PluginKind>

/** Manifest ids and service names: lowercase kebab. */
export const PluginId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/, 'use lowercase letters, digits and dashes')

/**
 * Where the interpreter comes from.
 *  light     the shared light Python group (no torch)
 *  audio     the shared audio Python group (torch)
 *  external  an environment the user installed and points to by config (GPT-SoVITS, Forge Neo, Applio, ...)
 *  node      the orchestrator's own Node
 *  native    any other executable
 */
export const RuntimeEnv = z.enum(['light', 'audio', 'external', 'node', 'native'])
export type RuntimeEnv = z.infer<typeof RuntimeEnv>

const ProcessRuntime = z.object({
  type: z.literal('process'),
  env: RuntimeEnv,
  /**
   * argv. Placeholders: {port}, {plugin_dir}, {data_dir}, {config.<key>}. The first element may be
   * {python} for the interpreter of `env`.
   */
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().optional(),
  port: z.union([z.literal('auto'), z.number().int().min(1024).max(65535)]).default('auto'),
  /** Literal values, or ${secret:name} / ${config:key} references resolved by the orchestrator. */
  env_vars: z.record(z.string(), z.string()).default({}),
  /** Run under the job-object guard so children die with the orchestrator (Windows). */
  guard: z.boolean().default(true),
  stop: z
    .object({
      /** Polite shutdown request tried before the process tree is killed. */
      http: z
        .object({ method: z.enum(['GET', 'POST']).default('POST'), path: z.string() })
        .optional(),
      grace_ms: z.number().int().min(0).max(60000).default(5000),
    })
    .default({ grace_ms: 5000 }),
})

/**
 * A service the user starts and stops themselves; the orchestrator only health-checks it. `url` may use
 * `{config.<key>}` placeholders (checked to be an http(s) URL after they are resolved).
 */
const ExternalRuntime = z.object({ type: z.literal('external'), url: z.string().min(1).max(2048) })

/** No process at all: the adapter is the plugin (for example a chat-platform event source). */
const InprocessRuntime = z.object({ type: z.literal('inprocess') })

export const PluginRuntime = z.discriminatedUnion('type', [
  ProcessRuntime,
  ExternalRuntime,
  InprocessRuntime,
])

export const HealthSpec = z
  .object({
    http: z
      .object({
        path: z.string().default('/health'),
        method: z.enum(['GET', 'HEAD']).default('GET'),
        expect_status: z.number().int().min(100).max(599).default(200),
        /**
         * The JSON body must have this field truthy (`ready` by default, as in ServiceHealth).
         * `null` skips the body check: only the status code counts. Some third-party servers have no
         * health endpoint and can only be probed with a page that answers 200 (for example `/docs`).
         */
        ready_field: z.string().nullable().default('ready'),
      })
      .optional(),
    tcp: z.boolean().default(false),
    start_timeout_ms: z.number().int().min(1000).max(600000).default(60000),
    interval_ms: z.number().int().min(500).max(600000).default(5000),
    timeout_ms: z.number().int().min(100).max(60000).default(2000),
    /** Consecutive failures before the service is declared down. */
    fail_threshold: z.number().int().min(1).max(20).default(3),
  })
  .refine((h) => h.http !== undefined || h.tcp, 'health needs http or tcp')

export const RestartSpec = z.object({
  policy: z.enum(['never', 'on-failure', 'always']).default('on-failure'),
  max_restarts: z.number().int().min(0).max(50).default(3),
  backoff_ms: z.array(z.number().int().min(0)).min(1).default([1000, 5000, 15000]),
})

export const ResourceSpec = z.object({
  gpu: z.boolean().default(false),
  /** Estimate in MiB. null = never measured; admission uses a conservative fallback and the UI says so. */
  vram_mb_est: z.number().min(0).nullable().default(null),
  ram_mb_est: z.number().min(0).nullable().default(null),
  /**
   * Settings (keys of the plugin's config) that change how much VRAM the service needs, such as the
   * image size limit or the checkpoint. A measurement is only valid for the same values of these keys;
   * they are hashed into the measurement's `config_hash`.
   */
  config_keys: z.array(z.string()).default([]),
  note: z.string().optional(),
})

export const SecretRef = z.object({
  /** Name in the orchestrator's secret store. */
  name: Id,
  /** Environment variable the value is injected as. */
  env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  required: z.boolean().default(false),
})

export const PluginManifest = z.object({
  manifest_version: z.literal(1).default(1),
  id: PluginId,
  title: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  version: z.string().max(32).default('0.0.0'),
  kind: PluginKind,
  /**
   * Service name modes refer to in `requires.services` (defaults to id). Several plugins may offer the
   * same service name; at most one may be enabled.
   */
  service: PluginId.optional(),
  /** Capabilities the adapter offers, e.g. `tts.stream`, `tts.reference-audio`. */
  provides: z.array(z.string().max(64)).default([]),
  runtime: PluginRuntime,
  health: HealthSpec,
  restart: RestartSpec.default({
    policy: 'on-failure',
    max_restarts: 3,
    backoff_ms: [1000, 5000, 15000],
  }),
  resources: ResourceSpec.default({
    gpu: false,
    vram_mb_est: null,
    ram_mb_est: null,
    config_keys: [],
  }),
  /** Secrets this plugin may receive. It never sees any other. */
  secrets: z.array(SecretRef).default([]),
  /** JSON-Schema-like description of the plugin's own settings, rendered as a form in the console. */
  config_schema: z.record(z.string(), z.unknown()).optional(),
  /** Adapter module, relative to the plugin directory. */
  adapter: z.string().optional(),
})
export type PluginManifest = z.infer<typeof PluginManifest>

/** The effective service name of a manifest. */
export const serviceName = (m: Pick<PluginManifest, 'id' | 'service'>) => m.service ?? m.id

// ───────────────────────── service HTTP contract ─────────────────────────
//
// Every service the orchestrator supervises answers, on the health path from its manifest:
//   200 + ServiceHealth{ok:true, ready:true}   working
//   200 + ServiceHealth{ok:true, ready:false}  process alive, still loading (not yet usable)
//   503 + ServiceHealth{ok:false, ...}         alive but broken
// and reports failures of real work with a non-2xx status and a ServiceError body. A failed
// synthesis, generation or download must never come back as 200 with empty or silent output.

export const ServiceHealth = z.object({
  ok: z.boolean(),
  ready: z.boolean(),
  service: z.string(),
  version: z.string().optional(),
  /** Self-reported VRAM in MiB, informational; the probe is the source of truth. */
  vram_mb: z.number().optional(),
  /** Effective settings worth showing in the console, e.g. Forge's max long side. */
  config: z.record(z.string(), z.unknown()).optional(),
  detail: z.string().optional(),
})
export type ServiceHealth = z.infer<typeof ServiceHealth>

export const ServiceError = z.object({
  error: z.object({
    code: z.string().max(64),
    message: z.string().max(1000),
    retryable: z.boolean().default(false),
  }),
})
export type ServiceError = z.infer<typeof ServiceError>

// ─────────────────────────── supervision status ───────────────────────────

export const PluginStatus = z.enum([
  'disabled',
  'stopped',
  'starting',
  'ready',
  'unhealthy',
  'stopping',
  'failed',
])
export type PluginStatus = z.infer<typeof PluginStatus>

// ───────────────────────── adapter interfaces (TS) ─────────────────────────
//
// Adapters run inside the orchestrator. These are the shapes the core depends on; each adapter
// module default-exports a factory `(ctx: AdapterContext) => <interface of its kind>`.

export interface AdapterContext {
  /** Base URL of the running service (http://127.0.0.1:<port>), or '' for in-process plugins. */
  baseUrl: string
  /** The plugin's settings as edited in the console. */
  config: Record<string, unknown>
  /** Secret values the manifest asked for, keyed by env name. Never log or return them. */
  secrets: Readonly<Record<string, string>>
  signal: AbortSignal
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void
}

export interface AudioResult {
  /** PCM16 little-endian mono. */
  pcm16: Uint8Array
  sampleRate: number
}

export interface TtsRequest {
  text: string
  /** Voice style key, resolved to a reference audio by the console's emotion map (e.g. neutral, happy, whisper). */
  style: string
  lang?: string
  /** Speaking-rate multiplier, 0.5 to 2 (1 = the voice's normal rate). */
  speed?: number
  /** Post-process pitch shift in semitones (used by whisper). */
  pitchSemitones?: number
  signal?: AbortSignal
}

/** Synthesised speech: PCM16 little-endian mono at `sampleRate`, delivered as it becomes available. */
export interface TtsStream {
  sampleRate: number
  chunks: AsyncIterable<Uint8Array>
}

export interface TtsAdapter {
  /**
   * Resolves once the first audio (or at least its format) is known. Rejects on any failure: an adapter
   * never resolves with silence in place of a failed synthesis. Requests to one backend are serialised by
   * the adapter when the backend can only do one at a time.
   */
  synthesize(req: TtsRequest): Promise<TtsStream>
  /** Voice styles (reference audios) this backend can render. */
  styles(): Promise<string[]>
}

export interface MotionAdapter {
  /** Speech audio in, a .vrma file out. */
  generate(audio: AudioResult, signal?: AbortSignal): Promise<Uint8Array>
}
