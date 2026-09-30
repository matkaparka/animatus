/**
 * The orchestrator's configuration file (`config/animatus.config.yaml`).
 *
 * The file describes where the operator's own files live, which services run and how the model
 * providers are ordered. It never holds a secret: keys are written as `${secret:name}` and resolved
 * from the secret store when something needs them. The parsed (unresolved) form is what the console
 * shows, so nothing in `AppConfig` is a secret.
 *
 * Relative paths are relative to the project root (the directory that holds `config/`).
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import {
  Background,
  CameraConfig,
  CharLayout,
  Id,
  LayoutOverride,
  LookOverride,
  PluginId,
  PresetName,
  Rect,
  SubtitleVariant,
} from '@animatus/protocol'
import { InboxConfigSchema } from './inbox/types.ts'
import type { InboxConfig } from './inbox/types.ts'
import type { LlmProviderConfig } from './llm/index.ts'
import type { SecretStore } from './plugins/secrets.ts'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const Port = z.number().int().min(1024).max(65535)
const Ms = z.number().int().min(0).max(3_600_000)

// ─────────────────────────────── model providers ───────────────────────────────

const ProviderCommon = {
  id: Id,
  model: z.string().min(1),
  /** Usually `${secret:name}`. */
  api_key: z.string().min(1),
  proxy: z.string().optional(),
  proxy_tunnel: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeout_ms: Ms.optional(),
  idle_timeout_ms: Ms.optional(),
  connect_timeout_ms: Ms.optional(),
}

const GeminiProvider = z.strictObject({
  kind: z.literal('gemini'),
  ...ProviderCommon,
  base_url: z.string().optional(),
  /** Gemini 2.5: 0 turns thinking off. The Gemini 3 family rejects it: use `thinking_level` there. */
  thinking_budget: z.number().int().min(0).optional(),
  /** Gemini 3 family: how much the model thinks before answering; `minimal` is fastest. */
  thinking_level: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  include_thoughts: z.boolean().optional(),
  safety_off: z.boolean().optional(),
  generation_config: z.record(z.string(), z.unknown()).optional(),
})

const OpenAiProvider = z.strictObject({
  kind: z.literal('openai-compatible'),
  ...ProviderCommon,
  /** A local server needs no key. */
  api_key: z.string().min(1).optional(),
  base_url: z.string().min(1),
  extra_body: z.record(z.string(), z.unknown()).optional(),
  include_usage: z.boolean().optional(),
  max_tokens_field: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  merge_consecutive_roles: z.boolean().optional(),
})

export const LlmProviderEntry = z.discriminatedUnion('kind', [GeminiProvider, OpenAiProvider])
export type LlmProviderEntry = z.infer<typeof LlmProviderEntry>

const Llm = z.strictObject({
  providers: z.array(LlmProviderEntry).default([]),
  /** Provider ids in the order they are tried; defaults to the order of `providers`. */
  order: z.array(Id).optional(),
  cooldown_ms: z
    .strictObject({
      quota: Ms.optional(),
      rate_limit: Ms.optional(),
      unavailable: Ms.optional(),
      timeout: Ms.optional(),
      auth: Ms.optional(),
    })
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_output_tokens: z.number().int().min(16).max(65536).optional(),
  /** How many of the latest chat entries go into a request. */
  history_messages: z.number().int().min(0).max(100).default(10),
  /** Time budget of one provider attempt. */
  timeout_ms: Ms.optional(),
})

// ─────────────────────────────────── the rest ───────────────────────────────────

const Paths = z.strictObject({
  data_dir: z.string().min(1).default('./data'),
  models: z.string().min(1).optional(),
  motions: z.string().min(1).optional(),
  songs: z.string().min(1).optional(),
  asmr: z.string().min(1).optional(),
  /** Folder with the wLipSync `profile.json` (served as `/asset/lipsync/profile.json`). */
  lipsync: z.string().min(1).optional(),
})

const Browser = z.strictObject({
  executable: z.string().min(1),
  /** Keep "animatus-stage" in the path: the VRAM probe finds the stage's processes by it. */
  profile_dir: z.string().min(1).default('./data/animatus-stage-profile'),
  window_size: z
    .tuple([z.number().int().min(320), z.number().int().min(240)])
    .default([1920, 1080]),
  /** Chrome DevTools port on 127.0.0.1, for automated checks. Leave out in normal use. */
  debug_port: Port.optional(),
})

