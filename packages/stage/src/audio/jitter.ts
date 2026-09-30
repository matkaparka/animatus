/**
 * Jitter-buffer scheduling for one streamed utterance. Pure logic: no Web Audio, no timers. The
 * caller passes the audio clock (AudioContext time) to `pump` and schedules what it returns.
 *
 * The legacy player kept only ~30 ms of headroom and, after an underrun, carried on with the same
 * offsets so everything after it stayed misaligned. This one:
 *  - waits for a short pre-roll before starting (unless the whole utterance is already here);
 *  - never schedules more than `maxAheadSec` ahead (so a cancel cuts quickly);
 *  - on underrun stops, re-buffers, and restarts from the current time (a re-sync), raising the
 *    pre-roll for the rest of the utterance so a slow source stops stuttering;
 *  - can chain gaplessly after the previous utterance (`notBefore`).
 */
export interface JitterOptions {
  /** Audio to hold back before the first sample is scheduled. */
  prebufferSec: number
  /** Minimum distance between "now" and the first scheduled sample. */
  leadSec: number
  /** Do not schedule more than this far ahead of "now". */
  maxAheadSec: number
  /** Distance from "now" at which playback resumes after an underrun. */
  resyncMarginSec: number
  /** The pre-roll grows by 1.5x per underrun up to this. */
  maxPrebufferSec: number
}

export const DEFAULT_JITTER: JitterOptions = {
  prebufferSec: 0.15,
  leadSec: 0.03,
  maxAheadSec: 1.5,
  resyncMarginSec: 0.05,
  maxPrebufferSec: 0.5,
}

export interface ScheduledChunk {
  samples: Float32Array
  /** AudioContext time at which the first sample is scheduled to sound. */
  startAt: number
  duration: number
}

export type JitterState = 'buffering' | 'playing' | 'finished'

export class JitterScheduler {
  readonly sampleRate: number
  private readonly opts: JitterOptions
  private queue: Float32Array[] = []
  private queuedSamples = 0
  private lastPushed = false
  private prebuffer: number
  private nextStart = 0
  private notBefore: number
  private _state: JitterState = 'buffering'
  private _startedAt: number | null = null
  private _scheduledSamples = 0
  private _underruns = 0

  constructor(sampleRate: number, opts: Partial<JitterOptions> = {}, notBefore = 0) {
    this.sampleRate = sampleRate
    this.opts = { ...DEFAULT_JITTER, ...opts }
    this.prebuffer = this.opts.prebufferSec
    this.notBefore = notBefore
  }

  push(samples: Float32Array): void {
    if (samples.length === 0) return
    this.queue.push(samples)
    this.queuedSamples += samples.length
  }

  markLast(): void {
    this.lastPushed = true
  }

  get state(): JitterState {
    return this._state
  }

  /** AudioContext time of the first sample, once started. */
  get startedAt(): number | null {
    return this._startedAt
  }

  /** AudioContext time at which everything scheduled so far ends, or null if nothing was scheduled. */
  get endsAt(): number | null {
    return this._scheduledSamples > 0 ? this.nextStart : null
  }

  /** Every sample has been handed out (audio may still be playing until `endsAt`). */
  get allScheduled(): boolean {
    return this._state === 'finished'
  }

  get underruns(): number {
    return this._underruns
  }

  get scheduledSec(): number {
    return this._scheduledSamples / this.sampleRate
  }

  get bufferedSec(): number {
    return this.queuedSamples / this.sampleRate
  }

  get currentPrebufferSec(): number {
    return this.prebuffer
  }

  /** Returns the chunks to schedule right now. Call on every frame and whenever data arrives. */
  pump(now: number): ScheduledChunk[] {
    const out: ScheduledChunk[] = []
    if (this._state === 'finished') return out

    if (this._state === 'buffering') {
      if (this.lastPushed && this.queuedSamples === 0 && this._scheduledSamples === 0) {
        this._state = 'finished' // an utterance with no audio at all
        return out
      }
      const ready =
        this.bufferedSec >= this.prebuffer || (this.lastPushed && this.queuedSamples > 0)
      if (!ready) return out
      const lead = this._startedAt === null ? this.opts.leadSec : this.opts.resyncMarginSec
      this.nextStart = Math.max(now + lead, this.notBefore)
      if (this._startedAt === null) this._startedAt = this.nextStart
      this._state = 'playing'
    }

    if (this.queuedSamples === 0) {
      if (this.lastPushed) this._state = 'finished'
      else if (this.nextStart <= now) this.underrun()
      return out
    }

    // Data is waiting but the scheduled audio already ran out: we were late (a stalled frame).
    if (this.nextStart < now) {
      this.nextStart = now + this.opts.resyncMarginSec
      this._underruns++
      this.prebuffer = Math.min(this.prebuffer * 1.5, this.opts.maxPrebufferSec)
    }

    while (this.queue.length > 0 && this.nextStart - now < this.opts.maxAheadSec) {
      const samples = this.queue.shift() as Float32Array
      this.queuedSamples -= samples.length
      const duration = samples.length / this.sampleRate
      out.push({ samples, startAt: this.nextStart, duration })
      this.nextStart += duration
      this._scheduledSamples += samples.length
    }
    if (this.queue.length === 0 && this.lastPushed) this._state = 'finished'
    return out
  }

  private underrun(): void {
    this._underruns++
    this.prebuffer = Math.min(this.prebuffer * 1.5, this.opts.maxPrebufferSec)
    this.notBefore = 0
    this._state = 'buffering'
  }
}
