import {
  FrameKind,
  type MediaFrame,
  type StageUpstream,
  type UtteranceBegin,
} from '@animatus/protocol'
import type { AudioEngine } from './engine.ts'
import { JitterScheduler, type JitterOptions } from './jitter.ts'
import { Pcm16Decoder } from './pcm.ts'

export type EndReason =
  'done' | 'cancelled' | 'error' | 'timeout' | 'audio_suspended' | 'superseded'

export interface UtteranceView {
  readonly id: string
  readonly seq: number
  readonly begin: UtteranceBegin
}

export interface SpeechHooks {
  /** The whole VRMA stream of an utterance has arrived (before its audio). */
  onVrma?(u: UtteranceView, bytes: Uint8Array): void
  /** The first sample of this utterance is being heard. */
  onStart(u: UtteranceView): void
  /** The utterance is over (after the report was sent). */
  onEnd(u: UtteranceView, reason: EndReason): void
}

const MAX_VRMA_BYTES = 8 * 1024 * 1024
/** An utterance whose audio never completes is dropped after this long. */
const UTTERANCE_TIMEOUT_MS = 90_000

class Utt implements UtteranceView {
  readonly id: string
  readonly seq: number
  state: 'queued' | 'active' | 'ended' = 'queued'
  sched: JitterScheduler | null = null
  pending: Float32Array[] = []
  readonly decoder = new Pcm16Decoder()
  lastReceived = false
  receivedSamples = 0
  vrmaParts: Uint8Array[] = []
  vrmaBytes = 0
  vrmaDone = false
  gain: GainNode | null = null
  sources: AudioBufferSourceNode[] = []
  startedReported = false
  silent = false
  silentStartedAt = 0
  activating = false
  readonly createdAt: number

  constructor(
    readonly begin: UtteranceBegin,
    createdAt: number
  ) {
    this.id = begin.utterance_id
    this.seq = begin.seq
    this.createdAt = createdAt
  }
}

/**
 * Plays utterances in arrival order through the jitter scheduler. One utterance is audible at a time;
 * the next is scheduled to start exactly when the current one ends when its audio is already here
 * (gapless), otherwise as soon as it can. Dance and song hold utterances back (`hold`), and if the audio
 * context cannot run an utterance still completes (`audio_suspended`), so the pipeline never waits for
 * a sound that will not come.
 */
export class SpeechPlayer {
  private queue: Utt[] = []
  private byHandle = new Map<number, Utt>()
  private holds = new Set<string>()
  private underrunsTotal = 0
  private droppedFrames = 0

  constructor(
    private readonly engine: AudioEngine,
    private readonly hooks: SpeechHooks,
    private readonly report: (msg: StageUpstream) => void,
    private readonly jitter: Partial<JitterOptions> = {}
  ) {}

  get underruns(): number {
    return this.underrunsTotal
  }

  get dropped(): number {
    return this.droppedFrames
  }

  /** True from the moment the first utterance in the queue becomes audible until it ends. */
  isSpeaking(): boolean {
    const cur = this.queue[0]
    return !!cur && cur.state === 'active' && cur.startedReported
  }

  hold(reason: string, on: boolean): void {
    if (on) this.holds.add(reason)
    else this.holds.delete(reason)
  }

  begin(msg: UtteranceBegin, nowMs: number = performance.now()): void {
    if (this.byHandle.has(msg.handle) || this.queue.some((u) => u.id === msg.utterance_id)) {
      this.report({
        type: 'error',
        code: 'duplicate_utterance',
        message: `utterance ${msg.utterance_id} already exists`,
      })
      return
    }
    const u = new Utt(msg, nowMs)
    this.queue.push(u)
    this.byHandle.set(msg.handle, u)
  }

  feed(frame: MediaFrame): void {
    const u = this.byHandle.get(frame.handle)
    if (!u || u.state === 'ended') {
      this.droppedFrames++
      return
    }
    if (frame.kind === FrameKind.Vrma) {
      if (u.vrmaBytes + frame.payload.byteLength <= MAX_VRMA_BYTES) {
        u.vrmaParts.push(frame.payload.slice())
        u.vrmaBytes += frame.payload.byteLength
      }
      if (frame.last && !u.vrmaDone) {
        u.vrmaDone = true
        const all = new Uint8Array(u.vrmaBytes)
        let o = 0
        for (const p of u.vrmaParts) {
          all.set(p, o)
          o += p.byteLength
        }
        u.vrmaParts = []
        this.hooks.onVrma?.(u, all)
      }
      return
    }
    const samples = u.decoder.push(frame.payload)
    u.receivedSamples += samples.length
    if (samples.length) {
      if (u.sched) u.sched.push(samples)
      else u.pending.push(samples)
    }
    if (frame.last) {
      u.lastReceived = true
      u.sched?.markLast()
    }
  }

  cancel(scope: 'utterance' | 'all', utteranceId: string | undefined, fadeMs: number): void {
    const targets =
      scope === 'all' ? [...this.queue] : this.queue.filter((u) => u.id === utteranceId)
    for (const u of targets) this.finish(u, 'cancelled', fadeMs)
  }