const Stage = z.strictObject({
  /** File name inside `paths.models`; null shows an empty stage. */
  model: z.string().min(1).nullable().default(null),
  background: Background.default({ kind: 'none' }),
  lighting: z.strictObject({ intensity: z.number().min(0).max(4).default(1) }).prefault({}),
  camera: CameraConfig.prefault({ fit: 'upper_body' }),
  /** The words of what is being said, shown on the stage while each sentence is spoken. */
  subtitle: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** A name badge above the words; leave out for none. */
      name: z.string().min(1).max(40).nullable().default(null),
      style: SubtitleVariant.default('bubble'),
    })
    .prefault({}),
  layout: z
    .strictObject({
      char: CharLayout.prefault({ x: 0, y: 0, scale: 1 }),
      frame: Rect.nullable().default(null),
    })
    .prefault({}),
  /**
   * Named looks of the stage that a mode pack can ask for by name (`stage: { look: sleep }` in its manifest):
   * where the character stands, what is behind, how calm it is. A mode pack that carries the values itself
   * does not need these.
   */
  presets: z
    .strictObject({
      layouts: z.record(PresetName, LayoutOverride).default({}),
      backgrounds: z.record(PresetName, Background).default({}),
      looks: z.record(PresetName, LookOverride).default({}),
    })
    .prefault({}),
  /** When set, the orchestrator opens the stage in a capture window itself. */
  browser: Browser.nullable().default(null),
})

const TtsStyle = z.strictObject({
  /** Path the speech server can open (same machine). */
  ref_audio: z.string().min(1),
  /** Transcript of the reference audio. */
  ref_text: z.string().min(1),
  speed: z.number().min(0.5).max(2).optional(),
})

const Tts = z.strictObject({
  /** Emotion (or `whisper` for sleep mode) to reference audio. */
  styles: z.record(z.string(), TtsStyle).default({}),
  default_style: z.string().default('neutral'),
  text_lang: z.string().default('zh'),
  prompt_lang: z.string().default('zh'),
  split_method: z.string().default('cut5'),
  /** One sentence should take seconds; a server that needs longer than this is stuck. */
  request_timeout_ms: Ms.default(45_000),
})

const Speech = z.strictObject({
  sensitive_words_file: z.string().min(1).optional(),
  /** Sentences synthesised ahead of playback. */
  lookahead: z.number().int().min(0).max(8).default(2),
  /** Sentences allowed at the stage (sent, not yet ended) at once. */
  stage_queue_max: z.number().int().min(1).max(8).default(2),
  /** Characters before a comma may end the first sentence of a reply (the legacy value for this voice engine). */
  first_comma_min_chars: z.number().int().min(2).max(40).default(10),
})

const PluginEntry = z.strictObject({
  enabled: z.boolean().default(false),
  config: z.record(z.string(), z.unknown()).default({}),
})

/** A mode is off until the operator switches it on; `config` holds that mode's own settings (its code validates them). */
const ModeEntry = z.strictObject({
  enabled: z.boolean().default(false),
  config: z.record(z.string(), z.unknown()).default({}),
})

/**
 * What the character remembers between streams: viewers, the stream, the world, in Markdown files the streamer can edit.
 * Off by default because it keeps what viewers say about themselves.
 */
const Memory = z.strictObject({
  enabled: z.boolean().default(false),
  /** The folder; default `<data_dir>/memory`. */
  dir: z.string().min(1).optional(),
  /** Put the chat messages that reach the model in the inbox, for the consolidation pass to read. */
  record_chat: z.boolean().default(true),
  recall: z
    .strictObject({
      max_lines: z.number().int().min(1).max(30).default(8),
      max_chars: z.number().int().min(100).max(4000).default(900),
      per_speaker: z.number().int().min(1).max(20).default(5),
      search_cache_days: z.number().int().min(1).max(365).default(7),
    })
    .prefault({}),
  consolidate: z
    .strictObject({
      /** Run the pass by itself every this many hours; 0 means only when the console asks. */
      every_hours: z.number().min(0).max(168).default(0),
      max_viewers: z.number().int().min(1).max(200).default(30),
      min_messages: z.number().int().min(1).max(50).default(2),
      max_facts: z.number().int().min(1).max(20).default(5),
      stream_notes: z.boolean().default(true),
    })
    .prefault({}),
})

/** Graphics memory the modes are admitted against. */
const Vram = z.strictObject({
  /** Dedicated memory of the card in MiB; leave out to read it from nvidia-smi. */
  budget_mb: z.number().int().min(1024).max(1_000_000).optional(),
  /** Kept free for the driver, the desktop and spikes. */
  margin_mb: z.number().int().min(0).max(65536).default(512),
  /** Services that are always running and count against the budget all the time. */
  resident: z.array(PluginId).default(['tts']),
})

