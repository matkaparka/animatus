import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONSOLE_SUBPROTOCOL,
  CONSOLE_TOKEN_PROTOCOL_PREFIX,
  ConsoleEvent,
  StatusView,
} from '@animatus/protocol'
import type { RunEvent } from '@animatus/protocol'
import { FakeBackend } from '../../src/console/fake.ts'
import {
  TEST_TOKEN,
  TestSocket,
  createCleanup,
  delay,
  rawSocket,
  startConsole,
  upgradeStatus,
  waitUntil,
} from './support.ts'
import type { Running } from './support.ts'

const cleanup = createCleanup()
afterEach(async () => {
  vi.useRealTimers()
  await cleanup.run()
})

const start = (over: Parameters<typeof startConsole>[1] = {}) => startConsole(cleanup, over)

const connect = async (run: Running, opts: Parameters<typeof TestSocket.connect>[1] = {}) => {
  const socket = await TestSocket.connect(run, opts)
  cleanup.add(() => socket.close())
  return socket
}

const runEvent = (text: string): { type: 'run'; event: RunEvent } => ({
  type: 'run',
  event: { ts: 1, kind: 'system', text },
})

describe('the handshake', () => {
  it('selects the console subprotocol, never the token one, and starts with hello then a status', async () => {
    const run = await start()
    const socket = await connect(run)
    expect(socket.ws.protocol).toBe(CONSOLE_SUBPROTOCOL)
    const hello = await socket.waitForType('hello')
    expect(ConsoleEvent.parse(hello)).toMatchObject({ type: 'hello', api: 1 })
    expect(typeof hello.now).toBe('number')
    const status = await socket.waitForType('status')
    expect(StatusView.safeParse(status.status).success).toBe(true)
    expect(socket.types().slice(0, 2)).toEqual(['hello', 'status'])
    expect(run.server.clientCount).toBe(1)
  })

  it('works when the token is offered first and other protocols are mixed in', async () => {
    const run = await start()
    const socket = await connect(run, {
      protocols: [`${CONSOLE_TOKEN_PROTOCOL_PREFIX}${TEST_TOKEN}`, 'other.v9', CONSOLE_SUBPROTOCOL],
    })
    expect(socket.ws.protocol).toBe(CONSOLE_SUBPROTOCOL)
    await socket.waitForType('hello')
  })

  it('refuses a missing or wrong token with 401', async () => {
    const run = await start()
    expect(await upgradeStatus(run, { token: null })).toBe(401)
    expect(await upgradeStatus(run, { token: 'x'.repeat(43) })).toBe(401)
    expect(await upgradeStatus(run, { token: '' })).toBe(401)
    expect(await upgradeStatus(run, { token: TEST_TOKEN.toUpperCase() })).toBe(401)
    expect(run.server.clientCount).toBe(0)
  })

  it('the token has to come as a subprotocol: a header, the query string or a cookie will not do', async () => {
    const run = await start()
    // no token entry, but the right token in every other place a client might put it
    const url = `${run.wsUrl}?token=${TEST_TOKEN}`
    expect(await upgradeStatus(run, { protocols: [CONSOLE_SUBPROTOCOL] }, url)).toBe(401)
    const socketless = await rawSocket(
      run.port,
      `GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1:${run.port}\r\nAuthorization: Bearer ${TEST_TOKEN}\r\nCookie: token=${TEST_TOKEN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${CONSOLE_SUBPROTOCOL}\r\n\r\n`
    )
    expect(socketless).toMatch(/^HTTP\/1\.1 401/)
  })

  it('offering two token entries is not two guesses: it is no token at all', async () => {
    const run = await start()
    const both = [
      CONSOLE_SUBPROTOCOL,
      `${CONSOLE_TOKEN_PROTOCOL_PREFIX}${'z'.repeat(43)}`,
      `${CONSOLE_TOKEN_PROTOCOL_PREFIX}${TEST_TOKEN}`,
    ]
    expect(await upgradeStatus(run, { protocols: both })).toBe(401)
    expect(await upgradeStatus(run, { protocols: [...both].reverse() })).toBe(401)
  })

  it('requires the console subprotocol next to the token (400), and the version has to match', async () => {
    const run = await start()
    const token = `${CONSOLE_TOKEN_PROTOCOL_PREFIX}${TEST_TOKEN}`
    expect(await upgradeStatus(run, { protocols: [token] })).toBe(400)
    expect(await upgradeStatus(run, { protocols: [token, 'animatus.console.v2'] })).toBe(400)
    expect(await upgradeStatus(run, { protocols: [token, 'animatus.stage.v1'] })).toBe(400)
    expect(await upgradeStatus(run, { protocols: [token, CONSOLE_SUBPROTOCOL] })).toBe('connected')
  })

  it('a refusal never echoes the token back', async () => {
    const run = await start()
    try {
      await TestSocket.connect(run, {
        token: ['guess', 'that', 'must', 'not', 'come', 'back', '1'].join('-'),
      })
      expect.unreachable()
    } catch (err) {
      const { status, body } = err as { status: number; body: string }
      expect(status).toBe(401)
      expect(body).not.toContain('guess-that-must-not-come-back-1')
      expect(JSON.parse(body)).toMatchObject({ error: { code: 'unauthorized' } })
    }
  })

  it.each([
    '/',
    '/api',
    '/api/ws/',
    '/api/wss',
    '/api/status',
    '/API/WS',
    '/ws',
    '/%61pi/ws',
    '/api/ws/extra',
  ])('404 for an upgrade on %s', async (p) => {
    const run = await start()
    expect(await upgradeStatus(run, {}, `ws://127.0.0.1:${run.port}${p}`)).toBe(404)
  })

  it('accepts a query string on the socket path', async () => {
    const run = await start()
    const socket = await TestSocket.connect(run, {}, `${run.wsUrl}?reload=1`)
    cleanup.add(() => socket.close())
    await socket.waitForType('hello')
  })

  it('a client that drops the connection during the handshake does not hurt the server', async () => {
    const run = await start()
    await rawSocket(
      run.port,
      `GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1:${run.port}\r\nOrigin: ${run.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${CONSOLE_SUBPROTOCOL}, ${CONSOLE_TOKEN_PROTOCOL_PREFIX}${TEST_TOKEN}\r\n\r\n`,
      150
    )
    await delay(50)
    expect((await run.call('GET', '/api/status')).status).toBe(200)
    await waitUntil(() => run.server.clientCount === 0)
  })

  it('caps the number of consoles that may be connected at once (503)', async () => {
    const run = await start({ maxClients: 2 })
    await connect(run)
    await connect(run)
    expect(await upgradeStatus(run)).toBe(503)
    expect(run.server.clientCount).toBe(2)
  })
})

