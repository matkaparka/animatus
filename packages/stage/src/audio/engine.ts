import { Emitter } from '../emitter.ts'
import { audioContextStats } from './counter.ts'

export type EngineState = 'running' | 'suspended' | 'closed' | 'unavailable'

/**
 * The one AudioContext of the stage. It is created once and lives as long as the page; loading a new
 * model never creates another (the legacy stage made two per load and closed neither).
 *
 * Graph:
 *   speech / vocals / whisper track --> speechBus --> master --> destination
 *   anything that should move the mouth --> lipInput --> lipDelay --> analyser --> (lip-sync node)
 *
 * `lipDelay` equals the output latency, so the mouth moves when the sound reaches the room, not when
 * it was handed to the audio device. `heardTime()` is the audio clock of what is being heard now; dance,
 * song and captions are positioned on it for the same reason. The legacy code positioned them on
 * `currentTime`, which runs one output latency ahead of the sound.
 */
export class AudioEngine {
  readonly ctx: AudioContext | null
  readonly master: GainNode | null = null
  readonly speechBus: GainNode | null = null
  readonly lipInput: GainNode | null = null
  readonly analyser: AnalyserNode | null = null
  readonly events = new Emitter<{ state: [EngineState] }>()

  private lipDelay: DelayNode | null = null
  private lastState: EngineState
  private lastLatencyAt = 0
  private lastResumeAt = 0

  constructor() {
    let ctx: AudioContext | null = null
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' })
    } catch (e) {
      console.warn('[stage] AudioContext unavailable', e)
    }
    this.ctx = ctx
    this.lastState = this.state
    if (!ctx) return

    this.master = ctx.createGain()
    this.master.connect(ctx.destination)
    this.speechBus = ctx.createGain()
    this.speechBus.connect(this.master)
    this.lipInput = ctx.createGain()
    this.lipDelay = ctx.createDelay(1)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.lipInput.connect(this.lipDelay)
    this.lipDelay.connect(this.analyser)
    this.speechBus.connect(this.lipInput)

    ctx.addEventListener('statechange', () => this.emitState())
    void this.ensureRunning()
  }

  get state(): EngineState {
    if (!this.ctx) return 'unavailable'
    const s = this.ctx.state as string
    return s === 'running' ? 'running' : s === 'closed' ? 'closed' : 'suspended'
  }

  get running(): boolean {
    return this.state === 'running'
  }

  /**
   * Try to get the context running; resolves false after `timeoutMs` if the browser will not let it
   * (no user gesture and no autoplay flag). Callers must not wait on audio forever.
   */
  async ensureRunning(timeoutMs = 400): Promise<boolean> {
    const ctx = this.ctx
    if (!ctx) return false
    if (ctx.state === 'running') return true
    if (ctx.state === 'closed') return false
    try {
      await Promise.race([ctx.resume(), new Promise<void>((r) => setTimeout(r, timeoutMs))])
    } catch {
      // autoplay blocked: fall through and report the real state
    }
    // re-read: the state may have changed while awaiting (TypeScript still has the narrowed type)
    return (ctx.state as AudioContextState) === 'running'
  }

  /** Output latency in seconds as the browser reports it (falls back to the base latency). */
  get outputLatency(): number {
    const c = this.ctx
    if (!c) return 0
    return c.outputLatency > 0 ? c.outputLatency : c.baseLatency || 0
  }

  /**
   * Audio-clock time of the sample being heard right now. `getOutputTimestamp` maps context time to
   * the performance clock at the speaker, so this is `currentTime` minus the real output latency.
   */
  heardTime(): number {
    const c = this.ctx
    if (!c) return performance.now() / 1000
    const ts = c.getOutputTimestamp?.()
    if (
      ts &&
      ts.performanceTime &&
      ts.performanceTime > 0 &&
      ts.contextTime &&
      ts.contextTime > 0
    ) {
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000
    }
    return Math.max(0, c.currentTime - this.outputLatency)
  }

  /** How far `currentTime` is ahead of what is heard. */
  latencySeconds(): number {
    const c = this.ctx
    if (!c) return 0
    return Math.max(0, c.currentTime - this.heardTime())
  }

  /** Per frame: keep the lip delay matched to the latency and nudge a suspended context. */
  update(nowMs: number): void {
    const c = this.ctx
    if (!c) return
    if (this.state === 'suspended' && nowMs - this.lastResumeAt > 2000) {
      this.lastResumeAt = nowMs
      void this.ensureRunning(200)
    }
    if (nowMs - this.lastLatencyAt > 1000 && this.lipDelay && c.state === 'running') {
      this.lastLatencyAt = nowMs
      const d = Math.min(0.5, this.latencySeconds() || this.outputLatency)
      this.lipDelay.delayTime.setTargetAtTime(d, c.currentTime, 0.2)
    }
  }

  describe() {
    const c = this.ctx
    const s = audioContextStats()
    return {
      state: this.state,
      sample_rate: c?.sampleRate ?? 0,
      base_latency: c?.baseLatency ?? 0,
      output_latency: c?.outputLatency ?? 0,
      contexts_created: s.created,
      contexts_open: s.open,
    }
  }

  private emitState(): void {
    const s = this.state
    if (s === this.lastState) return
    this.lastState = s
    this.events.emit('state', s)
  }
}
