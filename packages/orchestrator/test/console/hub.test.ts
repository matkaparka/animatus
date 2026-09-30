import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { StatusView } from '@animatus/protocol'
import { FakeBackend } from '../../src/console/fake.ts'
import { ConsoleHub } from '../../src/console/hub.ts'
import type { HubOptions } from '../../src/console/hub.ts'
import { collectLogs } from './support.ts'

/** Just enough of a WebSocket for the hub: an emitter with the few methods and fields it touches. */
class FakeSocket extends EventEmitter {
  readyState = 1 // OPEN
  bufferedAmount = 0
  sent: string[] = []
  pings = 0
  terminated = false
  closedWith: { code?: number; reason?: string } | null = null
  failSends = false

  send(text: string, cb?: (err?: Error) => void): void {
    this.sent.push(text)
    cb?.(this.failSends ? new Error('write failed') : undefined)
  }
  ping(): void {
    this.pings++
  }
  terminate(): void {
    this.terminated = true
    this.readyState = 3
    this.emit('close')
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
    this.readyState = 3
    this.emit('close')
  }
  types(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type)
  }
  asWs(): WebSocket {
    return this as unknown as WebSocket
  }
}

const backend = new FakeBackend()
const status = () => Promise.resolve(StatusView.parse(backend.status()))

function makeHub(over: Partial<HubOptions> = {}) {
  const logs = collectLogs()
  const hub = new ConsoleHub({
    loadStatus: status,
    logger: logs.logger,
    statusIntervalMs: 1000,
    pingIntervalMs: 1000,
    ...over,
  })
  return { hub, logs }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
})

