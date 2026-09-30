/**
 * The console's live connection: one WebSocket to `/api/ws` with the console subprotocol and the token as
 * a second subprotocol (browsers cannot set headers on a WebSocket). It reconnects on its own with an
 * exponential, jittered backoff, treats a connection as healthy only once the server's `hello` arrived,
 * and drops a connection that has gone quiet (the server pushes a status every two seconds).
 *
 * Everything the server sends is checked with `ConsoleEvent`; anything else is dropped.
 */
import {
  CONSOLE_SUBPROTOCOL,
  CONSOLE_TOKEN_PROTOCOL_PREFIX,
  CONSOLE_WS_PATH,
  ConsoleEvent,
} from '@animatus/protocol'

/** The part of a WebSocket this client uses, so tests can bring their own. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
  close(code?: number, reason?: string): void
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike

/** `connecting`: an attempt is under way. `open`: connected. `waiting`: between attempts. */
export type LiveState = 'connecting' | 'open' | 'waiting'

export interface BackoffOptions {
  /** First delay. Default 500 ms. */
  baseMs?: number
  /** Ceiling. Default 15 000 ms. */
  maxMs?: number
  /** Growth per attempt. Default 2. */
  factor?: number
  /** Random spread, 0..1: 0.2 means the delay varies by up to 20 % either way. Default 0.2. */
  jitter?: number
}

export const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 500,
  maxMs: 15_000,
  factor: 2,
  jitter: 0.2,
}

/** The wait before reconnect number `attempt` (0 is the first). */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random
): number {
  const o = { ...DEFAULT_BACKOFF, ...options }
  const raw = Math.min(o.maxMs, o.baseMs * o.factor ** Math.max(0, attempt))
  const spread = 1 + o.jitter * (random() * 2 - 1)
  return Math.max(0, Math.round(raw * spread))
}

export interface LiveOptions {
  token: string
  /** Default: `ws(s)://<this page's host>/api/ws`. */
  url?: string
  onEvent(event: ConsoleEvent): void
  onState?(state: LiveState): void
  /** Default: a real `WebSocket`. */
  createSocket?: SocketFactory
  backoff?: BackoffOptions
  /** A connection with nothing received for this long is dropped and retried. Default 8000 ms (four status pushes). */
  staleMs?: number
  /** For tests. Default `Math.random`. */
  random?: () => number
}

export interface Live {
  /** Stops for good: closes the socket, cancels every timer. */
  close(): void
  /** Reconnect attempts since the last healthy connection. */
  readonly attempts: number
}

export function defaultSocketUrl(
  location: { protocol: string; host: string } = window.location
): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${CONSOLE_WS_PATH}`
}

const realSocket: SocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as SocketLike

export function createLive(options: LiveOptions): Live {
  const createSocket = options.createSocket ?? realSocket
  const staleMs = options.staleMs ?? 8000
  const random = options.random ?? Math.random
  let socket: SocketLike | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let staleTimer: ReturnType<typeof setInterval> | undefined
  let lastMessageAt = 0
  let attempts = 0
  let closed = false

  const setState = (state: LiveState): void => options.onState?.(state)

  function clearStale(): void {
    if (staleTimer !== undefined) clearInterval(staleTimer)
    staleTimer = undefined
  }

  function connect(): void {
    if (closed) return
    setState('connecting')
    const url = options.url ?? defaultSocketUrl()
    const current = createSocket(url, [
      CONSOLE_SUBPROTOCOL,
      `${CONSOLE_TOKEN_PROTOCOL_PREFIX}${options.token}`,
    ])
    socket = current
    lastMessageAt = Date.now()

    current.onopen = () => {
      if (socket !== current) return
      lastMessageAt = Date.now()
      setState('open')
      clearStale()
      staleTimer = setInterval(
        () => {
          if (socket === current && Date.now() - lastMessageAt > staleMs) dropped(current)
        },
        Math.max(50, Math.floor(staleMs / 2))
      )
    }
    current.onmessage = (message) => {
      if (socket !== current) return
      lastMessageAt = Date.now()
      let parsed: ReturnType<typeof ConsoleEvent.safeParse>
      try {
        parsed = ConsoleEvent.safeParse(JSON.parse(String(message.data)))
      } catch {
        return // not JSON: ignored
      }
      if (!parsed.success) return // not something this console knows: ignored
      // Only a server that said hello is a healthy one; a connection that opens and dies keeps backing off.
      if (parsed.data.type === 'hello') attempts = 0
      options.onEvent(parsed.data)
    }
    current.onerror = () => {
      // The close that follows is what triggers the retry.
    }
    current.onclose = () => dropped(current)
  }

  /** The connection is gone (closed by the server, failed to open, or gone quiet): try again later. */
  function dropped(gone: SocketLike): void {
    if (socket !== gone) return
    socket = null
    clearStale()
    gone.onopen = gone.onmessage = gone.onclose = gone.onerror = null
    try {
      gone.close()
    } catch {
      // already closed
    }
    if (closed) return
    setState('waiting')
    const wait = backoffDelay(attempts, options.backoff, random)
    attempts += 1
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      connect()
    }, wait)
  }

  connect()

  return {
    close() {
      if (closed) return
      closed = true
      clearStale()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      const last = socket
      socket = null
      if (last) {
        last.onopen = last.onmessage = last.onclose = last.onerror = null
        try {
          last.close(1000, 'console closed')
        } catch {
          // already closed
        }
      }
    },
    get attempts() {
      return attempts
    },
  }
}
