import { describe, expect, it } from 'vitest'
import {
  measureAllWindows,
  measureWindow,
  median,
  summarizeRecording,
  toMeasurement,
} from '../src/summary.ts'
import type { Mark, Sample } from '../src/types.ts'

/** One sample per second starting at t=0; `forge` and `gsv` are the role columns. */
const mk = (rows: { total: number; gsv: number; forge: number; nv?: number | null }[]): Sample[] =>
  rows.map((r, i) => ({
    t: i * 1000,
    elapsed_s: i,
    target_mb: r.total,
    nvsmi_mb: r.nv === undefined ? r.total + 10 : r.nv,
    other_gpus_mb: {},
    roles: { gsv: r.gsv, forge: r.forge, other: r.total - r.gsv - r.forge },
    procs: [],
    roles_off_target: {},
  }))

const mark = (label: string, s: number): Mark => ({ t: s * 1000, elapsed_s: s, label })

describe('median', () => {
  it('handles odd, even and empty input', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('summarizeRecording', () => {
  it('reports baseline, peak and steady for the adapter and each role', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => ({ total: 100, gsv: 0, forge: 0 })),
      ...Array.from({ length: 5 }, () => ({ total: 2600, gsv: 2500, forge: 0 })),
      ...Array.from({ length: 5 }, () => ({ total: 10200, gsv: 2500, forge: 7600 })),
      ...Array.from({ length: 5 }, () => ({ total: 2600, gsv: 2500, forge: 0 })),
    ]
    const s = summarizeRecording(mk(rows))
    expect(s.samples).toBe(20)
    expect(s.target.baseline_mb).toBe(100)
    expect(s.target.peak_mb).toBe(10200)
    expect(s.roles.forge!.peak_mb).toBe(7600)
    expect(s.roles.gsv!.steady_mb).toBe(2500)
    expect(s.max_nvsmi_gap_mb).toBe(10)
  })

  it('has no nvidia-smi gap when it was not available', () => {
    const s = summarizeRecording(mk([{ total: 5, gsv: 0, forge: 0, nv: null }]))
    expect(s.max_nvsmi_gap_mb).toBeNull()
  })
})

describe('measureWindow', () => {
  // 0-9: idle at 3000 (gsv resident); 10-29: draw mode; 30-39: back to idle
  const rows = [
    ...Array.from({ length: 10 }, () => ({ total: 3000, gsv: 2900, forge: 0 })),
    ...Array.from({ length: 4 }, () => ({ total: 6000, gsv: 2900, forge: 3000 })), // loading
    ...Array.from({ length: 4 }, () => ({ total: 10200, gsv: 2900, forge: 7200 })), // generating
    ...Array.from({ length: 12 }, () => ({ total: 6100, gsv: 2900, forge: 3100 })), // settled
    ...Array.from({ length: 10 }, () => ({ total: 3050, gsv: 2900, forge: 0 })), // unloaded
  ]
  const samples = mk(rows)
  const marks = [mark('enter:draw', 10), mark('exit:draw', 29)]

  it('measures what the mode costs above the level just before it', () => {
    const w = measureWindow(samples, marks, 'enter:draw', 'exit:draw')!
    expect(w.baseline_mb).toBe(3000)
    expect(w.peak_mb).toBe(10200)
    expect(w.peak_delta_mb).toBe(7200)
    expect(w.steady_delta_mb).toBe(3100)
    expect(w.roles.forge!.peak_delta_mb).toBe(7200)
    expect(w.roles.gsv!.peak_delta_mb).toBe(0)
  })

  it('checks that memory falls back after the mode exits', () => {
    const w = measureWindow(samples, marks, 'enter:draw', 'exit:draw')!
    expect(w.residual_delta_mb).toBe(50)
  })

  it('flags a leak: residual stays high after exit', () => {
    const leaky = mk([
      ...Array.from({ length: 5 }, () => ({ total: 3000, gsv: 2900, forge: 0 })),
      ...Array.from({ length: 5 }, () => ({ total: 9000, gsv: 2900, forge: 6000 })),
      ...Array.from({ length: 6 }, () => ({ total: 8800, gsv: 2900, forge: 5800 })),
    ])
    const w = measureWindow(leaky, [mark('enter:x', 5), mark('exit:x', 9)], 'enter:x', 'exit:x')!
    expect(w.residual_delta_mb).toBe(5800)
  })

  it('returns null for missing marks or an empty window', () => {
    expect(measureWindow(samples, marks, 'enter:nope', 'exit:draw')).toBeNull()
    expect(
      measureWindow(samples, [mark('enter:a', 100), mark('exit:a', 101)], 'enter:a', 'exit:a')
    ).toBeNull()
  })

  it('uses the latest enter mark and an exit that comes after it', () => {
    const m = [
      mark('enter:draw', 2),
      mark('exit:draw', 3),
      mark('enter:draw', 10),
      mark('exit:draw', 29),
    ]
    const w = measureWindow(samples, m, 'enter:draw', 'exit:draw')!
    expect(w.duration_s).toBe(19)
  })

  it('measureAllWindows finds every enter/exit pair', () => {
    const m = [...marks, mark('enter:sing', 30), mark('exit:sing', 39)]
    const all = measureAllWindows(samples, m)
    expect(all.map((w) => w.from)).toEqual(['enter:draw', 'enter:sing'])
  })

  it('toMeasurement produces the admission record shape', () => {
    const w = measureWindow(samples, marks, 'enter:draw', 'exit:draw')!
    const rec = toMeasurement('forge', 'abc123', w, 'note')
    expect(rec).toMatchObject({
      key: 'forge',
      config_hash: 'abc123',
      peak_mb: 7200,
      steady_mb: 3100,
      note: 'note',
    })
    expect(new Date(rec.measured_at).getTime()).toBeGreaterThan(0)
  })
})
