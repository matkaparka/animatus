import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { PluginManifest } from '@animatus/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  probeHealth,
  probeHttp,
  probeTcp,
  type HealthSpec,
  type HttpHealthSpec,
} from '../../src/plugins/health.ts'
import { getFreePort } from '../../src/plugins/ports.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

interface Seen {
  method?: string
  url?: string
}

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url })
    handler(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}`, port, seen }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A validated http health block: the schema fills every default. */
const spec = (http: Record<string, unknown> = {}): HttpHealthSpec => {
  const manifest = PluginManifest.parse({
    id: 'demo',
    title: 'Demo',
    kind: 'custom',
    runtime: { type: 'inprocess' },
    health: { http },
  })
  return manifest.health.http as HttpHealthSpec
}

const GOOD = {
  ok: true,
  ready: true,
  service: 'demo',
  version: '1.0.0',
  config: { max_long_side: 1024 },
}

describe('probeHttp', () => {
  it('accepts 200 with ok and ready true, and returns the service health', async () => {
    const { baseUrl, seen } = await serve((_req, res) => json(res, 200, GOOD))
    const result = await probeHttp(baseUrl, spec(), 1000)
    expect(result.ok).toBe(true)
    expect(result.detail).toBeUndefined()
    expect(result.health).toMatchObject({
      ok: true,
      ready: true,
      service: 'demo',
      config: { max_long_side: 1024 },
    })
    expect(seen).toEqual([{ method: 'GET', url: '/health' }])
  })

  it('treats ready:false as still loading and keeps what the service said', async () => {
    const { baseUrl } = await serve((_req, res) =>
      json(res, 200, { ok: true, ready: false, service: 'demo', detail: 'loading weights' })
    )
    const result = await probeHttp(baseUrl, spec(), 1000)
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('the service reports ready=false: loading weights')
    expect(result.health?.ready).toBe(false)
  })

  it('treats ok:false as broken even when ready is true', async () => {
    const { baseUrl } = await serve((_req, res) =>
      json(res, 200, { ok: false, ready: true, service: 'demo', detail: 'disk full' })
    )
    const result = await probeHttp(baseUrl, spec(), 1000)
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('the service reports ok=false: disk full')
  })

  it('treats 503 with a ServiceHealth body as alive but broken and reports its detail', async () => {
    const { baseUrl } = await serve((_req, res) =>
      json(res, 503, { ok: false, ready: false, service: 'demo', detail: 'model missing' })
    )
    const result = await probeHttp(baseUrl, spec(), 1000)
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('expected HTTP 200, got 503: model missing')
    expect(result.health?.ok).toBe(false)
  })

  it('rejects a body that is not JSON, or not an object', async () => {
    let body = 'not json at all'
    const { baseUrl } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(body)
    })
    expect((await probeHttp(baseUrl, spec(), 1000)).detail).toBe('the health response is not JSON')
    body = '[1, 2, 3]'
    expect((await probeHttp(baseUrl, spec(), 1000)).detail).toBe(
      'the health response is not a JSON object'
    )
    body = ''
    expect((await probeHttp(baseUrl, spec(), 1000)).ok).toBe(false)
  })

  it('reads a custom ready_field, including a dotted path', async () => {
    const { baseUrl } = await serve((_req, res) =>
      json(res, 200, { status: { up: true }, loaded: false })
    )
    expect((await probeHttp(baseUrl, spec({ ready_field: 'status.up' }), 1000)).ok).toBe(true)
    const not = await probeHttp(baseUrl, spec({ ready_field: 'loaded' }), 1000)
    expect(not.ok).toBe(false)
    expect(not.detail).toBe('the service reports loaded=false')
    expect((await probeHttp(baseUrl, spec({ ready_field: 'absent' }), 1000)).detail).toBe(
      'the service reports absent=null'
    )
  })

  it('with ready_field null, only the status counts and an HTML body is fine', async () => {
    const { baseUrl } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body>Swagger UI</body></html>')
    })
    const nullSpec = spec({ path: '/docs', ready_field: null })
    expect(nullSpec.ready_field).toBeNull()
    const result = await probeHttp(baseUrl, nullSpec, 1000)
    expect(result).toEqual({ ok: true })
    // the same page fails the default check, which wants JSON with a ready field
    expect((await probeHttp(baseUrl, spec({ path: '/docs' }), 1000)).ok).toBe(false)
  })

  it('with ready_field null, a wrong status still fails, and the body is not read', async () => {
    const { baseUrl } = await serve((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ready: true, service: 'demo', detail: 'ignored' }))
    })
    const result = await probeHttp(baseUrl, spec({ ready_field: null }), 1000)
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('expected HTTP 200, got 500')
    expect(result.health).toBeUndefined()
  })

  it('with ready_field null, an ok:false body does not matter either', async () => {
    const { baseUrl } = await serve((_req, res) =>
      json(res, 200, { ok: false, ready: false, service: 'demo' })
    )
    expect((await probeHttp(baseUrl, spec({ ready_field: null }), 1000)).ok).toBe(true)
  })

  it('honours expect_status and HEAD (status only, no body to read)', async () => {
    const { baseUrl, seen } = await serve((req, res) => {
      res.writeHead(req.method === 'HEAD' ? 204 : 200)
      res.end()
    })
    expect((await probeHttp(baseUrl, spec({ method: 'HEAD', expect_status: 204 }), 1000)).ok).toBe(
      true
    )
    expect(seen[0]?.method).toBe('HEAD')
    const wrong = await probeHttp(baseUrl, spec({ method: 'HEAD', expect_status: 200 }), 1000)
    expect(wrong.detail).toBe('expected HTTP 200, got 204')
  })

  it('joins a base URL with a path prefix and a path that lacks its leading slash', async () => {
    const { baseUrl, seen } = await serve((_req, res) => json(res, 200, GOOD))
    await probeHttp(`${baseUrl}/api/`, spec({ path: 'v1/health?probe=1' }), 1000)
    expect(seen[0]?.url).toBe('/api/v1/health?probe=1')
  })

  it('gives up after timeout_ms when the service never answers', async () => {
    const { baseUrl } = await serve(() => undefined)
    const started = Date.now()
    const result = await probeHttp(baseUrl, spec(), 150)
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('no answer within 150 ms')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('reports a refused connection', async () => {
    const port = await getFreePort()
    const result = await probeHttp(`http://127.0.0.1:${port}`, spec(), 1000)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/ECONNREFUSED/)
  })

  it('stops at once when the signal aborts', async () => {
    const { baseUrl } = await serve(() => undefined)
    const controller = new AbortController()
    const started = Date.now()
    const pending = probeHttp(baseUrl, spec(), 5000, controller.signal)
    setTimeout(() => controller.abort(), 50)
    const result = await pending
    expect(result).toEqual({ ok: false, detail: 'aborted' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect((await probeHttp(baseUrl, spec(), 5000, controller.signal)).ok).toBe(false) // already aborted
  })

  it('refuses a health response that is far too large', async () => {
    const { baseUrl } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('x'.repeat(400 * 1024))
    })
    const result = await probeHttp(baseUrl, spec(), 2000)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/too large/)
  })
})

