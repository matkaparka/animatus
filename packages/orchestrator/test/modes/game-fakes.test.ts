/**
 * The in-process agent of the game tests (`MemoryWorker`) and the reference fake over HTTP (`../workers/fakes.ts`, the one
 * that is checked against the client) must be the same worker: the random test of the game mode runs on the first, and a
 * difference would make it prove things about a worker that does not exist. The same script runs against both.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkerClient, WorkerError } from '../../src/workers/index.ts'
import type { WorkerApi } from '../../src/workers/index.ts'
import { fakeWorker } from '../workers/fakes.ts'
import { MemoryWorker } from './gameFakes.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const o of open.splice(0)) await o.close()
})

interface Agent {
  api: WorkerApi
  push(kind: string, text: string, urgency: 'immediate' | 'soon' | 'later'): void
  restart(): void
  setOnline(online: boolean): void
}

async function http(): Promise<Agent> {
  const w = await fakeWorker()
  open.push(w)
  return {
    api: new WorkerClient({ baseUrl: w.url, timeoutMs: 1000 }),
    push: (k, t, u) => w.push(k, t, u),
    restart: () => w.restart(),
    setOnline: (v) => void (w.s.online = v),
  }
}

function memory(): Agent {
  const m = new MemoryWorker()
  return {
    api: m.client(1000),
    push: (k, t, u) => m.push(k, t, u),
    restart: () => m.restart(),
    setOnline: (v) => void (m.online = v),
  }
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    if (e instanceof WorkerError) return `${e.code}: ${e.message}`
    throw e
  }
  return 'it did not fail'
}

/** What a reader could see of the agent, with the parts that are chosen at random (epochs, times) taken out. */
async function script(a: Agent): Promise<unknown[]> {
  const seen: unknown[] = []
  const shape = (s: Awaited<ReturnType<WorkerApi['state']>>) => ({
    worker: s.worker,
    online: s.online,
    paused: s.paused,
    planner: s.planner,
    last_command: s.last_command === null ? null : s.last_command.text,
    latest_seq: s.latest_seq,
    summary: s.summary,
    facts: s.facts,
  })
  const page = (r: Awaited<ReturnType<WorkerApi['events']>>, epoch: string) => ({
    sameEpoch: r.epoch === epoch,
    latest: r.latest,
    reset: r.reset,
    more: r.more,
    events: r.events.map((e) => [e.seq, e.kind, e.text, e.urgency]),
  })
  const first = await a.api.state()
  seen.push(shape(first)) // starts paused
  for (const [k, t, u] of [
    ['turn', 'Turn 1', 'soon'],
    ['death', 'You died', 'immediate'],
    ['note', 'a note', 'later'],
  ] as const)
    a.push(k, t, u)
  seen.push((await a.api.state()).latest_seq)
  seen.push(page(await a.api.events(0, null), first.epoch))
  seen.push(page(await a.api.events(0, first.epoch), first.epoch))
  seen.push(page(await a.api.events(2, first.epoch), first.epoch))
  seen.push(page(await a.api.events(3, first.epoch), first.epoch))
  seen.push(page(await a.api.events(2, null), first.epoch)) // from the middle with no epoch: start over
  seen.push(page(await a.api.events(1, 'somebody-elses-epoch'), first.epoch)) // another run: start over

  seen.push(await a.api.pause(false), (await a.api.state()).paused)
  seen.push(await a.api.pause(true), (await a.api.state()).paused)
  await a.api.command('  gather wood  ')
  seen.push(shape(await a.api.state()))
  seen.push(page(await a.api.events(3, first.epoch), first.epoch)) // the directive is an event
  seen.push(await failure(a.api.command('   ')))
  seen.push(await failure(a.api.command('x'.repeat(301))))
  a.setOnline(false)
  seen.push(await failure(a.api.command('go north')))
  seen.push((await a.api.state()).online)
  a.setOnline(true)
  await a.api.forget()
  seen.push(shape(await a.api.state()))
  seen.push(await a.api.trace(5))

  // a backlog of more than a page
  for (let i = 1; i <= 120; i++) a.push('n', `event ${i}`, 'later')
  const p1 = await a.api.events(0, first.epoch)
  seen.push(page(p1, first.epoch))
  seen.push(page(await a.api.events(50, first.epoch), first.epoch))
  seen.push(page(await a.api.events(100, first.epoch), first.epoch))

  // a restart: a new epoch, the numbers start again, paused again
  await a.api.pause(false)
  a.restart()
  const second = await a.api.state()
  seen.push({ newEpoch: second.epoch !== first.epoch, ...shape(second) })
  a.push('n', 'after the restart', 'soon')
  seen.push(page(await a.api.events(50, first.epoch), second.epoch)) // the old reader is told to start over
  seen.push(page(await a.api.events(0, second.epoch), second.epoch))
  return seen
}

describe('the two fake agents are one agent', () => {
  it('give the same answers to the same script, restart and backlog included', async () => {
    const [a, b] = [await http(), memory()]
    const over = await script(a)
    const inProcess = await script(b)
    expect(inProcess).toEqual(over)
    expect(over.length).toBeGreaterThan(20) // the script did run
  })

  it('the in-process one can be made to fail like a real one, and only the calls the test says', async () => {
    const m = new MemoryWorker()
    const api = m.client(500)
    m.fault = { kind: 'unreachable' }
    expect(await failure(api.state())).toMatch(/^unreachable: /)
    m.fault = { kind: 'garbage' }
    expect(await failure(api.state())).toMatch(/^bad_response: /)
    m.fault = { kind: 'refuse', status: 409, message: 'bot offline' }
    expect(await failure(api.command('x'))).toBe('not_online: bot offline')
    m.fault = (call) => (call === 'pause:true' ? { kind: 'refuse', status: 503 } : null)
    expect((await api.state()).worker).toBe('fakegame')
    expect(await failure(api.pause(true))).toMatch(/^refused: /)
    expect(await api.pause(false)).toBe(false)
    expect(m.calls).toEqual(['state', 'state', 'command:x', 'state', 'pause:true', 'pause:false'])
    expect(m.count('state')).toBe(3)
    expect(m.count('pause')).toBe(2)
  })

  it('a worker it is told to expect is checked like the real client does', async () => {
    const m = new MemoryWorker()
    expect(await failure(m.client(500, 'civ6').state())).toBe(
      'wrong_worker: this is the worker "fakegame", not "civ6"'
    )
    expect((await m.client(500, 'fakegame').state()).worker).toBe('fakegame')
  })
})
