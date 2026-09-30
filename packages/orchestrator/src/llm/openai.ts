/**
 * Any OpenAI-compatible server: `POST {baseUrl}/chat/completions` with `stream: true` (OpenAI, vLLM,
 * llama.cpp, LM Studio, Ollama, OpenRouter, DeepSeek, ...).
 *
 * Reasoning text (`reasoning_content`, or `reasoning`) becomes `thinking` deltas. Usage is read from
 * the final chunk (`stream_options.include_usage`). Without an API key no Authorization header is sent,
 * which is what local servers want. Error classification:
 *
 * | Response                                                               | Code          |
 * |------------------------------------------------------------------------|---------------|
 * | HTTP 429 whose body says quota / balance / billing (`insufficient_quota`) | `quota`    |
 * | other HTTP 429                                                         | `rate_limit`  |
 * | HTTP 402, or `insufficient_quota` on another 4xx                       | `quota`       |
 * | HTTP 401 / 403                                                         | `auth`        |
 * | HTTP 408                                                               | `timeout`     |
 * | other 4xx                                                              | `bad_request` |
 * | HTTP 5xx (also 503 while a model loads), network failure, dropped      | `unavailable` |
 * | `finish_reason: content_filter` and no text                            | `bad_request` |
 * | no text for any other reason, malformed event                          | `protocol`    |
 */
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  LlmConfigError,
  Transport,
  excerpt,
  parseHttpUrl,
  parseJson,
  parseRetryAfter,
  requirePositive,
} from './http.ts'
import type { ClassifiedError, HttpErrorInfo } from './http.ts'
import { hasImage, joinText, normalizeMessages } from './messages.ts'
import { Redactor, secretsFromUrl } from './redact.ts'
import type { SseEvent } from './sse.ts'
import { LlmError } from './types.ts'
import type { LlmDelta, LlmErrorCode, LlmProvider, LlmRequest } from './types.ts'

export interface OpenAiConfig {
  id: string
  /** Including the version prefix, for example `http://127.0.0.1:8081/v1`. */
  baseUrl: string
  model: string
  /** Optional: local servers need none. Kept private, sent only as `Authorization: Bearer`. */
  apiKey?: string
  /** `http://127.0.0.1:7897`; empty or missing means direct (a local server must not use the proxy). */
  proxy?: string
  /** Force a CONNECT tunnel through the proxy even for an `http:` base URL. */
  proxyTunnel?: boolean
  /** Default sampling temperature; a request's own value wins. */
  temperature?: number
  /** Extra JSON fields for the request body (for example `chat_template_kwargs`). `model`, `messages` and `stream` cannot be overridden. */
  extraBody?: Record<string, unknown>
  /** Ask for token usage in the last chunk (default true). Turn off for a server that rejects `stream_options`. */
  includeUsage?: boolean
  /** Name of the output limit field (default `max_tokens`; newer OpenAI models want `max_completion_tokens`). */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Merge neighbouring messages with the same role (default true; some chat templates reject two user turns in a row). */
  mergeConsecutiveRoles?: boolean
  /** Total budget per attempt when the request has none (default 30 000). */
  timeoutMs?: number
  /** No bytes for this long ends the attempt (default 15 000). */
  idleTimeoutMs?: number
  /** TCP/TLS connect limit (default 10 000). */
  connectTimeoutMs?: number
}

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

// ───────────────────────────── error classification ─────────────────────────────

/**
 * A 429 is a plain rate limit unless the body talks about quota or an empty balance. "billing" alone is
 * not a signal: OpenAI's ordinary per-minute message links to the billing page.
 */
const QUOTA_WORDS = /quota|insufficient[_ ]?(?:balance|funds)|out of credits?/i

