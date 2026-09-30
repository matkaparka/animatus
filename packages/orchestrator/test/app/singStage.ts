/**
 * What the real stage page does with a song, for a `FakeStage`: it answers `sing.play` with `sing.state` reports
 * (loading, playing, then idle when the song is over) and `sing.stop` with a fade and `idle stopped`. It listens on the
 * fake page's own socket, so `fake-stage.ts` stays as it is. It can be told to fail, or to say nothing.
 */
import type { RawData } from 'ws'
import type { FakeStage } from '../_stage-support/fake-stage.ts'
import type { Json } from '../_stage-support/stage-client.ts'

export interface SingStageOptions {
  loadMs?: number
  playMs?: number
  fadeMs?: number
  /** Fails the song at once with this reason (like a track the page cannot decode). */
  fail?: string
  /** Never answers a `sing.play`. */
  silent?: boolean
}

export class SingStageScript {
  /** Every `sing.play` and `sing.stop` the page was sent. */
  readonly plays: Json[] = []
  readonly stops: Json[] = []
  private readonly timers = new Set<NodeJS.Timeout>()
  private ending: NodeJS.Timeout | null = null
  private id: string | null = null
  private phase: 'idle' | 'loading' | 'playing' = 'idle'

  constructor(
    private readonly stage: FakeStage,
    private readonly opts: SingStageOptions = {}
  ) {
    stage.stage.ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return
      const msg = JSON.parse(
        (Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)).toString('utf8')
      ) as Json
      if (msg.type === 'sing.play') this.onPlay(msg)
      else if (msg.type === 'sing.stop') this.onStop(msg)
    })
    stage.stage.ws.on('close', () => this.clear())
  }

  private clear(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private later(ms: number, fn: () => void): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (this.stage.stage.ws.readyState === 1) fn()
    }, ms)
    this.timers.add(t)
    return t
  }

  private report(phase: string, extra: Record<string, unknown> = {}): void {
    if (this.stage.stage.ws.readyState === 1)
      this.stage.stage.send({ type: 'sing.state', song_id: this.id, phase, ...extra })
  }

  private onPlay(msg: Json): void {
    this.plays.push(msg)
    if (this.opts.silent) return
    this.id = msg.song_id as string
    this.phase = 'loading'
    this.report('loading')
    if (this.opts.fail) {
      this.later(5, () => {
        this.phase = 'idle'
        this.report('idle', { reason: 'error', error: this.opts.fail })
      })
      return
    }
    this.later(this.opts.loadMs ?? 10, () => {
      this.phase = 'playing'
      this.report('playing')
    })
    this.ending = this.later((this.opts.loadMs ?? 10) + (this.opts.playMs ?? 400), () => {
      this.phase = 'idle'
      this.report('idle', { reason: 'done' })
    })
  }

  private onStop(msg: Json): void {
    this.stops.push(msg)
    if (this.phase === 'idle' || !this.id) return
    if (this.ending) clearTimeout(this.ending)
    this.ending = null
    this.report('ending')
    this.later(this.opts.fadeMs ?? 20, () => {
      this.phase = 'idle'
      this.report('idle', { reason: 'stopped' })
    })
  }

  /** The page's own idea of the current song, for a test that ends it by hand. */
  end(reason: 'done' | 'error' | 'stopped', error?: string): void {
    this.phase = 'idle'
    this.report('idle', { reason, ...(error ? { error } : {}) })
  }
}
