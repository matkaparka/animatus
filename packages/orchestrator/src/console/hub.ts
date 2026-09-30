/**
 * WebSocket fan-out of the console server: every connected console gets `hello`, a `status` snapshot every
 * couple of seconds, and every event handed to `publish()`.
 *
 * The socket is one-way in practice. Whatever a client sends is ignored (frames are capped at a few KiB by
 * the server), protocol-level pings are answered by the WebSocket library, and a client that stops
 * answering the hub's own pings, or falls too far behind, is dropped rather than left to pile up memory.
 */
import { WebSocket } from 'ws'
import { CONSOLE_API_VERSION, ConsoleEvent } from '@animatus/protocol'
import type { StatusView } from '@animatus/protocol'
import type { ConsoleLogger } from './backend.ts'
import { describeIssues } from './http.ts'

export interface HubOptions {
  /** A validated status snapshot. Throws when the backend cannot produce one. */
  loadStatus(): Promise<StatusView>
  logger: ConsoleLogger
  statusIntervalMs: number
  pingIntervalMs: number
  /** A client with more than this queued for sending is cut off. Default 1 MiB. */
  maxBufferedBytes?: number
}

interface Client {
  ws: WebSocket
  alive: boolean
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class ConsoleHub {
  private readonly clients = new Set<Client>()
  private readonly opts: HubOptions
  private readonly maxBuffered: number
  private statusTimer: NodeJS.Timeout | undefined
  private pingTimer: NodeJS.Timeout | undefined
  private statusBusy = false
  private lastStatusErrorLogAt = 0

  constructor(opts: HubOptions) {
    this.opts = opts
    this.maxBuffered = opts.maxBufferedBytes ?? 1024 * 1024
  }

  get size(): number {
    return this.clients.size
  }

  /** Starts the periodic status push and the heartbeat. Safe to call twice. */
  start(): void {
    if (this.statusTimer) return
    this.statusTimer = setInterval(() => void this.pushStatus(), this.opts.statusIntervalMs)
    this.statusTimer.unref()
    this.pingTimer = setInterval(() => this.heartbeat(), this.opts.pingIntervalMs)
    this.pingTimer.unref()
  }

  /** Adopts an accepted (already authenticated) socket: `hello` first, then a status snapshot straight away. */
  attach(ws: WebSocket): void {
    const client: Client = { ws, alive: true }
    this.clients.add(client)
    ws.on('pong', () => {
      client.alive = true
    })
    // Whatever the client sends is ignored on purpose; the listener only keeps the frames flowing.
    ws.on('message', () => undefined)
    ws.on('close', () => this.clients.delete(client))
    // An error (a frame over the size cap, a reset connection) is always followed by 'close': the library
    // sends its own close code first, so terminating here would replace, say, 1009 by 1006.
    ws.on('error', (err) => {
      this.opts.logger('debug', 'console socket error', { err: err.message })
    })
    this.send(client, JSON.stringify({ type: 'hello', api: CONSOLE_API_VERSION, now: Date.now() }))
    void this.opts.loadStatus().then(
      (status) => this.send(client, JSON.stringify({ type: 'status', status })),
      (err: unknown) => this.logStatusError(err)
    )
  }

  /** Validates and delivers one event to every connected console. An invalid event is refused and logged. */
  publish(event: ConsoleEvent): void {
    const parsed = ConsoleEvent.safeParse(event)
    if (!parsed.success) {
      this.opts.logger('error', 'refused to publish an invalid console event', {
        issues: describeIssues(parsed.error),
      })
      return
    }
    if (this.clients.size === 0) return
    const text = JSON.stringify(parsed.data)
    for (const client of [...this.clients]) this.send(client, text)
  }

  /** Closes every socket with 1001, gives them a moment to finish, then cuts what is left. */
  async close(): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.statusTimer = undefined
    this.pingTimer = undefined
    for (const client of this.clients) {
      try {
        client.ws.close(1001, 'console shutting down')
      } catch {
        client.ws.terminate()
      }
    }
    const deadline = Date.now() + 300
    while (this.clients.size > 0 && Date.now() < deadline) await sleep(10)
    for (const client of this.clients) client.ws.terminate()
    this.clients.clear()
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private send(client: Client, text: string): void {
    const { ws } = client
    if (ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount > this.maxBuffered) {
      this.opts.logger('warn', 'dropping a console client that is not keeping up', {
        queuedBytes: ws.bufferedAmount,
      })
      this.clients.delete(client)
      ws.terminate()
      return
    }
    ws.send(text, (err) => {
      if (err) {
        this.clients.delete(client)
        ws.terminate()
      }
    })
  }

  private async pushStatus(): Promise<void> {
    if (this.statusBusy || this.clients.size === 0) return
    this.statusBusy = true
    try {
      const text = JSON.stringify({ type: 'status', status: await this.opts.loadStatus() })
      for (const client of [...this.clients]) this.send(client, text)
    } catch (err) {
      this.logStatusError(err)
    } finally {
      this.statusBusy = false
    }
  }

  /** A backend that cannot produce a status would otherwise log every two seconds. */
  private logStatusError(err: unknown): void {
    const now = Date.now()
    if (now - this.lastStatusErrorLogAt < 30_000) return
    this.lastStatusErrorLogAt = now
    this.opts.logger('warn', 'cannot build the console status', { err })
  }

  private heartbeat(): void {
    for (const client of [...this.clients]) {
      if (!client.alive) {
        this.clients.delete(client)
        client.ws.terminate()
        continue
      }
      client.alive = false
      try {
        client.ws.ping()
      } catch {
        this.clients.delete(client)
        client.ws.terminate()
      }
    }
  }
}
