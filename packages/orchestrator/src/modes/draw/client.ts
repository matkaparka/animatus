/**
 * The image service (plugins/forge) as the draw mode calls it. The contract is written down in docs/mode-draw.md.
 *
 * Every answer is checked: a body that is not what the service promises is an error, never an empty picture, and a
 * failure of the service (a non-2xx answer with `{error: {code, message, retryable}}`) keeps its own words.
 */
import { z } from 'zod'

export class ForgeCallError extends Error {
  constructor(
    message: string,
    /** The service's error code, or `unreachable`, `timeout`, `bad_answer`. */
    readonly code: string,
    readonly retryable = false,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ForgeCallError'
  }
}

const Health = z.object({
  ok: z.boolean(),
  ready: z.boolean(),
  detail: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
})
export type ForgeHealth = z.infer<typeof Health>

const Catalog = z.object({
  checkpoints: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      family: z.string().nullable(),
      allowed: z.boolean(),
      why_not: z.string().optional(),
    })
  ),
  loras: z.array(
    z.object({ name: z.string(), alias: z.string().optional(), allowed: z.boolean() })
  ),
  families: z.array(z.string()).default([]),
  max_long_side: z.number().optional(),
})
export type ForgeCatalog = z.infer<typeof Catalog>

export interface GeneratePayload {
  checkpoint: string
  prompt: string
  negative_prompt: string
  width: number
  height: number
  steps: number
  cfg_scale: number
  sampler_name: string
  scheduler?: string
  seed: number
  loras: { name: string; weight: number }[]
  route: string
}

const Generated = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    image_b64: z.string().min(1),
    thumb_b64: z.string().nullable().optional(),
    width: z.number(),
    height: z.number(),
    seed: z.number(),
    attempts: z.number(),
    checkpoint: z.string().optional(),
    family: z.string().optional(),
  }),
  z.object({ status: z.literal('rejected'), reason: z.string() }),
  z.object({ status: z.literal('blocked'), reason: z.string(), attempts: z.number().optional() }),
])
export type Generated = z.infer<typeof Generated>

const ServiceError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().default(false),
  }),
})

export interface ForgeClientOptions {
  /** Injectable for tests. */
  fetch?: typeof fetch
  /** One picture: how long to wait for the service before giving up on it. */
  generateTimeoutMs: number
}

const oneLine = (s: string, max = 300): string => s.replace(/\s+/g, ' ').trim().slice(0, max)

export class ForgeClient {
  private readonly fetchFn: typeof fetch
  private readonly base: string

  constructor(
    baseUrl: string,
    private readonly opts: ForgeClientOptions
  ) {
    this.base = baseUrl.replace(/\/+$/, '')
    this.fetchFn = opts.fetch ?? globalThis.fetch
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    /** Statuses whose body is an answer of the contract and not an error (`/health` says 503 when broken). */
    answers: readonly number[] = []
  ): Promise<{ status: number; json: unknown }> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const both = signal ? AbortSignal.any([signal, timeout]) : timeout
    let res: Response
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        signal: both,
        ...(body !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      })
    } catch (e) {
      if (signal?.aborted) throw e
      if (timeout.aborted)
        throw new ForgeCallError(
          `the image service did not answer ${method} ${path} within ${Math.round(timeoutMs / 1000)} s`,
          'timeout',
          true
        )
      const cause = (e as { cause?: { code?: string; message?: string } }).cause
      throw new ForgeCallError(
        `cannot reach the image service (${cause?.code ?? cause?.message ?? (e as Error).message})`,
        'unreachable',
        true
      )
    }
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      if (signal?.aborted) throw e
      throw new ForgeCallError(
        `the image service's answer to ${method} ${path} was cut off`,
        'bad_answer',
        true
      )
    }
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      // handled below: an error answer may be plain text, a good one may not
    }
    if (!res.ok && !answers.includes(res.status)) {
      const err = ServiceError.safeParse(json)
      if (err.success)
        throw new ForgeCallError(
          err.data.error.message,
          err.data.error.code,
          err.data.error.retryable,
          res.status
        )
      throw new ForgeCallError(
        `the image service answered ${res.status} to ${method} ${path}: ${oneLine(text)}`,
        'bad_answer',
        res.status >= 500,
        res.status
      )
    }
    if (json === null || typeof json !== 'object')
      throw new ForgeCallError(
        `the image service answered ${method} ${path} with something that is not JSON`,
        'bad_answer'
      )
    return { status: res.status, json }
  }

  /** An unhealthy service is an answer (`ok: false` with its reason in `detail`), not an error; only a service that cannot be reached is. */
  async health(signal?: AbortSignal): Promise<ForgeHealth> {
    const { json } = await this.call('GET', '/health', undefined, 5000, signal, [503])
    return this.parse(Health, json, 'GET /health')
  }

  async catalog(signal?: AbortSignal): Promise<ForgeCatalog> {
    const { json } = await this.call('GET', '/catalog', undefined, 20_000, signal)
    return this.parse(Catalog, json, 'GET /catalog')
  }

  async setMaxLongSide(value: number, signal?: AbortSignal): Promise<void> {
    await this.call('POST', '/config', { max_long_side: value }, 10_000, signal)
  }

  async generate(payload: GeneratePayload, signal?: AbortSignal): Promise<Generated> {
    const { json } = await this.call(
      'POST',
      '/generate',
      payload,
      this.opts.generateTimeoutMs,
      signal
    )
    return this.parse(Generated, json, 'POST /generate')
  }

  private parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
    const parsed = schema.safeParse(json)
    if (!parsed.success)
      throw new ForgeCallError(
        `the image service answered ${what} with a body this program does not understand (${parsed.error.issues[0]?.path.join('.') || 'root'}: ${parsed.error.issues[0]?.message})`,
        'bad_answer'
      )
    return parsed.data
  }
}
