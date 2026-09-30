/**
 * Google Gemini over REST, streaming (`streamGenerateContent?alt=sse`).
 *
 * The API key travels only in the `x-goog-api-key` header, never in a URL. Error classification:
 *
 * | Response                                                          | Code          |
 * |-------------------------------------------------------------------|---------------|
 * | HTTP 429, or `RESOURCE_EXHAUSTED` anywhere in the body            | `quota`       |
 * |   ...when every violated quota is a per-minute one                | `rate_limit`  |
 * | HTTP 401 / 403, `API_KEY_INVALID` (Google answers 400 for those)  | `auth`        |
 * | HTTP 400 `FAILED_PRECONDITION` (region not supported, billing)    | `unavailable` |
 * | other 4xx (400, 404, 413, ...)                                    | `bad_request` |
 * | HTTP 408                                                          | `timeout`     |
 * | HTTP 5xx, network failure, connection dropped                     | `unavailable` |
 * | `promptFeedback.blockReason` / `finishReason: SAFETY`, no text    | `bad_request` |
 * | no text for any other reason, malformed event                     | `protocol`    |
 */
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  LlmConfigError,
  Transport,
  excerpt,
  parseDurationText,
  parseHttpUrl,
  parseJson,
  parseRetryAfter,
  requirePositive,
} from './http.ts'
import type { ClassifiedError, HttpErrorInfo } from './http.ts'
import { hasImage, normalizeMessages } from './messages.ts'
import { Redactor, secretsFromUrl } from './redact.ts'
import type { SseEvent } from './sse.ts'
import { LlmError } from './types.ts'
import type { LlmDelta, LlmErrorCode, LlmProvider, LlmRequest } from './types.ts'

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'

export interface GeminiConfig {
  id: string
  /** The resolved key value. Kept private, sent only as a header, scrubbed from every message. */
  apiKey: string
  model: string
  /** Origin of the API (default the public endpoint); a trailing `/v1beta` or `/v1` is ignored. */
  baseUrl?: string
  /** `http://127.0.0.1:7897`; empty or missing means direct. Used for this provider only. */
  proxy?: string
  /** Force a CONNECT tunnel through the proxy even for an `http:` base URL. */
  proxyTunnel?: boolean
  /** Default sampling temperature; a request's own value wins. */
  temperature?: number
  /** `generationConfig.thinkingConfig.thinkingBudget`. `0` turns thinking off (lower latency). */
  thinkingBudget?: number
  /** Ask for thought summaries; they become `thinking` deltas. Ignored when `thinkingBudget` is 0. */
  includeThoughts?: boolean
  /** Send `BLOCK_NONE` for the four adjustable harm categories. */
  safetyOff?: boolean
  /** Merged into `generationConfig` before the fields above (escape hatch for new API fields). */
  generationConfig?: Record<string, unknown>
  /** Total budget per attempt when the request has none (default 30 000). */
  timeoutMs?: number
  /** No bytes for this long ends the attempt (default 15 000). */
  idleTimeoutMs?: number
  /** TCP/TLS connect limit (default 10 000). */
  connectTimeoutMs?: number
}

const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
] as const

/** Finish reasons that mean "the content policy stopped this", not "something broke". */
const BLOCKED_FINISH = new Set([
  'SAFETY',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'RECITATION',
])

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

// ───────────────────────────── error classification ─────────────────────────────

/** The `error` object of a Gemini error body (`{error}` or `[{error}]`), if there is one. */
function errorObject(parsed: unknown): Rec | undefined {
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  return isRec(first) && isRec(first.error) ? first.error : undefined
}

function detailsOf(err: Rec | undefined, typeSuffix: string): Rec[] {
  const details = err?.details
  if (!Array.isArray(details)) return []
  return details.filter(
    (d): d is Rec => isRec(d) && typeof d['@type'] === 'string' && d['@type'].endsWith(typeSuffix)
  )
}

/** True when the violated quotas are all per-minute limits (a short wait fixes them). */
function onlyPerMinuteQuota(err: Rec | undefined): boolean {
  const ids: string[] = []
  for (const detail of detailsOf(err, 'QuotaFailure')) {
    const violations = Array.isArray(detail.violations) ? detail.violations : []
    for (const v of violations) {
      if (!isRec(v)) continue
      for (const key of ['quotaId', 'quotaMetric']) if (typeof v[key] === 'string') ids.push(v[key])
    }
  }
  return ids.some((id) => /PerMinute/i.test(id)) && !ids.some((id) => /PerDay|Daily/i.test(id))
}

