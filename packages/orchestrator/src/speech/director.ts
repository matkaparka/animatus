/**
 * Speech scheduling: turns the sentences of a reply into utterances on the stage, in order.
 *
 * What it replaces in the legacy browser code (speech dispatcher + speak queue):
 *  - sessions: a new reply supersedes the previous one: its queued sentences are dropped, the sentence
 *    being spoken finishes (legacy `checkSessionId`); a reply that was stopped stays silent;
 *  - ordering: sentences are synthesised ahead (a small window) but always reach the stage in order;
 *  - cancellation: `cancelAll` / `cancelTurn`, with in-flight synthesis aborted, and late results of a
 *    cancelled epoch discarded;
 *  - holds: while a dance or a song runs nothing is sent (the stage would also hold, this keeps the
 *    stage's queue short and cancellation crisp);
 *  - live motion: a per-sentence motion clip is requested as soon as the audio exists and waited for at
 *    most `motionWaitMs` when the sentence's turn comes. Speech never waits longer for motion.
 *
 * Failure policy: a sentence that cannot be synthesised is dropped and reported (`failed`), never replaced
 * by silence; the rest of the reply continues.
 */
import { EventEmitter } from 'node:events'
import type { ClipRef, Emotion, MotionAdapter, TtsAdapter } from '@animatus/protocol'
import { TtsError } from '../tts/gptsovits.ts'
import { SpeechFilter, cleanSpeechText, isSpeakable } from '../tts/text.ts'

export interface SpeechItem {
  text: string
  emotion: Emotion
  /** One-shot body motion already resolved to a clip. Wins over live motion. */
  motion?: ClipRef | null
  /** Voice style (reference audio) key; default neutral. */
  style?: string
  speed?: number
  /** Text shown on the stage's subtitle overlay while this sentence plays. Default: the sentence itself; '' shows nothing. */
  subtitle?: string
}

export interface BeginArgs {
  utterance_id: string
  seq: number
  turn_id: string
  emotion: Emotion
  motion: ClipRef | null
  live_motion: boolean
  audio: { sample_rate: number; total_samples: number }
  subtitle?: string
}

/** What the director needs from the stage side. `StageHub` is adapted to this. */
export interface StageOutput {
  readonly connected: boolean
  beginUtterance(
    args: BeginArgs,
    media: { pcm16: Uint8Array; vrma?: Uint8Array }
  ): Promise<{ cancelled: boolean }>
  cancel(scope: 'utterance' | 'all', utteranceId?: string, fadeMs?: number): void
}

export type EndReason =
  'done' | 'cancelled' | 'error' | 'timeout' | 'audio_suspended' | 'superseded'

/** Stage reports the director reacts to. */
export interface StageReports {
  on(event: 'started', fn: (utteranceId: string) => void): () => void
  on(event: 'ended', fn: (utteranceId: string, reason: EndReason) => void): () => void
  on(event: 'disconnected', fn: () => void): () => void
}

export interface LiveMotionPolicy {
  /** Out of every `cycle` sentences, this many use live motion (legacy: 3 of 4). */
  generatedPerCycle: number
  cycle: number
  /** Give up on the motion service after this long per request. */
  requestTimeoutMs: number
  /** At most this long is spent waiting for an unfinished motion request before a sentence is sent. */
  waitMs: number
}

export interface SpeechDirectorOptions {
  tts: TtsAdapter
  stage: StageOutput
  reports: StageReports
  motion?: MotionAdapter & { available?(): boolean }
  filter?: SpeechFilter
  /** How many sentences beyond the head of the line may be synthesised ahead of playback. */
  lookahead?: number
  /** How many sentences may be at the stage (sent, not yet ended) at once. */
  stageQueueMax?: number
  liveMotion?: Partial<LiveMotionPolicy>
  /** Retry a retryable TTS failure once after this delay (ms). 0 disables. */
  ttsRetryDelayMs?: number
  /** An utterance the stage never reports as ended is force-ended after its length plus this (ms). */
  endGraceMs?: number
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void
  now?: () => number
}

type State =
  'queued' | 'synthesizing' | 'ready' | 'sending' | 'sent' | 'playing' | 'ended' | 'dropped'

