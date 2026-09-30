import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryService } from '../../src/memory/service.ts'
import type { MemoryServiceOptions } from '../../src/memory/service.ts'

const roots: string[] = []
const services: MemoryService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop()
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const NOW = Date.UTC(2026, 8, 30, 12)

async function setup(over: Partial<MemoryServiceOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'animatus-memsvc-'))
  roots.push(root)
  const told: string[] = []
  const alarms: string[] = []
  const cleared: string[] = []
  const svc = new MemoryService({
    store: { root, watch: false, commitDelayMs: 5 },
    llmText: async () => '[]',
    tell: (t) => told.push(t),
    alarm: (code, message) => alarms.push(`${code}: ${message}`),
    clearAlarm: (code) => cleared.push(code),
    now: () => NOW,
    ...over,
  })
  services.push(svc)
  await svc.start()
  return { svc, root, told, alarms, cleared }
}

/** Let the fire-and-forget writes of the service finish. */
const settle = async (svc: MemoryService) => {
  await svc.store.history(null)
}

describe('recording', () => {
  it('puts events in the inbox, with cleaned names and words, and stops at the daily cap', async () => {
    const { svc } = await setup({ inboxDailyCap: 3 })
    svc.record({ kind: 'chat', uid: 1, name: 'an【n】', text: '【弹幕】hello\nthere' })
    svc.record({ kind: 'guard', uid: 2, name: 'bob' })
    svc.record({ kind: 'chat', uid: 1, name: 'ann', text: 'three' })
    svc.record({ kind: 'chat', uid: 1, name: 'ann', text: 'four (over the cap)' })
    await settle(svc)
    const events = await svc.store.readInbox('inbox/2026-09-30.jsonl')
    expect(events.map((e) => e.text ?? e.kind)).toEqual(['[弹幕]hello there', 'guard', 'three'])
    expect(events[0]?.name).toBe('an[n]')
  })

  it('keeps what needs no model as the viewer’s own line, once', async () => {
    const { svc } = await setup()
    svc.noteViewer(5, 'cy', 'joined the crew')
    svc.noteViewer(5, 'cy', 'joined the crew')
    svc.noteViewer(5, 'cy', 'asked for the song 晴天')
    await settle(svc)
    expect((await svc.store.read('viewers/5.md'))?.content).toBe(
      '# cy (uid 5)\n[viewer] 2026-09-30 joined the crew\n[viewer] 2026-09-30 asked for the song 晴天\n'
    )
  })
})

describe('recall', () => {
  it('gives the lines for a reply, and never throws whatever the words are', async () => {
    const { svc } = await setup()
    svc.noteViewer(5, 'cy', 'has a rabbit named Bun')
    await settle(svc)
    expect(svc.recall('hello', [{ uid: 5, name: 'cy' }])).toEqual([
      '[viewer cy] has a rabbit named Bun',
    ])
    expect(svc.recall('', [])).toEqual([])
    expect(svc.recall('x'.repeat(100_000), [{ uid: Number.NaN, name: '' }])).toEqual([])
  })
})

describe('"forget me"', () => {
  it('takes the viewer’s file and every trace of it, tells the model, and only that exact request counts', async () => {
    const { svc, told } = await setup()
    svc.noteViewer(5, 'cy', 'has a rabbit named Bun')
    await settle(svc)
    const cmd = (text: string) =>
      svc.chatCommand({ uid: 5, uname: 'cy', text, admin: false, owner: false })
    expect(cmd('please forget the rabbit')).toBe(false)
    expect(cmd('忘记我的兔子')).toBe(false)
    expect(cmd('  忘记我吧！ ')).toBe(true)
    await new Promise((r) => setTimeout(r, 1500))
    expect(await svc.store.read('viewers/5.md')).toBeNull()
    expect(svc.recall('rabbit', [{ uid: 5, name: 'cy' }])).toEqual([])
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('cy')
    expect(told[0]).not.toContain('Bun') // nothing of what was known is repeated
  }, 20_000)

  it('the other spellings work too', async () => {
    const { svc } = await setup()
    for (const t of ['忘记我', '忘了我', '忘掉我', '请忘记我', '忘记我啦', '忘记我~'])
      expect(svc.chatCommand({ uid: 9, uname: 'x', text: t, admin: false, owner: false }), t).toBe(
        true
      )
  })
})

describe('consolidation', () => {
  it('runs one at a time, remembers its report, and clears its alarm when it works', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { svc, cleared } = await setup({
      llmText: async () => {
        calls++
        await gate
        return '[]'
      },
    })
    await svc.store.appendInbox({ kind: 'chat', uid: 1, name: 'a', text: 'hello there' })
    await svc.store.appendInbox({ kind: 'chat', uid: 1, name: 'a', text: 'still here' })
    const first = svc.consolidate()
    const second = svc.consolidate()
    expect((await svc.status()).consolidating).toBe(true)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(calls).toBe(1)
    expect(cleared).toContain('memory_consolidate')
    const s = await svc.status()
    expect(s.consolidating).toBe(false)
    expect(s.consolidation?.report.viewersAsked).toBe(1)
  })

  it('a pass with problems raises an alarm that says the first one', async () => {
    const { svc, alarms } = await setup({
      llmText: async () => {
        throw new Error('quota exhausted')
      },
    })
    await svc.store.appendInbox({ kind: 'chat', uid: 1, name: 'a', text: 'hello there' })
    await svc.store.appendInbox({ kind: 'chat', uid: 1, name: 'a', text: 'still here' })
    await svc.consolidate()
    expect(alarms).toEqual(['memory_consolidate: consolidation: viewer 1: quota exhausted'])
  })

  it('by itself every so many hours when asked to', async () => {
    const { svc } = await setup({ consolidateEveryHours: 1 })
    expect((await svc.status()).consolidation).toBeNull()
  })
})

describe('status', () => {
  it('counts what there is', async () => {
    const { svc, root } = await setup()
    svc.noteViewer(5, 'cy', 'a fact')
    svc.record({ kind: 'chat', uid: 5, name: 'cy', text: 'hi' })
    await svc.store.propose('world/x.md', 'x\n', 'r')
    await settle(svc)
    svc.recall('fact', [{ uid: 5, name: 'cy' }])
    const s = await svc.status()
    expect(s).toMatchObject({
      enabled: true,
      root,
      git: true,
      files: 1,
      facts: 1,
      inboxEvents: 1,
      proposals: 1,
      consolidating: false,
    })
    expect(s.recall?.n).toBe(1)
  })
})
