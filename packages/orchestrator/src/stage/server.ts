/**
 * The stage server: one HTTP port on 127.0.0.1 that serves the stage build, the asset libraries
 * and the stage WebSocket (`/stage`, subprotocol `animatus.stage.v1`).
 *
 * Security posture (see AGENTS.md): loopback only, every request must carry a loopback Host header
 * (DNS-rebinding defence, so an attacker page cannot read assets or talk to the socket through a
 * name that resolves to 127.0.0.1), WebSocket upgrades are Origin-checked, incoming frames are capped
 * at 64 KiB and there are no CORS headers at all.
 */
import { realpath, stat } from 'node:fs/promises'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { MAX_UPSTREAM_BYTES, STAGE_SUBPROTOCOL } from '@animatus/protocol'
import {
  createAssetHandler,
  decodeUrlPathSegments,
  resolveInsideRoot,
  sendText,
  serveFile,
  staticContentType,
} from './assets.ts'
import { StageHub } from './hub.ts'
import type { StageHubOptions } from './hub.ts'
import { noopLogger } from './logger.ts'
import type { Logger } from './logger.ts'
import { errorMessage, sleep } from './util.ts'

/**
 * Content-Security-Policy sent with every HTML response of the stage build.
 * `connect-src` allows `blob:` because three's GLTFLoader loads a model's embedded textures with
 * fetch() on blob: URLs, and `data:` for inlined WebAssembly fetched through data: URLs. Neither can
 * carry anything out of the page, so they do not open a channel.
 */
export const STAGE_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; " +
  "connect-src 'self' blob: data: ws://127.0.0.1:* ws://localhost:*; img-src 'self' blob: data:; " +
  "media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'"

const NOT_BUILT_TEXT =
  'The stage has not been built yet.\n' +
  'Build it with: npm run build -w @animatus/stage\n' +
  'Then reload this page.\n'

// ───────────────────────────── header checks (pure) ─────────────────────────────

export interface UpgradeCheckInput {
  host: string | undefined
  origin: string | undefined
  /** The port the server is actually bound to. */
  port: number
  extraOrigins: readonly string[]
  dev: boolean
  /** Whether the TCP peer is on the loopback interface. */
  peerIsLoopback: boolean
}

export type UpgradeVerdict =
  { ok: true } | { ok: false; reason: 'bad_host' | 'bad_origin' | 'missing_origin' }

export const normalizeOrigin = (origin: string): string =>
  origin.trim().toLowerCase().replace(/\/+$/, '')

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return (
    address === '::1' ||
    address.startsWith('127.') ||
    address.toLowerCase().startsWith('::ffff:127.')
  )
}

/** `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` (case-insensitive). */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false
  const h = host.trim().toLowerCase()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`
}

/**
 * The rules for a WebSocket upgrade: a loopback Host; an Origin that is this server's own origin
 * (either loopback name) or listed in `extraOrigins`; a missing Origin (non-browser tools) only in
 * dev mode or from a loopback peer.
 */
export function checkUpgradeHeaders(input: UpgradeCheckInput): UpgradeVerdict {
  if (!isAllowedHost(input.host, input.port)) return { ok: false, reason: 'bad_host' }
  if (input.origin === undefined) {
    return input.dev || input.peerIsLoopback
      ? { ok: true }
      : { ok: false, reason: 'missing_origin' }
  }
  const origin = normalizeOrigin(input.origin)
  const allowed = new Set([
    `http://127.0.0.1:${input.port}`,
    `http://localhost:${input.port}`,
    ...input.extraOrigins.map(normalizeOrigin),
  ])
  return allowed.has(origin) ? { ok: true } : { ok: false, reason: 'bad_origin' }
}

function offersStageSubprotocol(header: string | undefined): boolean {
  if (!header) return false
  return header.split(',').some((p) => p.trim() === STAGE_SUBPROTOCOL)
}

