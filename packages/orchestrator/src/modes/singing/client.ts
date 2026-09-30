/**
 * A typed client for the song service (plugins/singing). It knows nothing about modes or the stage.
 *
 * Every call is bounded by a timeout and fails with a `SongServiceError` that says what kind of trouble it was:
 *   unreachable  the service is not running (no URL) or refused the connection
 *   timeout      it did not answer in time
 *   http         it answered with an error; `code`, `message` and `retryable` are its own (message is fit for a viewer)
 *   garbage      it answered something this client does not understand
 * so a caller can tell "the singing system is off" from "the source said no, and here is why".
 */
import { z } from 'zod'
import {
  AbandonResult,
  ActionResult,
  ClaimResult,
  OkResult,
  QueueView,
  RequestResult,
} from './types.ts'
import type { Outcome } from './types.ts'

/** What a service answers with when real work fails (ServiceError of the plugin contract). */
const ServiceFailure = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().default(false),
  }),
})

export type SongServiceErrorKind = 'unreachable' | 'timeout' | 'http' | 'garbage'

export class SongServiceError extends Error {
  constructor(
    message: string,
    readonly kind: SongServiceErrorKind,
    readonly status?: number,
    readonly code?: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'SongServiceError'
  }
}

export interface SongClientOptions {
  /** The service's base URL now, or null while it is not running (asked at every call: it comes and goes). */
  baseUrl(): string | null
  /** For every call but a request. */
  callTimeoutMs: number
  /** Injectable for tests. */
  fetch?: typeof fetch
}

const MAX_BODY_CHARS = 1_000_000

export class SongServiceClient {
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: SongClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    opts: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<T> {
    const base = this.opts.baseUrl()
    if (!base) throw new SongServiceError('the singing service is not running', 'unreachable')
    const timeoutMs = opts.timeoutMs ?? this.opts.callTimeoutMs
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
    let text: string
    let status: number
    try {
      const res = await this.fetchFn(`${base.replace(/\/+$/, '')}${path}`, {
        method,
        headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal,
      })
      status = res.status
      text = (await res.text()).slice(0, MAX_BODY_CHARS)
    } catch (e) {
      if (opts.signal?.aborted) throw new SongServiceError('the call was cancelled', 'unreachable')
      if (timeout.aborted)
        throw new SongServiceError(
          `the singing service did not answer within ${Math.round(timeoutMs / 100) / 10} s`,
          'timeout'
        )
      throw new SongServiceError(
        `cannot reach the singing service: ${(e as Error).message}`,
        'unreachable'
      )
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new SongServiceError(
        `the singing service answered with something that is not JSON (HTTP ${status})`,
        'garbage',
        status
      )
    }
    if (status < 200 || status >= 300) {
      const failure = ServiceFailure.safeParse(json)
      if (failure.success) {
        const { code, message, retryable } = failure.data.error
        throw new SongServiceError(message, 'http', status, code, retryable)
      }
      throw new SongServiceError(`the singing service answered HTTP ${status}`, 'garbage', status)
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success)
      throw new SongServiceError(
        `the singing service answered something this program does not understand (${parsed.error.issues[0]?.path.join('.') || 'the answer'}: ${parsed.error.issues[0]?.message})`,
        'garbage',
        status
      )
    return parsed.data
  }

  queue(signal?: AbortSignal): Promise<QueueView> {
    return this.call('GET', '/queue', QueueView, { ...(signal ? { signal } : {}) })
  }

  /**
   * A viewer's request. The service is told how long the caller will wait (`waitSec`) and answers within that,
   * queueing nothing after it; the HTTP timeout is `slackSec` longer, so that answer can arrive.
   */
  request(input: {
    requestId: string
    keyword: string
    uid: string
    name: string
    waitSec: number
    slackSec: number
  }): Promise<RequestResult> {
    return this.call('POST', '/request', RequestResult, {
      body: {
        request_id: input.requestId,
        keyword: input.keyword,
        requester_uid: input.uid,
        requester_name: input.name,
        wait_s: input.waitSec,
      },
      timeoutMs: (input.waitSec + input.slackSec) * 1000,
    })
  }

  /** The caller gave up on a request: it is taken off the queue, or never put on it. */
  abandon(requestId: string) {
    return this.call('POST', '/abandon', AbandonResult, { body: { request_id: requestId } })
  }

  claim(claimId: string, signal?: AbortSignal): Promise<ClaimResult> {
    return this.call('POST', '/claim', ClaimResult, {
      body: { claim_id: claimId },
      ...(signal ? { signal } : {}),
    })
  }

  done(input: { qid?: number; outcome: Outcome; reason?: string }): Promise<ActionResult> {
    return this.call('POST', '/done', ActionResult, {
      body: {
        ...(input.qid !== undefined ? { qid: input.qid } : {}),
        outcome: input.outcome,
        ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
      },
    })
  }

  skip(): Promise<ActionResult> {
    return this.call('POST', '/skip', ActionResult, { body: {} })
  }

  cancel(input: { uid?: string; position?: number }): Promise<ActionResult> {
    return this.call('POST', '/cancel', ActionResult, {
      body: {
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.uid !== undefined ? { requester_uid: input.uid } : {}),
      },
    })
  }

  remove(qid: number): Promise<ActionResult> {
    return this.call('POST', '/remove', ActionResult, { body: { qid } })
  }

  resumeSource(): Promise<{ ok: boolean }> {
    return this.call('POST', '/source/resume', OkResult, { body: {} })
  }
}
