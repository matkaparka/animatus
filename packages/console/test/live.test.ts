import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleEvent } from '@animatus/protocol'
import { DEFAULT_BACKOFF, backoffDelay, createLive, defaultSocketUrl } from '../src/live.ts'
import type { Live, LiveState } from '../src/live.ts'
import { FakeSocket, TOKEN, fakeSocketFactory, hello, status } from './helpers.tsx'

const URL = 'ws://127.0.0.1:7000/api/ws'
/** No jitter: random() = 0.5 puts the spread at exactly 1. */
const steady = () => 0.5

let live: Live | null = null

function start(over: Partial<Parameters<typeof createLive>[0]> = {}) {
  const events: ConsoleEvent[] = []
  const states: LiveState[] = []
  live = createLive({
    token: TOKEN,
    url: URL,
    onEvent: (e) => events.push(e),
    onState: (s) => states.push(s),
    createSocket: fakeSocketFactory,
    random: steady,
    ...over,
  })
  return { events, states, live }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.reset()
})
afterEach(() => {
  live?.close()
  live = null
  vi.useRealTimers()
})

describe('backoffDelay', () => {
  it('doubles from 500 ms up to a ceiling of 15 s', () => {
    const delays = Array.from({ length: 8 }, (_, attempt) => backoffDelay(attempt, {}, steady))
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000])
    expect(DEFAULT_BACKOFF).toEqual({ baseMs: 500, maxMs: 15000, factor: 2, jitter: 0.2 })
  })

  it('spreads by the jitter either way and never goes negative', () => {
    expect(backoffDelay(0, {}, () => 0)).toBe(400)
    expect(backoffDelay(0, {}, () => 1)).toBe(600)
    expect(backoffDelay(3, {}, () => 0)).toBe(3200)
    for (let attempt = 0; attempt < 30; attempt++) {
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const d = backoffDelay(attempt, {}, () => r)
        expect(d).toBeGreaterThanOrEqual(0)
        expect(d).toBeLessThanOrEqual(15000 * 1.2)
      }
    }
  })

  it('takes its numbers from the options', () => {
    expect(backoffDelay(2, { baseMs: 100, factor: 3, maxMs: 10_000, jitter: 0 }, Math.random)).toBe(
      900
    )
    expect(backoffDelay(9, { baseMs: 100, factor: 3, maxMs: 1000, jitter: 0 })).toBe(1000)
    expect(backoffDelay(-5, { baseMs: 100, jitter: 0 })).toBe(100)
  })
})

describe('defaultSocketUrl', () => {
  it('follows the page: ws for http, wss for https, same host and port', () => {
    expect(defaultSocketUrl({ protocol: 'http:', host: '127.0.0.1:7000' })).toBe(
      'ws://127.0.0.1:7000/api/ws'
    )
    expect(defaultSocketUrl({ protocol: 'https:', host: 'console.example:8443' })).toBe(
      'wss://console.example:8443/api/ws'
    )
  })
})

describe('connecting', () => {
  it('offers the console subprotocol and the token as a second subprotocol, at the given address', () => {
    start()
    const socket = FakeSocket.latest()
    expect(socket.url).toBe(URL)
    expect(socket.protocols).toEqual(['animatus.console.v1', `token.${TOKEN}`])
    expect(socket.url).not.toContain(TOKEN)
  })

  it('reports connecting, then open', () => {
    const { states } = start()
    expect(states).toEqual(['connecting'])
    FakeSocket.latest().open()
    expect(states).toEqual(['connecting', 'open'])
  })

  it('hands on what the server sends, once it has been checked', () => {
    const { events } = start()
    const socket = FakeSocket.latest()
    socket.open()
    socket.message(hello)
    socket.message({
      type: 'run',
      event: { ts: 1, kind: 'viewer', text: 'hi', trust: 'untrusted' },
    })
    socket.message({ type: 'status', status: status() })
    expect(events.map((e) => e.type)).toEqual(['hello', 'run', 'status'])
    expect(events[1]).toEqual({
      type: 'run',
      event: { ts: 1, kind: 'viewer', text: 'hi', trust: 'untrusted' },
    })
  })

  it('drops what it does not understand: junk, unknown types, wrong shapes', () => {
    const { events } = start()
    const socket = FakeSocket.latest()
    socket.open()
    socket.message('not json')
    socket.message('')
    socket.message('42')
    socket.message({ type: 'exec', cmd: 'calc' })
    socket.message({ type: 'run', event: { ts: 1, kind: 'nonsense', text: 'x' } })
    socket.message({ type: 'status', status: { api: 1 } })
    socket.message(null)
    socket.message(hello)
    expect(events.map((e) => e.type)).toEqual(['hello'])
  })
})

