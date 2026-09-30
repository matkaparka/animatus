import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { VramProbe, pickTarget } from '../src/probe.ts'
import { measureWindow } from '../src/summary.ts'
import type { AdapterInfo, Sample } from '../src/types.ts'

const FAKE = fileURLToPath(new URL('./fake-collector.mjs', import.meta.url))

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const dirs: string[] = []
const probes: VramProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const make = (extra: ConstructorParameters<typeof VramProbe>[0] = {}) => {
  const p = new VramProbe({
    collectorCommand: { command: process.execPath, args: [FAKE] },
    nvidiaSmi: false,
    ...extra,
  })
  probes.push(p)
  return p
}

describe('pickTarget', () => {
  const ad = (luid: string, vendor: string, mb: number, flags = 0): AdapterInfo => ({ luid, name: luid, vendor, dedicated_mb: mb, flags })
  it('prefers NVIDIA, then the largest hardware adapter, never the software one', () => {
    const list = [ad('a', '0x1002', 2019), ad('n', '0x10de', 11944), ad('w', '0x1414', 0, 2)]
    expect(pickTarget(list)?.luid).toBe('n')
    expect(pickTarget([ad('a', '0x1002', 2019), ad('w', '0x1414', 0, 2)])?.luid).toBe('a')
    expect(pickTarget([ad('a', '0x1002', 512), ad('i', '0x8086', 2048)])?.luid).toBe('i')
  })
  it('honours a forced luid, also by prefix', () => {
    const list = [ad('luid_0x0_0x1', '0x1002', 1), ad('luid_0x0_0x2', '0x10de', 2)]
    expect(pickTarget(list, 'luid_0x0_0x1')?.luid).toBe('luid_0x0_0x1')
    expect(pickTarget(list, 'luid_0x0_0x')?.luid).toBe('luid_0x0_0x1')
    expect(pickTarget(list, 'nope')).toBeNull()
  })
})

describe('VramProbe with a scripted collector', () => {
  it('targets the NVIDIA adapter and attributes memory to roles', async () => {
    const p = make()
    await p.start()
    expect(p.target?.name).toMatch(/NVIDIA/)
    await waitFor(() => p.samples.length >= 17)

    const peak = p.samples.reduce((a, b) => (b.target_mb > a.target_mb ? b : a))
    expect(peak.target_mb).toBe(2400 + 10100 + 40)
    expect(peak.roles['gpt-sovits']).toBe(2400)
    expect(peak.roles.forge).toBe(10100)
    expect(peak.roles.other).toBe(40) // pid 999 is never announced -> other
    expect(peak.procs.map((x) => x.pid)).toEqual([200, 100, 999])
  })

  it('reports the stage as off-target when it renders on the integrated GPU', async () => {
    const p = make()
    await p.start()
    await waitFor(() => p.samples.length >= 3)
    const s = p.samples[2] as Sample
    expect(s.roles.stage).toBe(0) // nothing of the stage on the NVIDIA card
    expect(s.roles_off_target['AMD Radeon(TM) 610M']).toEqual({ stage: 70 })
    expect(s.other_gpus_mb['AMD Radeon(TM) 610M']).toBe(850)
  })

  it('records marks, writes jsonl and csv, and a mark window measures the Forge cost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vram-probe-'))
    dirs.push(dir)
    const p = make({ outDir: dir, label: 'unit' })
    await p.start()
    await waitFor(() => p.samples.length >= 3)
    // enter/exit marks land between fake steps; align them with sample times by construction
    p.mark('enter:draw')
    const enterT = p.marks[0]!.t
    await waitFor(() => p.samples.some((s) => (s.roles.forge ?? 0) >= 10000))
    await waitFor(() => p.samples.length >= 17)
    p.mark('exit:draw')
    await waitFor(() => p.samples.filter((s) => s.t > p.marks[1]!.t).length >= 1)
    await p.stop()

    const w = measureWindow(p.samples, p.marks, 'enter:draw', 'exit:draw', { baselineSamples: 1 })!
    expect(w.peak_delta_mb).toBeGreaterThan(9000) // forge went up to 10100
    expect(enterT).toBeGreaterThan(0)

    const jsonl = readFileSync(p.files!.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(jsonl[0].type).toBe('meta')
    expect(jsonl[0].target.name).toMatch(/NVIDIA/)
    expect(jsonl.filter((r) => r.type === 'mark').map((r) => r.label)).toEqual(['enter:draw', 'exit:draw'])
    expect(jsonl.filter((r) => r.type === 'sample').length).toBe(p.samples.length)
    expect(jsonl.some((r) => r.type === 'proc' && r.pid === 100)).toBe(true)

    const csv = readFileSync(p.files!.csv, 'utf8').trim().split('\n')
    expect(csv[0]).toBe('elapsed_s,target_mb,nvsmi_mb,gpt-sovits,forge,stage,motion,llm,other,other_gpus_mb')
    expect(csv.length).toBe(p.samples.length + 1)
  })

  it('stop() ends the collector process', async () => {
    const p = make()
    await p.start()
    await waitFor(() => p.samples.length >= 1)
    const exited = new Promise<number | null>((res) => p.once('exit', res))
    await p.stop()
    await exited
    const n = p.samples.length
    await new Promise((r) => setTimeout(r, 100))
    expect(p.samples.length).toBe(n) // nothing arrives after stop
  })

  it('start() fails when the collector dies before reporting adapters', async () => {
    const p = new VramProbe({ collectorCommand: { command: process.execPath, args: ['-e', 'process.exit(3)'] }, nvidiaSmi: false })
    probes.push(p)
    await expect(p.start()).rejects.toThrow(/exited before reporting adapters/)
  })
})
