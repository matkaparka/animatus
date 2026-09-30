/**
 * The route table of the console API. Each entry validates its own parameters and query, calls exactly one
 * method of the `ConsoleBackend`, and validates what comes back with the contract schema before it is sent.
 * Transport concerns (token, Host, Origin, rate limit, body reading) live in `server.ts`.
 */
import type { z } from 'zod'
import {
  ConfigResponse,
  EventsResponse,
  InjectRequest,
  ModeAction,
  ModeId,
  ModeRequest,
  ModeView,
  ModesResponse,
  OkResponse,
  PluginAction,
  PluginId,
  PluginView,
  PluginsResponse,
  SayRequest,
  SecretName,
  SecretPut,
  SecretView,
  SecretsResponse,
  StatusView,
  TracesResponse,
} from '@animatus/protocol'
import { ApiFailure } from './backend.ts'
import type { ConsoleBackend } from './backend.ts'
import { sanitizeConfig } from './config.ts'
import { clampText, describeIssues } from './http.ts'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface RouteRequest {
  /** Percent-decoded path parameters (`:id`, `:name`). Not yet validated. */
  params: Readonly<Record<string, string>>
  query: URLSearchParams
  /** The validated body of a route that declares one; `{}` when an optional body was left out. */
  body: unknown
}

export type RouteResult = { kind: 'json'; body: unknown } | { kind: 'text'; body: string }

export interface BodySpec {
  schema: z.ZodObject
  /** An empty body counts as `{}` (defaults apply). */
  optional: boolean
  /** Secret-bearing: error messages never name fields or echo anything. */
  sensitive?: boolean
}

export interface Route {
  method: HttpMethod
  /** Segments starting with `:` are parameters. */
  pattern: string
  body?: BodySpec
  handle(req: RouteRequest, backend: ConsoleBackend): Promise<RouteResult>
}

/** The backend answered with something that breaks the contract: a bug, reported as 500 and logged. */
export class BackendContractError extends Error {
  constructor(what: string, error: z.ZodError) {
    super(`${what}: ${describeIssues(error)}`)
    this.name = 'BackendContractError'
  }
}

function checked<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new BackendContractError(what, result.error)
  return result.data as z.infer<S>
}

// ─────────────────────────────── parameters ───────────────────────────────

function idParam(params: RouteRequest['params'], schema: z.ZodType<string>, what: string): string {
  const parsed = schema.safeParse(params.id)
  // The message must not echo the value: for secrets a mix-up between name and value would print the value.
  if (!parsed.success) throw new ApiFailure('invalid_id', `not a valid ${what}`, 400)
  return parsed.data
}

function secretNameParam(params: RouteRequest['params']): string {
  const parsed = SecretName.safeParse(params.name)
  if (!parsed.success)
    throw new ApiFailure(
      'invalid_name',
      'not a valid secret name (lowercase letters, digits and _)',
      400
    )
  return parsed.data
}

/** A whole number from the query string: `def` when absent, refused when not a number or below `min`, capped at `max`. */
function intQuery(
  query: URLSearchParams,
  name: string,
  def: number,
  min: number,
  max: number
): number {
  const raw = query.get(name)
  if (raw === null || raw === '') return def
  if (!/^\d{1,9}$/.test(raw))
    throw new ApiFailure('invalid_query', `${name} must be a whole number`, 400)
  const n = Number(raw)
  if (n < min) throw new ApiFailure('invalid_query', `${name} must be at least ${min}`, 400)
  return Math.min(n, max)
}

export const LOG_LINES_DEFAULT = 200
export const LOG_LINES_MAX = 1000
const LOG_LINE_MAX_CHARS = 4000
export const EVENTS_DEFAULT = 100
export const EVENTS_MAX = 500
export const TRACES_DEFAULT = 50
export const TRACES_MAX = 200

const json = (body: unknown): RouteResult => ({ kind: 'json', body })
const ok = (): RouteResult => json(OkResponse.parse({ ok: true }))

// ─────────────────────────────── the table ───────────────────────────────

const pluginActionRoutes: Route[] = PluginAction.options.map((action) => ({
  method: 'POST' as const,
  pattern: `/api/plugins/:id/${action}`,
  async handle({ params }, backend) {
    const id = idParam(params, PluginId, 'plugin id')
    return json(checked(PluginView, await backend.pluginAction(id, action), 'pluginAction'))
  },
}))

const modeActionRoutes: Route[] = ModeAction.options.map((action) => ({
  method: 'POST' as const,
  pattern: `/api/modes/:id/${action}`,
  body: { schema: ModeRequest, optional: true },
  async handle({ params, body }, backend) {
    const id = idParam(params, ModeId, 'mode id')
    return json(
      checked(ModeView, await backend.modeAction(id, action, body as ModeRequest), 'modeAction')
    )
  },
}))

