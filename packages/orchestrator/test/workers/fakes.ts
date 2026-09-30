/**
 * Two small HTTP servers for the worker tests: one that speaks the Worker protocol the way the spec says (the reference
 * for what a worker must do), and one that speaks the older link. Both keep their state where a test can change it.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WorkerEvent } from '@animatus/protocol'

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(text)
}

export interface Listening {
  url: string
  server: Server
  close(): Promise<void>
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Listening> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

// ─────────────────────────────── the protocol ───────────────────────────────

export interface FakeWorkerState {
  worker: string
  epoch: string
  online: boolean
  paused: boolean
  thinking: boolean
  executing: string | null
  pending: number
  givenUp: boolean
  lastCommand: { text: string; at: number } | null
  summary: string
  facts: Record<string, string | number | boolean | null>
  events: WorkerEvent[]
  directives: string[]
  /** What the tests can make it do wrong. */
  misbehave: {
    hang?: boolean
    badState?: boolean
    badJson?: boolean
    huge?: boolean
    status?: number
  }
  requests: string[]
}

export async function fakeWorker(over: Partial<FakeWorkerState> = {}) {
  const s: FakeWorkerState = {
    worker: 'fakegame',
    epoch: 'epoch-aaaaaaaa',
    online: true,
    paused: true, // a worker starts paused
    thinking: false,
    executing: null,
    pending: 0,
    givenUp: false,
    lastCommand: null,
    summary: 'nothing has happened yet',
    facts: {},
    events: [],
    directives: [],
    misbehave: {},
    requests: [],
    ...over,
  }
  const push = (kind: string, text: string, urgency: WorkerEvent['urgency'] = 'later') => {
    s.events.push({ seq: (s.events.at(-1)?.seq ?? 0) + 1, at: Date.now(), kind, text, urgency })
    if (s.events.length > 300) s.events.splice(0, s.events.length - 300)
  }
  const latest = () => s.events.at(-1)?.seq ?? 0
  const state = () => ({
    protocol: 1,
    worker: s.worker,
    epoch: s.epoch,
    online: s.online,
    paused: s.paused,
    planner: {
      thinking: s.thinking,
      executing: s.executing,
      pending: s.pending,
      given_up: s.givenUp,
    },
    last_command: s.lastCommand,
    latest_seq: latest(),
    summary: s.summary,
    facts: s.facts,
  })
  const listening = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    s.requests.push(`${req.method} ${url.pathname}${url.search}`)
    if (s.misbehave.hang) return // never answers
    if (s.misbehave.status)
      return send(res, s.misbehave.status, {
        ok: false,
        code: 'bad_request',
        message: 'refused for a test',
      })
    if (s.misbehave.badJson) return send(res, 200, '{not json')
    if (s.misbehave.huge) return send(res, 200, JSON.stringify({ pad: 'x'.repeat(1_100_000) }))
    if (req.method === 'GET' && url.pathname === '/worker/state')
      return send(res, 200, s.misbehave.badState ? { ...state(), epoch: 'x' } : state())
    if (req.method === 'GET' && url.pathname === '/worker/events') {
      const after = Number(url.searchParams.get('after') ?? '0')
      const epoch = url.searchParams.get('epoch')
      const reset = (epoch !== null && epoch !== s.epoch) || (epoch === null && after > 0)
      const from = reset ? 0 : after
      const all = s.events.filter((e) => e.seq > from)
      const page = all.slice(0, 50)
      return send(res, 200, {
        epoch: s.epoch,
        latest: latest(),
        reset,
        events: page,
        more: all.length > page.length,
      })
    }
    if (req.method === 'GET' && url.pathname === '/worker/trace')
      return send(res, 200, [{ step: 1 }, { step: 2 }])
    if (req.method === 'POST' && url.pathname === '/worker/command') {
      const body = JSON.parse((await readBody(req)) || '{}') as { text?: unknown }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text || text.length > 300)
        return send(res, 400, {
          ok: false,
          code: 'bad_request',
          message: 'text must be 1-300 characters',
        })
      if (!s.online)
        return send(res, 409, {
          ok: false,
          code: 'not_online',
          message: 'the game is not connected',
        })
      s.lastCommand = { text, at: Date.now() }
      s.directives.push(text)
      push('command', `directive: ${text}`, 'later')
      return send(res, 200, { ok: true, epoch: s.epoch, paused: s.paused })
    }
    if (req.method === 'POST' && url.pathname === '/worker/pause') {
      const body = JSON.parse((await readBody(req)) || '{}') as { paused?: unknown }
      if (typeof body.paused !== 'boolean')
        return send(res, 400, {
          ok: false,
          code: 'bad_request',
          message: 'paused must be true or false',
        })
      s.paused = body.paused
      return send(res, 200, { ok: true, epoch: s.epoch, paused: s.paused })
    }
    if (req.method === 'POST' && url.pathname === '/worker/forget') {
      s.directives = []
      s.lastCommand = null
      return send(res, 200, { ok: true, epoch: s.epoch, paused: s.paused })
    }
    send(res, 404, { ok: false, code: 'not_found', message: 'no such route' })
  })
  return {
    ...listening,
    s,
    push,
    /** A restart: a new epoch, the numbers begin again, and the worker is paused. */
    restart(epoch = `epoch-${Math.random().toString(16).slice(2, 10)}`) {
      s.epoch = epoch
      s.events = []
      s.paused = true
      s.directives = []
      s.lastCommand = null
    },
  }
}

