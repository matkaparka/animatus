import { afterEach, describe, expect, it } from 'vitest'
import { WorkerClient, WorkerError, WorkerFeed } from '../../src/workers/index.ts'
import { fakeWorker } from './fakes.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const o of open.splice(0)) await o.close()
})
const worker = async (over: Parameters<typeof fakeWorker>[0] = {}) => {
  const w = await fakeWorker(over)
  open.push(w)
  return w
}
const client = (url: string, extra: { timeoutMs?: number; expect?: string } = {}) =>
  new WorkerClient({ baseUrl: url, timeoutMs: 400, ...extra })

const failure = async (p: Promise<unknown>): Promise<WorkerError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof WorkerError) return e
    throw e
  }
  throw new Error('it did not fail')
}

describe('the client of a worker', () => {
  it('reads the state, checked against the protocol', async () => {
    const w = await worker({ facts: { turn: 12 }, summary: 'turn 12' })
    const s = await client(w.url).state()
    expect(s).toMatchObject({
      protocol: 1,
      worker: 'fakegame',
      epoch: 'epoch-aaaaaaaa',
      online: true,
      paused: true,
      latest_seq: 0,
      summary: 'turn 12',
      facts: { turn: 12 },
      planner: { thinking: false, executing: null, pending: 0, given_up: false },
    })
  })

  it('refuses a worker that is not the one it was told to expect', async () => {
    const w = await worker()
    const e = await failure(client(w.url, { expect: 'civ6' }).state())
    expect(e.code).toBe('wrong_worker')
    expect(e.message).toContain('fakegame')
  })

  it('an answer that is not the protocol is a bad_response that says where, not a crash', async () => {
    const w = await worker()
    w.s.misbehave.badState = true
    const e = await failure(client(w.url).state())
    expect(e.code).toBe('bad_response')
    expect(e.message).toContain('epoch')
  })

  it('an answer that is not JSON, or is huge, is a bad_response', async () => {
    const w = await worker()
    w.s.misbehave.badJson = true
    expect((await failure(client(w.url).state())).code).toBe('bad_response')
    w.s.misbehave.badJson = false
    w.s.misbehave.huge = true
    expect((await failure(client(w.url).state())).code).toBe('bad_response')
  })

  it('a worker that never answers is a timeout after the limit, not a hang; one that is not there is unreachable', async () => {
    const w = await worker()
    w.s.misbehave.hang = true
    const t0 = Date.now()
    const e = await failure(client(w.url, { timeoutMs: 150 }).state())
    expect(e.code).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(2000)
    await w.close()
    expect((await failure(client(w.url).state())).code).toBe('unreachable')
  })

  it('a directive: sent when the game is on, refused as not_online when it is not, and checked before it is sent', async () => {
    const w = await worker()
    const c = client(w.url)
    await c.command('  gather wood first  ')
    expect(w.s.directives).toEqual(['gather wood first'])
    w.s.online = false
    const e = await failure(c.command('anything'))
    expect([e.code, e.status]).toEqual(['not_online', 409])
    expect(e.message).toBe('the game is not connected')
    const before = w.s.requests.length
    expect((await failure(c.command('   '))).code).toBe('bad_request')
    expect((await failure(c.command('x'.repeat(301)))).code).toBe('bad_request')
    expect(w.s.requests).toHaveLength(before) // neither went out
  })

  it('pause and resume say whether the worker is paused afterwards; forget clears what it carries', async () => {
    const w = await worker()
    const c = client(w.url)
    expect(await c.pause(false)).toBe(false)
    expect(w.s.paused).toBe(false)
    expect(await c.pause(true)).toBe(true)
    await c.command('a directive')
    await c.forget()
    expect(w.s.directives).toEqual([])
    expect(w.s.lastCommand).toBeNull()
  })

  it('the trace comes back as a list', async () => {
    const w = await worker()
    expect(await client(w.url).trace(5)).toEqual([{ step: 1 }, { step: 2 }])
  })

  it('a refusal says what the worker said, and a status it should not have sent is only a status', async () => {
    const w = await worker()
    w.s.misbehave.status = 400
    const e = await failure(client(w.url).state())
    expect([e.code, e.message]).toEqual(['bad_request', 'refused for a test'])
    w.s.misbehave.status = 503
    expect((await failure(client(w.url).state())).code).toBe('refused')
  })
})