export const ROUTES: readonly Route[] = [
  {
    method: 'GET',
    pattern: '/api/status',
    async handle(_req, backend) {
      return json(checked(StatusView, await backend.status(), 'status'))
    },
  },

  {
    method: 'GET',
    pattern: '/api/plugins',
    async handle(_req, backend) {
      return json(checked(PluginsResponse, { plugins: await backend.listPlugins() }, 'listPlugins'))
    },
  },
  ...pluginActionRoutes,
  {
    method: 'GET',
    pattern: '/api/plugins/:id/logs',
    async handle({ params, query }, backend) {
      const id = idParam(params, PluginId, 'plugin id')
      const lines = intQuery(query, 'lines', LOG_LINES_DEFAULT, 1, LOG_LINES_MAX)
      const raw = await backend.pluginLogs(id, lines)
      if (!Array.isArray(raw) || raw.some((line) => typeof line !== 'string')) {
        throw new Error('pluginLogs did not return an array of strings')
      }
      const tail = raw
        .slice(-lines)
        .map((line) => clampText(line.replace(/\r?\n/g, ' '), LOG_LINE_MAX_CHARS))
      return { kind: 'text', body: tail.length === 0 ? '' : `${tail.join('\n')}\n` }
    },
  },

  {
    method: 'GET',
    pattern: '/api/modes',
    async handle(_req, backend) {
      return json(checked(ModesResponse, { modes: await backend.listModes() }, 'listModes'))
    },
  },
  ...modeActionRoutes,

  {
    method: 'GET',
    pattern: '/api/secrets',
    async handle(_req, backend) {
      return json(checked(SecretsResponse, { secrets: await backend.listSecrets() }, 'listSecrets'))
    },
  },
  {
    method: 'PUT',
    pattern: '/api/secrets/:name',
    body: { schema: SecretPut, optional: false, sensitive: true },
    async handle({ params, body }, backend) {
      const name = secretNameParam(params)
      const { value } = body as z.infer<typeof SecretPut>
      return json(checked(SecretView, await backend.putSecret(name, value), 'putSecret'))
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/secrets/:name',
    async handle({ params }, backend) {
      const name = secretNameParam(params)
      return json(checked(SecretView, await backend.deleteSecret(name), 'deleteSecret'))
    },
  },

  {
    method: 'POST',
    pattern: '/api/say',
    body: { schema: SayRequest, optional: false },
    async handle({ body }, backend) {
      await backend.say(body as SayRequest)
      return ok()
    },
  },
  {
    method: 'POST',
    pattern: '/api/inject',
    body: { schema: InjectRequest, optional: false },
    async handle({ body }, backend) {
      await backend.inject(body as InjectRequest)
      return ok()
    },
  },
  {
    method: 'POST',
    pattern: '/api/stop',
    async handle(_req, backend) {
      await backend.stopSpeech()
      return ok()
    },
  },

  {
    method: 'GET',
    pattern: '/api/events',
    async handle({ query }, backend) {
      const limit = intQuery(query, 'limit', EVENTS_DEFAULT, 1, EVENTS_MAX)
      const events = await backend.recentEvents(limit)
      const body = checked(
        EventsResponse,
        { events: Array.isArray(events) ? events.slice(-limit) : events },
        'recentEvents'
      )
      return json(body)
    },
  },
  {
    method: 'GET',
    pattern: '/api/traces',
    async handle({ query }, backend) {
      const limit = intQuery(query, 'limit', TRACES_DEFAULT, 1, TRACES_MAX)
      const traces = await backend.recentTraces(limit)
      const body = checked(
        TracesResponse,
        { traces: Array.isArray(traces) ? traces.slice(-limit) : traces },
        'recentTraces'
      )
      return json(body)
    },
  },
  {
    method: 'GET',
    pattern: '/api/config',
    async handle(_req, backend) {
      return json(
        checked(ConfigResponse, { config: sanitizeConfig(await backend.config()) }, 'config')
      )
    },
  },
]

// ─────────────────────────────── matching ───────────────────────────────

export type RouteMatch =
  | { kind: 'match'; route: Route; params: Record<string, string> }
  | { kind: 'not_found' }
  | { kind: 'method_not_allowed'; allow: HttpMethod[] }
  | { kind: 'bad_path' }

const compiled = ROUTES.map((route) => ({ route, parts: route.pattern.split('/') }))

/**
 * Finds the route for a raw request path (percent-encoded, no query). Literal segments must match
 * exactly; parameters are percent-decoded once. A trailing slash or an empty segment matches nothing.
 */
export function matchRoute(method: string, rawPath: string): RouteMatch {
  const parts = rawPath.split('/')
  const byPath: Array<{ route: Route; params: Record<string, string> }> = []
  for (const { route, parts: pattern } of compiled) {
    if (pattern.length !== parts.length) continue
    const params: Record<string, string> = {}
    let fits = true
    for (let i = 0; i < pattern.length; i++) {
      const want = pattern[i] as string
      const got = parts[i] as string
      if (want.startsWith(':')) {
        if (got === '') {
          fits = false
          break
        }
        try {
          params[want.slice(1)] = decodeURIComponent(got)
        } catch {
          return { kind: 'bad_path' }
        }
      } else if (want !== got) {
        fits = false
        break
      }
    }
    if (fits) byPath.push({ route, params })
  }
  if (byPath.length === 0) return { kind: 'not_found' }
  const hit = byPath.find((candidate) => candidate.route.method === method)
  if (hit) return { kind: 'match', route: hit.route, params: hit.params }
  return { kind: 'method_not_allowed', allow: [...new Set(byPath.map((c) => c.route.method))] }
}