export function classifyOpenAiHttp(info: HttpErrorInfo): ClassifiedError {
  const parsed = parseJson(info.bodyText)
  const err = isRec(parsed) ? parsed.error : undefined
  const errRec = isRec(err) ? err : undefined
  const apiMessage =
    typeof errRec?.message === 'string' ? errRec.message : typeof err === 'string' ? err : undefined
  const apiCode = [errRec?.code, errRec?.type]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
  const detail = excerpt(apiMessage ?? info.bodyText) || 'no error body'
  const label = `HTTP ${info.status}${apiCode ? ` ${apiCode}` : ''}`
  const haystack = `${apiCode} ${apiMessage ?? ''} ${info.bodyText.slice(0, 2000)}`
  const retryAfterMs = parseRetryAfter(info.headers.get('retry-after'))
  const result = (code: LlmErrorCode, message: string): ClassifiedError => ({
    code,
    message,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })

  if (info.status === 429) {
    return QUOTA_WORDS.test(haystack)
      ? result('quota', `quota exhausted (${label}): ${detail}`)
      : result('rate_limit', `rate limited (${label}): ${detail}`)
  }
  if (info.status === 402) return result('quota', `payment required (${label}): ${detail}`)
  if (info.status === 401 || info.status === 403) {
    return result(
      'auth',
      `the server rejected the API key or its permissions (${label}): ${detail}`
    )
  }
  if (info.status === 408) return result('timeout', `${label}: ${detail}`)
  if (info.status >= 500) return result('unavailable', `${label}: ${detail}`)
  if (info.status >= 300 && info.status < 400) {
    return result('bad_request', `the server answered with a redirect (${label}); check baseUrl`)
  }
  if (QUOTA_WORDS.test(apiCode) || /insufficient_quota|insufficient_balance/i.test(haystack)) {
    return result('quota', `quota exhausted (${label}): ${detail}`)
  }
  return result('bad_request', `${label}: ${detail}`)
}

// ───────────────────────────── the provider ─────────────────────────────

interface StreamState {
  text: boolean
  done: boolean
  usage?: LlmDelta
  finish?: string
}

function mapUsage(u: Rec): LlmDelta | undefined {
  const input = num(u.prompt_tokens)
  const output = num(u.completion_tokens) // includes reasoning tokens
  if (input === undefined && output === undefined) return undefined
  return {
    type: 'usage',
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  }
}

