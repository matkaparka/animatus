import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Recall } from '../../src/memory/recall.ts'
import { MemoryStore } from '../../src/memory/store.ts'
import type { Outcome } from '../../src/memory/store.ts'

const roots: string[] = []
const stores: MemoryStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.dispose()
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const NOW = Date.UTC(2026, 8, 30, 12)

async function setup(opts: { maxLines?: number; maxChars?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'animatus-recall-'))
  roots.push(root)
  const store = new MemoryStore({ root, watch: false, commitDelayMs: 5, now: () => NOW })
  stores.push(store)
  await store.init()
  const recall = new Recall(store, { ...opts, now: () => NOW })
  const ok = <T extends object>(r: Outcome<T>) => {
    if (!r.ok) throw new Error(r.message)
  }
  const viewer = async (uid: number, name: string, ...facts: string[]) => {
    const f = store.viewerFile(uid, name)
    for (const text of facts)
      ok(
        await store.append(
          f.path,
          { source: 'viewer', text },
          { author: 'system', header: f.header }
        )
      )
  }
  const human = async (file: string, text: string, locked = false) =>
    ok(await store.append(file, { source: 'human', text, locked }, { author: 'human' }))
  const agent = async (file: string, text: string) =>
    ok(await store.append(file, { source: 'agent', text }, { author: 'agent' }))
  return { store, recall, viewer, human, agent, root }
}

