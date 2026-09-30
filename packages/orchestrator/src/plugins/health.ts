import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect } from 'node:net'
import { ServiceHealth, type PluginManifest } from '@animatus/protocol'

export type HealthSpec = PluginManifest['health']
export type HttpHealthSpec = NonNullable<HealthSpec['http']>

export interface ProbeResult {
  ok: boolean
  /** Why the probe failed, short and free of secrets. Absent when it succeeded. */
  detail?: string
  /** The service's own report, when its body parsed as a ServiceHealth. */
  health?: ServiceHealth
}

const MAX_BODY_BYTES = 256 * 1024
const MAX_DETAIL = 200

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${code}: ${err.message}`.slice(0, MAX_DETAIL) : err.message.slice(0, MAX_DETAIL)
  }
  return String(err).slice(0, MAX_DETAIL)
}

interface HttpAnswer {
  status: number
  /** Empty unless the body was asked for. */
  body: string
}

/**
 * One request to a service. The plain `http`/`https` modules are used on purpose: `fetch` may route
 * loopback traffic through a proxy from the environment, and a health check must never do that.
 */
function call(
  url: URL,
  method: 'GET' | 'HEAD',
  timeoutMs: number,
  wantBody: boolean,
  signal?: AbortSignal
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    let finished = false
    const lib = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = lib(url, {
      method,
      agent: false,
      headers: { connection: 'close', accept: 'application/json' },
    })
    const finish = (settle: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const timer = setTimeout(
      () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)),
      timeoutMs
    )
    const onAbort = () => req.destroy(new Error('aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    req.once('error', (err) => finish(() => reject(err)))
    req.once('response', (res) => {
      const status = res.statusCode ?? 0
      if (!wantBody) {
        res.resume()
        return finish(() => resolve({ status, body: '' }))
      }
      res.setEncoding('utf8')
      let body = ''
      res.on('data', (chunk: string) => {
        body += chunk
        if (body.length > MAX_BODY_BYTES) req.destroy(new Error('the health response is too large'))
      })
      res.once('end', () => finish(() => resolve({ status, body })))
      res.once('error', (err) => finish(() => reject(err)))
    })
    req.end()
  })
}

interface ParsedBody {
  object?: Record<string, unknown>
  health?: ServiceHealth
  error?: string
}

function parseBody(text: string): ParsedBody {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { error: 'the health response is not JSON' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'the health response is not a JSON object' }
  }
  const health = ServiceHealth.safeParse(value)
  return {
    object: value as Record<string, unknown>,
    health: health.success ? health.data : undefined,
  }
}

function pick(object: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(object, path)) return object[path]
  let current: unknown = object
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, part))
      return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function detailOf(object: Record<string, unknown> | undefined): string {
  const detail = object?.detail
  return typeof detail === 'string' && detail !== '' ? `: ${detail.slice(0, MAX_DETAIL)}` : ''
}

/**
 * HTTP health check.
 *  - The status must equal `expect_status`.
 *  - With `ready_field` set (the default is `ready`) the body must be a JSON object whose field of that
 *    name (a dotted path works) is truthy, and `ok` must not be `false`.
 *  - With `ready_field: null` the body is never read: only the status counts (for third-party servers
 *    that offer no health endpoint and can only be probed with a page such as `/docs`).
 *  - `HEAD` has no body, so it is status-only as well.
 */
export async function probeHttp(
  baseUrl: string,
  http: HttpHealthSpec,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProbeResult> {
  const path = http.path.startsWith('/') ? http.path : `/${http.path}`
  const readBody = http.method === 'GET' && http.ready_field !== null
  let answer: HttpAnswer
  try {
    answer = await call(
      new URL(`${baseUrl.replace(/\/+$/, '')}${path}`),
      http.method,
      timeoutMs,
      readBody,
      signal
    )
  } catch (err) {
    return { ok: false, detail: describeError(err) }
  }

  const parsed = readBody ? parseBody(answer.body) : undefined
  if (answer.status !== http.expect_status) {
    return {
      ok: false,
      detail: `expected HTTP ${http.expect_status}, got ${answer.status}${detailOf(parsed?.object)}`,
      health: parsed?.health,
    }
  }
  if (!readBody || parsed === undefined) return { ok: true }
  if (!parsed.object) return { ok: false, detail: parsed.error }
  if (parsed.object.ok === false) {
    return {
      ok: false,
      detail: `the service reports ok=false${detailOf(parsed.object)}`,
      health: parsed.health,
    }
  }
  const field = http.ready_field
  if (field !== null && !pick(parsed.object, field)) {
    return {
      ok: false,
      detail: `the service reports ${field}=${JSON.stringify(pick(parsed.object, field) ?? null)}${detailOf(parsed.object)}`,
      health: parsed.health,
    }
  }
  return { ok: true, health: parsed.health }
}

/** A TCP connect that succeeds means the port is open. */
export function probeTcp(
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, detail: 'aborted' })
    const socket = connect({ host: host.replace(/^\[|\]$/g, ''), port })
    let finished = false
    const finish = (result: ProbeResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, detail: `no connection within ${timeoutMs} ms` }),
      timeoutMs
    )
    const onAbort = () => finish({ ok: false, detail: 'aborted' })
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => finish({ ok: true }))
    socket.once('error', (err) => finish({ ok: false, detail: describeError(err) }))
  })
}

/**
 * Runs the manifest's health check against a service. Never throws. When both `http` and `tcp` are
 * configured, both must pass.
 */
export async function probeHealth(
  health: HealthSpec,
  baseUrl: string,
  signal?: AbortSignal
): Promise<ProbeResult> {
  if (health.tcp) {
    const url = new URL(baseUrl)
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    const tcp = await probeTcp(url.hostname, port, health.timeout_ms, signal)
    if (!tcp.ok || !health.http) return tcp
  }
  if (health.http) return probeHttp(baseUrl, health.http, health.timeout_ms, signal)
  return { ok: false, detail: 'the manifest configures no health check' }
}