/** `content` is a string in practice; some servers send an array of text parts. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (isRec(p) && typeof p.text === 'string' ? p.text : '')).join('')
}

export class OpenAiProvider implements LlmProvider {
  readonly id: string
  readonly kind = 'openai-compatible'
  readonly #apiKey: string | undefined
  readonly #model: string
  readonly #url: string
  readonly #cfg: OpenAiConfig
  readonly #timeoutMs: number
  readonly #idleTimeoutMs: number
  readonly #redactor: Redactor
  readonly #transport: Transport

  constructor(config: OpenAiConfig) {
    if (typeof config.id !== 'string' || config.id.trim() === '')
      throw new LlmConfigError('provider id is required')
    const where = `openai-compatible provider '${config.id}'`
    if (typeof config.model !== 'string' || config.model.trim() === '')
      throw new LlmConfigError(`${where}: model is required`)
    const baseUrl = parseHttpUrl(config.baseUrl, `${where}: baseUrl`)
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
    if (apiKey !== '' && !/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new LlmConfigError(`${where}: apiKey must be printable ASCII without spaces`)
    }
    if (config.temperature !== undefined && !Number.isFinite(config.temperature)) {
      throw new LlmConfigError(`${where}: temperature must be a number`)
    }
    if (config.extraBody !== undefined && !isRec(config.extraBody)) {
      throw new LlmConfigError(`${where}: extraBody must be an object`)
    }

    this.id = config.id
    this.#apiKey = apiKey === '' ? undefined : apiKey
    this.#model = config.model.trim()
    this.#cfg = config
    this.#timeoutMs = requirePositive(config.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.#idleTimeoutMs = requirePositive(
      config.idleTimeoutMs,
      DEFAULT_IDLE_TIMEOUT_MS,
      'idleTimeoutMs'
    )

    const path = baseUrl.pathname.replace(/\/+$/, '')
    this.#url = `${baseUrl.origin}${path.endsWith('/chat/completions') ? path : `${path}/chat/completions`}${baseUrl.search}`

    this.#redactor = new Redactor([
      ...(apiKey === '' ? [] : [apiKey]),
      ...secretsFromUrl(baseUrl.href),
    ])
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
    const normalized = normalizeMessages(req.messages, {
      providerId: this.id,
      mergeAdjacent: cfg.mergeConsecutiveRoles ?? true,
    })
    if (normalized.length === 0)
      throw this.#error('bad_request', 'the request has no non-empty message')
    const messages = normalized.map((m) => {
      if (!hasImage(m.parts)) return { role: m.role, content: joinText(m.parts) }
      if (m.role !== 'user')
        throw this.#error('bad_request', 'images are only supported in user messages')
      return {
        role: m.role,
        content: m.parts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } }
        ),
      }
    })

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

    const body: Rec = {}
    if (cfg.includeUsage ?? true) body.stream_options = { include_usage: true }
    Object.assign(body, cfg.extraBody)
    if (temperature !== undefined) body.temperature = temperature
    if (req.maxOutputTokens !== undefined)
      body[cfg.maxTokensField ?? 'max_tokens'] = req.maxOutputTokens
    body.model = this.#model
    body.messages = messages
    body.stream = true
    return body
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmDelta> {
    const body = this.#body(req)
    const state: StreamState = { text: false, done: false }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
    }
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`
    const events = this.#transport.postSse({
      url: this.#url,
      headers,
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs ?? this.#timeoutMs,
      idleTimeoutMs: this.#idleTimeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
      classify: classifyOpenAiHttp,
    })
    for await (const event of events) {
      yield* this.#handle(event, state)
      // Do not wait for the server to close: some keep the connection open after [DONE].
      if (state.done) break
    }

    if (state.usage) yield state.usage
    if (!state.text) throw this.#noText(state)
  }

  *#handle(event: SseEvent, state: StreamState): Generator<LlmDelta> {
    const data = event.data.trim()
    if (data === '') return
    if (data === '[DONE]') {
      state.done = true
      return
    }
    const parsed = parseJson(data)
    if (parsed === undefined)
      throw this.#error('protocol', 'the stream contained an event that is not valid JSON')
    if (event.event === 'error') throw this.#streamError(parsed)
    yield* this.#chunk(parsed, state)
  }

  *#chunk(item: unknown, state: StreamState): Generator<LlmDelta> {
    if (!isRec(item)) return
    if (item.error !== undefined && item.error !== null) throw this.#streamError(item)
    if (isRec(item.usage)) state.usage = mapUsage(item.usage) ?? state.usage
    const choice = Array.isArray(item.choices) ? item.choices[0] : undefined
    if (!isRec(choice)) return
    if (typeof choice.finish_reason === 'string') state.finish = choice.finish_reason
    // A server that ignored `stream: true` answers with `message` instead of `delta`.
    const delta = isRec(choice.delta)
      ? choice.delta
      : isRec(choice.message)
        ? choice.message
        : undefined
    if (!delta) return
    const reasoning =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : ''
    if (reasoning !== '') yield { type: 'thinking', text: reasoning }
    const content = textOfContent(delta.content)
    if (content !== '') {
      state.text = true
      yield { type: 'text', text: content }
    }
  }

  /** An error object delivered inside a stream that started with HTTP 200. */
  #streamError(parsed: unknown): LlmError {
    const err = isRec(parsed) && parsed.error !== undefined ? parsed.error : parsed
    const errRec = isRec(err) ? err : undefined
    // No HTTP status here: use the numeric code if there is one, else guess from the wording.
    const numeric =
      num(errRec?.code) ??
      (typeof errRec?.code === 'string' ? Number.parseInt(errRec.code, 10) : NaN)
    const words = `${String(errRec?.code ?? '')} ${String(errRec?.type ?? '')} ${String(errRec?.message ?? '')}`
    let status = 500
    if (Number.isInteger(numeric) && numeric >= 400 && numeric < 600) status = numeric
    else if (/rate.?limit|quota|insufficient/i.test(words)) status = 429
    else if (/auth|api.?key|unauthori[sz]ed/i.test(words)) status = 401
    const c = classifyOpenAiHttp({
      status,
      headers: { get: () => null },
      bodyText: JSON.stringify({ error: err }),
    })
    return new LlmError(c.code, this.#redactor.redact(c.message), { providerId: this.id, status })
  }

  #noText(state: StreamState): LlmError {
    if (state.finish === 'content_filter')
      return this.#error('bad_request', 'the reply was blocked by the content filter')
    if (state.finish === 'length') {
      return this.#error(
        'protocol',
        'the server returned no text before the token limit (finish_reason length); reasoning may have used the whole output budget'
      )
    }
    return this.#error(
      'protocol',
      `the server returned no text${state.finish ? ` (finish_reason ${state.finish})` : ''}`
    )
  }
}
