/** A scripted stand-in for the stage page: answers the orchestrator the way a healthy (or a broken) stage would. */
import { FrameKind, decodeFrame } from '@animatus/protocol'
import type { RawData } from 'ws'
import { TestStage } from './stage-client.ts'
import type { Json } from './stage-client.ts'

export interface FakeStageOptions {
  /** `playback.ended` reason. Default 'done'. */
  endReason?: 'done' | 'cancelled' | 'error' | 'timeout' | 'audio_suspended' | 'superseded'
  /** false: never answer an utterance (simulates a wedged stage). */
  answerUtterances?: boolean
  /** Underruns reported in every `playback.ended`. Default 0. */
  underruns?: number
  /** Time between the last audio frame and `playback.ended`. Default 25 ms. */
  playMs?: number
  /** Model load result. 'never': no model.state at all. */
  model?: 'ready' | 'error' | 'never'
  /** `dance.state` idle reason. Default 'finished'. */
  danceReason?: 'finished' | 'error' | 'stopped'
  danceMs?: number
  /** Fields merged into every `stats` report. */
  stats?: Record<string, number>
  /** false: never send stats. */
  sendStats?: boolean
  statsEveryMs?: number
  /** Send hello right after connecting. Default true. */
  hello?: boolean
}

interface Pending {
  begin: Json
  frames: Uint8Array[]
}

export class FakeStage {
  readonly stage: TestStage
  /** Every `utterance.begin` received, in order. */
  readonly begins: Json[] = []
  /** Audio payload per utterance id, concatenated. */
  readonly audio = new Map<string, Uint8Array>()
  readonly cancels: Json[] = []
  readonly dances: Json[] = []
  ended = 0
  private readonly pending = new Map<number, Pending>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private frames = 0

  private constructor(
    stage: TestStage,
    private readonly opts: FakeStageOptions
  ) {
    this.stage = stage
    stage.ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(data, isBinary))
    const every = opts.statsEveryMs ?? 60
    if (opts.sendStats !== false) {
      const timer = setInterval(() => this.sendStats(), every)
      this.timers.add(timer)
      stage.ws.on('close', () => this.stopTimers())
    }
  }

  /** Connects to a stage server (`http://127.0.0.1:port`) with the origin a real page would have. */
  static async connect(httpUrl: string, opts: FakeStageOptions = {}): Promise<FakeStage> {
    const url = new URL(httpUrl)
    const stage = await TestStage.connect(`ws://${url.host}/stage`, { origin: url.origin })
    const fake = new FakeStage(stage, opts)
    if (opts.hello !== false) stage.hello({ ua: 'fake-stage/1.0' })
    return fake
  }

  get closed(): boolean {
    return this.stage.closeInfo !== null
  }

  close(): void {
    this.stopTimers()
    this.stage.close()
  }

  terminate(): void {
    this.stopTimers()
    this.stage.ws.terminate()
  }

  private stopTimers(): void {
    for (const t of this.timers) {
      clearInterval(t)
      clearTimeout(t)
    }
    this.timers.clear()
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.stage.ws.readyState === 1) fn()
    }, ms)
    this.timers.add(timer)
  }

  private send(msg: unknown): void {
    if (this.stage.ws.readyState === 1) this.stage.send(msg)
  }

  private sendStats(): void {
    this.frames += 6
    this.send({
      type: 'stats',
      fps: 60,
      frame_ms_p95: 17,
      audio_contexts_created: 1,
      audio_contexts_open: 1,
      underruns_total: 0,
      tpose_frames: 0,
      frames_total: this.frames,
      models_loaded: 1,
      ...this.opts.stats,
    })
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) return this.onBinary(data)
    const msg = JSON.parse(
      (Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)).toString('utf8')
    ) as Json
    switch (msg.type) {
      case 'scene.set':
        return this.onScene(msg)
      case 'utterance.begin':
        this.begins.push(msg)
        this.pending.set(msg.handle as number, { begin: msg, frames: [] })
        return
      case 'utterance.cancel':
        this.cancels.push(msg)
        return
      case 'dance.play':
        return this.onDance(msg)
      default:
        return
    }
  }

  private onScene(msg: Json): void {
    const model = this.opts.model ?? 'ready'
    if (model === 'never') return
    const url = (msg.model as { url?: string } | null)?.url
    this.later(5, () => this.send({ type: 'model.state', status: 'loading', url }))
    this.later(15, () =>
      model === 'error'
        ? this.send({
            type: 'model.state',
            status: 'error',
            url,
            error: 'the fake stage could not load the model',
          })
        : this.send({
            type: 'model.state',
            status: 'ready',
            url,
            info: {
              vrm_version: '0',
              blend_shapes: 52,
              arkit_blink: true,
              vrm_blink: true,
              spring_joints: 4,
            },
          })
    )
  }

  private onBinary(data: RawData): void {
    const bytes = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data)
    const frame = decodeFrame(new Uint8Array(bytes))
    const entry = this.pending.get(frame.handle)
    if (!entry || frame.kind !== FrameKind.Audio) return
    entry.frames.push(new Uint8Array(frame.payload))
    if (!frame.last) return
    this.pending.delete(frame.handle)
    const id = entry.begin.utterance_id as string
    const total = entry.frames.reduce((n, f) => n + f.byteLength, 0)
    const joined = new Uint8Array(total)
    let offset = 0
    for (const f of entry.frames) {
      joined.set(f, offset)
      offset += f.byteLength
    }
    this.audio.set(id, joined)
    if (this.opts.answerUtterances === false) return
    const seq = entry.begin.seq as number
    this.send({ type: 'playback.started', utterance_id: id, seq, audio_time_s: 1, perf_ms: 1 })
    this.later(this.opts.playMs ?? 25, () => {
      this.ended++
      this.send({
        type: 'playback.ended',
        utterance_id: id,
        seq,
        reason: this.opts.endReason ?? 'done',
        underruns: this.opts.underruns ?? 0,
        played_ms: 100,
      })
    })
  }

  private onDance(msg: Json): void {
    this.dances.push(msg)
    const id = msg.dance_id as string
    const reason = this.opts.danceReason ?? 'finished'
    this.send({ type: 'dance.state', dance_id: id, phase: 'loading' })
    this.later(5, () => this.send({ type: 'dance.state', dance_id: id, phase: 'playing' }))
    this.later(this.opts.danceMs ?? 50, () =>
      this.send({
        type: 'dance.state',
        dance_id: id,
        phase: 'idle',
        reason,
        ...(reason === 'error' ? { error: 'the fake dance failed' } : {}),
      })
    )
  }
}
