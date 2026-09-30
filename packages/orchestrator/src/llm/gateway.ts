/**
 * The LLM gateway: one place for provider order, fallback, cooldowns, usage statistics and secret
 * hygiene.
 *
 * Fallback rules, per request:
 * - Providers are tried in `order`; a provider that is cooling down is skipped.
 * - A failure BEFORE the provider produced its first text delta moves on to the next provider (any
 *   error except a caller abort; `bad_request` starts no cooldown because the request is at fault).
 * - A failure AFTER the first text delta is thrown to the consumer as it is. The answer is never
 *   silently continued by another provider.
 * - A provider that ends without any text counts as failed (`protocol`, "empty").
 * - When every provider failed or is cooling down, an `LlmError` with code `unavailable` lists each
 *   provider and its code.
 *
 * Nothing that leaves this class (errors, log lines, stats) contains a key: messages are redacted
 * with the providers' own secrets, the ones passed as `secrets`, and the generic credential patterns.
 * Prompts and answers are never logged.
 */
import { Redactor, mapStrings } from './redact.ts'
import { LlmError } from './types.ts'
import type { LlmAttempt, LlmDelta, LlmErrorCode, LlmProvider, LlmRequest } from './types.ts'

// Also importable from here: the gateway is where callers expect the redaction helper to live.
export { redactSecrets } from './redact.ts'

export type LlmLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Same shape as the other loggers in the orchestrator. `extra` never holds a secret. */
export type LlmLogger = (level: LlmLogLevel, msg: string, extra?: Record<string, unknown>) => void

/** How long a provider is skipped after a failure, in ms. `0` disables the cooldown for that code. */
export interface LlmCooldownConfig {
  quota?: number
  rate_limit?: number
  unavailable?: number
  /** Defaults to the `unavailable` value. */
  timeout?: number
  /** A rejected key does not fix itself; default 5 minutes. */
  auth?: number
}

export const DEFAULT_COOLDOWN_MS = {
  quota: 30 * 60_000,
  rate_limit: 30_000,
  unavailable: 15_000,
  auth: 5 * 60_000,
} as const

export interface LlmGatewayOptions {
  providers: LlmProvider[]
  /** Provider ids in the order they are tried. */
  order: string[]
  cooldownMs?: LlmCooldownConfig
  /** Clock in ms since the epoch; injectable for tests. */
  now?: () => number
  log?: LlmLogger
  /** More secrets to scrub (for example every key the orchestrator holds), besides each provider's own. */
  secrets?: string[]
}

export interface LlmProviderStats {
  id: string
  kind: string
  /** Attempts (a request that fell through to the next provider counts once per provider tried). */
  requests: number
  successes: number
  failures: number
  /** Caller aborted, or the consumer stopped reading. */
  aborted: number
  lastError?: { code: LlmErrorCode; at: number; status?: number }
  inputTokens: number
  outputTokens: number
  /** Present only while the provider is being skipped. */
  cooldownUntil?: number
}

/** Per `req.tag`: whole gateway requests, however many providers they needed. */
export interface LlmTagStats {
  requests: number
  successes: number
  failures: number
  aborted: number
  inputTokens: number
  outputTokens: number
}

export interface LlmGatewayStats {
  providers: LlmProviderStats[]
  tags: Record<string, LlmTagStats>
}

interface Slot {
  provider: LlmProvider
  requests: number
  successes: number
  failures: number
  aborted: number
  inputTokens: number
  outputTokens: number
  lastError?: { code: LlmErrorCode; at: number; status?: number }
  cooldown?: { until: number; since: number; code: LlmErrorCode }
}

interface Usage {
  input?: number
  output?: number
}

/** Tags come from code, but cap them anyway so a careless caller cannot grow the map without bound. */
const MAX_TAGS = 64
const OTHER_TAG = 'other'
const UNTAGGED = 'untagged'

/** A provider may ask for a longer wait than any sane cooldown; cap at a day. */
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000

