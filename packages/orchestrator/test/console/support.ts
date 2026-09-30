/** Shared helpers of the console server tests: real HTTP and WebSocket clients, a running server, log capture. */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import type { RawData } from 'ws'
import { ApiError, CONSOLE_SUBPROTOCOL, CONSOLE_TOKEN_PROTOCOL_PREFIX } from '@animatus/protocol'
import type { ConsoleLogLevel, ConsoleLogger } from '../../src/console/backend.ts'
import { FakeBackend } from '../../src/console/fake.ts'
import { createConsoleServer } from '../../src/console/server.ts'
import type { ConsoleServer, ConsoleServerOptions } from '../../src/console/server.ts'

/** A secret value that must never show up in a response, a socket message or a log line. */
export const SECRET_VALUE = 'test-secret-123'

/** A fixed token for tests that need to know it. */
export const TEST_TOKEN = 'unit-test-token-0123456789abcdef'

// ───────────────────────────── cleanup and files ─────────────────────────────

export function createCleanup() {
  const tasks: Array<() => void | Promise<void>> = []
  return {
    add(task: () => void | Promise<void>): void {
      tasks.push(task)
    },
    async run() {
      const pending = tasks.splice(0).reverse()
      for (const task of pending) {
        try {
          await task()
        } catch {
          // best effort
        }
      }
    },
  }
}

export function makeTempDir(prefix = 'animatus-console-test-'): {
  dir: string
  remove: () => void
} {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  return {
    dir,
    remove: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  }
}

export function writeTree(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function waitUntil(
  cond: () => boolean,
  timeoutMs = 3000,
  what = 'condition'
): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await delay(5)
  }
}

// ───────────────────────────── logging ─────────────────────────────

export interface LogEntry {
  level: ConsoleLogLevel
  msg: string
  extra?: Record<string, unknown>
}

/** Collects every log line. `text()` is all of it as one string, for "never appears" assertions. */
export function collectLogs(): {
  logger: ConsoleLogger
  entries: LogEntry[]
  text: () => string
  has: (level: ConsoleLogLevel, part: string) => boolean
} {
  const entries: LogEntry[] = []
  const logger: ConsoleLogger = (level, msg, extra) => {
    entries.push(extra ? { level, msg, extra } : { level, msg })
  }
  return {
    logger,
    entries,
    text: () =>
      JSON.stringify(entries, (_key, value: unknown) =>
        value instanceof Error ? `${value.name}: ${value.message}` : value
      ),
    has: (level, part) => entries.some((e) => e.level === level && e.msg.includes(part)),
  }
}

// ───────────────────────────── raw HTTP ─────────────────────────────

export interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
  text(): string
  json<T = unknown>(): T
}

export interface RawRequestOptions {
  method?: string
  headers?: Record<string, string>
  /** Overrides the Host header (default: the right loopback name). */
  host?: string
  body?: string | Buffer
}

/** One HTTP request with the path sent exactly as given (no normalisation, unlike fetch) on its own connection. */
export function rawRequest(
  port: number,
  rawPath: string,
  opts: RawRequestOptions = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      Host: opts.host ?? `127.0.0.1:${port}`,
      ...opts.headers,
    }
    if (opts.body !== undefined) headers['Content-Length'] = Buffer.byteLength(opts.body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: rawPath,
        headers,
        setHost: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text: () => body.toString('utf8'),
            json: <T>() => JSON.parse(body.toString('utf8')) as T,
          })
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

/** Sends literal bytes over TCP and returns everything the server answers until it closes the socket. */
export function rawSocket(port: number, text: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(Buffer.concat(chunks).toString('latin1'))
    }, timeoutMs)
    socket.on('connect', () => socket.write(text))
    socket.on('data', (c) => chunks.push(c))
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('latin1'))
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

// ───────────────────────────── a running server ─────────────────────────────

export interface Running {
  server: ConsoleServer
  backend: FakeBackend
  port: number
  token: string
  /** `http://127.0.0.1:<port>` */
  origin: string
  wsUrl: string
  logs: ReturnType<typeof collectLogs>
  root: string
  staticDir: string
  /** An authenticated API call with the path as given. */
  call(method: string, rawPath: string, opts?: CallOptions): Promise<RawResponse>
}

export interface CallOptions {
  /** Sent as JSON unless `rawBody` is given. */
  body?: unknown
  rawBody?: string | Buffer
  /** `null` sends no Authorization header. Default: the server's token. */
  token?: string | null
  headers?: Record<string, string>
  host?: string
  origin?: string
}

export const INDEX_HTML =
  '<!doctype html><title>console</title><script type="module" src="/assets/app.js"></script>'

export interface StartOptions extends Partial<Omit<ConsoleServerOptions, 'backend'>> {
  backend?: ConsoleServerOptions['backend']
  /** false: no static folder on disk at all. */
  build?: boolean
  files?: Record<string, string>
}