describe('what the server sends', () => {
  it('pushes a status every two seconds by default', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const run = await start()
    const socket = await connect(run)
    await socket.waitForType('status', 1) // the one that comes with the connection
    expect(socket.ofType('status')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1999)
    await delay(60)
    expect(socket.ofType('status')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await socket.waitForType('status', 2)
    await vi.advanceTimersByTimeAsync(2000)
    await socket.waitForType('status', 3)
    expect(StatusView.safeParse(socket.ofType('status')[2]?.status).success).toBe(true)
  })

  it('the interval can be changed, and statuses reflect the backend as it is now', async () => {
    const run = await start({ statusIntervalMs: 40 })
    const socket = await connect(run)
    await socket.waitForType('status', 3)
    await run.call('POST', '/api/say', { body: { text: 'hello' } })
    const before = socket.ofType('status').length
    await socket.waitFor(() => socket.ofType('status').length > before + 1, 3000, 'later statuses')
    const last = StatusView.parse(socket.ofType('status').at(-1)?.status)
    expect(last.speech.speaking).toBe(true)
  })

  it('delivers everything passed to publish() to every connected console, in order', async () => {
    const run = await start()
    const sockets = await Promise.all([connect(run), connect(run), connect(run)])
    await Promise.all(sockets.map((s) => s.waitForType('hello')))
    for (let i = 0; i < 20; i++) run.server.publish(runEvent(`event ${i}`))
    for (const socket of sockets) {
      await socket.waitFor(() => socket.ofType('run').length === 20, 3000, '20 run events')
      expect(socket.ofType('run').map((m) => (m.event as RunEvent).text)).toEqual(
        Array.from({ length: 20 }, (_, i) => `event ${i}`)
      )
    }
    expect(run.server.clientCount).toBe(3)
  })

  it('carries every kind of event unchanged', async () => {
    const run = await start()
    const socket = await connect(run)
    await socket.waitForType('hello')
    const status = run.backend.status()
    const plugin = status.plugins[0]!
    const mode = status.modes[0]!
    const events: ConsoleEvent[] = [
      { type: 'run', event: { ts: 5, kind: 'viewer', text: 'amber_fox: hi', trust: 'untrusted' } },
      {
        type: 'trace',
        trace: {
          id: 't1',
          turn: 'u1',
          text: 'hello',
          audioSec: 1.2,
          synthMs: 100,
          liveMotion: 'used',
        },
      },
      {
        type: 'alarm',
        alarm: { id: 'a1', ts: 6, level: 'warn', code: 'demo', message: 'm', subject: 'draw' },
      },
      { type: 'plugin', plugin },
      { type: 'mode', mode },
    ]
    for (const event of events) run.server.publish(event)
    await socket.waitFor(
      () => ['run', 'trace', 'alarm', 'plugin', 'mode'].every((t) => socket.ofType(t).length >= 1),
      3000,
      'all kinds'
    )
    expect(socket.ofType('run').at(-1)).toEqual(events[0])
    expect(socket.ofType('trace').at(-1)).toEqual(events[1])
    expect(socket.ofType('alarm').at(-1)).toEqual(events[2])
    expect(ConsoleEvent.parse(socket.ofType('plugin').at(-1))).toMatchObject({
      type: 'plugin',
      plugin: { id: plugin.id },
    })
    expect(ConsoleEvent.parse(socket.ofType('mode').at(-1))).toMatchObject({
      type: 'mode',
      mode: { id: mode.id },
    })
  })

  it('backend events reach the console when the backend is wired to publish()', async () => {
    const run = await start()
    const backend = run.backend
    const off = backend.onEvent((event) => run.server.publish(event))
    cleanup.add(off)
    const socket = await connect(run)
    await socket.waitForType('hello')
    await run.call('POST', '/api/inject', { body: { text: 'wired' } })
    await socket.waitFor(
      () => socket.ofType('run').some((m) => (m.event as RunEvent).text.includes('wired')),
      3000,
      'the injected line'
    )
    const line = socket.ofType('run').find((m) => (m.event as RunEvent).text.includes('wired'))
    expect((line?.event as RunEvent).trust).toBe('untrusted')
    await run.call('POST', '/api/plugins/image/start')
    await socket.waitForType('plugin')
    expect(socket.ofType('plugin').at(-1)).toMatchObject({ plugin: { id: 'image' } })
  })

  it('refuses to publish an event that breaks the contract, and says so in the log', async () => {
    const run = await start()
    const socket = await connect(run)
    await socket.waitForType('hello')
    run.server.publish({ type: 'run', event: { ts: 1, kind: 'nonsense', text: 'x' } } as never)
    run.server.publish({ type: 'exec', cmd: 'x' } as never)
    run.server.publish(runEvent('a valid one'))
    await socket.waitFor(() => socket.ofType('run').length === 1, 3000, 'the valid event')
    expect(socket.types().filter((t) => t === 'exec')).toEqual([])
    expect(socket.ofType('run')).toHaveLength(1)
    expect(run.logs.has('error', 'refused to publish an invalid console event')).toBe(true)
  })

  it('publish() with nobody connected, and before start(), does nothing and does not throw', async () => {
    const run = await start()
    expect(() => run.server.publish(runEvent('into the void'))).not.toThrow()
  })
})