/** Request path without query or fragment, still percent-encoded. Null when the target is not origin-form. */
function rawPathOf(url: string | undefined): string | null {
  if (!url || !url.startsWith('/')) return null
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(statusText)}\r\n\r\n${statusText}`
  )
  // Flush the answer first, but never keep a half-open socket around.
  const timer = setTimeout(() => socket.destroy(), 1000)
  timer.unref()
  socket.once('close', () => clearTimeout(timer))
}

// ───────────────────────────── the server ─────────────────────────────

export interface StageServerOptions {
  /** 0 picks a free port (read it from `server.port` after `start()`). */
  port: number
  /** Only loopback is supported; anything else throws. */
  host?: '127.0.0.1'
  /** The stage's Vite build output. Without it (or when it does not exist) pages answer 503. */
  staticDir?: string
  /** Asset libraries: `/asset/<name>/...` is served from the mapped directory. */
  libraries: Record<string, string>
  /** Extra allowed WebSocket origins, e.g. a Vite dev server: `http://127.0.0.1:5173`. */
  extraOrigins?: string[]
  /** Sets `welcome.dev` and lets Origin-less WebSocket clients in from anywhere. */
  dev?: boolean
  logger?: Logger
  /** Extra hub settings (heartbeat, back-pressure, ...). */
  hub?: Omit<StageHubOptions, 'logger' | 'dev'>
  /** Test hook: decides whether the TCP peer counts as loopback for the missing-Origin rule. */
  peerIsLoopback?: (req: IncomingMessage) => boolean
}

export interface StageServer {
  readonly hub: StageHub
  /** `http://127.0.0.1:<port>`; the port is the real one after `start()`. */
  readonly url: string
  readonly port: number
  readonly httpServer: http.Server
  start(): Promise<void>
  stop(): Promise<void>
}