function retryDelayOf(err: Rec | undefined, message: string | undefined): number | undefined {
  for (const detail of detailsOf(err, 'RetryInfo')) {
    const ms = parseDurationText(detail.retryDelay)
    if (ms !== undefined) return ms
  }
  const m = message ? /retry in (\d+(?:\.\d+)?)s/i.exec(message) : null
  return m ? Math.round(Number(m[1]) * 1000) : undefined
}

export function classifyGeminiHttp(info: HttpErrorInfo): ClassifiedError {
  const err = errorObject(parseJson(info.bodyText))
  const apiStatus = typeof err?.status === 'string' ? err.status : undefined
  const apiMessage = typeof err?.message === 'string' ? err.message : undefined
  const text = info.bodyText
  const detail = excerpt(apiMessage ?? text) || 'no error body'
  const label = `HTTP ${info.status}${apiStatus ? ` ${apiStatus}` : ''}`
  const retryAfterMs =
    parseRetryAfter(info.headers.get('retry-after')) ?? retryDelayOf(err, apiMessage)
  const result = (code: LlmErrorCode, message: string): ClassifiedError => ({
    code,
    message,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })

  if (
    info.status === 429 ||
    apiStatus === 'RESOURCE_EXHAUSTED' ||
    /RESOURCE_EXHAUSTED/.test(text)
  ) {
    return result(onlyPerMinuteQuota(err) ? 'rate_limit' : 'quota', `Gemini ${label}: ${detail}`)
  }
  if (
    info.status === 401 ||
    info.status === 403 ||
    /API_KEY_INVALID|API_KEY_EXPIRED|API key (?:not valid|expired)/i.test(text)
  ) {
    return result('auth', `Gemini rejected the API key or its permissions (${label}): ${detail}`)
  }
  if (
    info.status === 400 &&
    (apiStatus === 'FAILED_PRECONDITION' || /FAILED_PRECONDITION/.test(text))
  ) {
    return result(
      'unavailable',
      `Gemini cannot serve this client (${label}; region or billing? check the proxy): ${detail}`
    )
  }
  if (info.status === 408) return result('timeout', `Gemini ${label}: ${detail}`)
  if (info.status >= 500) return result('unavailable', `Gemini ${label}: ${detail}`)
  if (info.status >= 300 && info.status < 400) {
    return result('bad_request', `Gemini answered with a redirect (${label}); check baseUrl`)
  }
  return result('bad_request', `Gemini ${label}: ${detail}`)
}

// ───────────────────────────── the provider ─────────────────────────────

interface StreamState {
  text: boolean
  usage?: LlmDelta
  finish?: string
  block?: string
  blockMessage?: string
}

function mapUsage(u: Rec): LlmDelta | undefined {
  const input = num(u.promptTokenCount)
  const candidates = num(u.candidatesTokenCount)
  const thoughts = num(u.thoughtsTokenCount)
  // Thinking tokens are billed as output.
  const output =
    candidates === undefined && thoughts === undefined
      ? undefined
      : (candidates ?? 0) + (thoughts ?? 0)
  if (input === undefined && output === undefined) return undefined
  return {
    type: 'usage',
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  }
}

export class GeminiProvider implements LlmProvider {
  readonly id: string
  readonly kind = 'gemini'
  readonly #apiKey: string
  readonly #model: string
  readonly #url: string
  readonly #cfg: GeminiConfig
  readonly #timeoutMs: number
  readonly #idleTimeoutMs: number
  readonly #redactor: Redactor
  readonly #transport: Transport

