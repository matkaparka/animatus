/**
 * The store of probe measurements the admission check reads: `data/vram-measured.json`, an array of
 * `VramMeasurement`. The probe CLI writes it (`--write-measurement`); this module only reads and validates.
 * A missing file is an empty store; a broken entry is skipped and reported, never trusted.
 */
import { readFile } from 'node:fs/promises'
import { VramMeasurement } from '@animatus/protocol'

export async function loadMeasurements(
  file: string
): Promise<{ measurements: VramMeasurement[]; problems: string[] }> {
  let raw: unknown
  try {
    raw = JSON.parse((await readFile(file, 'utf8')).replace(/^\u{FEFF}/u, ''))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { measurements: [], problems: [] }
    return {
      measurements: [],
      problems: [`${file} could not be read: ${(e as Error).message.split(/\r?\n/, 1)[0]}`],
    }
  }
  const list = Array.isArray(raw) ? raw : (raw as { measurements?: unknown })?.measurements
  if (!Array.isArray(list))
    return { measurements: [], problems: [`${file} is not a list of measurements`] }
  const measurements: VramMeasurement[] = []
  const problems: string[] = []
  list.forEach((item, i) => {
    const r = VramMeasurement.safeParse(item)
    if (r.success) measurements.push(r.data)
    else
      problems.push(
        `${file}: entry ${i} is not a valid measurement (${r.error.issues[0]?.path.join('.') ?? '?'})`
      )
  })
  return { measurements, problems }
}
