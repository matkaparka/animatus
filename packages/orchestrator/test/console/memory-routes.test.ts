import { afterEach, describe, expect, it } from 'vitest'
import {
  MemoryFileView,
  MemoryForgetResponse,
  MemoryHashResponse,
  MemoryHistoryResponse,
  MemoryProposalsResponse,
  MemoryStatusView,
  MemoryTreeResponse,
  MemoryConsolidateReport,
} from '@animatus/protocol'
import { AppBackend } from '../../src/console/appBackend.ts'
import { installCleanup, rig } from '../app/rig.ts'
import { createCleanup, errorCode, startConsole } from './support.ts'

const cleanup = createCleanup()
installCleanup()
afterEach(() => cleanup.run())

/** The real console server over a real app with memory on. */
async function open(memory = true) {
  const r = await rig({ config: memory ? { memory: { enabled: true } } : {} })
  const run = await startConsole(cleanup, { backend: new AppBackend(r.app) as never })
  const store = r.app.memory?.store
  return { r, run, store }
}

const json = <T>(res: { json<T>(): T }) => res.json<T>()
const put = (run: Awaited<ReturnType<typeof open>>['run'], body: unknown) =>
  run.call('PUT', '/api/memory/file', { body })
const line = (run: Awaited<ReturnType<typeof open>>['run'], body: unknown) =>
  run.call('POST', '/api/memory/line', { body })

describe('memory switched off', () => {
  it('says so at the status, and refuses everything else with memory_off', async () => {
    const { run } = await open(false)
    expect(json(await run.call('GET', '/api/memory'))).toEqual({ enabled: false })
    for (const [method, path, body] of [
      ['GET', '/api/memory/tree', undefined],
      ['GET', '/api/memory/file?path=world/a.md', undefined],
      ['PUT', '/api/memory/file', { path: 'world/a.md', content: 'x' }],
      ['POST', '/api/memory/line', { op: 'add', path: 'world/a.md', text: 'x' }],
      ['GET', '/api/memory/history', undefined],
      ['POST', '/api/memory/forget', { uid: 5 }],
      ['POST', '/api/memory/consolidate', undefined],
      ['GET', '/api/memory/proposals', undefined],
    ] as const) {
      const res = await run.call(method, path, body ? { body } : {})
      expect(res.status, `${method} ${path}`).toBe(409)
      expect(errorCode(res)).toBe('memory_off')
    }
  })
})

