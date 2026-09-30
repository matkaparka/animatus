/** A real `ws` client that stands in for the stage, plus a bare WebSocket server around a StageHub. */
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import { PROTOCOL_VERSION, STAGE_SUBPROTOCOL, decodeFrame } from '@animatus/protocol'
import type { MediaFrame } from '@animatus/protocol'
import { StageHub } from '../../src/stage/hub.ts'
import type { StageHubOptions } from '../../src/stage/hub.ts'

export type Json = { type: string; [key: string]: unknown }

export type Received = { kind: 'json'; msg: Json } | { kind: 'binary'; frame: MediaFrame }

export interface StageClientOptions {
  /** Sent as the Origin header. Omitted when undefined. */
  origin?: string
  /** Overrides the Host header. */
  host?: string
  /** Subprotocols offered. Default: the stage subprotocol. Pass [] to offer none. */
  protocols?: string[]
  /** Answer `ping` with `pong` (default true). */
  autoPong?: boolean
  headers?: Record<string, string>
}

export class RejectedError extends Error {
  readonly status: number | null
  constructor(status: number | null, message: string) {
    super(message)
    this.name = 'RejectedError'
    this.status = status
  }
}

export class TestStage {
  readonly received: Received[] = []
  closeInfo: { code: number; reason: string } | null = null
  autoPong: boolean
  private readonly watchers = new Set<() => void>()

  private constructor(
    readonly ws: WebSocket,
    autoPong: boolean
  ) {
    this.autoPong = autoPong
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data)
        this.received.push({ kind: 'binary', frame: decodeFrame(new Uint8Array(bytes)) })
      } else {
        const text = (Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)).toString(
          'utf8'
        )
        const msg = JSON.parse(text) as Json
        this.received.push({ kind: 'json', msg })
        if (msg.type === 'ping' && this.autoPong && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', t: msg.t }))
        }
      }
      this.notify()
    })
    ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString('utf8') }
      this.notify()
    })
    ws.on('error', () => {
      // surfaced through close / rejected connect
    })
  }

  /** Connects and resolves when the socket is open; rejects with RejectedError when the server refuses. */
  static connect(url: string, opts: StageClientOptions = {}): Promise<TestStage> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, opts.protocols ?? [STAGE_SUBPROTOCOL], {
        ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        headers: { ...(opts.host !== undefined ? { Host: opts.host } : {}), ...opts.headers },
        handshakeTimeout: 3000,
      })
      ws.once('unexpected-response', (_req, res) => {
        res.resume()
        reject(new RejectedError(res.statusCode ?? null, `server answered ${res.statusCode}`))
      })
      ws.once('error', (err) => reject(new RejectedError(null, err.message)))
      ws.once('open', () => {
        ws.removeAllListeners('error')
        resolve(new TestStage(ws, opts.autoPong ?? true))
      })
    })
  }

  /** Connects, sends hello and waits for the welcome. */
  static async connectAndHello(
    url: string,
    opts: StageClientOptions & { hello?: Record<string, unknown> } = {}
  ): Promise<TestStage> {
    const stage = await TestStage.connect(url, opts)
    stage.hello(opts.hello)
    await stage.waitForJson('welcome')
    return stage
  }

  hello(overrides: Record<string, unknown> = {}): void {
    this.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      stage_id: 'test-stage',
      ua: 'vitest',
      ...overrides,
    })
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg))
  }

  sendRaw(data: string | Uint8Array, binary = typeof data !== 'string'): void {
    this.ws.send(data, { binary })
  }

  json(): Json[] {
    return this.received.flatMap((r) => (r.kind === 'json' ? [r.msg] : []))
  }

  jsonTypes(): string[] {
    return this.json().map((m) => m.type)
  }

  binaries(): MediaFrame[] {
    return this.received.flatMap((r) => (r.kind === 'binary' ? [r.frame] : []))
  }

  /** The n-th (1-based) JSON message of a type, waiting for it if needed. */
  async waitForJson(type: string, n = 1, timeoutMs = 3000): Promise<Json> {
    const pick = () => this.json().filter((m) => m.type === type)[n - 1]
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
        const seen = this.received
          .map((r) => (r.kind === 'json' ? r.msg.type : `bin#${r.frame.index}`))
          .join(', ')
        reject(
          new Error(
            `timed out after ${timeoutMs} ms waiting for ${what}; received: [${seen}]${this.closeInfo ? ` closed ${this.closeInfo.code}` : ''}`
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

  /** Waits a little so that "nothing else arrived" assertions mean something. */
  settle(ms = 60): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      this.ws.close()
  }

  private notify(): void {
    for (const watcher of [...this.watchers]) watcher()
  }
}

export interface BareHub {
  hub: StageHub
  url: string
  port: number
  /** Server-side sockets in connection order. */
  sockets: WebSocket[]
  close(): Promise<void>
}

/**
 * A StageHub behind a bare WebSocket server (no HTTP routes, no origin checks), so hub behaviour can be
 * tested without the rest of the stage server. `onConnection` sees each server-side socket before the
 * hub attaches to it.
 */
export async function startBareHub(
  hubOptions: StageHubOptions = {},
  onConnection?: (ws: WebSocket) => void
): Promise<BareHub> {
  const hub = new StageHub(hubOptions)
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    maxPayload: 64 * 1024,
    handleProtocols: () => STAGE_SUBPROTOCOL,
  })
  const sockets: WebSocket[] = []
  wss.on('connection', (ws, req) => {
    sockets.push(ws)
    onConnection?.(ws)
    hub.attach(ws, { remoteAddress: req.socket.remoteAddress })
  })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port
  return {
    hub,
    url: `ws://127.0.0.1:${port}`,
    port,
    sockets,
    async close() {
      hub.close()
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