const Bilibili = z.strictObject({
  enabled: z.boolean().default(false),
  room_id: z.number().int().min(1),
  /** Secret holding the browser cookie of a logged-in account (real names, medal, etc.). Optional. */
  cookie_secret: Id.optional(),
  blocklist_file: z.string().min(1).optional(),
})

const Console = z.strictObject({
  /** Print the console URL with its start-up token, and open it in the default browser. */
  open_browser: z.boolean().default(false),
})

/** The keys of the `inbox` section are written in snake_case in the file, like the rest. */
const InboxSection = z.record(z.string(), z.unknown()).default({})

export const AppConfigSchema = z.strictObject({
  version: z.literal(1).default(1),
  servers: z
    .strictObject({ stage_port: Port.default(5810), console_port: Port.default(5811) })
    .prefault({})
    .refine((s) => s.stage_port !== s.console_port, 'stage_port and console_port must differ'),
  paths: Paths.prefault({}),
  stage: Stage.prefault({}),
  /** Folder that holds `persona.md`. */
  persona: z.string().min(1).default('./personas/example'),
  llm: Llm.prefault({}),
  tts: Tts.prefault({}),
  speech: Speech.prefault({}),
  inbox: InboxSection,
  sources: z.strictObject({ bilibili: Bilibili.optional() }).prefault({}),
  plugins: z.record(PluginId, PluginEntry).default({}),
  modes: z.record(PluginId, ModeEntry).default({}),
  vram: Vram.prefault({}),
  memory: Memory.prefault({}),
  console: Console.prefault({}),
})
export type AppConfigInput = z.input<typeof AppConfigSchema>

/** Everything a running orchestrator needs to know, with defaults filled in and paths made absolute. */
export interface AppConfig extends Omit<z.output<typeof AppConfigSchema>, 'inbox'> {
  /** Absolute project root the relative paths were resolved against. */
  root: string
  /** Absolute path of the file this was read from, or '' when built in memory. */
  file: string
  inbox: InboxConfig
}

// ─────────────────────────────── loading ───────────────────────────────

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())

/** `idle_settle_sec` to `idleSettleSec`, recursively. Only used for the inbox section, whose keys are all ours. */
export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [camel(k), camelizeKeys(v)]))
  }
  return value
}

function formatIssues(err: z.ZodError, file: string): string {
  const lines = err.issues.map(
    (i) => `  ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`
  )
  return `invalid configuration${file ? ` in ${file}` : ''}:\n${lines.join('\n')}`
}

const absolute = (root: string, p: string) => path.resolve(root, p)

/** Validate a parsed object (from YAML, or built in a test) and resolve its paths against `root`. */
export function parseConfig(raw: unknown, opts: { root: string; file?: string }): AppConfig {
  const root = path.resolve(opts.root)
  const file = opts.file ?? ''
  const parsed = AppConfigSchema.safeParse(raw ?? {})
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error, file))
  const c = parsed.data

  const inbox = InboxConfigSchema.safeParse(camelizeKeys(c.inbox))
  if (!inbox.success) {
    throw new ConfigError(
      formatIssues(inbox.error, file).replace(
        'invalid configuration',
        'invalid inbox configuration'
      )
    )
  }

  const known = new Set(c.llm.providers.map((p) => p.id))
  if (known.size !== c.llm.providers.length)
    throw new ConfigError('llm.providers: provider ids must be unique')
  for (const id of c.llm.order ?? []) {
    if (!known.has(id)) throw new ConfigError(`llm.order: no provider with id "${id}"`)
  }
  if (Object.keys(c.tts.styles).length > 0 && !c.tts.styles[c.tts.default_style]) {
    throw new ConfigError(`tts.default_style: "${c.tts.default_style}" is not one of tts.styles`)
  }

  const pathOf = (p: string | undefined) => (p === undefined ? undefined : absolute(root, p))
  return {
    ...c,
    root,
    file,
    inbox: inbox.data,
    paths: {
      data_dir: absolute(root, c.paths.data_dir),
      ...(c.paths.models !== undefined && { models: pathOf(c.paths.models) }),
      ...(c.paths.motions !== undefined && { motions: pathOf(c.paths.motions) }),
      ...(c.paths.songs !== undefined && { songs: pathOf(c.paths.songs) }),
      ...(c.paths.asmr !== undefined && { asmr: pathOf(c.paths.asmr) }),
      ...(c.paths.lipsync !== undefined && { lipsync: pathOf(c.paths.lipsync) }),
    },
    persona: absolute(root, c.persona),
    speech: {
      ...c.speech,
      ...(c.speech.sensitive_words_file !== undefined && {
        sensitive_words_file: absolute(root, c.speech.sensitive_words_file),
      }),
    },
    stage: {
      ...c.stage,
      browser: c.stage.browser && {
        ...c.stage.browser,
        profile_dir: absolute(root, c.stage.browser.profile_dir),
      },
    },
    sources: {
      ...(c.sources.bilibili && {
        bilibili: {
          ...c.sources.bilibili,
          ...(c.sources.bilibili.blocklist_file !== undefined && {
            blocklist_file: absolute(root, c.sources.bilibili.blocklist_file),
          }),
        },
      }),
    },
  } as AppConfig
}

