/**
 * Admission check: which modes fit in GPU memory alone, and which pairs fit together.
 *
 * Nothing here is a hard-coded conclusion. Costs come from probe measurements keyed by service and a hash of
 * the settings that affect memory; a service that was never measured for its current settings falls back to
 * the manifest's estimate, then to a conservative default, and every verdict says whether it rests on
 * measurements. Change a setting and the matrix recomputes with the numbers that apply to it.
 */
import { createHash } from 'node:crypto'
import type { ModeManifest, VramMeasurement } from '@animatus/protocol'

export interface ServiceInfo {
  /** Service name as used in `requires.services`. */
  name: string
  gpu: boolean
  /** Manifest estimate in MiB (null = none). */
  estMb: number | null
  /** Hash of this service's current memory-relevant settings (see `hashConfig`). */
  configHash: string
}

export interface AdmissionInput {
  modes: ModeManifest[]
  services: ServiceInfo[]
  measurements: VramMeasurement[]
  /** Dedicated memory of the card, MiB. */
  budgetMb: number
  /** Kept free for the driver, the desktop, spikes. */
  marginMb?: number
  /** Services that are always running (the resident set). */
  resident: string[]
  /** Used for a GPU service with neither a measurement nor an estimate. */
  fallbackServiceMb?: number
}

export interface Cost {
  mb: number
  /** Every part of this number comes from a probe measurement for the current settings. */
  measured: boolean
  /** Human-readable pieces, for the console: "forge 7280 (measured)". */
  parts: string[]
}

export interface Verdict {
  ok: boolean
  /** Estimated total on the card for this combination (resident + mode costs), MiB. */
  totalMb: number
  budgetMb: number
  measured: boolean
  /** Why not (or a note when it fits only on estimates). Empty when ok and measured. */
  reasons: string[]
}

export interface Matrix {
  resident: Cost
  alone: Record<string, Verdict>
  pairs: Record<string, Record<string, Verdict>>
}

/** Stable short hash of the settings that matter for memory. Key order does not matter. */
export function hashConfig(
  config: Record<string, unknown> | undefined,
  keys: readonly string[]
): string {
  const picked: Record<string, unknown> = {}
  for (const k of [...keys].sort()) if (config && k in config) picked[k] = config[k]
  return createHash('sha256').update(JSON.stringify(picked)).digest('hex').slice(0, 12)
}

const DEFAULT_MARGIN = 512
const DEFAULT_FALLBACK = 8000

export function computeMatrix(input: AdmissionInput): Matrix {
  const margin = input.marginMb ?? DEFAULT_MARGIN
  const usable = Math.max(0, input.budgetMb - margin)
  const fallback = input.fallbackServiceMb ?? DEFAULT_FALLBACK
  const byName = new Map(input.services.map((s) => [s.name, s]))
  const residentSet = new Set(input.resident)

  const cost = (name: string): Cost => {
    const s = byName.get(name)
    if (!s || !s.gpu) return { mb: 0, measured: true, parts: [] }
    const m = input.measurements.find((x) => x.key === name && x.config_hash === s.configHash)
    if (m)
      return {
        mb: m.peak_mb,
        measured: true,
        parts: [`${name} ${Math.round(m.peak_mb)} (measured)`],
      }
    if (s.estMb !== null)
      return { mb: s.estMb, measured: false, parts: [`${name} ${Math.round(s.estMb)} (estimate)`] }
    return { mb: fallback, measured: false, parts: [`${name} ${fallback} (assumed, not measured)`] }
  }

  const sum = (names: Iterable<string>): Cost => {
    let mb = 0
    let measured = true
    const parts: string[] = []
    for (const n of names) {
      const c = cost(n)
      mb += c.mb
      measured &&= c.measured
      parts.push(...c.parts)
    }
    return { mb, measured, parts }
  }

  const resident = sum(residentSet)

  /** Services of a mode beyond the resident set, and the mode-level extra when its services are unmeasured. */
  const modeCost = (m: ModeManifest, taken: Set<string>): Cost => {
    const own = m.requires.services.filter((s) => !residentSet.has(s) && !taken.has(s))
    const c = sum(own)
    const declared = m.requires.vram_mb_est
    if (!c.measured && declared !== null && declared > c.mb) {
      return {
        mb: declared,
        measured: false,
        parts: [`${m.id} declares ${Math.round(declared)} (estimate)`],
      }
    }
    return c
  }

  const verdict = (mb: number, measured: boolean, parts: string[], label: string): Verdict => {
    const total = resident.mb + mb
    const ok = total <= usable
    const reasons: string[] = []
    const detail = [...resident.parts.map((p) => `resident: ${p}`), ...parts].join(', ')
    if (!ok) {
      reasons.push(
        `${label}: about ${Math.round(total)} MiB needed, ${Math.round(usable)} MiB usable of ${Math.round(input.budgetMb)}` +
          `${measured ? '' : ' (not measured)'} [${detail}]`
      )
    } else if (!measured) {
      reasons.push(
        `${label}: fits on estimates only (about ${Math.round(total)} of ${Math.round(usable)} MiB); not measured [${detail}]`
      )
    }
    return {
      ok,
      totalMb: Math.round(total),
      budgetMb: input.budgetMb,
      measured: measured && resident.measured,
      reasons,
    }
  }

  const alone: Record<string, Verdict> = {}
  const pairs: Record<string, Record<string, Verdict>> = {}
  for (const m of input.modes) {
    const c = modeCost(m, new Set())
    alone[m.id] = verdict(c.mb, c.measured, c.parts, m.id)
    pairs[m.id] = {}
  }

  for (const a of input.modes) {
    for (const b of input.modes) {
      if (a.id === b.id) continue
      if (a.exclusive_with.includes(b.id) || b.exclusive_with.includes(a.id)) {
        pairs[a.id]![b.id] = {
          ok: false,
          totalMb: 0,
          budgetMb: input.budgetMb,
          measured: true,
          reasons: [`${a.id} and ${b.id} exclude each other (declared in the mode manifests)`],
        }
        continue
      }
      // Services both modes need are loaded once.
      const first = modeCost(a, new Set())
      const second = modeCost(b, new Set(a.requires.services))
      const measured = first.measured && second.measured
      pairs[a.id]![b.id] = verdict(
        first.mb + second.mb,
        measured,
        [...first.parts, ...second.parts],
        `${a.id} + ${b.id}`
      )
    }
  }
  return { resident, alone, pairs }
}