describe('what the server ignores', () => {
  it('anything the client sends: commands, junk and binary frames change nothing and cost nothing', async () => {
    const run = await start()
    const socket = await connect(run)
    await socket.waitForType('status')
    const seen = socket.received.length
    socket.send(JSON.stringify({ type: 'say', text: 'do it' }))
    socket.send(JSON.stringify({ type: 'exec', cmd: 'calc' }))
    socket.send('not even json')
    socket.send(new Uint8Array([1, 2, 3]))
    await delay(100)
    expect(socket.closeInfo).toBeNull()
    expect(run.backend.audit.filter((a) => a.op !== 'status')).toEqual([])
    // nothing was answered (a status tick may have arrived, and that is all)
    expect(socket.received.slice(seen).every((m) => m.type === 'status')).toBe(true)
    expect(run.server.clientCount).toBe(1)
  })

  it('a frame over a few KiB closes the socket with 1009', async () => {
    const run = await start()
    const socket = await connect(run)
    await socket.waitForType('hello')
    socket.send('x'.repeat(70 * 1024))
    expect((await socket.waitClosed()).code).toBe(1009)
    await waitUntil(() => run.server.clientCount === 0)
  })
})

describe('connections coming and going', () => {
  it('answers a protocol-level ping with a pong (the one thing a client may send that gets an answer)', async () => {
    const run = await start()
    const socket = await connect(run)
    await socket.waitForType('hello')
    const ponged = new Promise<void>((resolve) => socket.ws.once('pong', () => resolve()))
    socket.ws.ping()
    await ponged
    expect(socket.closeInfo).toBeNull()
  })

  it('a clean close and an abrupt one both leave the count at zero, however many there are', async () => {
    const run = await start()
    const sockets = await Promise.all(Array.from({ length: 8 }, () => connect(run)))
    await Promise.all(sockets.map((s) => s.waitForType('hello')))
    expect(run.server.clientCount).toBe(8)
    sockets.slice(0, 4).forEach((s) => s.close())
    sockets.slice(4).forEach((s) => s.ws.terminate())
    await waitUntil(() => run.server.clientCount === 0, 3000, 'all consoles to be gone')
    run.server.publish(runEvent('after everyone left'))
    expect((await run.call('GET', '/api/status')).status).toBe(200)
    // and new ones can come
    const again = await connect(run)
    await again.waitForType('hello')
    expect(run.server.clientCount).toBe(1)
  })

  it('a console that stops answering the heartbeat is dropped; one that answers stays', async () => {
    const run = await start({ pingIntervalMs: 40 })
    const quiet = await connect(run, { autoPong: false })
    const lively = await connect(run)
    await lively.waitForType('hello')
    const closed = await quiet.waitClosed(3000)
    expect(closed.code).toBe(1006)
    await delay(200)
    expect(lively.closeInfo).toBeNull()
    expect(run.server.clientCount).toBe(1)
  })

  it('stop() closes every console with 1001 and frees the port', async () => {
    const run = await start()
    const sockets = await Promise.all([connect(run), connect(run)])
    await Promise.all(sockets.map((s) => s.waitForType('hello')))
    await run.server.stop()
    for (const socket of sockets) expect((await socket.waitClosed()).code).toBe(1001)
    await expect(run.call('GET', '/api/status')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    await run.server.stop() // twice is fine
  })

  it('stop() does not wait for a console that will not close', async () => {
    const run = await start()
    const stubborn = await connect(run, { autoPong: false })
    await stubborn.waitForType('hello')
    const started = Date.now()
    await run.server.stop()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(stubborn.closeInfo).not.toBeNull()
  })
})

describe('a backend that cannot produce a status', () => {
  it('does not stop the socket: hello arrives, the problem is logged once, statuses resume when the backend recovers', async () => {
    class Flaky extends FakeBackend {
      broken = true
      override status() {
        if (this.broken) throw new Error('status is down for maintenance')
        return super.status()
      }
    }
    const backend = new Flaky()
    const run = await start({ backend, statusIntervalMs: 30 })
    const socket = await connect(run)
    await socket.waitForType('hello')
    await delay(200)
    expect(socket.closeInfo).toBeNull()
    expect(socket.ofType('status')).toHaveLength(0)
    expect(
      run.logs.entries.filter((e) => e.msg === 'cannot build the console status')
    ).toHaveLength(1) // throttled
    expect((await run.call('GET', '/api/status')).status).toBe(500)
    backend.broken = false
    await socket.waitForType('status')
  })
})