interface Entry {
  id: string
  seq: number
  turn: string
  epoch: number
  item: SpeechItem
  text: string
  state: State
  abort: AbortController
  pcm?: Uint8Array
  sampleRate?: number
  motionPromise?: Promise<Uint8Array | null>
  useLive: boolean
  endTimer?: NodeJS.Timeout
  trace: TraceRecord
}

/** Timestamps (ms) of one sentence's journey, for the run page and latency budgets. */
export interface TraceRecord {
  id: string
  turn: string
  seq: number
  text: string
  enqueuedAt: number
  synthStartedAt?: number
  synthDoneAt?: number
  sentAt?: number
  startedAt?: number
  endedAt?: number
  audioSec?: number
  liveMotion?: 'used' | 'late' | 'failed' | 'skipped'
}

export type DirectorEvents = {
  started: [id: string, trace: TraceRecord]
  ended: [id: string, reason: EndReason, trace: TraceRecord]
  failed: [id: string, error: Error, text: string]
  dropped: [id: string, why: 'superseded' | 'cancelled' | 'turn_cancelled']
  turnDone: [turn: string]
  idle: []
  trace: [trace: TraceRecord]
}

const DEFAULT_LIVE: LiveMotionPolicy = {
  generatedPerCycle: 3,
  cycle: 4,
  requestTimeoutMs: 3000,
  waitMs: 250,
}

export class SpeechTurn {
  #ended = false
  #done: Promise<void>
  #resolve!: () => void
  constructor(
    readonly id: string,
    private readonly director: SpeechDirector
  ) {
    this.#done = new Promise((r) => (this.#resolve = r))
  }
  /** False when the sentence was not accepted (unspeakable text, or this turn was superseded/cancelled). */
  enqueue(item: SpeechItem): boolean {
    return this.director.enqueue(this, item)
  }
  /** No more sentences will come. */
  end(): void {
    if (this.#ended) return
    this.#ended = true
    this.director._turnEnded(this)
  }
  get ended(): boolean {
    return this.#ended
  }
  /** Resolves when every accepted sentence has been spoken, dropped or cancelled, and `end()` was called. */
  whenDone(): Promise<void> {
    return this.#done
  }
  /** @internal */
  _finish(): void {
    this.#resolve()
  }
  /** Whether at least one sentence was accepted. */
  accepted = 0
}

export class SpeechDirector extends EventEmitter<DirectorEvents> {
  private readonly o: Required<
    Pick<SpeechDirectorOptions, 'lookahead' | 'stageQueueMax' | 'ttsRetryDelayMs' | 'endGraceMs'>
  > &
    SpeechDirectorOptions
  private readonly live: LiveMotionPolicy
  private entries: Entry[] = []
  private turns = new Map<string, SpeechTurn>()
  private latestTurn: string | null = null
  private disabledTurns = new Set<string>()
  private holds = new Set<string>()
  private epoch = 0
  private seq = 0
  private counter = 0
  private sending = false
  private sentCount = 0
  private liveSlot = 0
  private unsubscribe: (() => void)[] = []
  private readonly now: () => number
  private readonly log: NonNullable<SpeechDirectorOptions['log']>

  constructor(opts: SpeechDirectorOptions) {
    super()
    this.o = { lookahead: 2, stageQueueMax: 2, ttsRetryDelayMs: 300, endGraceMs: 15_000, ...opts }
    this.live = { ...DEFAULT_LIVE, ...opts.liveMotion }
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
    this.unsubscribe.push(
      opts.reports.on('started', (id) => this.onStarted(id)),
      opts.reports.on('ended', (id, reason) => this.onEnded(id, reason)),
      opts.reports.on('disconnected', () => this.cancelAll('stage disconnected'))
    )
  }

  dispose(): void {
    for (const f of this.unsubscribe) f()
    this.unsubscribe = []
    this.cancelAll('disposed')
  }

  // ─────────────────────────────── turns ───────────────────────────────

