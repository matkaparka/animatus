/**
 * HTTP transport shared by the providers: one undici dispatcher per provider (a plain `Agent`, or a
 * `ProxyAgent` when that provider has a `proxy`, so a local provider never goes through a proxy and
 * never reads proxy environment variables), a POST that yields Server-Sent Events, and the timers.
 *
 * Timers, all per attempt:
 * - connect: undici's connect timeout (`connectTimeoutMs`, default 10 s)
 * - idle: no bytes for `idleTimeoutMs` (default 15 s). It runs while we wait for the server (headers or
 *   the next chunk), not while the consumer is busy with an event.
 * - total: `timeoutMs` (default 30 s) from the start of the request.
 * A caller abort, a timer or the consumer walking away all end in an `AbortController` abort, which
 * makes undici destroy the socket (a mock server sees the connection close).
 */
import { Agent, ProxyAgent, fetch } from 'undici'
import type { Dispatcher } from 'undici'
import { Redactor, secretsFromUrl } from './redact.ts'
import { SseLimitError, SseParser } from './sse.ts'
import type { SseEvent } from './sse.ts'
import { LlmError } from './types.ts'
import type { LlmErrorCode } from './types.ts'

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_IDLE_TIMEOUT_MS = 15_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

/** Most of an error body we read; enough for any API error, protects against a runaway response. */
const MAX_ERROR_BODY_BYTES = 64 * 1024
/** Most of a non-streamed JSON reply we accept. */
const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024
/** How much of a provider's error text goes into a message. */
const MAX_MESSAGE_CHARS = 300
/** Retry-After values beyond a day are treated as a day. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

/** A bad provider configuration (found while constructing a provider, not while calling it). */
export class LlmConfigError extends Error {}
Object.defineProperty(LlmConfigError.prototype, 'name', {
  value: 'LlmConfigError',
  writable: true,
  configurable: true,
})

// ───────────────────────────── configuration helpers ─────────────────────────────

