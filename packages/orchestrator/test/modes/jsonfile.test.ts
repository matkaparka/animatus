import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { flushJson, readJson, writeJson } from '../../src/modes/jsonfile.ts'

const dirs: string[] = []
afterEach(async () => {
  await flushJson()
  for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
async function tmp() {
  const d = await mkdtemp(path.join(tmpdir(), 'animatus-json-'))
  dirs.push(d)
  return d
}

describe('readJson', () => {
  it('returns the fallback for a missing or torn file, and strips a byte-order mark', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'a.json')
    expect(await readJson(file, { x: 1 })).toEqual({ x: 1 })
    await writeFile(file, '{oops')
    expect(await readJson(file, { x: 1 })).toEqual({ x: 1 })
    await writeFile(file, '﻿{"y":2}')
    expect(await readJson(file, {})).toEqual({ y: 2 })
  })
})

describe('writeJson', () => {
  it('creates the folder and leaves no temporary file behind', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'deep', 'er', 'a.json')
    await writeJson(file, { ok: true })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ok: true })
    expect(await readdir(path.dirname(file))).toEqual(['a.json'])
  })

  it('many writes at once to one file end with the last one, and the file is never torn', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'a.json')
    const writes: Promise<void>[] = []
    for (let i = 0; i < 40; i++)
      writes.push(writeJson(file, { n: i, pad: 'x'.repeat(i % 2 ? 5000 : 10) }))
    await Promise.all(writes)
    expect((await readJson<{ n: number }>(file, { n: -1 })).n).toBe(39)
    expect(await readdir(dir)).toEqual(['a.json'])
  })

  it('takes the value as it is at the call, not when the write gets its turn', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'a.json')
    const state = { n: 1 }
    const first = writeJson(file, state)
    state.n = 2
    const second = writeJson(file, { n: 3 })
    await Promise.all([first, second])
    expect(await readJson(file, {})).toEqual({ n: 3 })
    const other = writeJson(file, state)
    state.n = 99
    await other
    expect(await readJson(file, {})).toEqual({ n: 2 })
  })

  it('reports a value that cannot be written and a folder that cannot be made, and does not throw', async () => {
    const dir = await tmp()
    const messages: string[] = []
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await writeJson(path.join(dir, 'c.json'), circular, (m) => messages.push(m))
    // a file where the folder should be
    await writeFile(path.join(dir, 'blocker'), 'x')
    await writeJson(path.join(dir, 'blocker', 'a.json'), {}, (m) => messages.push(m))
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('c.json could not be written')
    expect(messages[1]).toContain('a.json could not be written')
  })

  it('a failed write does not stop the next one', async () => {
    const dir = await tmp()
    await writeFile(path.join(dir, 'blocker'), 'x')
    const bad = writeJson(path.join(dir, 'blocker', 'a.json'), {})
    const good = writeJson(path.join(dir, 'b.json'), { fine: true })
    await Promise.all([bad, good])
    expect(await readJson(path.join(dir, 'b.json'), {})).toEqual({ fine: true })
  })
})
