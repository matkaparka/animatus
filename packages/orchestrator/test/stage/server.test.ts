import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STAGE_SUBPROTOCOL } from '@animatus/protocol'
import {
  STAGE_CSP,
  checkUpgradeHeaders,
  createStageServer,
  isAllowedHost,
  isLoopbackAddress,
  normalizeOrigin,
} from '../../src/stage/server.ts'
import type { StageServer, StageServerOptions } from '../../src/stage/server.ts'
import {
  collectLogger,
  createCleanup,
  delay,
  makeTempDir,
  rawRequest,
  rawSocket,
  waitUntil,
  writeTree,
} from '../_stage-support/fixtures.ts'
import { RejectedError, TestStage } from '../_stage-support/stage-client.ts'

const cleanup = createCleanup()
afterEach(() => cleanup.run())

/** The CSP the stage build must be served with, spelled out here so a change has to be deliberate. */
const EXPECTED_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; " +
  "connect-src 'self' blob: data: ws://127.0.0.1:* ws://localhost:*; img-src 'self' blob: data:; media-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

const INDEX_HTML =
  '<!doctype html><title>stage</title><script type="module" src="/assets/app.js"></script>'

interface Running {
  server: StageServer
  port: number
  origin: string
  wsUrl: string
  root: string
  staticDir: string
}