describe('reading the events of a worker', () => {
  it('a reader gets what is new, once, in order', async () => {
    const w = await worker()
    const feed = new WorkerFeed(client(w.url))
    w.push('turn', 'one')
    w.push('turn', 'two')
    let p = await feed.poll()
    expect(p.events.map((e) => e.text)).toEqual(['one', 'two'])
    expect(p.reset).toBe(false)
    expect((await feed.poll()).events).toEqual([])
    w.push('turn', 'three')
    p = await feed.poll()
    expect(p.events.map((e) => e.text)).toEqual(['three'])
  })

  it('starting from the state, what happened before is not news', async () => {
    const w = await worker()
    w.push('turn', 'old')
    const c = client(w.url)
    const feed = new WorkerFeed(c)
    feed.startFrom(await c.state())
    w.push('turn', 'new')
    expect((await feed.poll()).events.map((e) => e.text)).toEqual(['new'])
  })

  it('more than a page is read in pages, all of it, none twice', async () => {
    const w = await worker()
    for (let i = 1; i <= 130; i++) w.push('n', `event ${i}`)
    const feed = new WorkerFeed(client(w.url))
    const p = await feed.poll()
    expect(p.events).toHaveLength(130)
    expect(p.events.map((e) => e.seq)).toEqual(Array.from({ length: 130 }, (_, i) => i + 1))
    expect((await feed.poll()).events).toEqual([])
  })

  it('a restart is noticed: the reader starts over, and does not miss the first events of the new run', async () => {
    const w = await worker()
    const feed = new WorkerFeed(client(w.url))
    for (let i = 1; i <= 200; i++) w.push('n', `old ${i}`)
    expect((await feed.poll()).events).toHaveLength(200)
    // the worker restarts and, by the time anyone looks, has said 120 things: fewer than the reader had seen
    w.restart()
    for (let i = 1; i <= 120; i++) w.push('n', `new ${i}`)
    const p = await feed.poll()
    expect(p.reset).toBe(true)
    expect(p.events).toHaveLength(120)
    expect(p.events[0]?.text).toBe('new 1')
    expect(p.epoch).toBe(w.s.epoch)
    // and it goes on from there
    w.push('n', 'new 121')
    const q = await feed.poll()
    expect([q.reset, q.events.map((e) => e.text)]).toEqual([false, ['new 121']])
  })

  it('a restart with more events than before is noticed too (this is what the epoch is for)', async () => {
    const w = await worker()
    const feed = new WorkerFeed(client(w.url))
    for (let i = 1; i <= 5; i++) w.push('n', `old ${i}`)
    await feed.poll()
    w.restart()
    for (let i = 1; i <= 9; i++) w.push('n', `new ${i}`)
    const p = await feed.poll()
    expect([p.reset, p.events.length, p.events[0]?.text]).toEqual([true, 9, 'new 1'])
  })

  it('an event it has already seen is not handed on again', async () => {
    const w = await worker()
    const feed = new WorkerFeed(client(w.url))
    w.push('n', 'a')
    await feed.poll()
    // a worker that answers from too early (a bug on its side) must not make the reader repeat itself
    const c = client(w.url)
    const spy = feed as unknown as { api: { events: typeof c.events } }
    const real = spy.api.events.bind(c)
    spy.api.events = async (_after, epoch) => real(0, epoch)
    expect((await feed.poll()).events).toEqual([])
  })

  it('a worker that is away makes the poll throw a WorkerError, and the position is kept', async () => {
    const w = await worker()
    const feed = new WorkerFeed(client(w.url, { timeoutMs: 150 }))
    w.push('n', 'a')
    await feed.poll()
    w.s.misbehave.hang = true
    expect((await failure(feed.poll())).code).toBe('timeout')
    expect(feed.position.cursor).toBe(1)
    w.s.misbehave.hang = false
    w.push('n', 'b')
    expect((await feed.poll()).events.map((e) => e.text)).toEqual(['b'])
  })
})