  /** Per frame. */
  update(nowMs: number): void {
    const engine = this.engine
    const ctx = engine.ctx
    const heard = engine.heardTime()

    for (const u of [...this.queue]) {
      if (nowMs - u.createdAt > UTTERANCE_TIMEOUT_MS) this.finish(u, 'timeout', 0)
    }

    const cur = this.queue[0]
    if (!cur) return

    if (cur.state === 'queued' && this.holds.size === 0) this.activate(cur, 0, nowMs)
    if (cur.state === 'active') this.advance(cur, heard, nowMs)

    // Gapless chaining: once the current utterance has handed out all of its audio, the next one may
    // be scheduled to begin exactly where it ends.
    const next = this.queue[1]
    if (
      ctx &&
      cur.state === 'active' &&
      !cur.silent &&
      cur.sched?.allScheduled &&
      next &&
      next.state === 'queued' &&
      this.holds.size === 0
    ) {
      this.activate(next, cur.sched.endsAt ?? 0, nowMs)
    }
    if (next && next.state === 'active') this.advance(next, heard, nowMs, false)
  }

  private activate(u: Utt, notBefore: number, nowMs: number): void {
    if (u.state !== 'queued' || u.activating) return
    const ctx = this.engine.ctx
    if (!ctx || !this.engine.running) {
      // Ask once; if the context still cannot run, play the utterance silently.
      u.activating = true
      void this.engine.ensureRunning(400).then((ok) => {
        u.activating = false
        if (u.state !== 'queued') return
        if (ok) this.activate(u, notBefore, nowMs)
        else this.startSilent(u, nowMs)
      })
      return
    }
    u.state = 'active'
    u.sched = new JitterScheduler(u.begin.audio.sample_rate, this.jitter, notBefore)
    for (const s of u.pending) u.sched.push(s)
    u.pending = []
    if (u.lastReceived) u.sched.markLast()
    u.gain = ctx.createGain()
    u.gain.connect(this.engine.speechBus as GainNode)
  }

  private startSilent(u: Utt, nowMs: number): void {
    u.state = 'active'
    u.silent = true
    u.silentStartedAt = nowMs
    u.startedReported = true
    this.report({
      type: 'playback.started',
      utterance_id: u.id,
      seq: u.seq,
      audio_time_s: 0,
      perf_ms: nowMs,
    })
    this.hooks.onStart(u)
  }

  private advance(u: Utt, heard: number, nowMs: number, mayFinish = true): void {
    if (u.silent) {
      // Wall-clock timeline: the mouth stays shut but the body still "speaks" for the right duration.
      if (mayFinish && u.lastReceived) {
        const dur = (u.receivedSamples / u.begin.audio.sample_rate) * 1000
        if (nowMs - u.silentStartedAt >= dur) this.finish(u, 'audio_suspended', 0)
      }
      return
    }
    const ctx = this.engine.ctx
    const sched = u.sched
    if (!ctx || !sched) return
    const chunks = sched.pump(ctx.currentTime)
    for (const c of chunks) {
      const buf = ctx.createBuffer(1, c.samples.length, u.begin.audio.sample_rate)
      buf.copyToChannel(c.samples as Float32Array<ArrayBuffer>, 0)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(u.gain as GainNode)
      src.start(c.startAt)
      src.onended = () => {
        const i = u.sources.indexOf(src)
        if (i >= 0) u.sources.splice(i, 1)
        src.disconnect()
      }
      u.sources.push(src)
    }

    if (!u.startedReported && sched.startedAt !== null && heard >= sched.startedAt) {
      u.startedReported = true
      this.report({
        type: 'playback.started',
        utterance_id: u.id,
        seq: u.seq,
        audio_time_s: sched.startedAt,
        perf_ms: performance.now(),
      })
      this.hooks.onStart(u)
    }

    if (!mayFinish) return
    if (sched.allScheduled) {
      const end = sched.endsAt
      if (end === null) {
        // no audio at all: report start and end together
        if (!u.startedReported) {
          u.startedReported = true
          this.report({
            type: 'playback.started',
            utterance_id: u.id,
            seq: u.seq,
            audio_time_s: ctx.currentTime,
            perf_ms: performance.now(),
          })
          this.hooks.onStart(u)
        }
        this.finish(u, 'done', 0)
      } else if (heard >= end) {
        this.finish(u, 'done', 0)
      }
    }
  }

  private finish(u: Utt, reason: EndReason, fadeMs: number): void {
    if (u.state === 'ended') return
    const wasActive = u.state === 'active'
    u.state = 'ended'
    const ctx = this.engine.ctx
    const underruns = u.sched?.underruns ?? 0
    this.underrunsTotal += underruns

    if (ctx && u.gain && (reason === 'cancelled' || reason === 'timeout')) {
      const now = ctx.currentTime
      u.gain.gain.cancelScheduledValues(now)
      u.gain.gain.setValueAtTime(u.gain.gain.value, now)
      u.gain.gain.linearRampToValueAtTime(0, now + Math.max(fadeMs, 5) / 1000)
      for (const s of u.sources) {
        try {
          s.stop(now + Math.max(fadeMs, 5) / 1000 + 0.02)
        } catch {
          // already stopped
        }
      }
    }
    const gain = u.gain
    if (gain) setTimeout(() => gain.disconnect(), Math.max(fadeMs, 5) + 400)

    const startedAt = u.sched?.startedAt ?? null
    const playedMs =
      u.startedReported && startedAt !== null && ctx
        ? Math.max(0, (this.engine.heardTime() - startedAt) * 1000)
        : 0
    this.queue = this.queue.filter((x) => x !== u)
    this.byHandle.delete(u.begin.handle)
    this.report({
      type: 'playback.ended',
      utterance_id: u.id,
      seq: u.seq,
      reason,
      underruns,
      played_ms: Math.round(wasActive ? playedMs : 0),
    })
    this.hooks.onEnd(u, reason)
  }
}
