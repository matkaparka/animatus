import { afterEach, describe, expect, it } from 'vitest'
import { LegacyLinkClient, WorkerError, WorkerFeed } from '../../src/workers/index.ts'
import { fakeLegacy } from './fakes.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const o of open.splice(0)) await o.close()
})
const legacy = async (over: Parameters<typeof fakeLegacy>[0] = {}) => {
  const l = await fakeLegacy(over)
  open.push(l)
  return l
}
const client = (url: string, worker = 'minecraft') =>
  new LegacyLinkClient({ baseUrl: url, timeoutMs: 400, worker })

const failure = async (p: Promise<unknown>): Promise<WorkerError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof WorkerError) return e
    throw e
  }
  throw new Error('it did not fail')
}

describe('an older agent behind the protocol', () => {
  it('a Civilization player’s status becomes a worker state', async () => {
    const l = await legacy({
      status: { game: 'civ6', turn: 12, summary: 'Turn 12, ahead in science', username: 'Rome' },
    })
    l.push('turn', 'Turn 12 done', 'soon')
    const s = await client(l.url).state()
    expect(s).toMatchObject({
      protocol: 1,
      worker: 'civ6',
      online: true,
      paused: false,
      latest_seq: 1,
      summary: 'Turn 12, ahead in science',
      facts: { turn: 12, username: 'Rome' },
      last_command: null,
    })
    expect(s.epoch).toMatch(/^legacy-[0-9a-f]{12}$/)
  })

  it('a Minecraft bot’s status: the game is named by the caller, and the vitals become a few facts', async () => {
    const l = await legacy({
      status: {
        health: 18,
        food: 15,
        position: { x: 10.4, y: 64, z: -3.6 },
        dimension: 'overworld',
        isDay: true,
        heldItem: 'stone_pickaxe',
        inventory: [{ name: 'dirt' }, { name: 'stick' }],
        otherPlayers: [],
        planner: {
          thinking: true,
          executing: { tool: 'goToCoordinate' },
          pending: 1,
          givenUp: false,
        },
      },
    })
    const s = await client(l.url, 'minecraft').state()
    expect(s.worker).toBe('minecraft')
    expect(s.facts).toEqual({
      health: 18,
      food: 15,
      dimension: 'overworld',
      isDay: true,
      heldItem: 'stone_pickaxe',
      position: '10, 64, -4',
      inventory_items: 2,
      other_players: 0,
    })
    expect(s.planner).toEqual({
      thinking: true,
      executing: 'goToCoordinate',
      pending: 1,
      given_up: false,
    })
  })

  it('the last directive comes through, and an odd status is a bad_response, not a crash', async () => {
    const l = await legacy()
    const c = client(l.url)
    await c.command('build a house')
    expect((await c.state()).last_command).toEqual({ text: 'build a house', at: 1 })
    l.s.misbehave.badStatus = true
    expect((await failure(c.state())).code).toBe('bad_response')
  })

  it('events keep their words and their urgency; one with an urgency it does not know counts as background', async () => {
    const l = await legacy()
    l.push('death', 'you died', 'immediate')
    l.s.events.push({ seq: 2, at: 5, kind: 'odd', text: 'strange', urgency: 'whenever' })
    const c = client(l.url)
    const r = await c.events(0, null)
    expect(r.events.map((e) => [e.seq, e.kind, e.urgency])).toEqual([
      [1, 'death', 'immediate'],
      [2, 'odd', 'later'],
    ])
    expect([r.reset, r.more, r.latest]).toEqual([false, false, 2])
  })

  it('a full page means there may be more', async () => {
    const l = await legacy()
    for (let i = 1; i <= 50; i++) l.push('n', `e${i}`)
    expect((await client(l.url).events(0, null)).more).toBe(true)
  })

  it('directives: not connected is not_online; pause and forget go through and say so', async () => {
    const l = await legacy()
    const c = client(l.url)
    await c.command('go north')
    expect(l.s.commands).toEqual(['go north'])
    l.s.online = false
    const e = await failure(c.command('anything'))
    expect([e.code, e.status]).toEqual(['not_online', 409])
    expect(await c.pause(true)).toBe(true)
    expect(await c.pause(false)).toBe(false)
    await c.forget()
    expect(l.s.forgot).toBe(1)
    expect(await c.trace()).toEqual([{ tool: 'x' }])
  })

  it('a refusal says what the agent said: the older link keeps its words in `reason`, not `message`', async () => {
    // Without this the operator, and the model on its next turn, were told "the worker answered 409" for a bot that
    // had said "game not connected".
    const l = await legacy()
    l.s.online = false
    const e = await failure(client(l.url).command('go north'))
    expect([e.code, e.status, e.message]).toEqual(['not_online', 409, 'game not connected'])
  })

  it('a restart of the agent (its numbers go backwards) is a new epoch, and a reader is told to start over', async () => {
    const l = await legacy()
    const c = client(l.url)
    const feed = new WorkerFeed(c)
    for (let i = 1; i <= 8; i++) l.push('n', `old ${i}`)
    const first = await c.state()
    expect((await feed.poll()).events).toHaveLength(8)
    l.restart()
    for (let i = 1; i <= 3; i++) l.push('n', `new ${i}`)
    const p = await feed.poll()
    expect(p.reset).toBe(true)
    expect(p.events.map((e) => e.text)).toEqual(['new 1', 'new 2', 'new 3'])
    expect(p.epoch).not.toBe(first.epoch)
    expect((await c.state()).epoch).toBe(p.epoch)
  })

  it('what it cannot tell (a restart that already has more events than the reader had seen) is not noticed: written down, not hidden', async () => {
    const l = await legacy()
    const c = client(l.url)
    const feed = new WorkerFeed(c)
    for (let i = 1; i <= 3; i++) l.push('n', `old ${i}`)
    await feed.poll()
    l.restart()
    for (let i = 1; i <= 6; i++) l.push('n', `new ${i}`)
    const p = await feed.poll()
    // the numbers went 1..3 then 1..6: from outside it looks like three more events; the first three of the new run are missed
    expect(p.reset).toBe(false)
    expect(p.events.map((e) => e.text)).toEqual(['new 4', 'new 5', 'new 6'])
  })

  it('a hung agent is a timeout, a closed one is unreachable', async () => {
    const l = await legacy()
    l.s.misbehave.hang = true
    expect(
      (await failure(new LegacyLinkClient({ baseUrl: l.url, timeoutMs: 100, worker: 'x' }).state()))
        .code
    ).toBe('timeout')
    await l.close()
    expect((await failure(client(l.url).state())).code).toBe('unreachable')
  })
})
