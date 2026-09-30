/**
 * Shared by the procedural layer (`LIVE`) and the motion director (`MOTION`): apply a
 * `{ name: number }` snapshot (the `tuning.set` message) to a plain constants object.
 *
 * Only names that already exist as numbers are touched. A `name.N` key addresses element N of a
 * numeric tuple (for example `glanceYaw.0`). Anything else is ignored: unknown names, values that are
 * not finite numbers, tuple indices out of range, and constants that are not numbers.
 *
 * Returns the keys that were applied, in input order.
 */
export function applyNumericTuning(target: object, partial: Record<string, number>): string[] {
  const applied: string[] = []
  const obj = target as Record<string, unknown>
  for (const [key, value] of Object.entries(partial)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const dot = key.indexOf('.')
    if (dot < 0) {
      if (Object.hasOwn(obj, key) && typeof obj[key] === 'number') {
        obj[key] = value
        applied.push(key)
      }
      continue
    }
    const name = key.slice(0, dot)
    const index = key.slice(dot + 1)
    if (!/^\d+$/.test(index) || !Object.hasOwn(obj, name)) continue
    const tuple = obj[name]
    const i = Number(index)
    if (Array.isArray(tuple) && i < tuple.length && typeof tuple[i] === 'number') {
      tuple[i] = value
      applied.push(key)
    }
  }
  return applied
}