  /**
   * Start a reply. Sentences of other replies that have not reached the stage are dropped, and those
   * that reached it but have not started are cancelled; the one being spoken finishes.
   */
  beginTurn(id: string): SpeechTurn {
    const previous = this.latestTurn
    this.latestTurn = id
    if (previous && previous !== id) {
      this.disabledTurns.add(previous)
      for (const e of [...this.entries]) {
        if (e.turn === previous && e.state !== 'playing')
          this.drop(e, 'superseded', e.state === 'sending' || e.state === 'sent')
      }
      this.checkTurnDone(previous)
    }
    const t = new SpeechTurn(id, this)
    this.turns.set(id, t)
    return t
  }

  cancelTurn(id: string): void {
    this.disabledTurns.add(id)
    for (const e of [...this.entries]) {
      if (e.turn === id)
        this.drop(
          e,
          'turn_cancelled',
          e.state === 'sending' || e.state === 'sent' || e.state === 'playing'
        )
    }
    this.checkTurnDone(id)
  }

  /** Stop everything: in-flight synthesis, queued and playing sentences. New replies still work. */
  cancelAll(reason = 'cancelled'): void {
    this.log('info', `speech: cancel all (${reason})`)
    this.epoch++
    for (const id of this.turns.keys()) this.disabledTurns.add(id)
    const atStage = this.entries.some(
      (e) => e.state === 'sending' || e.state === 'sent' || e.state === 'playing'
    )
    for (const e of [...this.entries]) this.drop(e, 'cancelled', false)
    if (atStage || this.o.stage.connected) this.o.stage.cancel('all')
    this.sentCount = 0
    for (const id of [...this.turns.keys()]) this.checkTurnDone(id)
    this.emitIdleIfEmpty()
  }

  hold(reason: string, on: boolean): void {
    if (on) this.holds.add(reason)
    else this.holds.delete(reason)
    if (!on) this.pump()
  }

  get held(): boolean {
    return this.holds.size > 0
  }

  /** Re-evaluate the pipeline after something outside changed (the stage connected, a hold ended). */
  kick(): void {
    this.pump()
  }

  /** True while any sentence is at the stage or being sent. */
  get speaking(): boolean {
    return this.entries.some(
      (e) => e.state === 'sending' || e.state === 'sent' || e.state === 'playing'
    )
  }

  /** Sentences accepted and not yet finished, wherever they are. */
  get pending(): number {
    return this.entries.length
  }

  whenIdle(): Promise<void> {
    if (this.entries.length === 0) return Promise.resolve()
    return new Promise((r) => this.once('idle', () => r()))
  }

  // ─────────────────────────────── intake ───────────────────────────────

  /** @internal called by SpeechTurn */
  enqueue(turn: SpeechTurn, item: SpeechItem): boolean {
    if (turn.id !== this.latestTurn || this.disabledTurns.has(turn.id)) return false
    const filtered = this.o.filter ? this.o.filter.apply(item.text) : item.text
    const text = cleanSpeechText(filtered)
    if (!isSpeakable(text)) return false
    // Whatever is said is shown, unless the caller gave the words itself (an empty string shows nothing). The words
    // on screen are public like the voice is: a word the voice replaces is replaced in them too.
    const shown = item.subtitle ?? item.text
    const words = this.o.filter ? this.o.filter.apply(shown) : shown
    if (words !== item.subtitle) item = { ...item, subtitle: words }
    const seq = this.seq++
    const id = `${turn.id}-${++this.counter}`
    const useLive = !item.motion && this.nextUsesLive()
    const e: Entry = {
      id,
      seq,
      turn: turn.id,
      epoch: this.epoch,
      item,
      text,
      state: 'queued',
      abort: new AbortController(),
      useLive,
      trace: { id, turn: turn.id, seq, text, enqueuedAt: this.now() },
    }
    this.entries.push(e)
    turn.accepted++
    this.pump()
    return true
  }

  /** @internal */
  _turnEnded(turn: SpeechTurn): void {
    this.checkTurnDone(turn.id)
  }

  private nextUsesLive(): boolean {
    const m = this.o.motion
    if (!m || (m.available && !m.available())) return false
    const slot = this.liveSlot++ % this.live.cycle
    return slot < this.live.generatedPerCycle
  }

  // ─────────────────────────────── pipeline ───────────────────────────────

