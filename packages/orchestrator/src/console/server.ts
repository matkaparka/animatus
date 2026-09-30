/**
 * The console server: one HTTP port on 127.0.0.1 that serves the built console UI, the JSON API under
 * `/api/*` and the live socket at `/api/ws`.
 *
 * Security posture (see AGENTS.md and docs/console.md):
 *  - loopback only; every request must carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>`
 *    (DNS-rebinding defence) and, when it has an `Origin`, one of this server's own origins or a
 *    configured extra origin (a page on another site is refused even with a valid token);
 *  - every `/api/*` request needs the per-launch token, compared in constant time; ten failures a minute
 *    from one address earn a minute of 429s;
 *  - static files carry no token, the token travels in the URL fragment that browsers never send;
 *  - no CORS header is ever sent, bodies are JSON only and capped at 64 KiB, secrets are write-only and
 *    never appear in a response or a log line, the token never appears in a log line.
 */
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import {
  CONSOLE_STATUS_INTERVAL_MS,
  CONSOLE_SUBPROTOCOL,
  CONSOLE_WS_PATH,
  StatusView,
} from '@animatus/protocol'
import type { ConsoleEvent } from '@animatus/protocol'
import { ApiFailure, noopConsoleLogger } from './backend.ts'
import type { ConsoleBackend, ConsoleLogger } from './backend.ts'
import {
  FailureLimiter,
  assertValidToken,
  bearerToken,
  createTokenVerifier,
  generateToken,
  parseSubprotocols,
  tokenFromSubprotocols,
} from './auth.ts'
import { ConsoleHub } from './hub.ts'
import {
  ClientAborted,
  clampText,
  describeIssues,
  parseStrict,
  readJsonBody,
  sendApiError,
  sendJson,
  sendPlain,
} from './http.ts'
import {
  addressKey,
  allowedOrigins,
  baseSecurityHeaders,
  isAllowedHost,
  isAllowedOrigin,
  parseExtraOrigins,
  pathForLog,
  rawPathOf,
  rawQueryOf,
} from './policy.ts'
import { BackendContractError, matchRoute } from './routes.ts'
import type { Route } from './routes.ts'
import { createStaticHandler } from './static.ts'

// ─────────────────────────────── options and result ───────────────────────────────

export interface ConsoleServerOptions {
  /** 0 picks a free port (read it from `server.port` after `start()`). */
  port: number
  /** Only loopback is supported; anything else throws. */
  host?: '127.0.0.1'
  /** Default: 32 random bytes, base64url. A given token must be 8 to 128 characters from A-Z a-z 0-9 . _ ~ - */
  token?: string
  /** The console build (`packages/console/dist`). Without it, or before it exists, pages answer 503. */
  staticDir?: string
  backend: ConsoleBackend
  /** Extra allowed origins, e.g. a Vite dev server: `http://127.0.0.1:5174`. Validated at construction. */
  extraOrigins?: string[]
  logger?: ConsoleLogger
  /** Clock of the failure limiter. Default `Date.now`. */
  now?: () => number
  /** How often `status` is pushed. Default 2000. */
  statusIntervalMs?: number
  /** Heartbeat of the live sockets. Default 15 000. */
  pingIntervalMs?: number
  /** Concurrent live sockets. Default 16. */
  maxClients?: number
}

export interface ConsoleServer {
  /** `http://127.0.0.1:<port>`; the port is the real one after `start()`. */
  readonly url: string
  /** `url` plus `#token=...`: the address to open, and the one to print at start-up. Secret: do not log it. */
  readonly openUrl: string
  readonly port: number
  readonly token: string
  readonly httpServer: http.Server
  /** Live sockets right now. */
  readonly clientCount: number
  start(): Promise<void>
  /** Closes every socket and the listener. A stopped server is not restarted; make a new one. */
  stop(): Promise<void>
  /** Validates and delivers an event to every connected console. */
  publish(event: ConsoleEvent): void
}

/** Frames a console may send are ignored, so anything bigger than a ping-sized message is abuse. */
const MAX_INCOMING_FRAME_BYTES = 4096

const clip = (value: string | undefined, max = 100): string => clampText(value ?? '', max)

function apiStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
}

/**
 * Masks a submitted secret in a text that is about to leave the process. A correct backend never puts the
 * value anywhere, so this is the last line of defence for one that does (raw, JSON-escaped and
 * URL-encoded forms). Values shorter than four characters are not masked: they would mangle ordinary text.
 */
export function maskSecret(text: string, value: string): string {
  if (value.length < 4) return text
  let out = text
  for (const variant of new Set([
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
  ])) {
    if (variant !== '') out = out.split(variant).join('***')
  }
  return out
}

