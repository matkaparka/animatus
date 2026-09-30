import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LlmRequest } from '../../src/llm/types.ts'
import { danmaku, installCleanup, rig, until } from './rig.ts'

installCleanup()

const system = (req: LlmRequest) => String(req.messages[0]?.content ?? '')
const lastUser = (req: LlmRequest) => String(req.messages.at(-1)?.content ?? '')
const isChat = (req: LlmRequest) => req.tag === 'chat'

const on = { memory: { enabled: true } }

describe('memory in the running program', () => {
  it('is off unless asked for: no folder, nothing in the prompt', async () => {
    const r = await rig()
    expect(r.app.memory).toBeNull()
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('hello there everyone'))
    await until(() => r.llm.requests.length >= 1, 4000)
    expect(system(r.llm.requests[0]!)).not.toContain('Things you remember')
    expect(existsSync(path.join(r.dir, 'data', 'memory'))).toBe(false)
  })

  it('what is known about a viewer goes into the prompt of the reply to them, and only to them', async () => {
    const r = await rig({ config: on })
    const memory = r.app.memory!
    const f = memory.store.viewerFile(1001, 'ann')
    await memory.store.append(
      f.path,
      { source: 'viewer', text: 'has a rabbit named Bun' },
      { author: 'system', header: f.header }
    )
    const g = memory.store.viewerFile(1002, 'bob')
    await memory.store.append(
      g.path,
      { source: 'viewer', text: 'collects stamps' },
      { author: 'system', header: g.header }
    )
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('good evening everyone'))
    await until(() => r.llm.requests.filter(isChat).length >= 1, 4000)
    const prompt = system(r.llm.requests.filter(isChat)[0]!)
    expect(prompt).toContain('Things you remember')
    expect(prompt).toContain('[viewer ann] has a rabbit named Bun')
    expect(prompt).not.toContain('stamps')
    expect(prompt).toContain('[human] is right before [viewer]')
  })

  it('the streamer’s edit is in effect for the very next reply, and so is undoing it', async () => {
    const r = await rig({ config: on })
    const store = r.app.memory!.store
    await store.append(
      'world/lore.md',
      { source: 'human', text: 'the channel mascot is a red panda' },
      { author: 'human' }
    )
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    const ask = async (text: string, n: number) => {
      r.bili.emit(danmaku(text))
      await until(() => r.llm.requests.filter(isChat).length >= n, 6000, `reply ${n}`)
      return system(r.llm.requests.filter(isChat)[n - 1]!)
    }
    expect(await ask('who is the channel mascot', 1)).toContain('red panda')

    // one line changed in the console
    const file = (await store.read('world/lore.md'))!
    const line = file.content.split('\n')[0]!
    const edited = await store.editLine(
      'world/lore.md',
      {
        index: 0,
        expectText: line,
        replacement: '[human] 2026-09-30 the channel mascot is a snow leopard',
      },
      { author: 'human' }
    )
    expect(edited.ok).toBe(true)
    const second = await ask('tell me about the channel mascot again', 2)
    expect(second).toContain('snow leopard')
    expect(second).not.toContain('red panda')

    // and a rollback
    const first = (await store.history('world/lore.md')).at(-1)!
    expect((await store.rollback('world/lore.md', first.hash)).ok).toBe(true)
    const third = await ask('what was the channel mascot called', 3)
    expect(third).toContain('red panda')
    expect(third).not.toContain('snow leopard')
  })

  it('the rules the streamer keeps in memory’s persona folder are part of the persona, and an edit is in the next reply', async () => {
    const r = await rig({ config: on })
    const store = r.app.memory!.store
    await store.write('persona/rules.md', 'Rule one: always greet newcomers warmly.\n', {
      author: 'human',
    })
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('good evening everyone'))
    await until(() => r.llm.requests.filter(isChat).length >= 1, 6000)
    const first = system(r.llm.requests.filter(isChat)[0]!)
    expect(first).toContain('Test persona') // the persona file is still there
    expect(first).toContain('Rule one: always greet newcomers warmly.')

    const file = (await store.read('persona/rules.md'))!
    await store.write('persona/rules.md', 'Rule one: keep answers under two sentences.\n', {
      author: 'human',
      expectedHash: file.hash,
    })
    r.bili.emit(danmaku('how are you doing today'))
    await until(() => r.llm.requests.filter(isChat).length >= 2, 6000)
    const second = system(r.llm.requests.filter(isChat)[1]!)
    expect(second).toContain('keep answers under two sentences')
    expect(second).not.toContain('greet newcomers')
    expect(second).toContain('Test persona')
  })

  it('what viewers write is kept for the next consolidation, and joining the crew is a fact at once', async () => {
    const r = await rig({ config: on })
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('I have a cat named Mimi', { uid: 1003, uname: 'cy' }))
    await until(() => r.llm.requests.filter(isChat).length >= 1, 4000)
    r.bili.emit({ type: 'guard', uid: 1004, uname: 'dee', level: 3, num: 1, ts: Date.now() })
    await until(() => r.llm.requests.filter(isChat).length >= 2, 6000)
    const store = r.app.memory!.store
    await store.history(null) // lets the fire-and-forget writes finish
    const events = await store.readInbox((await store.inboxFiles())[0]!)
    expect(events.map((e) => [e.kind, e.uid, e.text])).toContainEqual([
      'chat',
      1003,
      'I have a cat named Mimi',
    ])
    const guard = (await store.read('viewers/1004.md'))?.content ?? ''
    expect(guard).toContain('# dee (uid 1004)')
    expect(guard).toContain('开通了舰长')
  })

  it('"forget me" deletes the viewer’s file, tells the model in a line that repeats nothing, and leaves the others alone', async () => {
    const r = await rig({ config: on })
    const store = r.app.memory!.store
    const a = store.viewerFile(1001, 'ann')
    await store.append(
      a.path,
      { source: 'viewer', text: 'has a rabbit named Bun' },
      { author: 'system', header: a.header }
    )
    const b = store.viewerFile(1002, 'bob')
    await store.append(
      b.path,
      { source: 'viewer', text: 'collects stamps' },
      { author: 'system', header: b.header }
    )
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('忘记我'))
    await until(() => r.llm.requests.filter(isChat).length >= 1, 6000, 'the note to the model')
    const note = lastUser(r.llm.requests.filter(isChat)[0]!)
    expect(note).toContain('要求你忘记他')
    expect(note).not.toContain('Bun')
    expect(await store.read(a.path)).toBeNull()
    expect(await store.read(b.path)).not.toBeNull()
    expect(r.app.memory!.recall('rabbit', [{ uid: 1001, name: 'ann' }])).toEqual([])
    // it was not passed on as chat: the only call so far is the note, and the words themselves are not in it
    expect(note).not.toContain('弹幕')
  })

  it('the consolidation pass files away what a viewer said, through the same model as the chat', async () => {
    const r = await rig({ config: on })
    r.llm.reply = (req) =>
      req.tag === 'memory-consolidate'
        ? [JSON.stringify([{ fact: 'has a cat named Mimi', quote: 'I have a cat named Mimi' }])]
        : ['[neutral]ok.']
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('I have a cat named Mimi', { uid: 1003, uname: 'cy' }))
    await until(() => r.llm.requests.filter(isChat).length >= 1, 4000)
    r.bili.emit(danmaku('and she sleeps all day long', { uid: 1003, uname: 'cy' }))
    await until(() => r.llm.requests.filter(isChat).length >= 2, 6000)
    const store = r.app.memory!.store
    await store.history(null)
    const report = await r.app.memory!.consolidate()
    expect(report.failures).toEqual([])
    expect(report.factsAdded).toBe(1)
    expect((await store.read('viewers/1003.md'))?.content).toContain('[viewer]')
    expect((await store.read('viewers/1003.md'))?.content).toContain('has a cat named Mimi')
    const asked = r.llm.requests.find((q) => q.tag === 'memory-consolidate')!
    expect(String(asked.messages.at(-1)?.content)).toContain('I have a cat named Mimi')
    // and the next reply to cy knows
    r.llm.reply = () => ['[neutral]ok.']
    r.bili.emit(danmaku('remember me?', { uid: 1003, uname: 'cy' }))
    await until(() => r.llm.requests.filter(isChat).length >= 3, 6000)
    expect(system(r.llm.requests.filter(isChat)[2]!)).toContain('[viewer cy] has a cat named Mimi')
  })

  it('a memory folder that cannot be used is an alarm and the program still answers', async () => {
    const r = await rig({
      config: { memory: { enabled: true, dir: path.join('Z:', 'no', 'such', 'drive', 'memory') } },
    })
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('anyone home'))
    await until(() => r.llm.requests.filter(isChat).length >= 1, 5000)
    expect(r.app.alarms.list().some((a) => a.code === 'memory')).toBe(true)
  })

  it('the settings have sensible bounds', async () => {
    const { parseConfig } = await import('../../src/config.ts')
    const c = parseConfig({}, { root: '/x' })
    expect(c.memory).toMatchObject({ enabled: false, record_chat: true })
    expect(c.memory.recall).toEqual({
      max_lines: 8,
      max_chars: 900,
      per_speaker: 5,
      search_cache_days: 7,
    })
    expect(() => parseConfig({ memory: { recall: { max_lines: 0 } } }, { root: '/x' })).toThrow()
    expect(() =>
      parseConfig({ memory: { consolidate: { every_hours: 1000 } } }, { root: '/x' })
    ).toThrow()
    expect(() => parseConfig({ memory: { unknown: 1 } }, { root: '/x' })).toThrow()
  })
})
