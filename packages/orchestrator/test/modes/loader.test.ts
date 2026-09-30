import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadModePacks } from '../../src/modes/loader.ts'
import { loadMeasurements } from '../../src/modes/measurements.ts'
import { GpuMeter } from '../../src/modes/gpu.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'animatus-modes-'))
  dirs.push(d)
  return d
}
async function pack(
  root: string,
  id: string,
  yaml: string | null,
  prompts: Record<string, string> = {}
) {
  const dir = path.join(root, id)
  await mkdir(path.join(dir, 'prompts'), { recursive: true })
  if (yaml !== null) await writeFile(path.join(dir, 'mode.yaml'), yaml)
  for (const [name, text] of Object.entries(prompts))
    await writeFile(path.join(dir, 'prompts', `${name}.md`), text)
}
const manifest = (id: string, extra = '') => `id: ${id}\ntitle: Mode ${id}\n${extra}`

describe('loadModePacks', () => {
  it('reads the manifest and every prompt, and finds the active prompt the manifest names', async () => {
    const root = await tmp()
    await pack(root, 'dance', manifest('dance', 'prompt: prompts/active.md\n'), {
      active: 'Dancing now.\n',
      available: '﻿You may dance.  ',
    })
    const { modes, errors } = await loadModePacks([root])
    expect(errors).toEqual([])
    expect(modes).toHaveLength(1)
    const m = modes[0]!
    expect(m.manifest).toMatchObject({ id: 'dance', priority: 50, preempts: false })
    expect(m.prompts.get('available')).toBe('You may dance.') // byte-order mark and trailing space gone
    expect(m.activePrompt).toBe('Dancing now.')
  })

  it('a later folder overrides file by file, and can add a mode of its own', async () => {
    const shipped = await tmp()
    const mine = await tmp()
    await pack(shipped, 'dance', manifest('dance', 'prompt: prompts/active.md\n'), {
      active: 'shipped active',
      available: 'shipped available',
    })
    await pack(mine, 'dance', null, { available: 'my own words' }) // prompts only
    await pack(mine, 'karaoke', manifest('karaoke'))
    const { modes, errors } = await loadModePacks([shipped, mine])
    expect(errors).toEqual([])
    const dance = modes.find((m) => m.manifest.id === 'dance')!
    expect(dance.prompts.get('available')).toBe('my own words')
    expect(dance.prompts.get('active')).toBe('shipped active')
    expect(dance.activePrompt).toBe('shipped active')
    expect(modes.map((m) => m.manifest.id)).toEqual(['dance', 'karaoke'])
  })

  it('a folder with a broken manifest is reported and does not stop the others', async () => {
    const root = await tmp()
    await pack(root, 'good', manifest('good'))
    await pack(root, 'bad', 'id: bad\ntitle: ""\npriority: 900\n')
    await pack(root, 'torn', 'id: [unclosed\n')
    await pack(root, 'named-wrong', manifest('something-else'))
    await pack(root, 'empty', null)
    const { modes, errors } = await loadModePacks([root])
    expect(modes.map((m) => m.manifest.id)).toEqual(['good'])
    const byDir = Object.fromEntries(errors.map((e) => [path.basename(e.dir), e.error]))
    expect(byDir.bad).toMatch(/invalid mode\.yaml/)
    expect(byDir.torn).toBeTypeOf('string')
    expect(byDir['named-wrong']).toMatch(/folder is called "named-wrong"/)
    expect(byDir.empty).toBe('missing mode.yaml')
  })

  it('ignores folders that start with a dot or underscore, and a folder that does not exist', async () => {
    const root = await tmp()
    await pack(root, '_template', manifest('template'))
    await pack(root, '.hidden', manifest('hidden'))
    const { modes, errors } = await loadModePacks([root, path.join(root, 'nope')])
    expect(modes).toEqual([])
    expect(errors).toEqual([])
  })

  it('the shipped dance pack loads with every prompt the controller asks for', async () => {
    const { modes, errors } = await loadModePacks([path.resolve(__dirname, '../../../../modes')])
    expect(errors).toEqual([])
    const dance = modes.find((m) => m.manifest.id === 'dance')!
    for (const name of [
      'available',
      'cooldown',
      'active',
      'gift_ok',
      'gift_cooldown',
      'gift_busy',
      'gift_none',
      'outro',
    ]) {
      expect(dance.prompts.get(name), name).toBeTruthy()
    }
    expect(dance.manifest.exclusive_with).toContain('sing')
  })
})

describe('loadMeasurements', () => {
  it('reads valid entries, skips broken ones and says so, and treats a missing file as empty', async () => {
    const root = await tmp()
    const file = path.join(root, 'vram-measured.json')
    expect(await loadMeasurements(file)).toEqual({ measurements: [], problems: [] })
    await writeFile(
      file,
      JSON.stringify([
        {
          key: 'tts',
          config_hash: 'abc',
          peak_mb: 3054,
          steady_mb: 2760,
          measured_at: '2026-09-30',
        },
        { key: 'forge', config_hash: 'x', peak_mb: 'lots', steady_mb: 1, measured_at: 'now' },
      ])
    )
    const r = await loadMeasurements(file)
    expect(r.measurements.map((m) => m.key)).toEqual(['tts'])
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('entry 1')
  })

  it('accepts an object with a measurements list, and reports what is not JSON or not a list', async () => {
    const root = await tmp()
    const file = path.join(root, 'm.json')
    await writeFile(
      file,
      JSON.stringify({
        measurements: [
          { key: 'tts', config_hash: 'a', peak_mb: 1, steady_mb: 1, measured_at: 'x' },
        ],
      })
    )
    expect((await loadMeasurements(file)).measurements).toHaveLength(1)
    await writeFile(file, '{oops')
    expect((await loadMeasurements(file)).problems[0]).toMatch(/could not be read/)
    await writeFile(file, '"a string"')
    expect((await loadMeasurements(file)).problems[0]).toMatch(/not a list/)
  })
})

describe('GpuMeter', () => {
  it('keeps the last reading, and forgets it when it is a minute old or the tool is gone', async () => {
    let now = 1_000_000
    let answer: { used: number; total: number } | null = { used: 2764, total: 11944 }
    const meter = new GpuMeter(
      async () => answer,
      10_000,
      () => now
    )
    expect(meter.usedMb()).toBeNull() // nothing read yet
    await meter.refresh()
    expect(meter.usedMb()).toBe(2764)
    expect(meter.totalMb()).toBe(11944)
    now += 30_000
    expect(meter.usedMb()).toBe(2764)
    now += 40_000
    expect(meter.usedMb()).toBeNull() // stale
    answer = null
    await meter.refresh()
    expect(meter.usedMb()).toBeNull() // no card, no tool: never a made-up number
  })

  it('does not start a second query while one is running', async () => {
    let calls = 0
    let release!: () => void
    const meter = new GpuMeter(
      () =>
        new Promise((res) => {
          calls++
          release = () => res({ used: 1, total: 2 })
        })
    )
    const a = meter.refresh()
    const b = meter.refresh()
    expect(calls).toBe(1)
    release()
    await Promise.all([a, b])
    expect(meter.usedMb()).toBe(1)
  })
})
