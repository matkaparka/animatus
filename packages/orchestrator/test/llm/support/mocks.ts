/**
 * Local mock servers for the LLM tests: an HTTP server that records requests and can write a stream
 * in tiny slices, and a small HTTP proxy that understands both absolute-URI requests and CONNECT.
 * Everything binds to 127.0.0.1 on an ephemeral port. No key in this file is real.
 */
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import net from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import type { LlmDelta } from '../../../src/llm/types.ts'

// ───────────────────────────── recording server ─────────────────────────────

export interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
  /** The parsed JSON body (`undefined` when the body is empty or not JSON). */
  json: any
  /** True once the connection closed before the response was finished (client abort or drop). */
  readonly clientAborted: boolean
  /** Resolves when the response or its connection is closed, whichever comes first. */
  readonly closed: Promise<void>
}

export interface MockServer {
  /** `http://127.0.0.1:<port>` */
  url: string
  port: number
  seen: Seen[]
  close(): Promise<void>
}

export type Handler = (
  seen: Seen,
  res: ServerResponse,
  raw: IncomingMessage
) => void | Promise<void>

const sockets = new Set<Socket>()
const servers = new Set<Server>()
const proxies = new Set<MockProxy>()

export async function startServer(handler: Handler): Promise<MockServer> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let json: any
      try {
        json = body ? JSON.parse(body) : undefined
      } catch {
        json = undefined
      }
      let aborted = false
      let onClosed: () => void = () => {}
      const closed = new Promise<void>((resolve) => (onClosed = resolve))
      res.on('close', () => {
        aborted = !res.writableFinished
        onClosed()
      })
      const entry: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
        json,
        get clientAborted() {
          return aborted
        },
        closed,
      }
      seen.push(entry)
      res.socket?.setNoDelay(true)
      Promise.resolve(handler(entry, res, req)).catch((e) => {
        // A handler bug should fail the test loudly, not hang it.
        if (!res.headersSent) res.writeHead(599)
        res.end(`mock handler failed: ${String(e)}`)
      })
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  servers.delete(server)
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

/** Close every server and proxy this file started (call from `afterEach`). */
export async function closeAllServers(): Promise<void> {
  await Promise.all([...proxies].map((p) => p.close()))
  proxies.clear()
  await Promise.all([...servers].map(closeServer))
  for (const s of sockets) s.destroy()
}

/** A port nothing listens on. */
export async function deadPort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

// ───────────────────────────── writing streams ─────────────────────────────

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Deterministic pseudo-random numbers (mulberry32), so a failing slice pattern can be replayed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Slicing = number | { seed: number; max: number }

/** Write `payload` as separate HTTP chunks of the given size (or seeded random sizes 1..max). */
export async function writeSliced(
  res: ServerResponse,
  payload: string | Buffer,
  slicing: Slicing
): Promise<void> {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const next =
    typeof slicing === 'number'
      ? () => slicing
      : (
          (rnd) => () =>
            1 + Math.floor(rnd() * slicing.max)
        )(seededRandom(slicing.seed))
  for (let i = 0; i < bytes.length;) {
    const n = next()
    res.write(bytes.subarray(i, i + n))
    i += n
    await tick()
  }
}

export function startSse(res: ServerResponse, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.flushHeaders()
}

/** One SSE event with a JSON (or literal string) payload. */
export const sse = (data: unknown): string =>
  `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`

/** Reply with a JSON body (error responses). */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(text)
}

// ───────────────────────────── wire formats ─────────────────────────────

export const gText = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
  ...extra,
})

export const gThought = (text: string) => ({
  candidates: [{ content: { role: 'model', parts: [{ text, thought: true }] }, index: 0 }],
})

export const gDone = (text: string, usage: Record<string, number> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
  ...(Object.keys(usage).length > 0 ? { usageMetadata: usage } : {}),
})

export const oText = (text: string) => ({
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
})
export const oThink = (text: string) => ({
  choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
})
export const oStop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
export const oUsage = (prompt: number, completion: number) => ({
  choices: [],
  usage: {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  },
})
export const DONE = 'data: [DONE]\n\n'

// ───────────────────────────── collecting deltas ─────────────────────────────

export interface Collected {
  deltas: LlmDelta[]
  text: string
  thinking: string
  usage?: Extract<LlmDelta, { type: 'usage' }>
}

/** Drain a stream; on failure the error is returned next to the deltas that arrived before it. */
export async function collect(
  stream: AsyncIterable<LlmDelta>
): Promise<Collected & { error?: unknown }> {
  const out: Collected & { error?: unknown } = { deltas: [], text: '', thinking: '' }
  try {
    for await (const d of stream) {
      out.deltas.push(d)
      if (d.type === 'text') out.text += d.text
      else if (d.type === 'thinking') out.thinking += d.text
      else out.usage = d
    }
  } catch (e) {
    out.error = e
  }
  return out
}

// ───────────────────────────── a tiny HTTP proxy ─────────────────────────────

export interface ProxySeen {
  kind: 'absolute' | 'connect'
  /** Absolute URL, or `host:port` for CONNECT. */
  target: string
  headers: IncomingHttpHeaders
}

export interface MockProxy {
  /** `http://127.0.0.1:<port>` */
  url: string
  port: number
  seen: ProxySeen[]
  close(): Promise<void>
}

/** Forwards absolute-URI requests and tunnels CONNECT, recording what it was asked for. */
export async function startProxy(): Promise<MockProxy> {
  const seen: ProxySeen[] = []
  const open = new Set<Socket>()
  const track = (s: Socket) => {
    open.add(s)
    s.on('close', () => open.delete(s))
  }
  const server = createServer((req, res) => {
    seen.push({ kind: 'absolute', target: req.url ?? '', headers: req.headers })
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400)
      res.end('absolute-form request target expected')
      return
    }
    // A real proxy consumes its own credentials and does not pass them on.
    const forwarded = { ...req.headers }
    delete forwarded['proxy-authorization']
    delete forwarded['proxy-connection']
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: forwarded,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      }
    )
    upstream.on('error', () => res.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connection', track)
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    seen.push({ kind: 'connect', target: req.url ?? '', headers: req.headers })
    const [host, port] = (req.url ?? '').split(':')
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    track(upstream)
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const proxy: MockProxy = {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: async () => {
      for (const s of open) s.destroy()
      await closeServer(server)
    },
  }
  proxies.add(proxy)
  return proxy
}