/** Starts a console server on a free port with a fake backend and a small static build in a temp folder. */
export async function startConsole(
  cleanup: ReturnType<typeof createCleanup>,
  over: StartOptions = {}
): Promise<Running> {
  const tmp = makeTempDir()
  cleanup.add(() => tmp.remove())
  const root = tmp.dir
  const staticDir = path.join(root, 'console-dist')
  if (over.build !== false) {
    writeTree(staticDir, {
      'index.html': INDEX_HTML,
      'assets/app.js': 'console.log("app")',
      'assets/app.css': 'body{}',
      'assets/app.js.map': '{}',
      'favicon.ico': 'ico',
      '.env': 'SECRET=1',
      ...over.files,
    })
  }
  writeTree(root, { 'outside.txt': 'outside the static folder' })
  const backend = new FakeBackend()
  cleanup.add(() => backend.dispose())
  const logs = collectLogs()
  const { build: _build, files: _files, ...serverOptions } = over
  const server = createConsoleServer({
    port: 0,
    staticDir,
    logger: logs.logger,
    token: TEST_TOKEN,
    backend,
    ...serverOptions,
  })
  await server.start()
  cleanup.add(() => server.stop())
  const port = server.port
  const run: Running = {
    server,
    backend: (over.backend as FakeBackend | undefined) ?? backend,
    port,
    token: server.token,
    origin: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/ws`,
    logs,
    root,
    staticDir,
    call(method, rawPath, opts = {}) {
      const headers: Record<string, string> = { ...opts.headers }
      if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? server.token}`
      if (opts.origin !== undefined) headers.Origin = opts.origin
      let body = opts.rawBody
      if (body === undefined && opts.body !== undefined) {
        body = JSON.stringify(opts.body)
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
      }
      return rawRequest(port, rawPath, {
        method,
        headers,
        ...(opts.host !== undefined ? { host: opts.host } : {}),
        ...(body !== undefined ? { body } : {}),
      })
    },
  }
  return run
}

/** Asserts the shape of an error body and returns its code. */
export function errorCode(res: RawResponse): string {
  const parsed = ApiError.safeParse(res.json())
  if (!parsed.success) throw new Error(`not an ApiError body: ${res.text().slice(0, 200)}`)
  return parsed.data.error.code
}

// ───────────────────────────── a WebSocket console client ─────────────────────────────

export type Json = { type: string; [key: string]: unknown }

export class RejectedError extends Error {
  readonly status: number | null
  readonly body: string
  constructor(status: number | null, message: string, body = '') {
    super(message)
    this.name = 'RejectedError'
    this.status = status
    this.body = body
  }
}

export interface SocketOptions {
  /** Subprotocols offered. Default: the console subprotocol plus `token.<token>`. */
  protocols?: string[]
  /** `null` offers no token. Ignored when `protocols` is given. Default: the server's token. */
  token?: string | null
  origin?: string
  host?: string
  autoPong?: boolean
}

export class TestSocket {
  readonly received: Json[] = []
  closeInfo: { code: number; reason: string } | null = null
  private readonly watchers = new Set<() => void>()

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: RawData) => {
      const text = (Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)).toString(
        'utf8'
      )
      this.received.push(JSON.parse(text) as Json)
      this.notify()
    })
    ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString('utf8') }
      this.notify()
    })
    ws.on('error', () => {
      // surfaced through close / a rejected connect
    })
  }

  static connect(
    run: Pick<Running, 'wsUrl' | 'token' | 'origin'>,
    opts: SocketOptions = {},
    url = run.wsUrl
  ): Promise<TestSocket> {
    const token = opts.token === undefined ? run.token : opts.token
    const protocols = opts.protocols ?? [
      CONSOLE_SUBPROTOCOL,
      ...(token === null ? [] : [`${CONSOLE_TOKEN_PROTOCOL_PREFIX}${token}`]),
    ]
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, protocols, {
        ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        ...(opts.host !== undefined ? { headers: { Host: opts.host } } : {}),
        ...(opts.autoPong === false ? { autoPong: false } : {}),
        handshakeTimeout: 3000,
      })
      ws.once('unexpected-response', (_req, res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          reject(
            new RejectedError(
              res.statusCode ?? null,
              `server answered ${res.statusCode}`,
              Buffer.concat(chunks).toString('utf8')
            )
          )
        )
        res.on('error', () =>
          reject(new RejectedError(res.statusCode ?? null, `server answered ${res.statusCode}`))
        )
      })
      ws.once('error', (err) => reject(new RejectedError(null, err.message)))
      ws.once('open', () => {
        ws.removeAllListeners('error')
        ws.on('error', () => undefined)
        resolve(new TestSocket(ws))
      })
    })
  }

  types(): string[] {
    return this.received.map((m) => m.type)
  }

  ofType(type: string): Json[] {
    return this.received.filter((m) => m.type === type)
  }

  /** The n-th (1-based) message of a type, waiting for it if needed. */
  async waitForType(type: string, n = 1, timeoutMs = 3000): Promise<Json> {
    const pick = () => this.ofType(type)[n - 1]
    await this.waitFor(() => pick() !== undefined, timeoutMs, `${n} x '${type}'`)
    return pick() as Json
  }

  async waitFor(cond: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
    if (cond()) return
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!cond()) return
        cleanup()
        resolve()
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new Error(
            `timed out after ${timeoutMs} ms waiting for ${what}; received: [${this.types().join(', ')}]${this.closeInfo ? ` closed ${this.closeInfo.code}` : ''}`
          )
        )
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        this.watchers.delete(check)
      }
      this.watchers.add(check)
    })
  }

  async waitClosed(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    await this.waitFor(() => this.closeInfo !== null, timeoutMs, 'the socket to close')
    return this.closeInfo as { code: number; reason: string }
  }

  send(data: string | Uint8Array): void {
    this.ws.send(data)
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      this.ws.close()
  }

  private notify(): void {
    for (const watcher of [...this.watchers]) watcher()
  }
}

/** The HTTP status a refused upgrade came back with, or 'connected'. */
export async function upgradeStatus(
  run: Pick<Running, 'wsUrl' | 'token' | 'origin'>,
  opts: SocketOptions = {},
  url = run.wsUrl
): Promise<number | 'connected' | string> {
  try {
    const socket = await TestSocket.connect(run, opts, url)
    socket.close()
    return 'connected'
  } catch (err) {
    if (err instanceof RejectedError) return err.status ?? `error: ${err.message}`
    throw err
  }
}
