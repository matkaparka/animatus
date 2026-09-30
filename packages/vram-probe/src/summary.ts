import type { Mark, Measurement, Sample } from './types.ts'

export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const round1 = (n: number) => Math.round(n * 10) / 10

export interface RoleStats {
  baseline_mb: number
  peak_mb: number
  steady_mb: number
}

export interface RecordingSummary {
  duration_s: number
  samples: number
  target: RoleStats
  /** Cross-check: largest gap between the adapter counter and nvidia-smi, MiB (null without nvidia-smi). */
  max_nvsmi_gap_mb: number | null
  roles: Record<string, RoleStats>
}

const statsOf = (values: number[], baselineN: number): RoleStats => ({
  baseline_mb: round1(median(values.slice(0, Math.max(1, baselineN)))),
  peak_mb: round1(values.length ? Math.max(...values) : 0),
  steady_mb: round1(median(values.slice(Math.floor((values.length * 2) / 3)))),
})

/** Whole-recording view: baseline = first samples, peak = maximum, steady = the last third's median. */
export function summarizeRecording(samples: Sample[], baselineN = 5): RecordingSummary {
  const roleNames = new Set<string>()
  for (const s of samples) for (const r of Object.keys(s.roles)) roleNames.add(r)
  const roles: Record<string, RoleStats> = {}
  for (const r of roleNames)
    roles[r] = statsOf(
      samples.map((s) => s.roles[r] ?? 0),
      baselineN
    )
  const gaps = samples
    .filter((s) => s.nvsmi_mb !== null)
    .map((s) => Math.abs(s.target_mb - (s.nvsmi_mb as number)))
  return {
    duration_s: samples.length
      ? round1(samples[samples.length - 1]!.elapsed_s - samples[0]!.elapsed_s)
      : 0,
    samples: samples.length,
    target: statsOf(
      samples.map((s) => s.target_mb),
      baselineN
    ),
    max_nvsmi_gap_mb: gaps.length ? round1(Math.max(...gaps)) : null,
    roles,
  }
}

export interface WindowMeasurement {
  from: string
  to: string
  duration_s: number
  samples: number
  /** Median of the samples just before the window opened. */
  baseline_mb: number
  peak_mb: number
  steady_mb: number
  /** Growth above the baseline: what the mode itself costs. */
  peak_delta_mb: number
  steady_delta_mb: number
  /** After the window closes: median of the samples that follow, relative to the baseline. Should be ~0. */
  residual_delta_mb: number | null
  roles: Record<string, { peak_delta_mb: number; steady_delta_mb: number }>
}

export interface WindowOptions {
  /** How many samples before the `from` mark form the baseline. */
  baselineSamples?: number
  /** How many samples after the `to` mark are used for the residual check. */
  afterSamples?: number
}

/**
 * Measure what happens between two marks (enter:draw .. exit:draw). Returns null when a mark is
 * missing or the window holds no samples.
 */
export function measureWindow(
  samples: Sample[],
  marks: Mark[],
  from: string,
  to: string,
  opts: WindowOptions = {}
): WindowMeasurement | null {
  const a = [...marks].reverse().find((m) => m.label === from)
  const b = [...marks].reverse().find((m) => m.label === to && (!a || m.t >= a.t))
  if (!a || !b) return null
  const inside = samples.filter((s) => s.t >= a.t && s.t <= b.t)
  if (inside.length === 0) return null
  const baseN = opts.baselineSamples ?? 5
  const afterN = opts.afterSamples ?? 5
  const before = samples.filter((s) => s.t < a.t).slice(-baseN)
  const after = samples.filter((s) => s.t > b.t).slice(0, afterN)
  const baselineOf = (pick: (s: Sample) => number) => median(before.map(pick))
  const base = baselineOf((s) => s.target_mb)
  const peak = Math.max(...inside.map((s) => s.target_mb))
  const steady = median(inside.slice(Math.floor((inside.length * 2) / 3)).map((s) => s.target_mb))

  const roleNames = new Set<string>()
  for (const s of [...before, ...inside]) for (const r of Object.keys(s.roles)) roleNames.add(r)
  const roles: WindowMeasurement['roles'] = {}
  for (const r of roleNames) {
    const rb = baselineOf((s) => s.roles[r] ?? 0)
    const rp = Math.max(...inside.map((s) => s.roles[r] ?? 0))
    const rs = median(inside.slice(Math.floor((inside.length * 2) / 3)).map((s) => s.roles[r] ?? 0))
    roles[r] = { peak_delta_mb: round1(rp - rb), steady_delta_mb: round1(rs - rb) }
  }
  return {
    from,
    to,
    duration_s: round1((b.t - a.t) / 1000),
    samples: inside.length,
    baseline_mb: round1(base),
    peak_mb: round1(peak),
    steady_mb: round1(steady),
    peak_delta_mb: round1(peak - base),
    steady_delta_mb: round1(steady - base),
    residual_delta_mb: after.length ? round1(median(after.map((s) => s.target_mb)) - base) : null,
    roles,
  }
}

/** Every enter:X .. exit:X pair found in the marks. */
export function measureAllWindows(
  samples: Sample[],
  marks: Mark[],
  opts: WindowOptions = {}
): WindowMeasurement[] {
  const out: WindowMeasurement[] = []
  const seen = new Set<string>()
  for (const m of marks) {
    const mm = /^enter:(.+)$/.exec(m.label)
    if (!mm || seen.has(m.label)) continue
    seen.add(m.label)
    const w = measureWindow(samples, marks, m.label, `exit:${mm[1]}`, opts)
    if (w) out.push(w)
  }
  return out
}

/** Turn a window into the record the admission check stores (shape of protocol VramMeasurement). */
export function toMeasurement(
  key: string,
  configHash: string,
  w: WindowMeasurement,
  note?: string
): Measurement {
  return {
    key,
    config_hash: configHash,
    peak_mb: Math.max(0, w.peak_delta_mb),
    steady_mb: Math.max(0, w.steady_delta_mb),
    measured_at: new Date().toISOString(),
    ...(note ? { note } : {}),
  }
}