// ─────────────────────────────── the older link ───────────────────────────────

export interface FakeLegacyState {
  status: Record<string, unknown>
  events: { seq: number; at: number; kind: string; text: string; urgency: string }[]
  paused: boolean
  online: boolean
  commands: string[]
  forgot: number
  requests: string[]
  misbehave: { hang?: boolean; badStatus?: boolean }
}

export async function fakeLegacy(over: Partial<FakeLegacyState> = {}) {
  const s: FakeLegacyState = {
    status: { game: 'civ6', turn: 12, summary: 'Turn 12, ahead in science' },
    events: [],
    paused: false,
    online: true,
    commands: [],
    forgot: 0,
    requests: [],
    misbehave: {},
    ...over,
  }
  const push = (kind: string, text: string, urgency = 'soon') =>
    s.events.push({ seq: (s.events.at(-1)?.seq ?? 0) + 1, at: Date.now(), kind, text, urgency })
  const latest = () => s.events.at(-1)?.seq ?? 0
  const listening = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    s.requests.push(`${req.method} ${url.pathname}${url.search}`)
    if (s.misbehave.hang) return
    if (req.method === 'GET' && url.pathname === '/status') {
      if (s.misbehave.badStatus) return send(res, 200, { online: 'yes', latestEventSeq: 'many' })
      return send(res, 200, {
        online: s.online,
        paused: s.paused,
        planner: { thinking: false, executing: null, pending: 0, givenUp: false },
        lastCommand: s.commands.length ? { text: s.commands.at(-1), at: 1 } : null,
        latestEventSeq: latest(),
        ...s.status,
      })
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') ?? '0')
      // the older links returned the newest fifty after the cursor
      return send(res, 200, {
        events: s.events.filter((e) => e.seq > after).slice(-50),
        latest: latest(),
      })
    }
    if (req.method === 'GET' && url.pathname === '/trace') return send(res, 200, [{ tool: 'x' }])
    if (req.method === 'POST' && url.pathname === '/command') {
      const body = JSON.parse((await readBody(req)) || '{}') as { text?: string }
      if (!body.text) return send(res, 400, { ok: false, reason: 'text must be 1-300 characters' })
      if (!s.online) return send(res, 409, { ok: false, reason: 'game not connected' })
      s.commands.push(body.text)
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/pause') {
      const body = JSON.parse((await readBody(req)) || '{}') as { paused?: boolean }
      s.paused = body.paused !== false
      return send(res, 200, { ok: true, paused: s.paused })
    }
    if (req.method === 'POST' && url.pathname === '/forget') {
      s.forgot++
      return send(res, 200, { ok: true })
    }
    send(res, 404, { ok: false })
  })
  return {
    ...listening,
    s,
    push,
    /** A restart: the numbers begin again at 1. */
    restart() {
      s.events = []
      s.paused = true
    },
  }
}