export class LlmGateway {
  readonly #slots = new Map<string, Slot>()
  readonly #order: readonly string[]
  readonly #cooldown: Record<'quota' | 'rate_limit' | 'unavailable' | 'timeout' | 'auth', number>
  readonly #now: () => number
  readonly #log: LlmLogger | undefined
  readonly #redactor: Redactor
  readonly #tags = new Map<string, LlmTagStats>()

  constructor(opts: LlmGatewayOptions) {
    for (const provider of opts.providers) {
      if (this.#slots.has(provider.id))
        throw new Error(`duplicate LLM provider id '${provider.id}'`)
      this.#slots.set(provider.id, {
        provider,
        requests: 0,
        successes: 0,
        failures: 0,
        aborted: 0,
        inputTokens: 0,
        outputTokens: 0,
      })
    }
    if (opts.order.length === 0) throw new Error('LLM provider order is empty')
    const seen = new Set<string>()
    for (const id of opts.order) {
      if (!this.#slots.has(id)) throw new Error(`LLM provider order names unknown provider '${id}'`)
      if (seen.has(id)) throw new Error(`LLM provider order lists '${id}' twice`)
      seen.add(id)
    }
    this.#order = [...opts.order]

    const c = opts.cooldownMs ?? {}
    const unavailable = c.unavailable ?? DEFAULT_COOLDOWN_MS.unavailable
    this.#cooldown = {
      quota: c.quota ?? DEFAULT_COOLDOWN_MS.quota,
      rate_limit: c.rate_limit ?? DEFAULT_COOLDOWN_MS.rate_limit,
      unavailable,
      timeout: c.timeout ?? unavailable,
      auth: c.auth ?? DEFAULT_COOLDOWN_MS.auth,
    }
    this.#now = opts.now ?? Date.now
    this.#log = opts.log
    this.#redactor = new Redactor(opts.secrets ?? [])
  }

  /** Provider ids in the order they are tried. */
  get order(): readonly string[] {
    return this.#order
  }

  // ───────────────────────────── public API ─────────────────────────────

  /** Stream the reply of the first provider that works. See the module comment for the rules. */
  async *stream(req: LlmRequest): AsyncGenerator<LlmDelta> {
    const tag = this.#tagStats(req.tag)
    tag.requests++
    // Stays `aborted` when the consumer stops reading (the generator is closed at a `yield`).
    let outcome: 'successes' | 'failures' | 'aborted' = 'aborted'
    const attempts: LlmAttempt[] = []
    try {
      for (const id of this.#order) {
        const slot = this.#slots.get(id)!
        if (req.signal?.aborted) throw this.#abortError(id)

        const startedAt = this.#now()
        const cooling = slot.cooldown && slot.cooldown.until > startedAt ? slot.cooldown : undefined
        if (cooling) {
          attempts.push({
            providerId: id,
            outcome: 'cooldown',
            code: cooling.code,
            remainingMs: cooling.until - startedAt,
          })
          this.#emit('debug', 'llm provider skipped (cooling down)', {
            provider: id,
            code: cooling.code,
            remainingMs: cooling.until - startedAt,
          })
          continue
        }

        slot.requests++
        let gotText = false
        let usage: Usage | undefined
        let settled = false
        try {
          for await (const delta of slot.provider.stream(req)) {
            if (delta.type === 'usage')
              usage = { input: delta.inputTokens, output: delta.outputTokens }
            else if (delta.type === 'text' && delta.text !== '') gotText = true
            yield delta
          }
          if (!gotText)
            throw new LlmError('protocol', 'the provider returned no text', { providerId: id })
          settled = true
          this.#onSuccess(slot, startedAt, usage, tag)
          outcome = 'successes'
          if (attempts.length > 0) {
            this.#emit('info', 'llm request served by a fallback provider', {
              provider: id,
              tried: attempts.map(
                (a) => `${a.providerId}:${a.outcome === 'cooldown' ? 'cooldown' : a.code}`
              ),
              tag: req.tag,
            })
          }
          return
        } catch (e) {
          settled = true
          const err = this.#toLlmError(e, id)
          if (err.code === 'aborted' || req.signal?.aborted) {
            slot.aborted++
            this.#addTokens(slot, tag, usage)
            outcome = 'aborted'
            throw err.code === 'aborted' ? err : this.#abortError(id)
          }
          slot.failures++
          slot.lastError = {
            code: err.code,
            at: this.#now(),
            ...(err.status !== undefined ? { status: err.status } : {}),
          }
          this.#addTokens(slot, tag, usage)
          this.#startCooldown(slot, err) // a health signal for the next requests, whatever happens to this one
          if (gotText) {
            // The consumer already has part of an answer from this provider: no silent switch.
            outcome = 'failures'
            this.#emit('warn', 'llm stream failed after output started', {
              provider: id,
              code: err.code,
              status: err.status,
              message: err.message,
              tag: req.tag,
            })
            throw err
          }
          attempts.push({
            providerId: id,
            outcome: 'error',
            code: err.code,
            ...(err.status !== undefined ? { status: err.status } : {}),
            detail: this.#scrub(err.message).slice(0, 300),
          })
          this.#emit('warn', 'llm provider failed', {
            provider: id,
            code: err.code,
            status: err.status,
            message: err.message,
            tag: req.tag,
          })
        } finally {
          if (!settled) {
            // The consumer stopped reading mid-answer.
            slot.aborted++
            this.#addTokens(slot, tag, usage)
          }
        }
      }

      outcome = 'failures'
      throw this.#allFailed(attempts, req.tag)
    } finally {
      tag[outcome]++
    }
  }

  /** The whole text of the reply. */
  async complete(req: LlmRequest): Promise<string> {
    let text = ''
    for await (const delta of this.stream(req)) if (delta.type === 'text') text += delta.text
    return text
  }

  /** Counters for the console. Contains no key material: only ids, codes and numbers. */
  stats(): LlmGatewayStats {
    const now = this.#now()
    const providers = this.#order.map((id): LlmProviderStats => {
      const s = this.#slots.get(id)!
      return {
        id,
        kind: s.provider.kind,
        requests: s.requests,
        successes: s.successes,
        failures: s.failures,
        aborted: s.aborted,
        ...(s.lastError ? { lastError: { ...s.lastError } } : {}),
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        ...(s.cooldown && s.cooldown.until > now ? { cooldownUntil: s.cooldown.until } : {}),
      }
    })
    return { providers, tags: Object.fromEntries([...this.#tags].map(([k, v]) => [k, { ...v }])) }
  }

  /** Make a provider eligible again right now (one id), or all of them. */
  resetCooldown(id?: string): void {
    if (id === undefined) {
      for (const slot of this.#slots.values()) delete slot.cooldown
      return
    }
    const slot = this.#slots.get(id)
    if (!slot) throw new Error(`unknown LLM provider '${id}'`)
    delete slot.cooldown
  }

  /** Close every provider that holds sockets. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#slots.values()].map((s) => s.provider.close?.()))
  }

  // ───────────────────────────── internals ─────────────────────────────

  #tagStats(tag: string | undefined): LlmTagStats {
    let key = tag && tag.trim() !== '' ? tag : UNTAGGED
    if (!this.#tags.has(key) && this.#tags.size >= MAX_TAGS) key = OTHER_TAG
    let stats = this.#tags.get(key)
    if (!stats) {
      stats = {
        requests: 0,
        successes: 0,
        failures: 0,
        aborted: 0,
        inputTokens: 0,
        outputTokens: 0,
      }
      this.#tags.set(key, stats)
    }
    return stats
  }

  #addTokens(slot: Slot, tag: LlmTagStats, usage: Usage | undefined): void {
    if (!usage) return
    slot.inputTokens += usage.input ?? 0
    slot.outputTokens += usage.output ?? 0
    tag.inputTokens += usage.input ?? 0
    tag.outputTokens += usage.output ?? 0
  }

  #onSuccess(slot: Slot, startedAt: number, usage: Usage | undefined, tag: LlmTagStats): void {
    slot.successes++
    this.#addTokens(slot, tag, usage)
    // A success clears the cooldown, unless a concurrent request started a newer one meanwhile.
    if (slot.cooldown && slot.cooldown.since < startedAt) delete slot.cooldown
    this.#emit('debug', 'llm request finished', {
      provider: slot.provider.id,
      ms: this.#now() - startedAt,
      inputTokens: usage?.input,
      outputTokens: usage?.output,
    })
  }

  #startCooldown(slot: Slot, err: LlmError): void {
    const base = (this.#cooldown as Record<string, number | undefined>)[err.code]
    if (base === undefined || base <= 0) return // bad_request / protocol: not the provider's health
    // A provider that says how long to wait is believed when that is longer than our default.
    const ms = Math.min(Math.max(base, err.retryAfterMs ?? 0), MAX_COOLDOWN_MS)
    const now = this.#now()
    const until = now + ms
    if (slot.cooldown && slot.cooldown.until >= until) return
    slot.cooldown = { until, since: now, code: err.code }
    this.#emit('warn', 'llm provider is cooling down', {
      provider: slot.provider.id,
      code: err.code,
      cooldownMs: ms,
      until,
    })
  }

  #abortError(providerId: string): LlmError {
    return new LlmError('aborted', 'request aborted by the caller', { providerId })
  }

  #allFailed(attempts: readonly LlmAttempt[], tag: string | undefined): LlmError {
    const parts = attempts.map((a) => {
      if (a.outcome === 'cooldown') {
        return `${a.providerId}=skipped (cooling down after ${a.code}, ${Math.ceil((a.remainingMs ?? 0) / 1000)} s left)`
      }
      return `${a.providerId}=${a.code}${a.status !== undefined ? ` (HTTP ${a.status})` : ''}`
    })
    const error = new LlmError(
      'unavailable',
      this.#scrub(`all LLM providers failed: ${parts.join(', ')}`),
      {
        providerId: 'gateway',
      }
    )
    error.attempts = attempts
    this.#emit('error', 'llm request failed on every provider', { attempts: parts, tag })
    return error
  }

  /** Whatever a provider threw, as an `LlmError` whose message is scrubbed. */
  #toLlmError(e: unknown, providerId: string): LlmError {
    if (e instanceof LlmError) {
      const clean = this.#scrub(e.message)
      if (clean === e.message) return e
      // A provider leaked into its own message: rebuild so the stack no longer carries it either.
      return new LlmError(e.code, clean, {
        providerId: e.providerId,
        retryable: e.retryable,
        ...(e.status !== undefined ? { status: e.status } : {}),
        ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
        ...(e.causeCode !== undefined ? { causeCode: e.causeCode } : {}),
      })
    }
    const raw = e instanceof Error ? e.message : String(e)
    const flat = this.#scrub(raw).replace(/\s+/g, ' ').trim().slice(0, 300)
    return new LlmError('unavailable', `unexpected provider failure: ${flat}`, { providerId })
  }

  /** Every registered secret (the gateway's and each provider's own) and every credential-looking fragment. */
  #scrub(text: string): string {
    let out = this.#redactor.redact(text)
    for (const { provider } of this.#slots.values()) {
      if (!provider.redact) continue
      try {
        out = provider.redact(out)
      } catch {
        // A broken redactor must not take the request down; the generic rules already ran.
      }
    }
    return out
  }

  #emit(level: LlmLogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (!this.#log) return
    try {
      this.#log(
        level,
        this.#scrub(msg),
        extra ? mapStrings(extra, (s) => this.#scrub(s)) : undefined
      )
    } catch {
      // A failing logger never fails a request.
    }
  }
}
