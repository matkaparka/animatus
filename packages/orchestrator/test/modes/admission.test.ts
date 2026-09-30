import { ModeManifest, type VramMeasurement } from '@animatus/protocol'
import { describe, expect, it } from 'vitest'
import { computeMatrix, hashConfig, type ServiceInfo } from '../../src/modes/admission.ts'

const mode = (
  id: string,
  services: string[],
  extra: Partial<ModeManifest> = {},
  vram: number | null = null
): ModeManifest =>
  ModeManifest.parse({ id, title: id, requires: { services, vram_mb_est: vram }, ...extra })

const svc = (name: string, over: Partial<ServiceInfo> = {}): ServiceInfo => ({
  name,
  gpu: true,
  estMb: null,
  configHash: 'h1',
  ...over,
})

const meas = (key: string, peak: number, hash = 'h1', steady = peak): VramMeasurement => ({
  key,
  config_hash: hash,
  peak_mb: peak,
  steady_mb: steady,
  measured_at: '2026-09-30T00:00:00Z',
})

const BUDGET = 11944

describe('hashConfig', () => {
  it('depends only on the listed keys and ignores order', () => {
    const a = hashConfig({ max_long_side: 1024, url: 'x', other: 1 }, ['max_long_side'])
    expect(hashConfig({ url: 'y', max_long_side: 1024 }, ['max_long_side'])).toBe(a)
    expect(hashConfig({ max_long_side: 896 }, ['max_long_side'])).not.toBe(a)
    expect(hashConfig({ a: 1, b: 2 }, ['b', 'a'])).toBe(hashConfig({ b: 2, a: 1 }, ['a', 'b']))
    expect(hashConfig(undefined, [])).toBe(hashConfig({}, []))
  })
})

describe('computeMatrix with the measured figures of this project', () => {
  // resident: speech synthesis (measured 3054 peak with a synthesis running); draw needs forge (7280 alone on top of it)
  const services = [svc('tts'), svc('motion', { gpu: false }), svc('forge'), svc('llm')]
  const measurements = [meas('tts', 3054), meas('forge', 7280)]
  const modes = [
    mode('draw', ['tts', 'motion', 'forge']),
    mode('sing', ['tts'], { exclusive_with: ['draw'] }),
    mode('game', ['tts', 'llm'], {}, 4000),
    mode('dance', ['tts']),
  ]

  it('reproduces the measured co-existence result: draw fits next to the resident speech server', () => {
    const m = computeMatrix({
      modes,
      services,
      measurements,
      budgetMb: BUDGET,
      resident: ['tts', 'motion'],
    })
    expect(m.resident.mb).toBe(3054)
    const draw = m.alone.draw!
    expect(draw.ok).toBe(true)
    expect(draw.totalMb).toBe(3054 + 7280)
    expect(draw.measured).toBe(true)
    expect(draw.reasons).toEqual([])
  })

  it('modes with only resident services cost nothing extra', () => {
    const m = computeMatrix({
      modes,
      services,
      measurements,
      budgetMb: BUDGET,
      resident: ['tts', 'motion'],
    })
    expect(m.alone.dance!.totalMb).toBe(3054)
    expect(m.alone.dance!.ok).toBe(true)
  })

  it('declared exclusions win over memory', () => {
    const m = computeMatrix({
      modes,
      services,
      measurements,
      budgetMb: BUDGET,
      resident: ['tts', 'motion'],
    })
    expect(m.pairs.draw!.sing!.ok).toBe(false)
    expect(m.pairs.draw!.sing!.reasons[0]).toContain('exclude each other')
    expect(m.pairs.sing!.draw!.ok).toBe(false) // symmetric, even though only sing declared it
  })

  it('a pair that does not fit says why, with the numbers', () => {
    // game (llm, not measured, declares 4000) + draw: 3054 + 7280 + 4000 = 14334 > usable
    const m = computeMatrix({
      modes,
      services,
      measurements,
      budgetMb: BUDGET,
      resident: ['tts', 'motion'],
    })
    const v = m.pairs.draw!.game!
    expect(v.ok).toBe(false)
    expect(v.measured).toBe(false)
    expect(v.totalMb).toBeGreaterThan(BUDGET)
    expect(v.reasons[0]).toContain('draw + game')
    expect(v.reasons[0]).toContain('(not measured)')
  })

  it('a shared service is counted once', () => {
    const svcs = [svc('tts'), svc('forge'), svc('vision')]
    const ms = [meas('tts', 3000), meas('forge', 5000), meas('vision', 1000)]
    const modes2 = [mode('a', ['forge', 'vision']), mode('b', ['forge'])]
    const m = computeMatrix({
      modes: modes2,
      services: svcs,
      measurements: ms,
      budgetMb: BUDGET,
      resident: ['tts'],
    })
    expect(m.pairs.a!.b!.totalMb).toBe(3000 + 5000 + 1000) // forge once
  })
})

