/**
 * How much dedicated memory the discrete card is using right now, read from `nvidia-smi`.
 *
 * The mode manager asks for it (synchronously) before entering a mode and while it waits for memory to fall
 * back after leaving one, so the meter keeps the last reading and refreshes it in the background. On a machine
 * without an NVIDIA card (or without the tool) every answer is null and the manager simply does not wait.
 */
import { execFile } from 'node:child_process'

export interface GpuReading {
  usedMb: number
  totalMb: number
  at: number
}

export type QueryFn = () => Promise<{ used: number; total: number } | null>

/** One call of nvidia-smi for the first GPU. Never throws. */
export const queryNvidiaSmi: QueryFn = () =>
  new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        const [used, total] =
          stdout
            .split(/\r?\n/, 1)[0]
            ?.split(',')
            .map((s) => Number(s.trim())) ?? []
        resolve(
          Number.isFinite(used) && Number.isFinite(total)
            ? { used: used as number, total: total as number }
            : null
        )
      }
    )
  })

export class GpuMeter {
  private last: GpuReading | null = null
  private timer: NodeJS.Timeout | null = null
  private inflight = false

  constructor(
    private readonly query: QueryFn = queryNvidiaSmi,
    private readonly intervalMs = 1000,
    private readonly now: () => number = Date.now
  ) {}

  /** Take a first reading and keep refreshing. */
  async start(): Promise<void> {
    await this.refresh()
    if (this.timer) return
    this.timer = setInterval(() => void this.refresh(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refresh(): Promise<GpuReading | null> {
    if (this.inflight) return this.last
    this.inflight = true
    try {
      const r = await this.query()
      if (r) this.last = { usedMb: r.used, totalMb: r.total, at: this.now() }
      return this.last
    } finally {
      this.inflight = false
    }
  }

  /** Used memory in MiB, or null when there is no reading (no card, no tool, or the last one is a minute old). */
  usedMb(): number | null {
    const r = this.last
    return r && this.now() - r.at < 60_000 ? r.usedMb : null
  }

  totalMb(): number | null {
    return this.last?.totalMb ?? null
  }
}