export function createStageServer(opts: StageServerOptions): StageServer {
  if (opts.host !== undefined && opts.host !== '127.0.0.1') {
    throw new Error(
      `the stage server only binds to 127.0.0.1, got host ${JSON.stringify(opts.host)}`
    )
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new RangeError(`invalid port ${opts.port}`)
  }
  const logger = opts.logger ?? noopLogger
  const extraOrigins = opts.extraOrigins ?? []
  const dev = opts.dev ?? false
  const peerIsLoopback =
    opts.peerIsLoopback ?? ((req) => isLoopbackAddress(req.socket.remoteAddress))
  const hub = new StageHub({ ...opts.hub, logger, dev })
  const handleAsset = createAssetHandler(opts.libraries, logger)
  let boundPort = opts.port

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_UPSTREAM_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(STAGE_SUBPROTOCOL) ? STAGE_SUBPROTOCOL : false),
  })

  // ─────────── static files (the stage build) ───────────

  const htmlHeaders = (contentType: string): Record<string, string> => ({
    'Referrer-Policy': 'no-referrer',
    ...(contentType.startsWith('text/html') ? { 'Content-Security-Policy': STAGE_CSP } : {}),
  })

  async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<void> {
    const head = req.method === 'HEAD'
    const notBuilt = (text = NOT_BUILT_TEXT) =>
      sendText(res, 503, text, { 'Retry-After': '10' }, head)
    if (!opts.staticDir) return notBuilt()
    let root: string
    try {
      root = await realpath(opts.staticDir)
      if (!(await stat(root)).isDirectory()) return notBuilt()
    } catch {
      return notBuilt()
    }

    let segments: string[] = []
    if (pathname !== '/') {
      const decoded = decodeUrlPathSegments(
        pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
      )
      if (!decoded) return sendText(res, 404, 'Not found', {}, head)
      segments = decoded
    }
    if (segments.length > 0) {
      const hit = await resolveInsideRoot(root, segments)
      if (hit) {
        const contentType = staticContentType(hit.file)
        return serveFile(req, res, hit.file, hit.stats, {
          contentType,
          headers: htmlHeaders(contentType),
        })
      }
      // Paths that look like files are real 404s; only route-like paths fall back to the app shell.
      if (path.extname(segments[segments.length - 1] ?? '') !== '')
        return sendText(res, 404, 'Not found', {}, head)
    }
    const index = await resolveInsideRoot(root, ['index.html'])
    if (!index)
      return notBuilt(
        'The stage build has no index.html.\nRebuild it with: npm run build -w @animatus/stage\n'
      )
    const contentType = staticContentType(index.file)
    return serveFile(req, res, index.file, index.stats, {
      contentType,
      headers: htmlHeaders(contentType),
    })
  }

  // ─────────── HTTP ───────────

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page on another name that resolves to 127.0.0.1 is same-origin for itself, so
    // the only defence is to refuse any Host that is not one of ours.
    if (!isAllowedHost(req.headers.host, boundPort)) return sendText(res, 403, 'Forbidden')
    const pathname = rawPathOf(req.url)
    if (pathname === null) return sendText(res, 400, 'Bad request')
    const head = req.method === 'HEAD'
    if (pathname === '/stage') {
      return sendText(
        res,
        426,
        'This endpoint only speaks WebSocket',
        { Upgrade: 'websocket', Connection: 'Upgrade' },
        head
      )
    }
    if (await handleAsset(req, res, pathname)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' })
    }
    await serveStatic(req, res, pathname)
  }

  const httpServer = http.createServer(
    // Sensible limits: slow headers or bodies are cut off, idle keep-alive sockets do not pile up.
    { headersTimeout: 15_000, requestTimeout: 30_000, keepAliveTimeout: 5_000 },
    (req, res) => {
      handleRequest(req, res).catch((err) => {
        logger('error', 'request failed', { err, url: req.url })
        if (!res.headersSent) sendText(res, 500, 'Internal error')
        else res.destroy()
      })
    }
  )

  httpServer.on('clientError', (err, socket) => {
    logger('debug', 'client error', { err: errorMessage(err) })
    if (socket.writable && !socket.destroyed)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    else socket.destroy()
  })
  // Listen errors are handled by start(); anything later is logged instead of crashing the process.
  httpServer.on('error', (err) => logger('error', 'http server error', { err }))

  // ─────────── WebSocket upgrade ───────────

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      if (rawPathOf(req.url) !== '/stage') return rejectUpgrade(socket, 404, 'Not Found')
      const verdict = checkUpgradeHeaders({
        host: req.headers.host,
        origin: req.headers.origin,
        port: boundPort,
        extraOrigins,
        dev,
        peerIsLoopback: peerIsLoopback(req),
      })
      if (!verdict.ok) {
        logger('warn', 'rejected a stage upgrade', {
          reason: verdict.reason,
          host: req.headers.host,
          origin: req.headers.origin,
        })
        return rejectUpgrade(socket, 403, 'Forbidden')
      }
      if (!offersStageSubprotocol(req.headers['sec-websocket-protocol'])) {
        logger('warn', 'rejected a stage upgrade: subprotocol not offered')
        return rejectUpgrade(socket, 400, 'Bad Request')
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        hub.attach(ws, { remoteAddress: req.socket.remoteAddress })
      )
    } catch (err) {
      logger('error', 'upgrade failed', { err })
      socket.destroy()
    }
  })

  // ─────────── lifecycle ───────────

  let stopping: Promise<void> | null = null

  return {
    hub,
    httpServer,
    get port() {
      return boundPort
    },
    get url() {
      return `http://127.0.0.1:${boundPort}`
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
      logger('info', 'stage server listening', { url: `http://127.0.0.1:${boundPort}` })
    },

    stop() {
      stopping ??= (async () => {
        hub.close(1001, 'orchestrator shutting down')
        // Let well-behaved stages finish the close handshake, then cut whatever is left.
        const deadline = Date.now() + 300
        while (wss.clients.size > 0 && Date.now() < deadline) await sleep(10)
        for (const client of wss.clients) client.terminate()
        wss.close()
        await new Promise<void>((resolve) => {
          // The callback receives an error when the server never listened; either way we are done.
          httpServer.close(() => resolve())
          httpServer.closeAllConnections()
        })
      })()
      return stopping
    },
  }
}