describe('probeTcp and probeHealth', () => {
  async function listener() {
    const server = createTcpServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
  }

  it('connects to an open port and fails on a closed one', async () => {
    const open = await listener()
    expect(await probeTcp('127.0.0.1', open.port, 500)).toEqual({ ok: true })
    await open.close()
    const closed = await probeTcp('127.0.0.1', open.port, 500)
    expect(closed.ok).toBe(false)
    expect(closed.detail).toMatch(/ECONNREFUSED/)
  })

  const healthSpec = (health: Record<string, unknown>): HealthSpec =>
    PluginManifest.parse({
      id: 'demo',
      title: 'Demo',
      kind: 'custom',
      runtime: { type: 'inprocess' },
      health,
    }).health

  it('runs the tcp check alone, the http check alone, or both', async () => {
    const { baseUrl } = await serve((_req, res) =>
      json(res, 200, { ok: true, ready: false, service: 'demo' })
    )
    // the port is open, so tcp passes while the http body says "not ready"
    expect((await probeHealth(healthSpec({ tcp: true }), baseUrl)).ok).toBe(true)
    expect((await probeHealth(healthSpec({ http: {} }), baseUrl)).ok).toBe(false)
    const both = await probeHealth(healthSpec({ http: {}, tcp: true }), baseUrl)
    expect(both.ok).toBe(false)
    expect(both.detail).toMatch(/ready=false/)
    // a closed port fails on tcp before http is tried
    const port = await getFreePort()
    const refused = await probeHealth(
      healthSpec({ http: {}, tcp: true }),
      `http://127.0.0.1:${port}`
    )
    expect(refused.ok).toBe(false)
    expect(refused.detail).toMatch(/ECONNREFUSED/)
  })
})
