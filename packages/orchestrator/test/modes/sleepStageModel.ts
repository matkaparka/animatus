/**
 * The stage's half of sleep mode as the real one does it (packages/stage/src/activities/sleep.ts), for tests:
 * `pause` only acts on a playing track, `resume` only on a paused one, a new `play` replaces the old, `stop` reports
 * `off`, and every report is made a moment after the change (never inside the call that caused it, as with a socket).
 * The position of a paused track is not modelled: a resumed track lasts `trackMs` again.
 */
export type SleepPhase = 'off' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export interface SleepStageOpts {
  /** How it answers `sleep.play`: loads then plays; never says a word; fails to load; says loading and never plays. */
  mode: 'auto' | 'silent' | 'error' | 'stuck'
  loadMs: number
  trackMs: number
  /** Tracks (by the end of their URL) the stage cannot play. */
  broken: Set<string>
}

export const DEFAULT_SLEEP_STAGE: SleepStageOpts = {
  mode: 'auto',
  loadMs: 20,
  trackMs: 60_000,
  broken: new Set(),
}

export type SleepMessage = Record<string, unknown> & { type: string }

export class SleepStageModel {
  phase: SleepPhase = 'off'
  trackId: string | undefined
  private end: NodeJS.Timeout | null = null
  private readonly timers = new Set<NodeJS.Timeout>()

  constructor(
    readonly opts: SleepStageOpts,
    private readonly report: (m: SleepMessage) => void
  ) {}

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }

  private state(phase: SleepPhase, error?: string): void {
    this.phase = phase
    const id = this.trackId
    this.later(1, () =>
      this.report({
        type: 'sleep.state',
        ...(id ? { track_id: id } : {}),
        phase,
        ...(error ? { error } : {}),
      })
    )
  }

  private clearEnd(): void {
    if (this.end) clearTimeout(this.end)
    this.end = null
  }

  private startEnd(id: string): void {
    this.clearEnd()
    this.end = setTimeout(() => {
      if (this.trackId === id && this.phase === 'playing') this.state('ended')
    }, this.opts.trackMs)
  }

  handle(m: SleepMessage): void {
    const id = this.trackId
    switch (m.type) {
      case 'sleep.play': {
        this.clearEnd()
        const mine = m.track_id as string
        this.trackId = mine
        if (this.opts.mode === 'silent') return
        this.state('loading')
        if (this.opts.mode === 'stuck') return
        this.later(this.opts.loadMs, () => {
          if (this.trackId !== mine) return
          if (
            this.opts.mode === 'error' ||
            [...this.opts.broken].some((b) => String(m.url).endsWith(b))
          )
            return this.state('error', 'cannot read the track (fake)')
          this.state('playing')
          this.startEnd(mine)
        })
        return
      }
      case 'sleep.pause':
        if (this.phase !== 'playing') return
        this.clearEnd()
        this.state('paused')
        return
      case 'sleep.resume':
        if (this.phase !== 'paused' || !id) return
        this.later(1, () => {
          if (this.trackId !== id || this.phase !== 'paused') return
          this.state('playing')
          this.startEnd(id)
        })
        return
      case 'sleep.stop':
        if (this.phase === 'off') return
        this.clearEnd()
        this.state('off')
        this.trackId = undefined
        return
    }
  }

  /** The page went away (or the test is over): everything on it is gone, and it cannot report. */
  reset(): void {
    this.clearEnd()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.phase = 'off'
    this.trackId = undefined
  }
}