async function start(
  extra: Partial<StageServerOptions> = {},
  files: Record<string, string> | null = {}
): Promise<Running> {
  const tmp = makeTempDir()
  cleanup.add(() => tmp.remove())
  const root = tmp.dir
  const staticDir = path.join(root, 'stage-dist')
  if (files !== null) {
    writeTree(staticDir, {
      'index.html': INDEX_HTML,
      'assets/app.js': 'console.log("app")',
      'assets/style.css': 'body{}',
      'assets/app.js.map': '{}',
      'assets/lipsync.wasm': '\0asm',
      'assets/worklet.js': 'class P extends AudioWorkletProcessor {}',
      'assets/chunk.mjs': 'export default 1',
      'favicon.ico': 'ico',
      '.env': 'SECRET=1',
      ...files,
    })
  }
  writeTree(path.join(root, 'lib'), { 'hello.wav': 'RIFFdata' })
  writeTree(root, { 'outside.txt': 'outside the static folder' })
  const server = createStageServer({
    port: 0,
    libraries: { lib: path.join(root, 'lib') },
    staticDir,
    ...extra,
  })
  await server.start()
  cleanup.add(() => server.stop())
  const port = server.port
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/stage`,
    root,
    staticDir,
  }
}

const connectOk = async (
  run: Running,
  opts: Parameters<typeof TestStage.connect>[1] = {},
  url = run.wsUrl
) => {
  const stage = await TestStage.connect(url, { origin: run.origin, ...opts })
  cleanup.add(() => stage.close())
  return stage
}

const rejectedStatus = async (
  run: Running,
  opts: Parameters<typeof TestStage.connect>[1] = {},
  url = run.wsUrl
) => {
  try {
    const stage = await TestStage.connect(url, opts)
    stage.close()
    return 'connected'
  } catch (err) {
    if (err instanceof RejectedError) return err.status ?? `error: ${err.message}`
    throw err
  }
}

// ───────────────────────────── pure rules ─────────────────────────────

describe('checkUpgradeHeaders', () => {
  const base = {
    host: '127.0.0.1:5810',
    origin: 'http://127.0.0.1:5810',
    port: 5810,
    extraOrigins: [] as string[],
    dev: false,
    peerIsLoopback: true,
  }
  const verdict = (over: Partial<typeof base>) => checkUpgradeHeaders({ ...base, ...over })

  it('accepts the two loopback names with the bound port', () => {
    expect(verdict({})).toEqual({ ok: true })
    expect(verdict({ host: 'localhost:5810', origin: 'http://localhost:5810' })).toEqual({
      ok: true,
    })
    expect(verdict({ host: 'LOCALHOST:5810', origin: 'HTTP://LocalHost:5810/' })).toEqual({
      ok: true,
    })
    // the stage page opened through either name may talk to the same server
    expect(verdict({ host: '127.0.0.1:5810', origin: 'http://localhost:5810' })).toEqual({
      ok: true,
    })
  })

  it.each([
    undefined,
    '',
    '127.0.0.1',
    'localhost',
    '127.0.0.1:1',
    '127.0.0.1:5810.evil.example',
    '127.0.0.1.evil.example:5810',
    'evil.example',
    'evil.example:5810',
    '[::1]:5810',
    '0.0.0.0:5810',
    '127.0.0.1:5810, evil.example',
    '127.0.0.1:5810@evil.example',
    ' evil.example:5810',
  ])('rejects Host %j', (host) => {
    expect(verdict({ host })).toEqual({ ok: false, reason: 'bad_host' })
  })

  it.each([
    'null',
    '',
    'http://evil.example',
    'http://evil.example:5810',
    'https://127.0.0.1:5810',
    'http://127.0.0.1',
    'http://127.0.0.1:5811',
    'http://127.0.0.1:5810.evil.example',
    'http://127.0.0.1:5810@evil.example',
    'http://localhost.evil.example:5810',
    'file://',
    'chrome-extension://abc',
    'http://127.0.0.1:5810/path',
    'http://127.0.0.1:5810 http://evil.example',
  ])('rejects Origin %j', (origin) => {
    expect(verdict({ origin })).toEqual({ ok: false, reason: 'bad_origin' })
  })

  it('accepts origins listed in extraOrigins (normalised), nothing else', () => {
    const extraOrigins = ['http://127.0.0.1:5173', 'HTTP://Localhost:5174/']
    expect(verdict({ origin: 'http://127.0.0.1:5173', extraOrigins })).toEqual({ ok: true })
    expect(verdict({ origin: 'http://localhost:5174', extraOrigins })).toEqual({ ok: true })
    expect(verdict({ origin: 'http://127.0.0.1:5175', extraOrigins })).toEqual({
      ok: false,
      reason: 'bad_origin',
    })
  })

  it('a missing Origin needs dev mode or a loopback peer; the Host is checked either way', () => {
    expect(verdict({ origin: undefined })).toEqual({ ok: true })
    expect(verdict({ origin: undefined, peerIsLoopback: false })).toEqual({
      ok: false,
      reason: 'missing_origin',
    })
    expect(verdict({ origin: undefined, peerIsLoopback: false, dev: true })).toEqual({ ok: true })
    expect(verdict({ origin: undefined, host: 'evil.example:5810', dev: true })).toEqual({
      ok: false,
      reason: 'bad_host',
    })
    // dev mode does not excuse a wrong Origin
    expect(verdict({ origin: 'http://evil.example', dev: true })).toEqual({
      ok: false,
      reason: 'bad_origin',
    })
  })

  it('helper predicates', () => {
    expect(isAllowedHost('127.0.0.1:80', 80)).toBe(true)
    expect(isAllowedHost(undefined, 80)).toBe(false)
    expect(normalizeOrigin(' HTTP://Example.COM:1/// ')).toBe('http://example.com:1')
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])
      expect(isLoopbackAddress(a)).toBe(true)
    for (const a of ['192.168.1.5', '10.0.0.1', '::ffff:10.0.0.1', '8.8.8.8', '', undefined])
      expect(isLoopbackAddress(a)).toBe(false)
  })
})

// ───────────────────────────── binding and lifecycle ─────────────────────────────

describe('binding and lifecycle', () => {
  it('binds to 127.0.0.1 only, on a free port when asked for 0', async () => {
    const run = await start()
    const address = run.server.httpServer.address()
    expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' })
    expect(run.port).toBeGreaterThan(0)
    expect(run.server.port).toBe((address as net.AddressInfo).port)
    expect(run.server.url).toBe(`http://127.0.0.1:${run.port}`)

    // the IPv6 loopback and the machine's other addresses are not listening
    await expect(
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: '::1', port: run.port })
        socket.once('connect', () => {
          socket.destroy()
          resolve('connected')
        })
        socket.once('error', reject)
      })
    ).rejects.toBeInstanceOf(Error)
  })

  it('refuses to bind anywhere else, or to an invalid port', () => {
    expect(() => createStageServer({ port: 0, libraries: {}, host: '0.0.0.0' as never })).toThrow(
      /127\.0\.0\.1/
    )
    expect(() =>
      createStageServer({ port: 0, libraries: {}, host: 'localhost' as never })
    ).toThrow()
    expect(() => createStageServer({ port: -1, libraries: {} })).toThrow(RangeError)
    expect(() => createStageServer({ port: 70000, libraries: {} })).toThrow(RangeError)
    expect(() => createStageServer({ port: 1.5, libraries: {} })).toThrow(RangeError)
    expect(() => createStageServer({ port: 0, libraries: {}, host: '127.0.0.1' })).not.toThrow()
  })

  it('start() is idempotent and rejects when the port is taken', async () => {
    const run = await start()
    await run.server.start()
    const second = createStageServer({ port: run.port, libraries: {} })
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await second.stop()
    expect((await rawRequest(run.port, '/asset/lib/hello.wav')).status).toBe(200) // the first one is untouched
  })

  it('stop() closes connected stages with 1001, frees the port and can be called twice', async () => {
    const run = await start()
    const stage = await connectOk(run)
    stage.hello()
    await stage.waitForJson('welcome')
    await run.server.stop()
    expect((await stage.waitClosed()).code).toBe(1001)
    await expect(rawRequest(run.port, '/')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    await run.server.stop()
  })

  it('sets request timeouts so slow clients cannot hold sockets forever', async () => {
    const run = await start()
    const http = run.server.httpServer
    expect(http.headersTimeout).toBe(15_000)
    expect(http.requestTimeout).toBe(30_000)
    expect(http.keepAliveTimeout).toBe(5000)
    expect(http.headersTimeout).toBeLessThanOrEqual(http.requestTimeout)
  })
})

