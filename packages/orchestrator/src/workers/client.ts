/**
 * The orchestrator's side of the Worker protocol (see `@animatus/protocol` worker.ts and docs/workers.md).
 *
 * Every call has a time limit (the older agents' tool calls had none, so one stuck call froze a whole game), every answer
 * is checked against the schema and read only up to a size limit, and every failure is a `WorkerError` with a code the
 * caller can act on; nothing here throws anything else.
 */
import {
  WORKER_MAX_COMMAND_CHARS,
  WorkerAck,
  WorkerErrorBody,
  WorkerEventsResponse,
  WorkerState,
} from '@animatus/protocol'
import type { z } from 'zod'

export type WorkerErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'bad_response'
  | 'not_online'
  | 'bad_request'
  | 'too_large'
  | 'refused'
  | 'wrong_worker'

export class WorkerError extends Error {
  readonly code: WorkerErrorCode
  /** The HTTP status, 0 when there was no answer. */
  readonly status: number
  constructor(code: WorkerErrorCode, message: string, status = 0) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.status = status
  }
}

/** What the game mode needs from a worker, whichever protocol it speaks. */
export interface WorkerApi {
  /** `worker` for the protocol of worker.ts; `legacy` for an older agent behind the adapter. */
  readonly kind: 'worker' | 'legacy'
  state(): Promise<WorkerState>
  events(after: number, epoch: string | null): Promise<WorkerEventsResponse>
  command(text: string): Promise<void>
  /** Resolves with whether the worker is paused afterwards. */
  pause(paused: boolean): Promise<boolean>
  forget(): Promise<void>
  trace(limit?: number): Promise<unknown[]>
}

export interface WorkerHttpOptions {
  /** `http://127.0.0.1:<port>`, no trailing path. */
  baseUrl: string
  /** For tests. */
  fetch?: typeof fetch
  /** Per call. Default 5 s. */
  timeoutMs?: number
}

const MAX_BODY_BYTES = 1_000_000

/** One call: the method and path, a JSON body for POST, the time limit, and the answer as parsed JSON. */
export class WorkerHttp {
  private readonly base: string
  private readonly doFetch: typeof fetch
  private readonly timeoutMs: number

  constructor(o: WorkerHttpOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '')
    this.doFetch = o.fetch ?? ((...a) => globalThis.fetch(...a))
    this.timeoutMs = o.timeoutMs ?? 5000
  }

  async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: Response
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      })
    } catch (e) {
      const name = (e as Error).name
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new WorkerError(
          'timeout',
          `the worker did not answer ${path} within ${this.timeoutMs} ms`
        )
      throw new WorkerError(
        'unreachable',
        `cannot reach the worker (${(e as Error).message.split('\n')[0]})`
      )
    }
    let text: string
    try {
      text = await this.readCapped(res)
    } catch (e) {
      if (e instanceof WorkerError) throw e
      const name = (e as Error).name
      throw new WorkerError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable',
        `the worker's answer to ${path} did not arrive whole`
      )
    }
    let json: unknown = undefined
    try {
      json = text === '' ? {} : JSON.parse(text)
    } catch {
      if (res.ok)
        throw new WorkerError('bad_response', `the answer to ${path} is not JSON`, res.status)
    }
    if (!res.ok) throw this.failure(res.status, json)
    return json
  }

  private async readCapped(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > MAX_BODY_BYTES)
      throw new WorkerError('bad_response', 'the worker sent a very large answer', res.status)
    const text = await res.text()
    if (text.length > MAX_BODY_BYTES)
      throw new WorkerError('bad_response', 'the worker sent a very large answer', res.status)
    return text
  }

  private failure(status: number, json: unknown): WorkerError {
    const body = WorkerErrorBody.safeParse(json)
    // the worker's own words are shown; a body of another shape says only the status
    const said = body.success ? body.data.message : `the worker answered ${status}`
    if (status === 409) return new WorkerError('not_online', said, status)
    if (status === 400) return new WorkerError('bad_request', said, status)
    if (status === 413) return new WorkerError('too_large', said, status)
    return new WorkerError('refused', said, status)
  }

  /** `call`, with the answer checked against a schema. */
  async get<S extends z.ZodType>(schema: S, path: string): Promise<z.infer<S>> {
    return this.check(schema, path, await this.call('GET', path))
  }

  async post<S extends z.ZodType>(schema: S, path: string, body: unknown): Promise<z.infer<S>> {
    return this.check(schema, path, await this.call('POST', path, body))
  }

  private check<S extends z.ZodType>(schema: S, path: string, json: unknown): z.infer<S> {
    const r = schema.safeParse(json)
    if (!r.success)
      throw new WorkerError(
        'bad_response',
        `the answer to ${path} is not what the protocol says (${r.error.issues[0]?.path.join('.') || 'body'}: ${r.error.issues[0]?.message ?? 'invalid'})`
      )
    return r.data as z.infer<S>
  }
}

const enc = encodeURIComponent

/** A worker that speaks the protocol. `expect` names the worker the caller believes it is talking to. */
export class WorkerClient implements WorkerApi {
  readonly kind = 'worker' as const
  private readonly http: WorkerHttp

  constructor(o: WorkerHttpOptions & { expect?: string }) {
    this.http = new WorkerHttp(o)
    this.expect = o.expect
  }
  private readonly expect: string | undefined

  async state(): Promise<WorkerState> {
    const s = await this.http.get(WorkerState, '/worker/state')
    if (this.expect !== undefined && s.worker !== this.expect)
      throw new WorkerError(
        'wrong_worker',
        `this is the worker "${s.worker}", not "${this.expect}"`
      )
    return s
  }

  events(after: number, epoch: string | null): Promise<WorkerEventsResponse> {
    const q = `after=${Math.max(0, Math.trunc(after))}${epoch ? `&epoch=${enc(epoch)}` : ''}`
    return this.http.get(WorkerEventsResponse, `/worker/events?${q}`)
  }

  async command(text: string): Promise<void> {
    const t = text.trim()
    if (t === '' || t.length > WORKER_MAX_COMMAND_CHARS)
      throw new WorkerError(
        'bad_request',
        `a directive is 1 to ${WORKER_MAX_COMMAND_CHARS} characters`
      )
    await this.http.post(WorkerAck, '/worker/command', { text: t })
  }

  async pause(paused: boolean): Promise<boolean> {
    return (await this.http.post(WorkerAck, '/worker/pause', { paused })).paused
  }

  async forget(): Promise<void> {
    await this.http.post(WorkerAck, '/worker/forget', {})
  }

  async trace(limit = 20): Promise<unknown[]> {
    const r = await this.http.call(
      'GET',
      `/worker/trace?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}`
    )
    return Array.isArray(r) ? r.slice(-200) : []
  }
}