describe('computeMatrix: settings drive the answer', () => {
  it('a measurement for other settings is ignored, so a new setting shows as not measured', () => {
    const modes = [mode('draw', ['forge'])]
    const at1024 = [svc('forge', { configHash: 'size-1024', estMb: 9000 }), svc('tts')]
    const ms = [meas('forge', 7280, 'size-1024'), meas('tts', 3054)]
    const a = computeMatrix({
      modes,
      services: at1024,
      measurements: ms,
      budgetMb: BUDGET,
      resident: ['tts'],
    })
    expect(a.alone.draw!.measured).toBe(true)
    expect(a.alone.draw!.totalMb).toBe(3054 + 7280)

    const at896 = [svc('forge', { configHash: 'size-896', estMb: 9000 }), svc('tts')]
    const b = computeMatrix({
      modes,
      services: at896,
      measurements: ms,
      budgetMb: BUDGET,
      resident: ['tts'],
    })
    expect(b.alone.draw!.measured).toBe(false)
    expect(b.alone.draw!.totalMb).toBe(3054 + 9000) // the estimate, not the stale measurement
    expect(b.alone.draw!.reasons.join(' ')).toContain('not measured')
  })

  it('an unmeasured GPU service with no estimate is assumed large, and the verdict says so', () => {
    const m = computeMatrix({
      modes: [mode('draw', ['forge'])],
      services: [svc('forge'), svc('tts')],
      measurements: [meas('tts', 3054)],
      budgetMb: BUDGET,
      resident: ['tts'],
      fallbackServiceMb: 9000,
    })
    expect(m.alone.draw!.ok).toBe(false)
    expect(m.alone.draw!.reasons[0]).toContain('assumed')
  })

  it('a smaller budget flips a verdict; the margin is respected', () => {
    const args = {
      modes: [mode('draw', ['forge'])],
      services: [svc('forge'), svc('tts')],
      measurements: [meas('forge', 7280), meas('tts', 3054)],
      resident: ['tts'],
    }
    expect(computeMatrix({ ...args, budgetMb: 11000 }).alone.draw!.ok).toBe(true) // 10334 <= 11000-512
    expect(computeMatrix({ ...args, budgetMb: 10800 }).alone.draw!.ok).toBe(false)
    expect(computeMatrix({ ...args, budgetMb: 10800, marginMb: 0 }).alone.draw!.ok).toBe(true)
  })

  it('CPU-only and unknown services contribute nothing', () => {
    const m = computeMatrix({
      modes: [mode('x', ['motion', 'not-declared'])],
      services: [svc('motion', { gpu: false })],
      measurements: [],
      budgetMb: BUDGET,
      resident: [],
    })
    expect(m.alone.x!.totalMb).toBe(0)
    expect(m.alone.x!.ok).toBe(true)
    expect(m.alone.x!.measured).toBe(true)
  })

  it('a fit that rests on estimates is flagged', () => {
    const m = computeMatrix({
      modes: [mode('draw', ['forge'])],
      services: [svc('forge', { estMb: 6000 })],
      measurements: [],
      budgetMb: BUDGET,
      resident: [],
    })
    expect(m.alone.draw!.ok).toBe(true)
    expect(m.alone.draw!.measured).toBe(false)
    expect(m.alone.draw!.reasons[0]).toContain('estimates only')
  })
})