describe('the streamer’s editor over the real memory', () => {
  it('reports a status that satisfies the contract, and lists files with their facts', async () => {
    const { run, store } = await open()
    await store!.append(
      'world/lore.md',
      { source: 'human', text: 'the mascot is a red panda' },
      { author: 'human' }
    )
    const status = MemoryStatusView.parse(json(await run.call('GET', '/api/memory')))
    expect(status).toMatchObject({
      enabled: true,
      git: true,
      files: 1,
      facts: 1,
      consolidating: false,
    })
    const tree = MemoryTreeResponse.parse(json(await run.call('GET', '/api/memory/tree')))
    expect(tree.files.map((f) => [f.path, f.section, f.facts])).toEqual([
      ['world/lore.md', 'world', 1],
    ])
  })

  it('reads a file line by line with the source, the lock and a hash', async () => {
    const { run, store } = await open()
    await store!.append(
      'world/lore.md',
      { source: 'human', text: 'locked rule', locked: true },
      { author: 'human' }
    )
    await store!.append(
      'world/lore.md',
      { source: 'agent', text: 'a summary' },
      { author: 'agent' }
    )
    const file = MemoryFileView.parse(
      json(await run.call('GET', '/api/memory/file?path=world%2Flore.md'))
    )
    expect(file.versioned).toBe(true)
    expect(file.lines.map((l) => [l.index, l.kind, l.source, l.locked, l.body])).toEqual([
      [0, 'fact', 'human', true, 'locked rule'],
      [1, 'fact', 'agent', false, 'a summary'],
    ])
    expect(file.hash).toMatch(/^[0-9a-f]{40}$/)
    expect((await run.call('GET', '/api/memory/file?path=world%2Fnone.md')).status).toBe(404)
    expect((await run.call('GET', '/api/memory/file?path=..%2Fetc%2Fpasswd')).status).toBe(400)
    expect(errorCode(await run.call('GET', '/api/memory/file'))).toBe('invalid_query')
  })

  it('viewer files say they have no history', async () => {
    const { run, store } = await open()
    const v = store!.viewerFile(5, 'cy')
    await store!.append(
      v.path,
      { source: 'viewer', text: 'a fact' },
      { author: 'system', header: v.header }
    )
    const file = MemoryFileView.parse(
      json(await run.call('GET', '/api/memory/file?path=viewers%2F5.md'))
    )
    expect(file.versioned).toBe(false)
  })

  it('a whole-file write needs the hash it is based on; a stale one is a 409 and nothing changes', async () => {
    const { run } = await open()
    const first = MemoryHashResponse.parse(
      json(await put(run, { path: 'world/a.md', content: 'one\n' }))
    )
    const second = MemoryHashResponse.parse(
      json(await put(run, { path: 'world/a.md', content: 'two\n', expected_hash: first.hash }))
    )
    expect(second.hash).not.toBe(first.hash)
    const stale = await put(run, {
      path: 'world/a.md',
      content: 'lost\n',
      expected_hash: first.hash,
    })
    expect(stale.status).toBe(409)
    expect(errorCode(stale)).toBe('conflict')
    const now = MemoryFileView.parse(
      json(await run.call('GET', '/api/memory/file?path=world%2Fa.md'))
    )
    expect(now.lines.map((l) => l.text)).toEqual(['two'])
    expect((await put(run, { path: 'nowhere.md', content: 'x' })).status).toBe(400)
    // a whole-file write is for small files: the schema stops it at 60,000 characters, the transport at 64 KB
    expect((await put(run, { path: 'world/big.md', content: 'x'.repeat(62_000) })).status).toBe(400)
    expect((await put(run, { path: 'world/big.md', content: 'x'.repeat(300_000) })).status).toBe(
      413
    )
  })

  it('adds, edits, removes, locks and unlocks lines; a line that moved is a 409', async () => {
    const { run } = await open()
    const added = MemoryHashResponse.parse(
      json(await line(run, { op: 'add', path: 'world/a.md', text: 'first fact' }))
    )
    expect(added.hash).toMatch(/^[0-9a-f]{40}$/)
    await line(run, { op: 'add', path: 'world/a.md', text: 'second fact', locked: true })
    let file = MemoryFileView.parse(
      json(await run.call('GET', '/api/memory/file?path=world%2Fa.md'))
    )
    const [a, b] = file.lines
    expect(b?.locked).toBe(true)

    const edit = await line(run, {
      op: 'edit',
      path: 'world/a.md',
      index: 0,
      expect: a!.text,
      text: '[human] 2026-09-30 reworded',
    })
    expect(edit.status).toBe(200)
    const again = await line(run, {
      op: 'edit',
      path: 'world/a.md',
      index: 0,
      expect: a!.text,
      text: 'x',
    })
    expect(again.status).toBe(409)
    expect(errorCode(again)).toBe('conflict')

    const unlock = await line(run, { op: 'unlock', path: 'world/a.md', index: 1, expect: b!.text })
    expect(unlock.status).toBe(200)
    file = MemoryFileView.parse(json(await run.call('GET', '/api/memory/file?path=world%2Fa.md')))
    expect(file.lines.map((l) => [l.body, l.locked])).toEqual([
      ['reworded', false],
      ['second fact', false],
    ])
    const lock = await line(run, {
      op: 'lock',
      path: 'world/a.md',
      index: 1,
      expect: file.lines[1]!.text,
    })
    expect(lock.status).toBe(200)

    const remove = await line(run, {
      op: 'remove',
      path: 'world/a.md',
      index: 0,
      expect: file.lines[0]!.text,
    })
    expect(remove.status).toBe(200)
    file = MemoryFileView.parse(json(await run.call('GET', '/api/memory/file?path=world%2Fa.md')))
    expect(file.lines.map((l) => l.body)).toEqual(['second fact'])
  })

  it('validates a line request: an operation that is not one, a missing field, a bad path', async () => {
    const { run } = await open()
    expect((await line(run, { op: 'explode', path: 'world/a.md' })).status).toBe(400)
    expect((await line(run, { op: 'add', path: 'world/a.md' })).status).toBe(400)
    expect((await line(run, { op: 'add', path: 'nowhere/a.md', text: 'x' })).status).toBe(400)
    expect(
      (await line(run, { op: 'edit', path: 'world/none.md', index: 0, expect: 'x', text: 'y' }))
        .status
    ).toBe(404)
  })

  it('history, diff and rollback: the streamer undoes an edit, and the undo is a commit of its own', async () => {
    const { run } = await open()
    const first = MemoryHashResponse.parse(
      json(await put(run, { path: 'world/a.md', content: 'first\n' }))
    )
    await put(run, { path: 'world/a.md', content: 'second\n', expected_hash: first.hash })
    const history = MemoryHistoryResponse.parse(
      json(await run.call('GET', '/api/memory/history?path=world%2Fa.md'))
    )
    expect(history.commits.map((c) => c.author)).toEqual(['human', 'human'])
    const [newer, older] = history.commits as [
      (typeof history.commits)[number],
      (typeof history.commits)[number],
    ]
    const diff = await run.call(
      'GET',
      `/api/memory/diff?path=world%2Fa.md&from=${older.hash}&to=${newer.hash}`
    )
    expect(diff.status).toBe(200)
    expect(diff.text()).toContain('-first')
    expect(diff.text()).toContain('+second')
    const back = await run.call('POST', '/api/memory/rollback', {
      body: { path: 'world/a.md', rev: older.hash },
    })
    expect(back.status).toBe(200)
    const file = MemoryFileView.parse(
      json(await run.call('GET', '/api/memory/file?path=world%2Fa.md'))
    )
    expect(file.lines.map((l) => l.text)).toEqual(['first'])
    const after = MemoryHistoryResponse.parse(json(await run.call('GET', '/api/memory/history')))
    expect(after.commits[0]?.subject).toContain('roll back')
    // things that are not what they should be
    expect((await run.call('GET', '/api/memory/diff?path=world%2Fa.md&from=nothex')).status).toBe(
      400
    )
    expect((await run.call('GET', '/api/memory/diff?path=world%2Fa.md')).status).toBe(400)
    expect(
      (await run.call('POST', '/api/memory/rollback', { body: { path: 'world/a.md', rev: 'zz' } }))
        .status
    ).toBe(400)
    const unknown = await run.call('POST', '/api/memory/rollback', {
      body: { path: 'world/a.md', rev: 'a'.repeat(40) },
    })
    expect(unknown.status).toBe(404)
    expect((await run.call('GET', '/api/memory/history?limit=abc')).status).toBe(400)
  })

  it('forgets a viewer: the file is gone; forgetting someone with no file says so', async () => {
    const { run, store } = await open()
    const v = store!.viewerFile(5, 'cy')
    await store!.append(
      v.path,
      { source: 'viewer', text: 'a fact' },
      { author: 'system', header: v.header }
    )
    const gone = MemoryForgetResponse.parse(
      json(await run.call('POST', '/api/memory/forget', { body: { uid: 5 } }))
    )
    expect(gone.existed).toBe(true)
    expect((await run.call('GET', '/api/memory/file?path=viewers%2F5.md')).status).toBe(404)
    expect(
      MemoryForgetResponse.parse(
        json(await run.call('POST', '/api/memory/forget', { body: { uid: 5 } }))
      ).existed
    ).toBe(false)
    expect((await run.call('POST', '/api/memory/forget', { body: { uid: 0 } })).status).toBe(400)
    expect((await run.call('POST', '/api/memory/forget', { body: { uid: 'five' } })).status).toBe(
      400
    )
  })

  it('proposals: the program asks, the streamer approves or refuses', async () => {
    const { run, store } = await open()
    await put(run, { path: 'persona/rules.md', content: 'Be kind.\n' })
    const p = await store!.propose(
      'persona/rules.md',
      'Be kind.\nNo politics.\n',
      'viewers ask about it'
    )
    if (!p.ok) throw new Error(p.message)
    const list = MemoryProposalsResponse.parse(json(await run.call('GET', '/api/memory/proposals')))
    expect(list.proposals.map((x) => x.target)).toEqual(['persona/rules.md'])
    expect((await run.call('POST', `/api/memory/proposals/${p.id}/approve`)).status).toBe(200)
    const file = MemoryFileView.parse(
      json(await run.call('GET', '/api/memory/file?path=persona%2Frules.md'))
    )
    expect(file.lines.map((l) => l.text)).toEqual(['Be kind.', 'No politics.'])
    expect(
      MemoryProposalsResponse.parse(json(await run.call('GET', '/api/memory/proposals'))).proposals
    ).toEqual([])
    expect((await run.call('POST', `/api/memory/proposals/${p.id}/reject`)).status).toBe(404)
    expect((await run.call('POST', '/api/memory/proposals/not-an-id/approve')).status).toBe(400)
  })

  it('consolidation through the console reports what it did, and a failing model is the report, not a crash', async () => {
    const { r, run, store } = await open()
    r.llm.reply = () => [
      JSON.stringify([{ fact: 'has a cat named Mimi', quote: 'I have a cat named Mimi' }]),
    ]
    await store!.appendInbox({
      kind: 'chat',
      uid: 1003,
      name: 'cy',
      text: 'I have a cat named Mimi',
    })
    await store!.appendInbox({
      kind: 'chat',
      uid: 1003,
      name: 'cy',
      text: 'and she sleeps all day',
    })
    const ok = MemoryConsolidateReport.parse(
      json(await run.call('POST', '/api/memory/consolidate'))
    )
    expect(ok).toMatchObject({ viewersAsked: 1, factsAdded: 1, failures: [] })
    const status = MemoryStatusView.parse(json(await run.call('GET', '/api/memory')))
    expect(status.enabled && status.consolidation?.report.factsAdded).toBe(1)

    await store!.appendInbox({ kind: 'chat', uid: 1004, name: 'dee', text: 'I like tea' })
    await store!.appendInbox({ kind: 'chat', uid: 1004, name: 'dee', text: 'and coffee too' })
    r.llm.reply = () => [new Error('quota exhausted')]
    const bad = MemoryConsolidateReport.parse(
      json(await run.call('POST', '/api/memory/consolidate'))
    )
    expect(bad.failures[0]).toContain('viewer 1004')
  })

  it('needs the token like every other route', async () => {
    const { run } = await open()
    for (const [method, path] of [
      ['GET', '/api/memory'],
      ['GET', '/api/memory/tree'],
      ['PUT', '/api/memory/file'],
      ['POST', '/api/memory/forget'],
    ] as const) {
      const res = await run.call(method, path, { token: null })
      expect(res.status, path).toBe(401)
    }
  })
})
