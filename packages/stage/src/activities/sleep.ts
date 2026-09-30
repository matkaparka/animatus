import type { SleepPlay, StageUpstream } from '@animatus/protocol'
import type { AudioEngine } from '../audio/engine.ts'
import { captionAt, type Caption } from './timeline.ts'

type Phase = 'off' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export interface SleepDeps {
  engine: AudioEngine
  setCaption(text: string): void
  report(msg: StageUpstream): void
}

/**
 * The stage's half of sleep mode: a long whispered track played from a URL through one media element
 * (long tracks are streamed, not decoded whole, which would cost a lot of memory), routed to the speakers
 * and to the lip-sync path. The playlist, loop, and when to pause for a reply are the orchestrator's; this
 * class plays one track, fades, pauses/resumes on command, and times the captions.
 */
export class SleepStage {
  private el: HTMLAudioElement | null = null
  private gain: GainNode | null = null
  private phase: Phase = 'off'
  private trackId: string | undefined
  private captions: Caption[] = []
  private token = 0
  private pauseTimer: number | null = null

  constructor(private readonly deps: SleepDeps) {}

  get active(): boolean {
    return this.phase === 'loading' || this.phase === 'playing' || this.phase === 'paused'
  }

  async play(msg: SleepPlay): Promise<void> {
    const engine = this.deps.engine
    const ctx = engine.ctx
    const token = ++this.token
    this.clearPauseTimer()
    this.trackId = msg.track_id
    this.captions = msg.captions
    if (!ctx) return this.setState('error', 'no audio context')
    const el = this.ensureElement(ctx)
    this.setState('loading')
    await engine.ensureRunning(500)
    if (token !== this.token) return
    el.src = msg.url
    this.ramp(0, msg.volume, msg.fade_in_s)
    try {
      await el.play()
      if (token === this.token) this.setState('playing')
    } catch (e) {
      if (token === this.token)
        this.setState('error', `play failed: ${String((e as Error)?.message ?? e)}`)
    }
  }

  pause(fadeS: number): void {
    const el = this.el
    if (!el || this.phase !== 'playing') return
    this.clearPauseTimer()
    this.ramp(null, 0, fadeS)
    const token = this.token
    this.pauseTimer = window.setTimeout(
      () => {
        if (token === this.token && this.phase === 'paused') el.pause()
      },
      fadeS * 1000 + 50
    )
    this.setState('paused')
  }

  async resume(fadeS: number, volume: number): Promise<void> {
    const el = this.el
    if (!el || this.phase !== 'paused') return
    this.clearPauseTimer()
    this.ramp(0, volume, fadeS)
    try {
      await el.play()
      this.setState('playing')
    } catch (e) {
      this.setState('error', `resume failed: ${String((e as Error)?.message ?? e)}`)
    }
  }

  stop(fadeS: number): void {
    const el = this.el
    if (!el || this.phase === 'off') return
    this.token++
    this.clearPauseTimer()
    this.ramp(null, 0, fadeS)
    this.pauseTimer = window.setTimeout(
      () => {
        el.pause()
        el.removeAttribute('src')
        el.load()
      },
      fadeS * 1000 + 50
    )
    this.captions = []
    this.deps.setCaption('')
    this.setState('off')
    this.trackId = undefined
  }

  /** Immediate stop (disconnect). */
  abort(): void {
    this.stop(0.1)
  }

  update(): void {
    if (this.phase === 'playing' && this.el && !this.el.paused) {
      this.deps.setCaption(captionAt(this.captions, this.el.currentTime))
    } else if (this.phase !== 'paused') {
      this.deps.setCaption('')
    }
  }

  // ─────────────────────────────── internals ───────────────────────────────

  /** One media element and one source node for the life of the page: createMediaElementSource works once per element. */
  private ensureElement(ctx: AudioContext): HTMLAudioElement {
    if (this.el) return this.el
    const el = new Audio()
    el.preload = 'auto'
    el.addEventListener('ended', () => {
      if (this.phase === 'off') return
      this.setState('ended')
    })
    el.addEventListener('error', () => {
      if (this.phase === 'off' || !el.getAttribute('src')) return
      this.setState('error', `cannot read the track (${el.error?.message ?? 'media error'})`)
    })
    const src = ctx.createMediaElementSource(el)
    const gain = ctx.createGain()
    src.connect(gain)
    gain.connect(this.deps.engine.master as GainNode)
    gain.connect(this.deps.engine.lipInput as GainNode)
    this.el = el
    this.gain = gain
    return el
  }

  private ramp(from: number | null, to: number, sec: number): void {
    const ctx = this.deps.engine.ctx
    const g = this.gain?.gain
    if (!ctx || !g) return
    const now = ctx.currentTime
    g.cancelScheduledValues(now)
    g.setValueAtTime(from === null ? g.value : from, now)
    g.linearRampToValueAtTime(to, now + Math.max(sec, 0.01))
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer !== null) {
      window.clearTimeout(this.pauseTimer)
      this.pauseTimer = null
    }
  }

  private setState(phase: Phase, error?: string): void {
    this.phase = phase
    this.deps.report({
      type: 'sleep.state',
      ...(this.trackId ? { track_id: this.trackId } : {}),
      phase,
      ...(error ? { error } : {}),
    })
  }
}