  private pump(): void {
    // 1. start synthesis for the head of the line and the lookahead window
    let window = 0
    for (const e of this.entries) {
      if (e.state === 'ended' || e.state === 'dropped') continue
      if (e.state === 'queued' && window < this.o.lookahead + 1) void this.synthesize(e)
      if (e.state !== 'sent' && e.state !== 'playing' && e.state !== 'sending') window++
    }
    // 2. send the head of the line if it is ready
    void this.sendLoop()
  }

  private async synthesize(e: Entry): Promise<void> {
    e.state = 'synthesizing'
    e.trace.synthStartedAt = this.now()
    const epoch = e.epoch
    try {
      let stream
      try {
        stream = await this.o.tts.synthesize({
          text: e.text,
          style: e.item.style ?? 'neutral',
          speed: e.item.speed,
          signal: e.abort.signal,
        })
      } catch (err) {
        if (
          err instanceof TtsError &&
          err.retryable &&
          this.o.ttsRetryDelayMs > 0 &&
          !e.abort.signal.aborted
        ) {
          await sleep(this.o.ttsRetryDelayMs)
          if (e.abort.signal.aborted) throw err
          stream = await this.o.tts.synthesize({
            text: e.text,
            style: e.item.style ?? 'neutral',
            speed: e.item.speed,
            signal: e.abort.signal,
          })
        } else throw err
      }
      const parts: Uint8Array[] = []
      let bytes = 0
      for await (const c of stream.chunks) {
        parts.push(c)
        bytes += c.byteLength
      }
      if (this.gone(e, epoch)) return
      const pcm = new Uint8Array(bytes)
      let o = 0
      for (const p of parts) {
        pcm.set(p, o)
        o += p.byteLength
      }
      e.pcm = pcm
      e.sampleRate = stream.sampleRate
      e.trace.synthDoneAt = this.now()
      e.trace.audioSec = bytes / 2 / stream.sampleRate
      e.state = 'ready'
      if (e.useLive && this.o.motion) e.motionPromise = this.requestMotion(e)
      this.pump()
    } catch (err) {
      if (this.gone(e, epoch)) return
      this.log('warn', `speech: synthesis failed, sentence dropped: ${(err as Error).message}`)
      this.emit('failed', e.id, err as Error, e.text)
      this.finish(e, 'dropped')
      this.pump()
    }
  }

  private requestMotion(e: Entry): Promise<Uint8Array | null> {
    const m = this.o.motion as MotionAdapter
    const ctl = new AbortController()
    e.abort.signal.addEventListener('abort', () => ctl.abort(), { once: true })
    const timer = setTimeout(() => ctl.abort(), this.live.requestTimeoutMs)
    return m
      .generate({ pcm16: e.pcm as Uint8Array, sampleRate: e.sampleRate as number }, ctl.signal)
      .then(
        (v) => v,
        () => null
      )
      .finally(() => clearTimeout(timer))
  }

  private async sendLoop(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      for (;;) {
        const head = this.entries.find(
          (e) =>
            e.state !== 'ended' &&
            e.state !== 'dropped' &&
            e.state !== 'sent' &&
            e.state !== 'playing'
        )
        if (!head || head.state !== 'ready') return
        if (this.held || !this.o.stage.connected) return
        if (this.sentCount >= this.o.stageQueueMax) return
        await this.send(head)
      }
    } finally {
      this.sending = false
    }
  }