// ───────────────────────────── WebSocket upgrade ─────────────────────────────

describe('WebSocket upgrade', () => {
  it('accepts a page on the stage origin, selects the subprotocol and completes the handshake', async () => {
    const run = await start({ dev: true })
    run.server.hub.setLook({ type: 'look.set', calm: 0.5 })
    const stage = await connectOk(run)
    expect(stage.ws.protocol).toBe(STAGE_SUBPROTOCOL)
    stage.hello()
    const welcome = await stage.waitForJson('welcome')
    expect(welcome).toMatchObject({ protocol: 1, dev: true })
    await stage.waitForJson('look.set')
    expect(run.server.hub.state.connected).toBe(true)
  })

  it('picks the stage subprotocol out of several offered', async () => {
    const run = await start()
    const stage = await connectOk(run, { protocols: ['other.v9', STAGE_SUBPROTOCOL] })
    expect(stage.ws.protocol).toBe(STAGE_SUBPROTOCOL)
  })

  it('accepts the localhost names and origins listed in extraOrigins', async () => {
    const run = await start({ extraOrigins: ['http://127.0.0.1:5173'] })
    await connectOk(run, { origin: `http://localhost:${run.port}`, host: `localhost:${run.port}` })
    await connectOk(run, { origin: 'http://127.0.0.1:5173' })
  })

  it.each([
    ['a foreign origin', () => 'http://evil.example'],
    ['a foreign origin with the right port', (p: number) => `http://evil.example:${p}`],
    ['the wrong port', () => 'http://127.0.0.1:1'],
    ['no port', () => 'http://127.0.0.1'],
    ['https', (p: number) => `https://127.0.0.1:${p}`],
    ['the null origin', () => 'null'],
    ['a look-alike host', (p: number) => `http://127.0.0.1:${p}.evil.example`],
    ['an extension origin', () => 'chrome-extension://abcdef'],
  ])('403 for %s', async (_name, origin) => {
    const run = await start()
    expect(await rejectedStatus(run, { origin: origin(run.port) })).toBe(403)
    expect(run.server.hub.state.connected).toBe(false)
  })

  it.each([
    ['a foreign name', () => 'evil.example'],
    ['a foreign name with the port', (p: number) => `evil.example:${p}`],
    ['the IP without a port', () => '127.0.0.1'],
    ['the wrong port', () => '127.0.0.1:1'],
    ['localhost without a port', () => 'localhost'],
    ['a look-alike', (p: number) => `127.0.0.1.evil.example:${p}`],
    ['IPv6', (p: number) => `[::1]:${p}`],
  ])('403 for Host: %s (DNS rebinding)', async (_name, host) => {
    const run = await start()
    expect(await rejectedStatus(run, { origin: run.origin, host: host(run.port) })).toBe(403)
    expect(run.server.hub.state.connected).toBe(false)
  })

  it('a bad Host is refused even when the Origin is fine and dev mode is on', async () => {
    const run = await start({ dev: true })
    expect(await rejectedStatus(run, { origin: run.origin, host: 'evil.example' })).toBe(403)
  })

  it('handles a missing Origin according to dev mode and the loopback hook', async () => {
    // default: the peer is loopback, so non-browser tools (no Origin) are fine
    const open = await start()
    expect(await rejectedStatus(open, {})).toBe('connected')

    const seen: string[] = []
    const strict = await start({
      peerIsLoopback: (req) => {
        seen.push(req.url ?? '')
        return false
      },
    })
    expect(await rejectedStatus(strict, {})).toBe(403)
    expect(seen).toEqual(['/stage'])
    // a browser-style request with a proper Origin does not depend on the hook
    expect(await rejectedStatus(strict, { origin: strict.origin })).toBe('connected')

    const dev = await start({ dev: true, peerIsLoopback: () => false })
    expect(await rejectedStatus(dev, {})).toBe('connected')
  })

  it('rejects clients that do not offer the stage subprotocol', async () => {
    const run = await start()
    expect(await rejectedStatus(run, { origin: run.origin, protocols: [] })).toBe(400)
    expect(
      await rejectedStatus(run, { origin: run.origin, protocols: ['animatus.stage.v2'] })
    ).toBe(400)
    expect(await rejectedStatus(run, { origin: run.origin, protocols: ['chat'] })).toBe(400)
    expect(run.server.hub.state.connected).toBe(false)
  })

  it.each(['/', '/other', '/stage/x', '/stage/', '/STAGE', '/asset/lib/hello.wav', '/%73tage'])(
    '404 for an upgrade on %s',
    async (p) => {
      const run = await start()
      expect(
        await rejectedStatus(run, { origin: run.origin }, `ws://127.0.0.1:${run.port}${p}`)
      ).toBe(404)
    }
  )

  it('accepts a query string on /stage', async () => {
    const run = await start()
    await connectOk(run, {}, `${run.wsUrl}?reload=1`)
  })

  it('caps incoming frames at 64 KiB (1009)', async () => {
    const run = await start()
    const stage = await connectOk(run)
    stage.hello()
    await stage.waitForJson('welcome')
    stage.sendRaw('x'.repeat(70 * 1024))
    expect((await stage.waitClosed()).code).toBe(1009)
    await waitUntil(() => !run.server.hub.state.connected)
  })

  it('a frame just under the cap is parsed (and dropped as invalid, not fatal)', async () => {
    const run = await start()
    const stage = await connectOk(run)
    stage.hello()
    await stage.waitForJson('welcome')
    stage.sendRaw('y'.repeat(60 * 1024))
    await waitUntil(() => run.server.hub.counters.invalidFramesIn === 1)
    expect(stage.closeInfo).toBeNull()
  })

  it('passes the hub options through (heartbeat) and logs rejections', async () => {
    const { logger, has } = collectLogger()
    const run = await start({ logger, hub: { pingIntervalMs: 30, deadAfterMs: 5000 } })
    const stage = await connectOk(run)
    stage.hello()
    await stage.waitFor(() => stage.jsonTypes().includes('ping'), 3000, 'a ping')
    expect(await rejectedStatus(run, { origin: 'http://evil.example' })).toBe(403)
    expect(has('warn', 'rejected a stage upgrade')).toBe(true)
  })

  it('survives a client that drops the connection during the handshake', async () => {
    const run = await start()
    await rawSocket(
      run.port,
      `GET /stage HTTP/1.1\r\nHost: 127.0.0.1:${run.port}\r\nOrigin: ${run.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${STAGE_SUBPROTOCOL}\r\n\r\n`,
      150
    )
    await delay(50)
    expect((await rawRequest(run.port, '/asset/lib/hello.wav')).status).toBe(200)
  })
})