describe('ConsoleHub', () => {
  it('says hello, then sends a status snapshot, to a new socket', async () => {
    const { hub } = makeHub()
    const ws = new FakeSocket()
    hub.attach(ws.asWs())
    await flush()
    expect(ws.types()).toEqual(['hello', 'status'])
    expect(hub.size).toBe(1)
    ws.emit('close')
    expect(hub.size).toBe(0)
  })

  it('ignores whatever a socket sends', async () => {
    const { hub } = makeHub()
    const ws = new FakeSocket()
    hub.attach(ws.asWs())
    await flush()
    ws.emit('message', Buffer.from('{"type":"say","text":"hi"}'), false)
    ws.emit('message', Buffer.from([1, 2, 3]), true)
    expect(ws.types()).toEqual(['hello', 'status'])
    expect(hub.size).toBe(1)
  })

  it('a socket that errors is left to close by itself, and forgotten when it does', async () => {
    const { hub, logs } = makeHub()
    const ws = new FakeSocket()
    hub.attach(ws.asWs())
    ws.emit('error', new Error('reset by peer'))
    // the library sends its own close code after an error; cutting the socket here would replace it
    expect(ws.terminated).toBe(false)
    expect(logs.has('debug', 'console socket error')).toBe(true)
    ws.emit('close')
    expect(hub.size).toBe(0)
  })

  it('cuts off a console that is not keeping up rather than queueing for it without bound', async () => {
    const { hub, logs } = makeHub({ maxBufferedBytes: 1000 })
    const slow = new FakeSocket()
    const fine = new FakeSocket()
    hub.attach(slow.asWs())
    hub.attach(fine.asWs())
    await flush()
    slow.bufferedAmount = 5000
    hub.publish({ type: 'run', event: { ts: 1, kind: 'system', text: 'x' } })
    expect(slow.terminated).toBe(true)
    expect(hub.size).toBe(1)
    expect(fine.types()).toEqual(['hello', 'status', 'run'])
    expect(logs.has('warn', 'not keeping up')).toBe(true)
  })

  it('a failed send drops the socket', async () => {
    const { hub } = makeHub()
    const ws = new FakeSocket()
    hub.attach(ws.asWs())
    await flush()
    ws.failSends = true
    hub.publish({ type: 'run', event: { ts: 1, kind: 'system', text: 'x' } })
    expect(ws.terminated).toBe(true)
    expect(hub.size).toBe(0)
  })

  it('does not send to a socket that is closing', async () => {
    const { hub } = makeHub()
    const ws = new FakeSocket()
    hub.attach(ws.asWs())
    await flush()
    ws.readyState = 2 // CLOSING
    hub.publish({ type: 'run', event: { ts: 1, kind: 'system', text: 'x' } })
    expect(ws.types()).toEqual(['hello', 'status'])
  })

  it('publish validates: a bad event is refused and logged, a good one goes out', async () => {
    const { hub, logs } = makeHub()
    const ws = new FakeSocket()
    hub.attach(ws.asWs())
    await flush()
    hub.publish({ type: 'status', status: { api: 2 } } as never)
    expect(ws.types()).toEqual(['hello', 'status'])
    expect(logs.has('error', 'refused to publish')).toBe(true)
    hub.publish({
      type: 'alarm',
      alarm: { id: 'a1', ts: 1, level: 'error', code: 'c', message: 'm' },
    })
    expect(ws.types()).toEqual(['hello', 'status', 'alarm'])
  })

  it('pushes a status on the interval, and only while somebody is connected', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const loads = vi.fn(status)
    const { hub } = makeHub({ loadStatus: loads, statusIntervalMs: 100, pingIntervalMs: 100_000 })
    hub.start()
    await vi.advanceTimersByTimeAsync(500)
    expect(loads).not.toHaveBeenCalled() // nobody there: no work
    const ws = new FakeSocket()
    hub.attach(ws.asWs())
    await vi.advanceTimersByTimeAsync(0)
    expect(ws.types()).toEqual(['hello', 'status'])
    await vi.advanceTimersByTimeAsync(300)
    expect(ws.types().filter((t) => t === 'status')).toHaveLength(4)
    await hub.close()
  })

  it('does not start a second status build while one is still running', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let release: () => void = () => undefined
    let calls = 0
    const slow = () => {
      calls++
      return new Promise<StatusView>((resolve) => {
        release = () => resolve(StatusView.parse(backend.status()))
      })
    }
    const { hub } = makeHub({ loadStatus: slow, statusIntervalMs: 50, pingIntervalMs: 100_000 })
    hub.start()
    const ws = new FakeSocket()
    hub.attach(ws.asWs()) // one call for the connection itself
    expect(calls).toBe(1)
    release()
    await vi.advanceTimersByTimeAsync(50) // first tick starts a build
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(500) // ten more ticks, the build is still not done
    expect(calls).toBe(2)
    release()
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toBe(3)
    await hub.close()
  })

  it('a failing status build is logged once in a while, not on every tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const { hub, logs } = makeHub({
      loadStatus: () => Promise.reject(new Error('nope')),
      statusIntervalMs: 100,
      pingIntervalMs: 100_000,
    })
    hub.start()
    const ws = new FakeSocket()
    hub.attach(ws.asWs())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(logs.entries.filter((e) => e.msg === 'cannot build the console status')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(
      logs.entries.filter((e) => e.msg === 'cannot build the console status').length
    ).toBeGreaterThanOrEqual(2)
    expect(
      logs.entries.filter((e) => e.msg === 'cannot build the console status').length
    ).toBeLessThanOrEqual(3)
    await hub.close()
  })

  it('heartbeat: pings each socket every interval and terminates one that never answered', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { hub } = makeHub({ pingIntervalMs: 100, statusIntervalMs: 100_000 })
    hub.start()
    const answers = new FakeSocket()
    const silent = new FakeSocket()
    hub.attach(answers.asWs())
    hub.attach(silent.asWs())
    await vi.advanceTimersByTimeAsync(100)
    expect([answers.pings, silent.pings]).toEqual([1, 1])
    answers.emit('pong')
    await vi.advanceTimersByTimeAsync(100)
    expect(silent.terminated).toBe(true)
    expect(answers.terminated).toBe(false)
    expect(answers.pings).toBe(2)
    expect(hub.size).toBe(1)
    await hub.close()
  })

  it('close(): every socket is closed with 1001, stragglers are terminated after a moment, timers are gone', async () => {
    const { hub } = makeHub()
    hub.start()
    const polite = new FakeSocket()
    const stubborn = new FakeSocket()
    stubborn.close = function (this: FakeSocket, code?: number, reason?: string) {
      this.closedWith = { code, reason } // takes its time: never emits 'close' by itself
    }
    hub.attach(polite.asWs())
    hub.attach(stubborn.asWs())
    const started = Date.now()
    await hub.close()
    expect(polite.closedWith?.code).toBe(1001)
    expect(stubborn.closedWith?.code).toBe(1001)
    expect(stubborn.terminated).toBe(true)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(hub.size).toBe(0)
    await hub.close() // twice is fine
  })

  it('start() twice does not double the timers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { hub } = makeHub({ pingIntervalMs: 100, statusIntervalMs: 100_000 })
    hub.start()
    hub.start()
    const ws = new FakeSocket()
    hub.attach(ws.asWs())
    await vi.advanceTimersByTimeAsync(100)
    expect(ws.pings).toBe(1)
    await hub.close()
  })
})