  private async send(e: Entry): Promise<void> {
    const epoch = e.epoch
    e.state = 'sending'
    let vrma: Uint8Array | undefined
    if (e.motionPromise) {
      const first = await Promise.race([
        e.motionPromise,
        sleep(this.live.waitMs).then(() => 'late' as const),
      ])
      if (first === 'late') e.trace.liveMotion = 'late'
      else if (first) {
        vrma = first
        e.trace.liveMotion = 'used'
      } else e.trace.liveMotion = 'failed'
      if (this.gone(e, epoch)) return
    } else e.trace.liveMotion = 'skipped'
    this.sentCount++
    e.trace.sentAt = this.now()
    try {
      const r = await this.o.stage.beginUtterance(
        {
          utterance_id: e.id,
          seq: e.seq,
          turn_id: e.turn,
          emotion: e.item.emotion,
          motion: e.item.motion ?? null,
          live_motion: !!vrma,
          audio: {
            sample_rate: e.sampleRate as number,
            total_samples: (e.pcm as Uint8Array).byteLength / 2,
          },
          ...(e.item.subtitle ? { subtitle: e.item.subtitle } : {}),
        },
        { pcm16: e.pcm as Uint8Array, ...(vrma ? { vrma } : {}) }
      )
      if (this.gone(e, epoch)) return
      if (r.cancelled) {
        // the stage side gave up on it (it was cancelled while its frames were being written)
        this.sentCount = Math.max(0, this.sentCount - 1)
        this.finish(e, 'dropped')
        return
      }
      e.state = 'sent'
      e.pcm = undefined // the stage has it now
      e.motionPromise = undefined
      const guard = (e.trace.audioSec ?? 0) * 1000 + this.o.endGraceMs + this.backlogMs(e)
      e.endTimer = setTimeout(() => this.onEnded(e.id, 'timeout'), guard)
      e.endTimer.unref?.()
    } catch (err) {
      this.log('warn', `speech: could not send a sentence to the stage: ${(err as Error).message}`)
      this.sentCount = Math.max(0, this.sentCount - 1)
      this.emit('failed', e.id, err as Error, e.text)
      this.finish(e, 'dropped')
    }
  }

  /** Audio queued at the stage ahead of `self`, so its end guard is not shorter than the wait in the line. */
  private backlogMs(self: Entry): number {
    let ms = 0
    for (const x of this.entries) {
      if (x !== self && (x.state === 'sent' || x.state === 'playing'))
        ms += (x.trace.audioSec ?? 0) * 1000
    }
    return ms
  }

  // ─────────────────────────────── stage reports ───────────────────────────────

  private onStarted(id: string): void {
    const e = this.entries.find((x) => x.id === id)
    if (!e || e.state === 'ended' || e.state === 'dropped') return
    e.state = 'playing'
    e.trace.startedAt = this.now()
    this.emit('started', id, e.trace)
  }

  private onEnded(id: string, reason: EndReason): void {
    const e = this.entries.find((x) => x.id === id)
    if (!e || e.state === 'ended' || e.state === 'dropped') return
    if (e.endTimer) clearTimeout(e.endTimer)
    if (e.state === 'sent' || e.state === 'playing' || e.state === 'sending')
      this.sentCount = Math.max(0, this.sentCount - 1)
    e.trace.endedAt = this.now()
    this.emit('ended', id, reason, e.trace)
    this.emit('trace', e.trace)
    this.finish(e, 'ended')
    this.pump()
  }

  // ─────────────────────────────── bookkeeping ───────────────────────────────

  /** The entry was dropped or its epoch is over while something asynchronous was running. */
  private gone(e: Entry, epoch: number): boolean {
    return e.state === 'dropped' || e.state === 'ended' || e.epoch !== epoch
  }

  private drop(
    e: Entry,
    why: 'superseded' | 'cancelled' | 'turn_cancelled',
    cancelAtStage: boolean
  ): void {
    if (e.state === 'ended' || e.state === 'dropped') return
    const atStage = e.state === 'sending' || e.state === 'sent' || e.state === 'playing'
    e.abort.abort()
    if (atStage) this.sentCount = Math.max(0, this.sentCount - 1)
    if (cancelAtStage && atStage && why !== 'cancelled') this.o.stage.cancel('utterance', e.id)
    this.emit('dropped', e.id, why)
    this.finish(e, 'dropped')
  }

  private finish(e: Entry, state: 'ended' | 'dropped'): void {
    if (e.endTimer) clearTimeout(e.endTimer)
    e.state = state
    e.pcm = undefined
    e.motionPromise = undefined
    this.entries = this.entries.filter((x) => x !== e)
    this.checkTurnDone(e.turn)
    this.emitIdleIfEmpty()
  }

  private checkTurnDone(id: string): void {
    const t = this.turns.get(id)
    // A cancelled or superseded turn is finished once its sentences are gone, whether or not the caller
    // ever calls end(): nobody may wait forever on a reply that was stopped.
    if (!t || (!t.ended && !this.disabledTurns.has(id))) return
    if (this.entries.some((e) => e.turn === id)) return
    this.turns.delete(id)
    t._finish()
    this.emit('turnDone', id)
  }

  private emitIdleIfEmpty(): void {
    if (this.entries.length === 0) this.emit('idle')
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