/** Error text for the log. For routes that carry secrets only the error's name is logged. */
function describeError(err: unknown, sensitive: boolean): string {
  if (!(err instanceof Error)) return 'a non-error value was thrown'
  return sensitive ? err.name : `${err.name}: ${err.message}`
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  statusText: string,
  code: string,
  message: string,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify({ error: { code, message } })
  const lines = [
    `HTTP/1.1 ${status} ${statusText}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    ...Object.entries(baseSecurityHeaders()).map(([name, value]) => `${name}: ${value}`),
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ]
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`)
  // Flush the answer, but never keep a half-open socket around.
  const timer = setTimeout(() => socket.destroy(), 1000)
  timer.unref()
  socket.once('close', () => clearTimeout(timer))
}

// ─────────────────────────────── the server ───────────────────────────────

export function createConsoleServer(opts: ConsoleServerOptions): ConsoleServer {
  if (opts.host !== undefined && opts.host !== '127.0.0.1') {
    throw new Error(
      `the console server only binds to 127.0.0.1, got host ${JSON.stringify(opts.host)}`
    )
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new RangeError(`invalid port ${opts.port}`)
  }
  const token = opts.token ?? generateToken()
  assertValidToken(token)
  const extraOrigins = parseExtraOrigins(opts.extraOrigins ?? [])
  const logger = opts.logger ?? noopConsoleLogger
  const backend = opts.backend
  const maxClients = opts.maxClients ?? 16
  const verifyToken = createTokenVerifier(token)
  const limiter = new FailureLimiter({ now: opts.now })
  const handleStatic = createStaticHandler(opts.staticDir)
  let boundPort = opts.port
  let origins = allowedOrigins(boundPort, extraOrigins)

  /** A status snapshot that satisfies the contract, or an error. */
  async function loadStatus(): Promise<StatusView> {
    const parsed = StatusView.safeParse(await backend.status())
    if (!parsed.success) throw new BackendContractError('status', parsed.error)
    return parsed.data
  }

  const hub = new ConsoleHub({
    loadStatus,
    logger,
    statusIntervalMs: opts.statusIntervalMs ?? CONSOLE_STATUS_INTERVAL_MS,
    pingIntervalMs: opts.pingIntervalMs ?? 15_000,
  })

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INCOMING_FRAME_BYTES,
    perMessageDeflate: false,
    // Only the console subprotocol is ever selected; the `token.<token>` entry is never echoed back.
    handleProtocols: (protocols) =>
      protocols.has(CONSOLE_SUBPROTOCOL) ? CONSOLE_SUBPROTOCOL : false,
  })

  // ─────────────────────────────── HTTP ───────────────────────────────

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    rawPath: string
  ): Promise<void> {
    const address = addressKey(req.socket.remoteAddress)

    // A blocked address gets 429 whatever it presents: admitting the right token would tell a guesser
    // when it guessed right.
    const waitMs = limiter.retryAfterMs(address)
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000)
      logger('debug', 'refused a console request: address is blocked', { address })
      return sendApiError(
        res,
        429,
        'rate_limited',
        `Too many failed attempts. Try again in ${seconds} seconds.`,
        {
          'Retry-After': String(seconds),
        }
      )
    }
    if (!verifyToken(bearerToken(req.headers.authorization))) {
      const tripped = limiter.recordFailure(address)
      logger(
        'warn',
        tripped
          ? 'too many failed console logins, blocking this address for a while'
          : 'refused a console request: missing or wrong token',
        {
          address,
          path: pathForLog(rawPath),
        }
      )
      return sendApiError(res, 401, 'unauthorized', 'A valid bearer token is required.', {
        'WWW-Authenticate': 'Bearer',
      })
    }

    // Only now does the caller learn which routes exist.
    const match = matchRoute(req.method ?? '', rawPath)
    if (match.kind === 'bad_path')
      return sendApiError(res, 400, 'invalid_path', 'The path contains an invalid percent-escape.')
    if (match.kind === 'not_found') return sendApiError(res, 404, 'not_found', 'No such route.')
    if (match.kind === 'method_not_allowed') {
      const allow = match.allow.join(', ')
      return sendApiError(res, 405, 'method_not_allowed', `This route answers ${allow}.`, {
        Allow: allow,
      })
    }

    const { route, params } = match
    const sensitive = route.pattern.startsWith('/api/secrets')
    // The value being stored, held only to keep it out of anything this request answers or logs.
    let submitted: string | undefined
    try {
      const body = await readRouteBody(req, route)
      if (route.pattern === '/api/secrets/:name' && route.method === 'PUT')
        submitted = (body as { value?: string }).value
      const query = new URLSearchParams(rawQueryOf(req.url))
      const result = await route.handle({ params, query, body }, backend)
      if (result.kind === 'text') return sendPlain(res, 200, result.body)
      if (
        submitted !== undefined &&
        maskSecret(JSON.stringify(result.body), submitted) !== JSON.stringify(result.body)
      ) {
        logger(
          'error',
          'a backend answered a secret upload with the value in it; the answer was dropped',
          { route: route.pattern }
        )
        return sendApiError(
          res,
          500,
          'internal_error',
          'The orchestrator could not complete the request.'
        )
      }
      return sendJson(res, 200, result.body)
    } catch (err) {
      if (err instanceof ClientAborted || res.destroyed || res.writableEnded) return
      if (err instanceof ApiFailure) {
        const status = apiStatus(err.httpStatus)
        logger(status >= 500 ? 'warn' : 'debug', 'console request refused', {
          route: route.pattern,
          status,
          code: maskSecret(err.code, submitted ?? ''),
          ...(sensitive ? {} : { message: clip(err.message, 200) }),
        })
        const code = submitted === undefined ? err.code : maskSecret(err.code, submitted)
        const message = submitted === undefined ? err.message : maskSecret(err.message, submitted)
        return sendApiError(res, status, code, message)
      }
      logger(
        'error',
        err instanceof BackendContractError
          ? 'the backend broke the console contract'
          : 'console request failed',
        {
          route: route.pattern,
          err: describeError(err, sensitive),
        }
      )
      return sendApiError(
        res,
        500,
        'internal_error',
        'The orchestrator could not complete the request.'
      )
    }
  }

  /** The validated body of a route that declares one; `{}` for an optional body left out; undefined otherwise. */
  async function readRouteBody(req: IncomingMessage, route: Route): Promise<unknown> {
    if (route.method !== 'POST' && route.method !== 'PUT') return undefined
    const body = await readJsonBody(req)
    if (!route.body) {
      const empty =
        !body.present ||
        (typeof body.value === 'object' &&
          body.value !== null &&
          !Array.isArray(body.value) &&
          Object.keys(body.value).length === 0)
      if (!empty) throw new ApiFailure('unexpected_body', 'This route takes no body.', 400)
      return undefined
    }
    if (!body.present) {
      if (!route.body.optional)
        throw new ApiFailure('body_required', 'This route needs a JSON body.', 400)
      return parseStrict(route.body.schema, {}, 'the request body', !route.body.sensitive)
    }
    return parseStrict(route.body.schema, body.value, 'the request body', !route.body.sensitive)
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawPath = rawPathOf(req.url)
    if (rawPath === null) return sendPlain(res, 400, 'Bad request')
    const isApi = rawPath === '/api' || rawPath.startsWith('/api/')
    const refuse = (status: number, code: string, message: string) =>
      isApi
        ? sendApiError(res, status, code, message)
        : sendPlain(res, status, message, {}, req.method === 'HEAD')

    // DNS rebinding: a page on another name that resolves to 127.0.0.1 is same-origin for itself, so the
    // only defence is to refuse any Host that is not one of ours.
    if (!isAllowedHost(req.headers.host, boundPort)) {
      logger('warn', 'refused a console request: Host header not allowed', {
        host: clip(req.headers.host),
      })
      return refuse(403, 'forbidden_host', 'Forbidden: this Host header is not allowed.')
    }
    // A page on another site is refused even with a valid token. No Origin (non-browser tools, top-level
    // navigations) passes here; API routes still need the token.
    if (!isAllowedOrigin(req.headers.origin, origins)) {
      logger('warn', 'refused a console request: Origin not allowed', {
        origin: clip(req.headers.origin),
      })
      return refuse(403, 'forbidden_origin', 'Forbidden: this Origin is not allowed.')
    }
    if (!isApi) return handleStatic(req, res, rawPath)
    return handleApi(req, res, rawPath)
  }

  const httpServer = http.createServer(
    // Slow headers or bodies are cut off, idle keep-alive sockets do not pile up.
    { headersTimeout: 15_000, requestTimeout: 30_000, keepAliveTimeout: 5_000 },
    (req, res) => {
      const started = performance.now()
      res.once('finish', () => {
        logger('debug', 'console request', {
          method: req.method,
          path: pathForLog(rawPathOf(req.url) ?? '(invalid target)'),
          status: res.statusCode,
          ms: Math.round(performance.now() - started),
        })
      })
      handleRequest(req, res).catch((err: unknown) => {
        logger('error', 'console request crashed', { err: describeError(err, true) })
        if (!res.headersSent) sendPlain(res, 500, 'Internal error')
        else res.destroy()
      })
    }
  )

  httpServer.on('clientError', (err, socket) => {
    logger('debug', 'client error', { err: err.message })
    if (socket.writable && !socket.destroyed)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    else socket.destroy()
  })
  // Listen errors are handled by start(); anything later is logged instead of crashing the process.
  httpServer.on('error', (err) => logger('error', 'http server error', { err: err.message }))

  // ─────────────────────────────── WebSocket upgrade ───────────────────────────────

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const rawPath = rawPathOf(req.url)
    if (rawPath !== CONSOLE_WS_PATH)
      return rejectUpgrade(socket, 404, 'Not Found', 'not_found', 'No such route.')
    if (!isAllowedHost(req.headers.host, boundPort)) {
      logger('warn', 'refused a console socket: Host header not allowed', {
        host: clip(req.headers.host),
      })
      return rejectUpgrade(
        socket,
        403,
        'Forbidden',
        'forbidden_host',
        'Forbidden: this Host header is not allowed.'
      )
    }
    if (!isAllowedOrigin(req.headers.origin, origins)) {
      logger('warn', 'refused a console socket: Origin not allowed', {
        origin: clip(req.headers.origin),
      })
      return rejectUpgrade(
        socket,
        403,
        'Forbidden',
        'forbidden_origin',
        'Forbidden: this Origin is not allowed.'
      )
    }
    const address = addressKey(req.socket.remoteAddress)
    const waitMs = limiter.retryAfterMs(address)
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000)
      return rejectUpgrade(
        socket,
        429,
        'Too Many Requests',
        'rate_limited',
        `Too many failed attempts. Try again in ${seconds} seconds.`,
        {
          'Retry-After': String(seconds),
        }
      )
    }
    const offered = parseSubprotocols(req.headers['sec-websocket-protocol'])
    if (!verifyToken(tokenFromSubprotocols(offered))) {
      const tripped = limiter.recordFailure(address)
      logger(
        'warn',
        tripped
          ? 'too many failed console logins, blocking this address for a while'
          : 'refused a console socket: missing or wrong token',
        {
          address,
        }
      )
      return rejectUpgrade(
        socket,
        401,
        'Unauthorized',
        'unauthorized',
        'A valid token is required.'
      )
    }
    if (!offered.includes(CONSOLE_SUBPROTOCOL)) {
      return rejectUpgrade(
        socket,
        400,
        'Bad Request',
        'bad_subprotocol',
        `Offer the ${CONSOLE_SUBPROTOCOL} subprotocol.`
      )
    }
    if (hub.size >= maxClients) {
      logger('warn', 'refused a console socket: too many clients', { clients: hub.size })
      return rejectUpgrade(
        socket,
        503,
        'Service Unavailable',
        'too_many_clients',
        'Too many consoles are connected.'
      )
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws))
  }

  httpServer.on('upgrade', (req, socket, head) => {
    // An early destroy must not turn into an unhandled 'error' event.
    socket.on('error', () => undefined)
    try {
      handleUpgrade(req, socket, head)
    } catch (err) {
      logger('error', 'console upgrade failed', { err: describeError(err, true) })
      socket.destroy()
    }
  })

  // ─────────────────────────────── lifecycle ───────────────────────────────

  let stopping: Promise<void> | null = null

  return {
    httpServer,
    token,
    get port() {
      return boundPort
    },
    get url() {
      return `http://127.0.0.1:${boundPort}`
    },
    get openUrl() {
      return `http://127.0.0.1:${boundPort}/#token=${token}`
    },
    get clientCount() {
      return hub.size
    },

    async start() {
      if (httpServer.listening) return
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          httpServer.off('error', onError)
          resolve()
        }
        httpServer.once('error', onError)
        httpServer.once('listening', onListening)
        httpServer.listen({ port: opts.port, host: '127.0.0.1' })
      })
      boundPort = (httpServer.address() as AddressInfo).port
      origins = allowedOrigins(boundPort, extraOrigins)
      hub.start()
      // The address, never the token: the token is printed by whoever starts the server, on purpose.
      logger('info', 'console server listening', { url: `http://127.0.0.1:${boundPort}` })
    },

    stop() {
      stopping ??= (async () => {
        await hub.close()
        wss.close()
        await new Promise<void>((resolve) => {
          // The callback receives an error when the server never listened; either way we are done.
          httpServer.close(() => resolve())
          httpServer.closeAllConnections()
        })
      })()
      return stopping
    },

    publish(event) {
      hub.publish(event)
    },
  }
}