/** Read and validate a configuration file. A missing file is an error that says where it looked. */
export async function loadConfig(file: string, opts: { root?: string } = {}): Promise<AppConfig> {
  const abs = path.resolve(file)
  let text: string
  try {
    text = await readFile(abs, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        `configuration file not found: ${abs}\nCopy config.example/ to config/ and edit config/animatus.config.yaml.`
      )
    }
    throw e
  }
  let raw: unknown
  try {
    raw = YAML.parse(text.replace(/^\u{FEFF}/u, ''))
  } catch (e) {
    throw new ConfigError(`${abs} is not valid YAML: ${(e as Error).message.split('\n')[0]}`)
  }
  return parseConfig(raw, { root: opts.root ?? path.resolve(path.dirname(abs), '..'), file: abs })
}

// ─────────────────────────────── secrets ───────────────────────────────

const REF = /\$\{secret:([A-Za-z0-9._:@-]{1,96})\}/g

/** Names of the secrets a string refers to. */
export function secretRefs(s: string): string[] {
  return [...s.matchAll(REF)].map((m) => m[1] as string)
}

/**
 * Replace `${secret:name}` in a string with the stored value. A missing secret is an error that names the
 * secret, never a value. The result is a secret itself: keep it in memory, out of logs and out of the config.
 */
export async function resolveSecrets(s: string, store: SecretStore): Promise<string> {
  const names = [...new Set(secretRefs(s))]
  if (names.length === 0) return s
  const values = new Map<string, string>()
  for (const name of names) {
    const v = await store.get(name)
    if (v === undefined)
      throw new ConfigError(
        `secret "${name}" is not set (add it in the console's key page or config/.env)`
      )
    values.set(name, v)
  }
  return s.replace(REF, (_, name: string) => values.get(name) as string)
}

/** A provider entry as `createLlmProvider` wants it, with its key resolved. */
export async function toProviderConfig(
  entry: LlmProviderEntry,
  store: SecretStore
): Promise<LlmProviderConfig> {
  const apiKey =
    entry.api_key === undefined ? undefined : await resolveSecrets(entry.api_key, store)
  const common = {
    id: entry.id,
    model: entry.model,
    ...(entry.proxy !== undefined && { proxy: entry.proxy }),
    ...(entry.proxy_tunnel !== undefined && { proxyTunnel: entry.proxy_tunnel }),
    ...(entry.temperature !== undefined && { temperature: entry.temperature }),
    ...(entry.timeout_ms !== undefined && { timeoutMs: entry.timeout_ms }),
    ...(entry.idle_timeout_ms !== undefined && { idleTimeoutMs: entry.idle_timeout_ms }),
    ...(entry.connect_timeout_ms !== undefined && { connectTimeoutMs: entry.connect_timeout_ms }),
  }
  if (entry.kind === 'gemini') {
    return {
      kind: 'gemini',
      ...common,
      apiKey: apiKey as string,
      ...(entry.base_url !== undefined && { baseUrl: entry.base_url }),
      ...(entry.thinking_budget !== undefined && { thinkingBudget: entry.thinking_budget }),
      ...(entry.thinking_level !== undefined && { thinkingLevel: entry.thinking_level }),
      ...(entry.include_thoughts !== undefined && { includeThoughts: entry.include_thoughts }),
      ...(entry.safety_off !== undefined && { safetyOff: entry.safety_off }),
      ...(entry.generation_config !== undefined && { generationConfig: entry.generation_config }),
    }
  }
  return {
    kind: 'openai-compatible',
    ...common,
    baseUrl: entry.base_url,
    ...(apiKey !== undefined && { apiKey }),
    ...(entry.extra_body !== undefined && { extraBody: entry.extra_body }),
    ...(entry.include_usage !== undefined && { includeUsage: entry.include_usage }),
    ...(entry.max_tokens_field !== undefined && { maxTokensField: entry.max_tokens_field }),
    ...(entry.merge_consecutive_roles !== undefined && {
      mergeConsecutiveRoles: entry.merge_consecutive_roles,
    }),
  }
}

/** The configuration as the console may show it: the parsed form, in which secrets are only `${secret:x}` references. */
export function publicConfig(c: AppConfig): Record<string, unknown> {
  const { root: _root, file: _file, ...rest } = c
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
}