describe('recall', () => {
  it('starts with what is known about the people who just spoke, newest first, labelled with their name', async () => {
    const { recall, viewer } = await setup()
    await viewer(12, 'ann', 'has a cat named Mimi', 'plays chess', 'likes rainy days')
    await viewer(13, 'bob', 'has a dog')
    const r = recall.lookup({ text: 'hello everyone', speakers: [{ uid: 12, name: 'ann' }] })
    expect(r.lines).toEqual([
      '[viewer ann] likes rainy days',
      '[viewer ann] plays chess',
      '[viewer ann] has a cat named Mimi',
    ])
  })

  it('takes only the newest few lines of a speaker, and each speaker once', async () => {
    const { store, viewer } = await setup()
    await viewer(1, 'ann', 'one', 'two', 'three', 'four', 'five', 'six', 'seven')
    const recall = new Recall(store, { perSpeaker: 3, now: () => NOW })
    const r = recall.lookup({
      text: '',
      speakers: [
        { uid: 1, name: 'ann' },
        { uid: 1, name: 'ann again' },
      ],
    })
    expect(r.lines).toEqual(['[viewer ann] seven', '[viewer ann] six', '[viewer ann] five'])
  })

  it('then what matches the words, the streamer’s lines before the program’s, and labels each with its source', async () => {
    const { recall, human, agent } = await setup()
    await agent('world/lore.md', 'the community joke about pineapple pizza started in spring')
    await human('world/lore.md', 'pineapple pizza is the sacred meme of this channel')
    await human('world/other.md', 'something unrelated about trains')
    const r = recall.lookup({
      text: '【弹幕】ann：who started the pineapple pizza joke',
      speakers: [],
    })
    expect(r.lines).toEqual([
      '[human] pineapple pizza is the sacred meme of this channel',
      '[agent] the community joke about pineapple pizza started in spring',
    ])
  })

  it('other viewers’ files are not searched by topic; a viewer is only brought in when the message names them', async () => {
    const { recall, viewer } = await setup()
    await viewer(20, '阿花', 'is allergic to peanuts', 'plays the violin')
    await viewer(21, 'bob', 'plays the violin too')
    // a topic that matches their lines does not pull them in
    expect(recall.lookup({ text: 'who plays the violin', speakers: [] }).lines).toEqual([])
    // naming them does, with their newest lines
    const named = recall.lookup({
      text: '阿花 is here today',
      speakers: [{ uid: 21, name: 'bob' }],
    })
    expect(named.lines).toEqual([
      '[viewer bob] plays the violin too',
      '[viewer 阿花] plays the violin',
      '[viewer 阿花] is allergic to peanuts',
    ])
  })

  it('web results are labelled untrusted, and stale ones are not recalled', async () => {
    const { store, recall } = await setup()
    await store.write(
      'search-cache/weather.md',
      '[agent] 2026-09-29 tomorrow forecast for Shanghai: sunny\n[agent] 2026-08-01 old forecast for Shanghai: storms\n',
      { author: 'human' }
    )
    const r = recall.lookup({ text: 'what is the Shanghai forecast', speakers: [] })
    expect(r.lines).toEqual(['[web, unverified] tomorrow forecast for Shanghai: sunny'])
  })

  it('the persona, the proposals and the inbox are never recalled', async () => {
    const { store, recall } = await setup()
    await store.write('persona/rules.md', 'the secret rule about xylophones\n', { author: 'human' })
    await store.appendInbox({ kind: 'chat', uid: 1, name: 'a', text: 'a chat about xylophones' })
    await store.propose('world/x.md', 'a proposal about xylophones\n', 'r')
    expect(recall.lookup({ text: 'xylophones', speakers: [] }).lines).toEqual([])
  })

  it('never more lines or characters than allowed, and one line is never taken twice', async () => {
    const { store, human, recall } = await setup({ maxLines: 3, maxChars: 10_000 })
    const items = Array.from(
      { length: 10 },
      (_, i) => `[human] 2026-09-30 item ${i} about giraffes`
    )
    await store.write('world/a.md', `${items.join('\n')}\n`, { author: 'human' })
    void human
    const r = new Recall(store, { maxLines: 3, now: () => NOW }).lookup({
      text: 'giraffes',
      speakers: [],
    })
    expect(r.lines).toHaveLength(3)
    expect(new Set(r.lines).size).toBe(3)
    expect(recall).toBeDefined()
    const tight = new Recall(store, { maxLines: 10, maxChars: 60, now: () => NOW }).lookup({
      text: 'giraffes',
      speakers: [],
    })
    expect(tight.lines.join('').length).toBeLessThanOrEqual(60 + 30)
    expect(tight.lines.length).toBeGreaterThanOrEqual(1)
    expect(tight.lines.length).toBeLessThan(10)
  })

  it('a very long line is cut', async () => {
    const { human, recall } = await setup()
    await human('world/a.md', `giraffes ${'long '.repeat(200)}`)
    const [line] = recall.lookup({ text: 'giraffes', speakers: [] }).lines
    expect([...(line ?? '')].length).toBeLessThanOrEqual(260)
  })

  it('a match that is too weak is not worth a place in the prompt', async () => {
    const { recall, human, store } = await setup()
    const filler = Array.from(
      { length: 30 },
      (_, i) => `[human] 2026-09-30 filler line number ${i} with the word common`
    )
    await store.write('world/filler.md', `${filler.join('\n')}\n`, { author: 'human' })
    await human('world/a.md', 'an entry about okapi')
    expect(recall.lookup({ text: 'common', speakers: [] }).lines.length).toBeLessThanOrEqual(8)
    expect(recall.lookup({ text: 'okapi', speakers: [] }).lines).toEqual([
      '[human] an entry about okapi',
    ])
  })

  it('an edit by the streamer is in effect for the very next lookup, and so is a rollback of it', async () => {
    const { store, recall, human } = await setup()
    await human('world/rules.md', 'the mascot is a red panda')
    expect(recall.lookup({ text: 'what is the mascot', speakers: [] }).lines).toEqual([
      '[human] the mascot is a red panda',
    ])
    const file = (await store.read('world/rules.md'))!
    const r = await store.editLine(
      'world/rules.md',
      {
        index: 0,
        expectText: '[human] 2026-09-30 the mascot is a red panda',
        replacement: '[human] 2026-09-30 the mascot is a snow leopard',
      },
      { author: 'human' }
    )
    expect(r.ok).toBe(true)
    expect(file.hash).not.toBe((await store.read('world/rules.md'))!.hash)
    expect(recall.lookup({ text: 'what is the mascot', speakers: [] }).lines).toEqual([
      '[human] the mascot is a snow leopard',
    ])
    const first = (await store.history('world/rules.md')).at(-1)!
    await store.rollback('world/rules.md', first.hash)
    expect(recall.lookup({ text: 'what is the mascot', speakers: [] }).lines).toEqual([
      '[human] the mascot is a red panda',
    ])
  })

  it('reports how long lookups take', async () => {
    const { recall, human } = await setup()
    expect(recall.latency()).toBeNull()
    await human('world/a.md', 'something about llamas')
    for (let i = 0; i < 20; i++)
      recall.lookup({ text: 'llamas', speakers: [{ uid: 1, name: 'a' }] })
    const l = recall.latency()!
    expect(l.n).toBe(20)
    expect(l.p95).toBeGreaterThanOrEqual(l.p50)
    expect(l.p95).toBeLessThan(50) // a lookup over a small memory is a fraction of a millisecond
  })
})