/** Absolute http(s) URL without credentials. Messages never echo the value: it may hold a token. */
export function parseHttpUrl(raw: unknown, what: string): URL {
  if (typeof raw !== 'string' || raw.trim() === '') throw new LlmConfigError(`${what} is required`)
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new LlmConfigError(`${what} must be an absolute http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LlmConfigError(`${what} must use http: or https:`)
  }
  if (url.username || url.password) {
    throw new LlmConfigError(`${what} must not contain credentials`)
  }
  return url
}

/**
 * The proxy URL of a provider. Empty or missing means "no proxy" (the example configuration uses an
 * empty string). Credentials in the URL are allowed here (undici sends them as Proxy-Authorization).
 */
export function parseProxyUrl(raw: string | undefined): URL | undefined {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '') return undefined
  let url: URL
  try {
    url = new URL(s)
  } catch {
    throw new LlmConfigError('proxy must be an absolute URL such as http://127.0.0.1:7897')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LlmConfigError('proxy must use http: or https: (for example http://127.0.0.1:7897)')
  }
  if (!url.hostname) throw new LlmConfigError('proxy URL has no host')
  return url
}

export function requirePositive(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0)
    throw new LlmConfigError(`${what} must be a positive number`)
  return value
}

/** The largest delay a Node timer accepts; anything bigger fires immediately. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** A usable timer delay: `Infinity` means "as long as possible", junk falls back to the default. */
export function timerMs(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return fallback
  return Math.min(value, MAX_TIMER_MS)
}

// ───────────────────────────── error helpers ─────────────────────────────

/** What a provider decides about an HTTP error response. */
export interface ClassifiedError {
  code: LlmErrorCode
  message: string
  retryAfterMs?: number
}

/** The part of a `Headers` object the classifiers need. */
export interface HeaderReader {
  get(name: string): string | null
}

export interface HttpErrorInfo {
  status: number
  headers: HeaderReader
  /** Up to 64 KiB of the body, decoded as UTF-8. */
  bodyText: string
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** One line, bounded: the part of a provider's error text that goes into our message. */
export function excerpt(text: string, max = MAX_MESSAGE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

/** `Retry-After` as milliseconds (delta-seconds or an HTTP date). */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now()
): number | undefined {
  if (!value) return undefined
  const s = value.trim()
  let ms: number | undefined
  if (/^\d+(\.\d+)?$/.test(s)) ms = Math.round(Number(s) * 1000)
  else {
    const t = Date.parse(s)
    if (!Number.isNaN(t)) ms = Math.max(0, t - now)
  }
  return ms === undefined ? undefined : Math.min(ms, MAX_RETRY_AFTER_MS)
}

/** `34s`, `0.5s`, `1.2s` (protobuf Duration text) as milliseconds. */
export function parseDurationText(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
  return m ? Math.min(Math.round(Number(m[1]) * 1000), MAX_RETRY_AFTER_MS) : undefined
}

type AbortKind = 'caller' | 'total' | 'idle' | 'cleanup'

class AbortCause extends Error {
  readonly kind: AbortKind
  constructor(kind: AbortKind) {
    super(`request aborted (${kind})`)
    this.kind = kind
  }
}

const TIMEOUT_ERRNO = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
])

/** The first errno-style `code` in an error, its `errors[]` (AggregateError) or its `cause` chain. */
function errnoOf(e: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof e !== 'object' || e === null) return undefined
  const rec = e as { code?: unknown; errors?: unknown; cause?: unknown }
  if (typeof rec.code === 'string') return rec.code
  if (Array.isArray(rec.errors)) {
    for (const sub of rec.errors) {
      const code = errnoOf(sub, depth + 1)
      if (code) return code
    }
  }
  return errnoOf(rec.cause, depth + 1)
}

/** The messages along an error's cause chain, for one diagnostic line. */
function describeError(e: unknown): string {
  const seen: string[] = []
  let cur: unknown = e
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    if (cur.message && !seen.includes(cur.message)) seen.push(cur.message)
    cur = cur.cause
  }
  return seen.join(': ') || 'unknown error'
}

// ───────────────────────────── the transport ─────────────────────────────

export interface TransportConfig {
  providerId: string
  proxy?: string
  /** Force a CONNECT tunnel even to a plain-http upstream (by default only https upstreams are tunnelled). */
  proxyTunnel?: boolean
  connectTimeoutMs?: number
  /** Receives the proxy credentials so they are scrubbed from every message. */
  redactor: Redactor
}

export interface PostSseArgs {
  url: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
  idleTimeoutMs: number
  signal?: AbortSignal
  classify(info: HttpErrorInfo): ClassifiedError
}

interface Limits {
  timeoutMs: number
  idleTimeoutMs: number
}

export class Transport {
  readonly #providerId: string
  readonly #dispatcher: Dispatcher
  readonly #redactor: Redactor
  readonly #connectTimeoutMs: number
  readonly proxied: boolean

  constructor(cfg: TransportConfig) {
    this.#providerId = cfg.providerId
    this.#redactor = cfg.redactor
    this.#connectTimeoutMs = requirePositive(
      cfg.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      'connectTimeoutMs'
    )
    const proxy = parseProxyUrl(cfg.proxy)
    this.proxied = proxy !== undefined
    // Timers are ours (see the module comment); undici's own default of 5 minutes would cut in for a
    // long `timeoutMs`.
    const common = { connectTimeout: this.#connectTimeoutMs, headersTimeout: 0, bodyTimeout: 0 }
    if (proxy) {
      cfg.redactor.add(...secretsFromUrl(proxy.href))
      this.#dispatcher = new ProxyAgent({
        uri: proxy.href,
        proxyTunnel: cfg.proxyTunnel,
        ...common,
      })
    } else {
      this.#dispatcher = new Agent(common)
    }
  }

  async close(): Promise<void> {
    await this.#dispatcher.close()
  }

  #error(
    code: LlmErrorCode,
    message: string,
    extra: { status?: number; retryAfterMs?: number; causeCode?: string } = {}
  ) {
    return new LlmError(code, this.#redactor.redact(message), {
      providerId: this.#providerId,
      ...extra,
    })
  }

  /** Turn whatever `fetch` or a body read threw into an `LlmError`. */
  #transportError(e: unknown, signal: AbortSignal, limits: Limits): LlmError {
    if (e instanceof LlmError) return e
    if (signal.aborted) {
      const reason: unknown = signal.reason
      if (reason instanceof AbortCause) {
        if (reason.kind === 'total')
          return this.#error('timeout', `request exceeded the ${limits.timeoutMs} ms time budget`)
        if (reason.kind === 'idle')
          return this.#error('timeout', `no data from the provider for ${limits.idleTimeoutMs} ms`)
        return this.#error('aborted', 'request aborted')
      }
    }
    if (e instanceof SseLimitError) return this.#error('protocol', e.message)
    const errno = errnoOf(e)
    const extra = errno ? { causeCode: errno } : {}
    if (errno && TIMEOUT_ERRNO.has(errno)) {
      return this.#error(
        'timeout',
        `network timeout (${errno}), connect limit ${this.#connectTimeoutMs} ms`,
        extra
      )
    }
    return this.#error(
      'unavailable',
      `network error${errno ? ` (${errno})` : ''}: ${excerpt(describeError(e), 200)}`,
      extra
    )
  }

  /**
   * POST `args.body` and yield the Server-Sent Events of the reply. A JSON reply (a server that ignored
   * `stream: true`) is yielded as one event. Throws `LlmError` only.
   */
  async *postSse(args: PostSseArgs): AsyncGenerator<SseEvent> {
    const { signal } = args
    if (signal?.aborted) throw this.#error('aborted', 'request aborted before it started')

    const limits: Limits = {
      timeoutMs: timerMs(args.timeoutMs, DEFAULT_TIMEOUT_MS),
      idleTimeoutMs: timerMs(args.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
    }
    const ctl = new AbortController()
    const abortWith = (kind: AbortKind) => {
      if (!ctl.signal.aborted) ctl.abort(new AbortCause(kind))
    }
    const onCallerAbort = () => abortWith('caller')
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    const totalTimer = setTimeout(() => abortWith('total'), limits.timeoutMs)
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => abortWith('idle'), limits.idleTimeoutMs)
    }
    const disarmIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let complete = false

    /** Read up to `limit` bytes of the body as text (the rest is dropped). */
    const readText = async (limit: number): Promise<string> => {
      const decoder = new TextDecoder()
      let text = ''
      let bytes = 0
      for (;;) {
        armIdle()
        const chunk = await reader!.read()
        disarmIdle()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        text += decoder.decode(chunk.value, { stream: true })
        if (bytes >= limit) break
      }
      return text + decoder.decode()
    }

    try {
      armIdle()
      let res: Awaited<ReturnType<typeof fetch>>
      try {
        res = await fetch(args.url, {
          method: 'POST',
          headers: args.headers,
          body: args.body,
          dispatcher: this.#dispatcher,
          signal: ctl.signal,
          // Never follow a redirect: it could carry the key header to another host.
          redirect: 'manual',
        })
      } catch (e) {
        throw this.#transportError(e, ctl.signal, limits)
      }
      disarmIdle()
      if (res.body) reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>

      if (!res.ok) {
        let bodyText = ''
        if (reader) {
          try {
            bodyText = await readText(MAX_ERROR_BODY_BYTES)
          } catch (e) {
            const err = this.#transportError(e, ctl.signal, limits)
            if (err.code === 'aborted') throw err
            // Otherwise the status alone has to do.
          }
        }
        const c = args.classify({ status: res.status, headers: res.headers, bodyText })
        throw this.#error(c.code, c.message, {
          status: res.status,
          ...(c.retryAfterMs !== undefined ? { retryAfterMs: c.retryAfterMs } : {}),
        })
      }

      const contentType = res.headers.get('content-type') ?? ''
      if (/text\/html/i.test(contentType)) {
        throw this.#error(
          'protocol',
          `unexpected content type ${excerpt(contentType, 60)} (a proxy or captive portal may have answered)`,
          { status: res.status }
        )
      }
      if (!reader)
        throw this.#error('protocol', 'the provider sent no response body', { status: res.status })

      if (/json/i.test(contentType)) {
        let text: string
        try {
          text = await readText(MAX_JSON_BODY_BYTES)
        } catch (e) {
          throw this.#transportError(e, ctl.signal, limits)
        }
        complete = true
        yield { event: 'message', data: text }
        return
      }

      const parser = new SseParser()
      for (;;) {
        armIdle()
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try {
          chunk = await reader.read()
        } catch (e) {
          throw this.#transportError(e, ctl.signal, limits)
        }
        disarmIdle()
        if (chunk.done) break
        let events: SseEvent[]
        try {
          events = parser.pushBytes(chunk.value)
        } catch (e) {
          throw this.#transportError(e, ctl.signal, limits)
        }
        for (const event of events) yield event
      }
      let tail: SseEvent[]
      try {
        tail = parser.flush()
      } catch (e) {
        throw this.#transportError(e, ctl.signal, limits)
      }
      complete = true
      for (const event of tail) yield event
    } finally {
      clearTimeout(totalTimer)
      disarmIdle()
      signal?.removeEventListener('abort', onCallerAbort)
      if (!complete) {
        // Error, or the consumer stopped early: make sure the socket does not linger.
        abortWith('cleanup')
        reader?.cancel().catch(() => {})
      }
    }
  }
}