// ───────────────────────────── HTTP routes ─────────────────────────────

describe('HTTP routes', () => {
  it('serves assets through the route, with the query stripped', async () => {
    const run = await start()
    const r = await rawRequest(run.port, '/asset/lib/hello.wav?v=2')
    expect(r.status).toBe(200)
    expect(r.body.toString()).toBe('RIFFdata')
    expect(r.headers['content-type']).toBe('audio/wav')
  })

  it('an unknown /asset path is a 404, not the app shell', async () => {
    const run = await start()
    for (const p of ['/asset/nothing', '/asset/lib/missing.wav', '/asset/', '/asset']) {
      const r = await rawRequest(run.port, p)
      expect(r.status).toBe(404)
      expect(r.body.toString()).not.toContain('<title>')
    }
  })

  it('GET /stage without an upgrade says so', async () => {
    const run = await start()
    const r = await rawRequest(run.port, '/stage')
    expect(r.status).toBe(426)
    expect(r.headers.upgrade).toBe('websocket')
  })

  it('refuses any Host that is not a loopback name with the bound port, for every route', async () => {
    const run = await start()
    const hosts = [
      'evil.example',
      `evil.example:${run.port}`,
      '127.0.0.1',
      'localhost',
      `[::1]:${run.port}`,
      `127.0.0.1.evil.example:${run.port}`,
    ]
    for (const host of hosts) {
      for (const p of ['/', '/asset/lib/hello.wav', '/assets/app.js', '/stage', '/anything']) {
        const r = await rawRequest(run.port, p, { host })
        expect(r.status, `${host} ${p}`).toBe(403)
        expect(r.body.toString()).not.toContain('RIFFdata')
        expect(r.body.toString()).not.toContain('<title>')
        expect(r.headers['x-content-type-options']).toBe('nosniff')
      }
    }
    // the two allowed names work
    expect(
      (await rawRequest(run.port, '/asset/lib/hello.wav', { host: `localhost:${run.port}` })).status
    ).toBe(200)
    expect(
      (await rawRequest(run.port, '/asset/lib/hello.wav', { host: `LOCALHOST:${run.port}` })).status
    ).toBe(200)
  })

  it('has no CORS at all: preflights and cross-origin reads get nothing', async () => {
    const run = await start()
    const pre = await rawRequest(run.port, '/asset/lib/hello.wav', {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' },
    })
    expect(pre.status).toBe(405)
    const cross = await rawRequest(run.port, '/asset/lib/hello.wav', {
      headers: { Origin: 'http://evil.example' },
    })
    for (const r of [pre, cross])
      for (const name of Object.keys(r.headers))
        expect(name.startsWith('access-control-')).toBe(false)
    expect(cross.headers['cross-origin-resource-policy']).toBe('same-origin')
  })

  it('rejects methods other than GET and HEAD on the app routes', async () => {
    const run = await start()
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await rawRequest(run.port, '/', { method })
      expect(r.status).toBe(405)
      expect(r.headers.allow).toBe('GET, HEAD')
    }
  })

  it('rejects absolute-form request targets and other non-origin-form targets', async () => {
    const run = await start()
    const absolute = await rawSocket(
      run.port,
      `GET http://127.0.0.1:${run.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${run.port}\r\nConnection: close\r\n\r\n`
    )
    expect(absolute).toMatch(/^HTTP\/1\.1 400/)
    expect(absolute).not.toContain('<title>')
  })

  it('answers malformed requests without crashing the server', async () => {
    const run = await start()
    const junk = await rawSocket(run.port, 'THIS IS NOT HTTP\r\n\r\n', 500)
    expect(junk).toMatch(/^HTTP\/1\.1 400/)
    expect((await rawRequest(run.port, '/asset/lib/hello.wav')).status).toBe(200)
  })
})

