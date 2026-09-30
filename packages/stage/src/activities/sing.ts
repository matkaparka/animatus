import type { SingPlay, StageUpstream } from '@animatus/protocol'
import type { AudioEngine } from '../audio/engine.ts'
import { lyricIndexAt, voiceActivity, type LyricLine } from './timeline.ts'

type Phase = 'idle' | 'loading' | 'playing' | 'ending'
type Reason = 'done' | 'stopped' | 'error' | 'cancelled'

export interface SingDeps {
  engine: AudioEngine
  setLyric(text: string): void
  hold(on: boolean): void
  report(msg: StageUpstream): void
}

const FRAME_S = 0.05

/**
 * The stage's half of a song: decode instrumental and vocal tracks, start them together on the audio
 * clock, send only the vocals to the lip-sync path (so the mouth follows the singer, not the band), show
 * the current lyric line, and tell the body when the voice is active (talk motion during phrases, idle in
 * real breaks). Queueing, skipping and the outro line belong to the orchestrator.
 */
export class SingStage {
  /** Whether the vocal track is voiced right now; drives the talking motion. */
  voiceActive = false

  private phase: Phase = 'idle'
  private current: SingPlay | null = null
  private token = 0
  private nodes: {
    inst: AudioBufferSourceNode
    voc: AudioBufferSourceNode
    gInst: GainNode
    gVoc: GainNode
  } | null = null
  private env: Uint8Array = new Uint8Array(0)
  private lyrics: LyricLine[] = []
  private t0 = 0
  private duration = 0
  private endAt = 0
  private endReason: Reason = 'done'

  constructor(private readonly deps: SingDeps) {}

  get active(): boolean {
    return this.phase !== 'idle'
  }

  play(msg: SingPlay): void {
    if (this.phase !== 'idle') {
      this.state(msg.song_id, 'idle', 'cancelled')
      return
    }
    this.current = msg
    void this.start(msg)
  }

  stop(fadeS: number): void {
    if (this.phase === 'loading') {
      this.token++
      this.finish('stopped')
    } else if (this.phase === 'playing') {
      this.beginEnding(fadeS, 'stopped')
    }
  }

  /** Abort at once (disconnect, model swap does not matter for songs). */
  abort(reason: Reason = 'cancelled'): void {
    if (this.phase === 'idle') return
    this.token++
    this.silence()
    this.finish(reason)
  }

  update(): void {
    const engine = this.deps.engine
    if ((this.phase === 'playing' || this.phase === 'ending') && this.nodes) {
      const heard = engine.heardTime()
      const t = heard - this.t0
      const f = Math.floor(t / FRAME_S)
      this.voiceActive = this.phase === 'playing' && f >= 0 && f < this.env.length && !!this.env[f]
      const idx = lyricIndexAt(this.lyrics, t)
      this.deps.setLyric(idx >= 0 ? (this.lyrics[idx]?.text ?? '') : '')
      if (this.phase === 'playing' && t >= this.duration) this.finish('done')
      else if (this.phase === 'ending' && heard >= this.endAt) this.finish(this.endReason)
    } else {
      this.voiceActive = false
    }
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private state(id: string, phase: Phase, reason?: Reason, error?: string): void {
    this.deps.report({
      type: 'sing.state',
      song_id: id,
      phase,
      ...(reason ? { reason } : {}),
      ...(error ? { error } : {}),
    })
  }

  private async decode(ctx: AudioContext, url: string): Promise<AudioBuffer> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`)
    return ctx.decodeAudioData(await res.arrayBuffer())
  }

  private async start(msg: SingPlay): Promise<void> {
    const engine = this.deps.engine
    const token = ++this.token
    this.phase = 'loading'
    this.deps.hold(true)
    this.state(msg.song_id, 'loading')
    try {
      const ctx = engine.ctx
      if (!ctx || !(await engine.ensureRunning(500))) throw new Error('audio context not running')
      const [instBuf, vocBuf] = await Promise.all([
        this.decode(ctx, msg.inst_url),
        this.decode(ctx, msg.vocals_url),
      ])
      if (token !== this.token || this.phase !== 'loading') return

      this.env = voiceActivity(vocBuf.getChannelData(0), vocBuf.sampleRate)
      this.lyrics = msg.lyrics
      const inst = ctx.createBufferSource()
      inst.buffer = instBuf
      const gInst = ctx.createGain()
      inst.connect(gInst).connect(engine.master as GainNode)
      const voc = ctx.createBufferSource()
      voc.buffer = vocBuf
      const gVoc = ctx.createGain()
      voc.connect(gVoc)
      gVoc.connect(engine.master as GainNode)
      gVoc.connect(engine.lipInput as GainNode) // only the vocals drive the mouth
      this.t0 = ctx.currentTime + msg.start_delay_s
      inst.start(this.t0)
      voc.start(this.t0)
      this.nodes = { inst, voc, gInst, gVoc }
      this.duration = Math.max(instBuf.duration, vocBuf.duration)
      this.phase = 'playing'
      this.state(msg.song_id, 'playing')
    } catch (e) {
      console.error('[stage] song failed to start', e)
      if (token === this.token) this.finish('error', String((e as Error)?.message ?? e))
    }
  }

  private beginEnding(fadeS: number, reason: Reason): void {
    const ctx = this.deps.engine.ctx
    if (!ctx || !this.nodes || !this.current) return
    const { inst, voc, gInst, gVoc } = this.nodes
    const now = ctx.currentTime
    for (const g of [gInst.gain, gVoc.gain]) {
      g.cancelScheduledValues(now)
      g.setValueAtTime(g.value, now)
      g.linearRampToValueAtTime(0, now + fadeS)
    }
    for (const s of [inst, voc]) {
      try {
        s.stop(now + fadeS + 0.05)
      } catch {
        // not started yet
      }
    }
    this.phase = 'ending'
    this.endReason = reason
    this.endAt = this.deps.engine.heardTime() + fadeS
    this.state(this.current.song_id, 'ending')
  }

  private silence(): void {
    if (!this.nodes) return
    for (const s of [this.nodes.inst, this.nodes.voc]) {
      try {
        s.stop()
      } catch {
        // already stopped
      }
    }
  }

  private finish(reason: Reason, error?: string): void {
    const id = this.current?.song_id
    if (this.nodes) {
      this.silence()
      this.nodes.gInst.disconnect()
      this.nodes.gVoc.disconnect()
      this.nodes = null
    }
    this.voiceActive = false
    this.env = new Uint8Array(0)
    this.lyrics = []
    this.current = null
    this.phase = 'idle'
    this.deps.setLyric('')
    this.deps.hold(false)
    if (id) this.state(id, 'idle', reason, error)
  }
}