describe('reconnecting', () => {
  it('waits 500 ms, then 1 s, 2 s, 4 s ... when the connection keeps failing, and stops growing at 15 s', () => {
    const { states } = start()
    const waits: number[] = []
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = FakeSocket.instances.length
      FakeSocket.latest().drop()
      expect(states.at(-1)).toBe('waiting')
      const expected = backoffDelay(attempt, {}, steady)
      waits.push(expected)
      vi.advanceTimersByTime(expected - 1)
      expect(FakeSocket.instances.length, `attempt ${attempt} came early`).toBe(before)
      vi.advanceTimersByTime(1)
      expect(FakeSocket.instances.length, `attempt ${attempt} did not come`).toBe(before + 1)
      expect(states.at(-1)).toBe('connecting')
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000])
  })

  it('every attempt offers the same protocols', () => {
    start()
    FakeSocket.latest().drop()
    vi.advanceTimersByTime(500)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(FakeSocket.latest().protocols).toEqual(['animatus.console.v1', `token.${TOKEN}`])
    expect(FakeSocket.latest().url).toBe(URL)
  })

  it('a server that said hello is healthy: the next outage starts again from 500 ms', () => {
    const { live: l } = start()
    // two failures first
    FakeSocket.latest().drop()
    vi.advanceTimersByTime(500)
    FakeSocket.latest().drop()
    vi.advanceTimersByTime(1000)
    expect(l.attempts).toBe(2)
    const socket = FakeSocket.latest()
    socket.open()
    socket.message(hello)
    expect(l.attempts).toBe(0)
    socket.drop()
    const count = FakeSocket.instances.length
    vi.advanceTimersByTime(499)
    expect(FakeSocket.instances).toHaveLength(count)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(count + 1)
  })

  it('a connection that opens and dies without a hello does not reset the backoff', () => {
    const { live: l } = start()
    for (let attempt = 0; attempt < 3; attempt++) {
      const socket = FakeSocket.latest()
      socket.open()
      socket.drop()
      vi.advanceTimersByTime(backoffDelay(attempt, {}, steady))
    }
    expect(l.attempts).toBe(3)
    expect(FakeSocket.instances).toHaveLength(4)
  })

  it('an error on its own does nothing; the close is what counts', () => {
    const { states } = start()
    const socket = FakeSocket.latest()
    socket.onerror?.({})
    expect(states).toEqual(['connecting'])
    socket.drop()
    expect(states.at(-1)).toBe('waiting')
  })

  it('uses the backoff it is given', () => {
    start({ backoff: { baseMs: 100, factor: 3, maxMs: 1000, jitter: 0 } })
    FakeSocket.latest().drop()
    vi.advanceTimersByTime(99)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)
    FakeSocket.latest().drop()
    vi.advanceTimersByTime(299)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)
  })

  it('spreads the retries with jitter: the clients of one outage do not all come back at the same instant', () => {
    const draws = [0, 1, 0.5]
    let n = 0
    start({ random: () => draws[n++ % draws.length] as number })
    const arrivals: number[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const count = FakeSocket.instances.length
      const began = Date.now()
      FakeSocket.latest().drop()
      while (FakeSocket.instances.length === count) vi.advanceTimersByTime(1)
      arrivals.push(Date.now() - began)
    }
    // 500 ms +/- 20 %, then 1000 ms +/- 20 %, then 2000 ms: three different waits from three different draws
    expect(arrivals).toEqual([400, 1200, 2000])
  })
})

describe('closing', () => {
  it('close() closes the socket, and nothing is retried afterwards', () => {
    const { live: l, states } = start()
    const socket = FakeSocket.latest()
    socket.open()
    l.close()
    expect(socket.closeCalls).toBe(1)
    expect(socket.closedWith).toBe(1000)
    // a late close event from that socket changes nothing
    socket.drop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(states).toEqual(['connecting', 'open'])
    l.close() // twice is fine
  })

  it('close() cancels a retry that is waiting', () => {
    const { live: l } = start()
    FakeSocket.latest().drop()
    l.close()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('a socket that has been replaced can no longer speak', () => {
    const { events } = start()
    const old = FakeSocket.latest()
    old.open()
    const stale = old.onmessage
    old.drop()
    vi.advanceTimersByTime(500)
    stale?.({
      data: JSON.stringify({ type: 'run', event: { ts: 1, kind: 'system', text: 'late' } }),
    })
    expect(events).toEqual([])
    expect(old.onmessage).toBeNull()
    expect(old.onclose).toBeNull()
  })
})

describe('a connection that has gone quiet', () => {
  it('is dropped and retried after staleMs without a message', () => {
    const { states } = start({ staleMs: 1000 })
    const socket = FakeSocket.latest()
    socket.open()
    socket.message(hello)
    vi.advanceTimersByTime(900)
    expect(states.at(-1)).toBe('open')
    vi.advanceTimersByTime(700)
    expect(states.at(-1)).toBe('waiting')
    expect(socket.closeCalls).toBeGreaterThanOrEqual(1)
    vi.advanceTimersByTime(500)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('messages keep it alive', () => {
    const { states } = start({ staleMs: 1000 })
    const socket = FakeSocket.latest()
    socket.open()
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(400)
      socket.message({ type: 'run', event: { ts: i, kind: 'system', text: 'tick' } })
    }
    expect(states.at(-1)).toBe('open')
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('a connection that never opens is left to the close event, not the stale timer', () => {
    start({ staleMs: 1000 })
    vi.advanceTimersByTime(10_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