// ───────────────────────────── static files ─────────────────────────────

describe('the stage build', () => {
  it('serves index.html at / with the CSP and the other security headers', async () => {
    const run = await start()
    for (const p of ['/', '/index.html']) {
      const r = await rawRequest(run.port, p)
      expect(r.status).toBe(200)
      expect(r.body.toString()).toBe(INDEX_HTML)
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(r.headers['content-security-policy']).toBe(EXPECTED_CSP)
      expect(r.headers['x-content-type-options']).toBe('nosniff')
      expect(r.headers['referrer-policy']).toBe('no-referrer')
      expect(r.headers['cache-control']).toBe('no-cache')
      expect(r.headers.etag).toBeTruthy()
    }
    expect(STAGE_CSP).toBe(EXPECTED_CSP)
  })

  it('serves scripts and styles with the right types and no CSP', async () => {
    const run = await start()
    const js = await rawRequest(run.port, '/assets/app.js')
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(js.headers['content-security-policy']).toBeUndefined()
    expect(js.headers['x-content-type-options']).toBe('nosniff')
    expect((await rawRequest(run.port, '/assets/style.css')).headers['content-type']).toBe(
      'text/css; charset=utf-8'
    )
    expect((await rawRequest(run.port, '/assets/app.js.map')).headers['content-type']).toBe(
      'application/json'
    )
    // the audio worklet module is fetched as a same-origin script, and WebAssembly needs its own type to be streamed
    const worklet = await rawRequest(run.port, '/assets/worklet.js')
    expect(worklet.status).toBe(200)
    expect(worklet.headers['content-type']).toMatch(/^text\/javascript\b/)
    expect(worklet.headers['content-security-policy']).toBeUndefined()
    const wasm = await rawRequest(run.port, '/assets/lipsync.wasm')
    expect(wasm.status).toBe(200)
    expect(wasm.headers['content-type']).toBe('application/wasm')
    expect(wasm.headers['x-content-type-options']).toBe('nosniff')
    expect((await rawRequest(run.port, '/assets/chunk.mjs')).headers['content-type']).toMatch(
      /^text\/javascript\b/
    )
    expect((await rawRequest(run.port, '/favicon.ico')).headers['content-type']).toBe(
      'image/x-icon'
    )
  })

  it('falls back to index.html only for paths without a file extension', async () => {
    const run = await start()
    for (const p of ['/console', '/a/b/c', '/assets', '/assets/', '/some-route/']) {
      const r = await rawRequest(run.port, p)
      expect(r.status, p).toBe(200)
      expect(r.body.toString(), p).toBe(INDEX_HTML)
      expect(r.headers['content-security-policy']).toBe(EXPECTED_CSP)
    }
    for (const p of [
      '/missing.js',
      '/assets/missing.css',
      '/some.route',
      '/nothing.png',
      '/assets/app.js.bak',
    ]) {
      const r = await rawRequest(run.port, p)
      expect(r.status, p).toBe(404)
      expect(r.body.toString(), p).not.toContain('<title>')
    }
  })

  it('answers HEAD and conditional requests for the page', async () => {
    const run = await start()
    const head = await rawRequest(run.port, '/', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(INDEX_HTML.length))
    expect(head.body.length).toBe(0)
    const etag = head.headers.etag as string
    const cond = await rawRequest(run.port, '/', { headers: { 'If-None-Match': etag } })
    expect(cond.status).toBe(304)
    expect(cond.body.length).toBe(0)
    expect(cond.headers['content-security-policy']).toBe(EXPECTED_CSP)
  })

  it.each([
    '/../outside.txt',
    '/%2e%2e/outside.txt',
    '/%2E%2E/outside.txt',
    '/assets/../../outside.txt',
    '/assets/%2e%2e/%2e%2e/outside.txt',
    '/..%2foutside.txt',
    '/assets/..%2f..%2foutside.txt',
    '/%252e%252e/outside.txt',
    '/..\\outside.txt',
    '/assets/..\\..\\outside.txt',
    '/%5coutside.txt',
    '/C:/Windows/win.ini',
    '/outside.txt%00.html',
    '/.env',
    '/assets/.env',
    '/%2eenv',
    '/assets//app.js',
    '/./index.html',
    '/assets/./app.js',
    '/%',
    '/a%zz',
  ])('404 for %s (never index.html, never a file outside the build)', async (p) => {
    const run = await start()
    const r = await rawRequest(run.port, p)
    expect(r.status).toBe(404)
    expect(r.body.toString()).not.toContain('outside the static folder')
    expect(r.body.toString()).not.toContain('SECRET')
    expect(r.body.toString()).not.toContain('<title>')
  })

  it('answers 503 with a plain-text hint while the stage has not been built', async () => {
    const run = await start({}, null) // no static folder on disk
    for (const method of ['GET', 'HEAD']) {
      const r = await rawRequest(run.port, '/', { method })
      expect(r.status).toBe(503)
      expect(r.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(r.headers['retry-after']).toBeTruthy()
      if (method === 'GET') {
        expect(r.body.toString()).toMatch(/has not been built/)
        expect(r.body.toString()).toMatch(/npm run build/)
      } else {
        expect(r.body.length).toBe(0)
      }
    }
    expect((await rawRequest(run.port, '/some/route')).status).toBe(503)
    // assets and the socket work without a build
    expect((await rawRequest(run.port, '/asset/lib/hello.wav')).status).toBe(200)
    await connectOk(run)
  })

  it('answers 503 when no static folder is configured at all', async () => {
    const tmp = makeTempDir()
    cleanup.add(() => tmp.remove())
    const server = createStageServer({ port: 0, libraries: {} })
    await server.start()
    cleanup.add(() => server.stop())
    expect((await rawRequest(server.port, '/')).status).toBe(503)
  })

  it('picks up a build that appears after the server started', async () => {
    const run = await start({}, null)
    expect((await rawRequest(run.port, '/')).status).toBe(503)
    fs.mkdirSync(run.staticDir, { recursive: true })
    expect((await rawRequest(run.port, '/')).status).toBe(503) // folder exists, index.html does not yet
    expect((await rawRequest(run.port, '/')).body.toString()).toMatch(/index\.html/)
    fs.writeFileSync(path.join(run.staticDir, 'index.html'), INDEX_HTML)
    const r = await rawRequest(run.port, '/')
    expect(r.status).toBe(200)
    expect(r.body.toString()).toBe(INDEX_HTML)
  })

  it('does not follow a junction out of the build folder', async (ctx) => {
    const run = await start()
    try {
      fs.symlinkSync(path.join(run.root, 'lib'), path.join(run.staticDir, 'escape'), 'junction')
    } catch {
      return ctx.skip()
    }
    const r = await rawRequest(run.port, '/escape/hello.wav')
    expect(r.status).toBe(404)
    expect(r.body.toString()).not.toContain('RIFFdata')
  })
})
