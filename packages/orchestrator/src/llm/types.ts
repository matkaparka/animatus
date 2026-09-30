/**
 * Types shared by the LLM gateway and its providers.
 *
 * The orchestrator is the only secret holder. Providers receive already-resolved key values, and
 * nothing in this module (errors, deltas, stats) ever carries one.
 */
import { redactGeneric } from './redact.ts'

export type ChatRole = 'system' | 'user' | 'assistant'

export type ChatPart =
  { type: 'text'; text: string } | { type: 'image'; mime: string; base64: string }

export interface ChatMessage {
  role: ChatRole
  content: string | ChatPart[]
}

export interface LlmRequest {
  messages: ChatMessage[]
  temperature?: number
  maxOutputTokens?: number
  /** Total time budget of one provider attempt in ms (default 30 000). A fallback gets its own budget. */
  timeoutMs?: number
  /** Aborting closes the provider connection and ends the stream with an `aborted` error. */
  signal?: AbortSignal
  /** Who is asking (for example `chat` or `observer`); statistics only, never sent to a provider. */
  tag?: string
}

/**
 * One increment of a reply.
 *
 * `usage` is a snapshot for the whole attempt, not an increment: a provider emits it once, at the end
 * of a stream that ended normally. `outputTokens` counts what the provider bills as output, which
 * includes thinking tokens.
 */
export type LlmDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }

export interface LlmProvider {
  readonly id: string
  /** `gemini`, `openai-compatible`, ... */
  readonly kind: string
  stream(req: LlmRequest): AsyncIterable<LlmDelta>
  /** Remove this provider's own secrets (API key, proxy credentials) from a string. */
  redact?(text: string): string
  /** Release pooled sockets. */
  close?(): Promise<void>
}

export type LlmErrorCode =
  | 'quota'
  | 'auth'
  | 'rate_limit'
  | 'unavailable'
  | 'bad_request'
  | 'timeout'
  | 'aborted'
  | 'protocol'

/** Codes where the same request may work on another provider or later without any change. */
export function isRetryableCode(code: LlmErrorCode): boolean {
  return code === 'quota' || code === 'rate_limit' || code === 'unavailable' || code === 'timeout'
}

export interface LlmErrorInit {
  providerId: string
  status?: number
  /** Defaults to `isRetryableCode(code)`. */
  retryable?: boolean
  /** How long the provider asked us to wait (`Retry-After`, `RetryInfo`), in ms. */
  retryAfterMs?: number
  /** Errno-style code of the transport failure (`ECONNREFUSED`), for diagnostics. */
  causeCode?: string
}

/**
 * Every failure of the LLM layer. The message is scrubbed of credential-looking fragments at
 * construction; providers additionally remove their own registered secrets before building it (a stack
 * string is fixed when the error is created). No raw `cause` is attached.
 */
export class LlmError extends Error {
  readonly code: LlmErrorCode
  readonly retryable: boolean
  readonly status?: number
  readonly providerId: string
  readonly retryAfterMs?: number
  readonly causeCode?: string
  /** Set on the gateway's "all providers failed" error: one entry per provider in order. */
  attempts?: readonly LlmAttempt[]

  constructor(code: LlmErrorCode, message: string, init: LlmErrorInit) {
    super(redactGeneric(message))
    this.code = code
    this.retryable = init.retryable ?? isRetryableCode(code)
    this.providerId = init.providerId
    if (init.status !== undefined) this.status = init.status
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs
    if (init.causeCode !== undefined) this.causeCode = init.causeCode
  }
}

// On the prototype (not a class field) so the name is already right when V8 builds `stack`.
Object.defineProperty(LlmError.prototype, 'name', {
  value: 'LlmError',
  writable: true,
  configurable: true,
})

/** What happened to one provider during one gateway request. */
export interface LlmAttempt {
  providerId: string
  /** `error` = tried and failed, `cooldown` = skipped because it was cooling down. */
  outcome: 'error' | 'cooldown'
  code: LlmErrorCode
  status?: number
  /** For `cooldown`: milliseconds until the provider is tried again. */
  remainingMs?: number
}