  constructor(config: GeminiConfig) {
    if (typeof config.id !== 'string' || config.id.trim() === '')
      throw new LlmConfigError('provider id is required')
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
    if (apiKey === '')
      throw new LlmConfigError(`gemini provider '${config.id}': apiKey is required`)
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new LlmConfigError(
        `gemini provider '${config.id}': apiKey must be printable ASCII without spaces`
      )
    }
    if (typeof config.model !== 'string' || config.model.trim() === '') {
      throw new LlmConfigError(`gemini provider '${config.id}': model is required`)
    }
    const baseUrl = parseHttpUrl(
      config.baseUrl ?? GEMINI_DEFAULT_BASE_URL,
      `gemini provider '${config.id}': baseUrl`
    )
    if (config.temperature !== undefined && !Number.isFinite(config.temperature)) {
      throw new LlmConfigError(`gemini provider '${config.id}': temperature must be a number`)
    }
    if (config.thinkingBudget !== undefined && !Number.isFinite(config.thinkingBudget)) {
      throw new LlmConfigError(`gemini provider '${config.id}': thinkingBudget must be a number`)
    }

    this.id = config.id
    this.#apiKey = apiKey
    this.#cfg = config
    this.#timeoutMs = requirePositive(config.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.#idleTimeoutMs = requirePositive(
      config.idleTimeoutMs,
      DEFAULT_IDLE_TIMEOUT_MS,
      'idleTimeoutMs'
    )

    const model = config.model.trim()
    this.#model = model
    const path = /^(?:models|tunedModels)\//.test(model)
      ? model.split('/').map(encodeURIComponent).join('/')
      : `models/${encodeURIComponent(model)}`
    const base = (baseUrl.origin + baseUrl.pathname)
      .replace(/\/+$/, '')
      .replace(/\/v1(?:beta)?$/, '')
    this.#url = `${base}/v1beta/${path}:streamGenerateContent?alt=sse`

    this.#redactor = new Redactor([apiKey, ...secretsFromUrl(baseUrl.href)])
    this.#transport = new Transport({
      providerId: config.id,
      redactor: this.#redactor,
      ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
      ...(config.proxyTunnel !== undefined ? { proxyTunnel: config.proxyTunnel } : {}),
      ...(config.connectTimeoutMs !== undefined
        ? { connectTimeoutMs: config.connectTimeoutMs }
        : {}),
    })
  }

  /** The model name, for the console. */
  get model(): string {
    return this.#model
  }

  redact(text: string): string {
    return this.#redactor.redact(text)
  }

  close(): Promise<void> {
    return this.#transport.close()
  }

  #error(code: LlmErrorCode, message: string, status?: number): LlmError {
    return new LlmError(code, this.#redactor.redact(message), {
      providerId: this.id,
      ...(status !== undefined ? { status } : {}),
    })
  }

  #body(req: LlmRequest): Rec {
    const cfg = this.#cfg
    const messages = normalizeMessages(req.messages, { providerId: this.id, mergeAdjacent: false })
    const systemParts: Rec[] = []
    const contents: { role: 'user' | 'model'; parts: Rec[] }[] = []
    for (const m of messages) {
      if (m.role === 'system') {
        if (hasImage(m.parts))
          throw this.#error('bad_request', 'Gemini system messages must be text only')
        for (const p of m.parts) if (p.type === 'text') systemParts.push({ text: p.text })
        continue
      }
      const role = m.role === 'assistant' ? 'model' : 'user'
      const parts = m.parts.map((p): Rec =>
        p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mime, data: p.base64 } }
      )
      const last = contents[contents.length - 1]
      if (last && last.role === role) last.parts.push(...parts)
      else contents.push({ role, parts })
    }
    if (contents.length === 0) {
      throw this.#error(
        'bad_request',
        'Gemini needs at least one non-empty user or assistant message'
      )
    }

    const temperature = req.temperature ?? cfg.temperature
    if (temperature !== undefined && !Number.isFinite(temperature)) {
      throw this.#error('bad_request', 'temperature must be a finite number')
    }
    if (
      req.maxOutputTokens !== undefined &&
      !(Number.isInteger(req.maxOutputTokens) && req.maxOutputTokens > 0)
    ) {
      throw this.#error('bad_request', 'maxOutputTokens must be a positive integer')
    }
    const generationConfig: Rec = { ...cfg.generationConfig }
    if (temperature !== undefined) generationConfig.temperature = temperature
    if (req.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = req.maxOutputTokens
    const thinking: Rec = {}
    if (cfg.thinkingBudget !== undefined) thinking.thinkingBudget = cfg.thinkingBudget
    if (cfg.includeThoughts && cfg.thinkingBudget !== 0) thinking.includeThoughts = true
    if (Object.keys(thinking).length > 0) generationConfig.thinkingConfig = thinking

    const body: Rec = { contents }
    if (systemParts.length > 0) body.systemInstruction = { parts: systemParts }
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig
    if (cfg.safetyOff) {
      body.safetySettings = SAFETY_CATEGORIES.map((category) => ({
        category,
        threshold: 'BLOCK_NONE',
      }))
    }
    return body
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmDelta> {
    const body = this.#body(req)
    const state: StreamState = { text: false }
    const events = this.#transport.postSse({
      url: this.#url,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        // Compressed streams are buffered by the decompressor, which delays the first words.
        'accept-encoding': 'identity',
        'x-goog-api-key': this.#apiKey,
      },
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs ?? this.#timeoutMs,
      idleTimeoutMs: this.#idleTimeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
      classify: classifyGeminiHttp,
    })
    for await (const event of events) yield* this.#handle(event, state)

    if (state.usage) yield state.usage
    if (!state.text) throw this.#noText(state)
  }

  *#handle(event: SseEvent, state: StreamState): Generator<LlmDelta> {
    if (event.data.trim() === '') return
    const parsed = parseJson(event.data)
    if (parsed === undefined)
      throw this.#error('protocol', 'the stream contained an event that is not valid JSON')
    if (event.event === 'error') throw this.#streamError(parsed)
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) yield* this.#chunk(item, state)
  }

  *#chunk(item: unknown, state: StreamState): Generator<LlmDelta> {
    if (!isRec(item)) return
    if (item.error !== undefined) throw this.#streamError(item)
    const feedback = item.promptFeedback
    if (isRec(feedback) && typeof feedback.blockReason === 'string') {
      state.block = feedback.blockReason
      if (typeof feedback.blockReasonMessage === 'string')
        state.blockMessage = feedback.blockReasonMessage
    }
    if (isRec(item.usageMetadata)) {
      const usage = mapUsage(item.usageMetadata)
      if (usage) state.usage = usage // cumulative: the last one wins
    }
    const candidate = Array.isArray(item.candidates) ? item.candidates[0] : undefined
    if (!isRec(candidate)) return
    if (
      typeof candidate.finishReason === 'string' &&
      candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED'
    ) {
      state.finish = candidate.finishReason
    }
    const parts =
      isRec(candidate.content) && Array.isArray(candidate.content.parts)
        ? candidate.content.parts
        : []
    for (const part of parts) {
      if (!isRec(part) || typeof part.text !== 'string' || part.text === '') continue
      if (part.thought === true) {
        yield { type: 'thinking', text: part.text }
      } else {
        state.text = true
        yield { type: 'text', text: part.text }
      }
    }
  }

  /** An error object delivered inside a stream that started with HTTP 200. */
  #streamError(parsed: unknown): LlmError {
    const err = errorObject(parsed) ?? errorObject({ error: parsed })
    const status = num(err?.code) ?? 500
    const c = classifyGeminiHttp({
      status,
      headers: new Headers(),
      bodyText: JSON.stringify({ error: err ?? parsed }),
    })
    return new LlmError(c.code, this.#redactor.redact(c.message), {
      providerId: this.id,
      status,
      ...(c.retryAfterMs !== undefined ? { retryAfterMs: c.retryAfterMs } : {}),
    })
  }

  #noText(state: StreamState): LlmError {
    if (state.block) {
      const why = state.blockMessage ? `: ${excerpt(state.blockMessage, 160)}` : ''
      return this.#error(
        'bad_request',
        `Gemini blocked the prompt (blockReason ${state.block})${why}`
      )
    }
    if (state.finish && BLOCKED_FINISH.has(state.finish)) {
      return this.#error('bad_request', `Gemini blocked the reply (finishReason ${state.finish})`)
    }
    if (state.finish === 'MAX_TOKENS') {
      return this.#error(
        'protocol',
        'Gemini returned no text before the token limit (finishReason MAX_TOKENS); thinking may have used the whole output budget'
      )
    }
    return this.#error(
      'protocol',
      `Gemini returned no text${state.finish ? ` (finishReason ${state.finish})` : ''}`
    )
  }
}
