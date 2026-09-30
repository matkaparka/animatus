import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeBackend } from '../../src/console/fake.ts'
import { createConsoleServer } from '../../src/console/server.ts'
import { TEST_TOKEN, createCleanup, rawRequest, startConsole } from './support.ts'

const cleanup = createCleanup()
afterEach(() => cleanup.run())

const start = (over: Parameters<typeof startConsole>[1] = {}) => startConsole(cleanup, over)

describe('binding', () => {
  it('binds to 127.0.0.1 only, on a free port when asked for 0', async () => {
    const run = await start()
    const address = run.server.httpServer.address()
    expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' })
    expect(run.port).toBeGreaterThan(0)
    expect(run.server.port).toBe((address as net.AddressInfo).port)
    expect(run.server.url).toBe(`http://127.0.0.1:${run.port}`)

    // the IPv6 loopback is not listening
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

  it('answers only on the loopback interface: no other local address of this machine reaches it', async () => {
    const run = await start()
    const { networkInterfaces } = await import('node:os')
    const others = Object.values(networkInterfaces())
      .flat()
      .filter(
        (i): i is NonNullable<typeof i> =>
          i !== undefined && i.family === 'IPv4' && i.address !== '127.0.0.1' && !i.internal
      )
    for (const iface of others.slice(0, 3)) {
      await expect(
        new Promise((resolve, reject) => {
          const socket = net.connect({ host: iface.address, port: run.port })
          socket.setTimeout(1000, () => {
            socket.destroy()
            reject(new Error('timed out'))
          })
          socket.once('connect', () => {
            socket.destroy()
            resolve('connected')
          })
          socket.once('error', reject)
        }),
        iface.address
      ).rejects.toBeInstanceOf(Error)
    }
  })

  it('refuses to bind anywhere else, or to an invalid port', () => {
    const backend = new FakeBackend()
    expect(() => createConsoleServer({ port: 0, backend, host: '0.0.0.0' as never })).toThrow(
      /127\.0\.0\.1/
    )
    expect(() => createConsoleServer({ port: 0, backend, host: 'localhost' as never })).toThrow()
    expect(() => createConsoleServer({ port: 0, backend, host: '::' as never })).toThrow()
    expect(() => createConsoleServer({ port: -1, backend })).toThrow(RangeError)
    expect(() => createConsoleServer({ port: 70000, backend })).toThrow(RangeError)
    expect(() => createConsoleServer({ port: 1.5, backend })).toThrow(RangeError)
    expect(() => createConsoleServer({ port: 0, backend, host: '127.0.0.1' })).not.toThrow()
  })

  it('the address to open carries the token in the fragment; the port is the real one', async () => {
    const run = await start()
    expect(run.server.openUrl).toBe(`http://127.0.0.1:${run.port}/#token=${TEST_TOKEN}`)
    expect(new URL(run.server.openUrl).hash).toBe(`#token=${TEST_TOKEN}`)
    // the fragment is never part of a request line: the server cannot see what follows '#'
    expect(new URL(run.server.openUrl).pathname + new URL(run.server.openUrl).search).toBe('/')
  })
})

describe('lifecycle', () => {
  it('start() is idempotent and rejects when the port is taken', async () => {
    const run = await start()
    await run.server.start()
    const second = createConsoleServer({ port: run.port, backend: new FakeBackend() })
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await second.stop()
    expect((await run.call('GET', '/api/status')).status).toBe(200) // the first one is untouched
  })

  it('stop() frees the port and can be called twice, or before start()', async () => {
    const run = await start()
    await run.server.stop()
    await expect(rawRequest(run.port, '/')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    await run.server.stop()
    const never = createConsoleServer({ port: 0, backend: new FakeBackend() })
    await never.stop()
    await never.stop()
  })

  it('sets request timeouts so slow clients cannot hold sockets forever', async () => {
    const run = await start()
    const server = run.server.httpServer
    expect(server.headersTimeout).toBe(15_000)
    expect(server.requestTimeout).toBe(30_000)
    expect(server.keepAliveTimeout).toBe(5000)
  })

  it('reports the number of connected consoles', async () => {
    const run = await start()
    expect(run.server.clientCount).toBe(0)
  })

  it('logs where it listens, without the token', async () => {
    const run = await start()
    expect(run.logs.has('info', 'console server listening')).toBe(true)
    expect(run.logs.text()).toContain(`http://127.0.0.1:${run.port}`)
    expect(run.logs.text()).not.toContain(TEST_TOKEN)
  })

  it('two servers do not share tokens, limits or consoles', async () => {
    const a = await start({ token: undefined })
    const b = await start({ token: undefined })
    expect(a.token).not.toBe(b.token)
    expect((await a.call('GET', '/api/status', { token: b.token })).status).toBe(401)
    expect((await b.call('GET', '/api/status', { token: a.token })).status).toBe(401)
    expect((await a.call('GET', '/api/status')).status).toBe(200)
  })
})
