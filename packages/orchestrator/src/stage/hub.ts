/**
 * The orchestrator side of the stage protocol (see docs/protocol.md).
 *
 * The hub owns exactly one live stage connection, the snapshots that are re-sent on every
 * (re)connect, command delivery (including binary audio / VRMA streaming with back-pressure) and
 * the closed set of upstream reports. A misbehaving stage can only ever get itself disconnected:
 * every handler is wrapped, invalid frames are dropped and counted, and no listener exception or
 * unhandled 'error' event can take the process down.
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { RawData, WebSocket } from 'ws'
import type { z } from 'zod'
import {
  LibrarySet,
  LookSet,
  OverlayId,
  OverlaySet,
  PROTOCOL_VERSION,
  SceneSet,
  StageDownstream,
  TuningSet,
  UtteranceBegin,
  chunkPcm16,
  encodeVrmaFrame,
  parseUpstream,
} from '@animatus/protocol'
import type { StageDownstreamInput, StageUpstream } from '@animatus/protocol'
import { noopLogger } from './logger.ts'
import type { Logger } from './logger.ts'
import { errorMessage, sleep, yieldToEventLoop } from './util.ts'

// ───────────────────────────── types ─────────────────────────────

/** One upstream report by its `type` tag. */
export type Report<T extends StageUpstream['type']> = Extract<StageUpstream, { type: T }>

export type SceneSetInput = z.input<typeof SceneSet>
export type LibrarySetInput = z.input<typeof LibrarySet>
export type LookSetInput = z.input<typeof LookSet>
export type TuningSetInput = z.input<typeof TuningSet>
export type OverlaySetInput = z.input<typeof OverlaySet>
type SceneSetOutput = z.output<typeof SceneSet>
type LibrarySetOutput = z.output<typeof LibrarySet>
type LookSetOutput = z.output<typeof LookSet>
type TuningSetOutput = z.output<typeof TuningSet>
type OverlaySetOutput = z.output<typeof OverlaySet>

/** Latest information the stage reported. Cleared when a new stage session starts. */
export interface StageState {
  connected: boolean
  sessionId?: string
  hello?: Report<'hello'>
  model?: Report<'model.state'>
  audio?: Report<'audio.state'>
  stats?: Report<'stats'>
  dance?: Report<'dance.state'>
  sing?: Report<'sing.state'>
  sleep?: Report<'sleep.state'>
  /** `now()` of the last valid upstream report; 0 when none yet. */
  lastReportAt: number
}

export interface StageConnectionInfo {
  sessionId: string
  hello: Report<'hello'>
}

export interface StageDisconnectInfo {
  sessionId: string
  code: number
  reason: string
  /** True when a newer stage took over this session. */
  replaced: boolean
}

export type StageHubEvents = {
  /** Every valid upstream frame, including the ones that also have a typed event below. */
  report: [msg: StageUpstream]
  hello: [msg: Report<'hello'>]
  'playback.started': [msg: Report<'playback.started'>]
  'playback.ended': [msg: Report<'playback.ended'>]
  'dance.state': [msg: Report<'dance.state'>]
  'sing.state': [msg: Report<'sing.state'>]
  'sleep.state': [msg: Report<'sleep.state'>]
  stats: [msg: Report<'stats'>]
  'model.state': [msg: Report<'model.state'>]
  'audio.state': [msg: Report<'audio.state'>]
  'debug.reply': [msg: Report<'debug.reply'>]
  /** The stage reported an `error` frame (not to be confused with the hub's own 'error' event). */
  'stage.error': [msg: Report<'error'>]
  connected: [info: StageConnectionInfo]
  disconnected: [info: StageDisconnectInfo]
  /** Hub-side failures worth surfacing (for example an utterance aborted by back-pressure). */
  error: [err: Error]
}

export interface BackpressureOptions {
  /** Wait while `ws.bufferedAmount` is above this many bytes before each binary frame. */
  highWaterBytes: number
  /** Give up (abort the utterance, emit 'error') after waiting this long for the buffer to drain. */
  timeoutMs: number
  pollMs: number
}

export interface StageHubOptions {
  logger?: Logger
  /** Value of `welcome.dev`. */
  dev?: boolean
  /** Initial `welcome.epoch`. */
  epoch?: number
  /** Clock in ms (injectable for tests). */
  now?: () => number
  /** Application-level `ping` interval. Default 10 s. */
  pingIntervalMs?: number
  /** Terminate the socket when nothing at all arrived for this long. Default 30 s. */
  deadAfterMs?: number
  /** Close a socket that has not sent a valid hello within this time. Default 10 s. */
  helloTimeoutMs?: number
  /** Invalid frames tolerated inside `invalidFrameWindowMs` before the socket is closed (1008). Default 20. */
  invalidFrameLimit?: number
  /** Default 60 s. */
  invalidFrameWindowMs?: number
  backpressure?: Partial<BackpressureOptions>
}

export type StageSendErrorCode = 'no_stage' | 'disconnected' | 'backpressure' | 'invalid'

export class StageSendError extends Error {
  readonly code: StageSendErrorCode
  constructor(code: StageSendErrorCode, message: string) {
    super(message)
    this.name = 'StageSendError'
    this.code = code
  }
}

export type StageWaitFailure = 'timeout' | 'aborted' | 'disconnected'

/** Why `waitFor` gave up: it timed out, its signal aborted, or (with `rejectOnDisconnect`) the stage left. */
export class StageWaitError extends Error {
  readonly reason: StageWaitFailure
  constructor(reason: StageWaitFailure, message: string) {
    super(message)
    this.name = 'StageWaitError'
    this.reason = reason
  }
}

/** `utterance.begin` as the caller writes it: `handle` is allocated when missing, `live_motion` is derived. */
export type UtteranceBeginArgs = Omit<
  z.input<typeof UtteranceBegin>,
  'type' | 'handle' | 'audio' | 'live_motion'
> & {
  type?: 'utterance.begin'
  handle?: number
  /** Derived from `media.vrma`; when given it must agree with it. */
  live_motion?: boolean
  audio: { sample_rate: number; total_samples?: number; codec?: 'pcm16'; channels?: 1 }
}

export interface UtteranceMedia {
  /** Little-endian mono PCM16 (even byte length). Missing means an utterance without audio. */
  pcm16?: Uint8Array
  /** A complete .vrma file, streamed before the audio. */
  vrma?: Uint8Array
  /** Audio frame payload size in bytes. Default 9600 (about 150 ms at 32 kHz). */
  chunkBytes?: number
}

export interface UtteranceSendResult {
  handle: number
  utteranceId: string
  frames: number
  bytes: number
  /** True when `cancelUtterance` / `cancelAll` stopped the stream before it was complete. */
  cancelled: boolean
}

export interface WaitForOptions {
  /** Default 30 s. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Reject as soon as the stage disconnects instead of waiting for the timeout. */
  rejectOnDisconnect?: boolean
}

// ───────────────────────────── internals ─────────────────────────────

const OPEN = 1
const VRMA_CHUNK_BYTES = 256 * 1024
export const DEFAULT_AUDIO_CHUNK_BYTES = 9600
const YIELD_EVERY_FRAMES = 16
const CLOSE_FALLBACK_MS = 3000
const EMPTY = new Uint8Array(0)

type ConnPhase = 'awaiting_hello' | 'ready' | 'closing' | 'closed'

interface Conn {
  id: number
  ws: WebSocket
  remote: string
  phase: ConnPhase
  sessionId: string | null
  helloTimer: NodeJS.Timeout | null
  heartbeat: NodeJS.Timeout | null
  closeTimer: NodeJS.Timeout | null
  lastRxAt: number
  invalidAt: number[]
  localCloseReason: string | null
}

interface Pump {
  handle: number
  utteranceId: string
  conn: Conn
  cancelled: boolean
  sinceYield: number
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/** WebSocket close reasons are limited to 123 bytes. */
const closeReason = (reason: string) => reason.slice(0, 120)

// ───────────────────────────── the hub ─────────────────────────────

export class StageHub extends EventEmitter<StageHubEvents> {
  readonly state: StageState = { connected: false, lastReportAt: 0 }
  readonly counters = {
    connections: 0,
    replaced: 0,
    reportsIn: 0,
    invalidFramesIn: 0,
    binaryFramesIn: 0,
  }

  private readonly log: Logger
  private readonly dev: boolean
  private readonly now: () => number
  private readonly pingIntervalMs: number
  private readonly deadAfterMs: number
  private readonly helloTimeoutMs: number
  private readonly invalidLimit: number
  private readonly invalidWindowMs: number
  private readonly bp: BackpressureOptions

  private epochValue: number
  private handleCounter = 0
  private connSeq = 0
  private active: Conn | null = null
  private readonly conns = new Set<Conn>()
  private readonly pumps = new Map<number, Pump>()
  private readonly snap: {
    scene?: SceneSetOutput
    library?: LibrarySetOutput
    look?: LookSetOutput
    tuning?: TuningSetOutput
    overlays: Map<OverlayId, OverlaySetOutput>
  } = { overlays: new Map() }

  constructor(options: StageHubOptions = {}) {
    // Rejections of async listeners are routed to the handler below instead of crashing the process.
    super({ captureRejections: true })
    this.log = options.logger ?? noopLogger
    this.dev = options.dev ?? false
    this.epochValue = options.epoch ?? 0
    this.now = options.now ?? Date.now
    this.pingIntervalMs = options.pingIntervalMs ?? 10_000
    this.deadAfterMs = options.deadAfterMs ?? 30_000
    this.helloTimeoutMs = options.helloTimeoutMs ?? 10_000
    this.invalidLimit = options.invalidFrameLimit ?? 20
    this.invalidWindowMs = options.invalidFrameWindowMs ?? 60_000
    this.bp = {
      highWaterBytes: options.backpressure?.highWaterBytes ?? 1024 * 1024,
      timeoutMs: options.backpressure?.timeoutMs ?? 5000,
      pollMs: options.backpressure?.pollMs ?? 10,
    }
    this.setMaxListeners(64)
  }

  override [EventEmitter.captureRejectionSymbol](
    err: Error,
    event: unknown,
    ..._args: unknown[]
  ): void {
    this.log('error', `an async listener of '${String(event)}' rejected`, { err })
  }

  // ─────────── public state ───────────

  get connected(): boolean {
    return this.state.connected
  }

  get epoch(): number {
    return this.epochValue
  }

  /** Call when the orchestrator hard-resets playback; the new value goes out with the next `welcome`. */
  bumpEpoch(): number {
    return ++this.epochValue
  }

  /** A copy of the stored snapshots (what a newly connecting stage would receive). */
  get snapshots(): {
    scene?: SceneSetOutput
    library?: LibrarySetOutput
    look?: LookSetOutput
    tuning?: TuningSetOutput
    overlays: OverlaySetOutput[]
  } {
    return {
      scene: this.snap.scene,
      library: this.snap.library,
      look: this.snap.look,
      tuning: this.snap.tuning,
      overlays: [...this.snap.overlays.values()],
    }
  }

  /** Next binary-frame handle: increasing u32 values starting at 1, wrapping back to 1 after 2^32 - 1. */
  nextHandle(): number {
    this.handleCounter = this.handleCounter >= 0xffffffff ? 1 : this.handleCounter + 1
    return this.handleCounter
  }

  // ─────────── snapshots ───────────

  setScene(msg: SceneSetInput): SceneSetOutput {
    const parsed = SceneSet.parse(msg)
    this.snap.scene = parsed
    this.deliver(parsed)
    return parsed
  }

  setLibrary(msg: LibrarySetInput): LibrarySetOutput {
    const parsed = LibrarySet.parse(msg)
    this.snap.library = parsed
    this.deliver(parsed)
    return parsed
  }

  setLook(msg: LookSetInput): LookSetOutput {
    const parsed = LookSet.parse(msg)
    this.snap.look = parsed
    this.deliver(parsed)
    return parsed
  }

  setTuning(msg: TuningSetInput): TuningSetOutput {
    const parsed = TuningSet.parse(msg)
    this.snap.tuning = parsed
    this.deliver(parsed)
    return parsed
  }

  setOverlay(msg: OverlaySetInput): OverlaySetOutput {
    const parsed = OverlaySet.parse(msg)
    this.snap.overlays.set(parsed.id, parsed)
    this.deliver(parsed)
    return parsed
  }

  // ─────────── commands ───────────

  /**
   * Validates `msg` against `StageDownstream` (throws a ZodError when invalid) and sends it. Snapshot
   * types are routed through the snapshot store so they survive a stage reload. Returns true when a
   * connected stage received the frame, false when there is no stage.
   */
  send(msg: StageDownstreamInput): boolean {
    const parsed = StageDownstream.parse(msg)
    switch (parsed.type) {
      case 'welcome':
        throw new Error(
          "'welcome' is sent by the hub during the handshake and cannot be sent manually"
        )
      case 'scene.set':
        this.setScene(parsed)
        return this.isStageReady()
      case 'library.set':
        this.setLibrary(parsed)
        return this.isStageReady()
      case 'look.set':
        this.setLook(parsed)
        return this.isStageReady()
      case 'tuning.set':
        this.setTuning(parsed)
        return this.isStageReady()
      case 'overlay.set':
        this.setOverlay(parsed)
        return this.isStageReady()
      default:
        return this.deliver(parsed)
    }
  }

  /**
   * Sends `utterance.begin`, then the VRMA stream (kind 2, at most 256 KiB per frame) when given, then
   * the PCM16 audio (kind 1) as chunks of `chunkBytes`, the last one flagged. Before every binary frame
   * it waits while the socket's send buffer is above the high-water mark; if that lasts longer than
   * the timeout the utterance is aborted (the stage is told to cancel it, an 'error' event is emitted
   * and the promise rejects with a StageSendError of code 'backpressure').
   *
   * Resolves when everything has been handed to the socket, or early with `cancelled: true` after
   * `cancelUtterance` / `cancelAll`. Rejects with a ZodError for an invalid message and with a
   * StageSendError for no stage / disconnect / back-pressure / bad media.
   */
  async beginUtterance(
    args: UtteranceBeginArgs,
    media: UtteranceMedia = {}
  ): Promise<UtteranceSendResult> {
    const conn = this.active
    if (!conn || conn.phase !== 'ready')
      throw new StageSendError('no_stage', 'no stage is connected')

    const pcm = media.pcm16 ?? EMPTY
    const vrma = media.vrma
    if (pcm.byteLength % 2 !== 0) {
      throw new StageSendError(
        'invalid',
        `pcm16 must have an even byte length, got ${pcm.byteLength}`
      )
    }
    if (vrma !== undefined && vrma.byteLength === 0)
      throw new StageSendError('invalid', 'vrma is empty')
    if (args.live_motion !== undefined && args.live_motion !== (vrma !== undefined)) {
      throw new StageSendError(
        'invalid',
        'live_motion must be true exactly when a vrma stream is provided'
      )
    }
    const chunkBytes = media.chunkBytes ?? DEFAULT_AUDIO_CHUNK_BYTES
    if (!Number.isInteger(chunkBytes) || chunkBytes < 2) {
      throw new StageSendError('invalid', `chunkBytes must be an integer >= 2, got ${chunkBytes}`)
    }

    const handle = args.handle ?? this.nextHandle()
    const begin = UtteranceBegin.parse({
      ...args,
      type: 'utterance.begin',
      handle,
      live_motion: vrma !== undefined,
      audio: {
        codec: 'pcm16',
        channels: 1,
        sample_rate: args.audio.sample_rate,
        total_samples: args.audio.total_samples ?? pcm.byteLength / 2,
      },
    })

    const pump: Pump = {
      handle,
      utteranceId: begin.utterance_id,
      conn,
      cancelled: false,
      sinceYield: 0,
    }
    this.pumps.set(handle, pump)
    let frames = 0
    let bytes = 0
    const result = (cancelled: boolean): UtteranceSendResult => ({
      handle,
      utteranceId: begin.utterance_id,
      frames,
      bytes,
      cancelled,
    })
    try {
      this.sendJsonOrThrow(conn, begin)

      if (vrma) {
        for (
          let offset = 0, index = 0;
          offset < vrma.byteLength;
          offset += VRMA_CHUNK_BYTES, index++
        ) {
          const end = Math.min(offset + VRMA_CHUNK_BYTES, vrma.byteLength)
          const frame = encodeVrmaFrame(
            handle,
            index,
            vrma.subarray(offset, end),
            end >= vrma.byteLength
          )
          if (!(await this.sendFrame(pump, frame))) return result(true)
          frames++
          bytes += frame.byteLength
        }
      }
      for (const frame of chunkPcm16(handle, pcm, chunkBytes)) {
        if (!(await this.sendFrame(pump, frame))) return result(true)
        frames++
        bytes += frame.byteLength
      }
      return result(false)
    } catch (err) {
      if (err instanceof StageSendError && err.code === 'backpressure') {
        this.log('error', 'utterance aborted', {
          utterance: begin.utterance_id,
          handle,
          reason: err.message,
        })
        // Tell the stage to drop what it has so it does not wait for a stream that will not finish.
        this.deliver(
          StageDownstream.parse({
            type: 'utterance.cancel',
            scope: 'utterance',
            utterance_id: begin.utterance_id,
          })
        )
        this.emitError(err)
      }
      throw err
    } finally {
      this.pumps.delete(handle)
    }
  }

  /** Cancels one utterance: stops streaming it (if still in flight) and tells the stage. */
  cancelUtterance(utteranceId: string, opts: { fadeMs?: number } = {}): boolean {
    for (const pump of this.pumps.values())
      if (pump.utteranceId === utteranceId) pump.cancelled = true
    return this.send({
      type: 'utterance.cancel',
      scope: 'utterance',
      utterance_id: utteranceId,
      ...(opts.fadeMs !== undefined ? { fade_ms: opts.fadeMs } : {}),
    })
  }

  /** Cancels everything in flight and everything the stage is playing or has queued. */
  cancelAll(opts: { fadeMs?: number } = {}): boolean {
    for (const pump of this.pumps.values()) pump.cancelled = true
    return this.send({
      type: 'utterance.cancel',
      scope: 'all',
      ...(opts.fadeMs !== undefined ? { fade_ms: opts.fadeMs } : {}),
    })
  }

  // ─────────── waiting ───────────

  /**
   * Resolves with the next upstream report that has the given `type` or satisfies the predicate.
   * Only reports that arrive after the call are considered (see `waitForConnected` for hello).
   */
  waitFor<T extends StageUpstream['type']>(type: T, opts?: WaitForOptions): Promise<Report<T>>
  waitFor<R extends StageUpstream>(
    predicate: (report: StageUpstream) => report is R,
    opts?: WaitForOptions
  ): Promise<R>
  waitFor(
    predicate: (report: StageUpstream) => boolean,
    opts?: WaitForOptions
  ): Promise<StageUpstream>
  waitFor(
    match: StageUpstream['type'] | ((report: StageUpstream) => boolean),
    opts: WaitForOptions = {}
  ): Promise<StageUpstream> {
    const test = typeof match === 'string' ? (r: StageUpstream) => r.type === match : match
    const what = typeof match === 'string' ? `a '${match}' report` : 'a matching report'
    const timeoutMs = opts.timeoutMs ?? 30_000
    return new Promise<StageUpstream>((resolve, reject) => {
      if (opts.signal?.aborted)
        return reject(new StageWaitError('aborted', `waiting for ${what} was aborted`))
      let timer: NodeJS.Timeout | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this.off('report', onReport)
        this.off('disconnected', onDisconnected)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const settle = (fn: () => void) => {
        cleanup()
        fn()
      }
      const onReport = (report: StageUpstream) => {
        let hit = false
        try {
          hit = test(report)
        } catch (err) {
          return settle(() => reject(err))
        }
        if (hit) settle(() => resolve(report))
      }
      const onDisconnected = () => {
        if (opts.rejectOnDisconnect) {
          settle(() =>
            reject(
              new StageWaitError('disconnected', `the stage disconnected while waiting for ${what}`)
            )
          )
        }
      }
      const onAbort = () =>
        settle(() => reject(new StageWaitError('aborted', `waiting for ${what} was aborted`)))
      timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new StageWaitError('timeout', `timed out after ${timeoutMs} ms waiting for ${what}`)
            )
          ),
        timeoutMs
      )
      this.on('report', onReport)
      this.on('disconnected', onDisconnected)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Resolves with the current hello when a stage is connected, otherwise with the next one. */
  waitForConnected(
    opts: Omit<WaitForOptions, 'rejectOnDisconnect'> = {}
  ): Promise<Report<'hello'>> {
    const { hello } = this.state
    if (this.state.connected && hello) return Promise.resolve(hello)
    return this.waitFor('hello', opts)
  }

  // ─────────── connections ───────────

  /**
   * Takes over one accepted stage WebSocket. The first message must be a valid `hello` for this
   * protocol version (otherwise an `error` frame is sent and the socket is closed with 1008). A newer
   * stage replaces the current one once its hello is accepted.
   */
  attach(ws: WebSocket, info: { remoteAddress?: string } = {}): void {
    if (ws.readyState !== OPEN) {
      this.log('warn', 'attach() was given a socket that is not open')
      return
    }
    const conn: Conn = {
      id: ++this.connSeq,
      ws,
      remote: info.remoteAddress ?? 'unknown',
      phase: 'awaiting_hello',
      sessionId: null,
      helloTimer: null,
      heartbeat: null,
      closeTimer: null,
      lastRxAt: this.now(),
      invalidAt: [],
      localCloseReason: null,
    }
    this.conns.add(conn)
    this.counters.connections++
    ws.on('message', (data, isBinary) =>
      this.guard('message', () => this.onMessage(conn, data, isBinary))
    )
    ws.on('close', (code, reason) =>
      this.guard('close', () => this.onSocketClosed(conn, code, reason.toString('utf8')))
    )
    ws.on('error', (err) => this.log('warn', 'stage socket error', { conn: conn.id, err }))
    conn.helloTimer = setTimeout(
      () =>
        this.guard('hello timeout', () => {
          if (conn.phase === 'awaiting_hello') {
            this.reject(conn, 'hello_timeout', `no hello within ${this.helloTimeoutMs} ms`)
          }
        }),
      this.helloTimeoutMs
    )
    conn.helloTimer.unref()
  }

  /** Closes every socket (default 1001) and stops in-flight utterance streams. Safe to call twice. */
  close(code = 1001, reason = 'orchestrator shutting down'): void {
    for (const pump of this.pumps.values()) pump.cancelled = true
    for (const conn of [...this.conns]) this.closeConn(conn, code, reason)
  }

  // ─────────── upstream ───────────

  private onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.phase === 'closing' || conn.phase === 'closed') return
    conn.lastRxAt = this.now()

    if (conn.phase === 'awaiting_hello') {
      const first = isBinary ? null : parseUpstream(rawToString(data))
      if (!first || first.type !== 'hello') {
        return this.reject(conn, 'bad_hello', 'the first message must be a valid hello')
      }
      if (first.protocol !== PROTOCOL_VERSION) {
        return this.reject(
          conn,
          'protocol_mismatch',
          `unsupported protocol version ${first.protocol}; this orchestrator speaks ${PROTOCOL_VERSION}`
        )
      }
      return this.acceptHello(conn, first)
    }

    if (isBinary) {
      this.counters.binaryFramesIn++
      return this.noteInvalid(conn, 'binary frame from the stage')
    }
    const msg = parseUpstream(rawToString(data))
    if (!msg) {
      this.counters.invalidFramesIn++
      return this.noteInvalid(conn, 'invalid frame or not a report')
    }
    this.handleReport(msg)
  }

  private noteInvalid(conn: Conn, what: string): void {
    const t = this.now()
    conn.invalidAt.push(t)
    const cutoff = t - this.invalidWindowMs
    while (conn.invalidAt.length > 0 && (conn.invalidAt.at(0) ?? t) <= cutoff)
      conn.invalidAt.shift()
    if (conn.invalidAt.length <= 3) {
      this.log('warn', `dropped a frame from the stage: ${what}`, {
        conn: conn.id,
        inWindow: conn.invalidAt.length,
      })
    }
    if (conn.invalidAt.length >= this.invalidLimit) {
      this.log('warn', 'closing the stage socket: too many invalid frames', {
        conn: conn.id,
        limit: this.invalidLimit,
        windowMs: this.invalidWindowMs,
      })
      this.closeConn(conn, 1008, 'too many invalid frames')
    }
  }

  private handleReport(msg: StageUpstream): void {
    this.counters.reportsIn++
    const s = this.state
    s.lastReportAt = this.now()
    switch (msg.type) {
      case 'hello':
        s.hello = msg // a repeated hello on a live session just refreshes it
        break
      case 'model.state':
        s.model = msg
        break
      case 'audio.state':
        s.audio = msg
        break
      case 'stats':
        s.stats = msg
        break
      case 'dance.state':
        s.dance = msg
        break
      case 'sing.state':
        s.sing = msg
        break
      case 'sleep.state':
        s.sleep = msg
        break
      case 'error':
        this.log('warn', 'the stage reported an error', { code: msg.code, message: msg.message })
        break
      default:
        break
    }
    this.dispatch(msg)
  }

  private dispatch(msg: StageUpstream): void {
    this.safeEmit('report', msg)
    switch (msg.type) {
      case 'hello':
        this.safeEmit('hello', msg)
        break
      case 'playback.started':
        this.safeEmit('playback.started', msg)
        break
      case 'playback.ended':
        this.safeEmit('playback.ended', msg)
        break
      case 'dance.state':
        this.safeEmit('dance.state', msg)
        break
      case 'sing.state':
        this.safeEmit('sing.state', msg)
        break
      case 'sleep.state':
        this.safeEmit('sleep.state', msg)
        break
      case 'stats':
        this.safeEmit('stats', msg)
        break
      case 'model.state':
        this.safeEmit('model.state', msg)
        break
      case 'audio.state':
        this.safeEmit('audio.state', msg)
        break
      case 'debug.reply':
        this.safeEmit('debug.reply', msg)
        break
      case 'error':
        this.safeEmit('stage.error', msg)
        break
      case 'pong':
        break
    }
  }

  // ─────────── handshake ───────────

  private acceptHello(conn: Conn, hello: Report<'hello'>): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer)
    conn.helloTimer = null

    const previous = this.active
    if (previous && previous !== conn) {
      this.counters.replaced++
      this.log('info', 'a new stage connected; closing the previous one', {
        previous: previous.id,
        next: conn.id,
      })
      this.closeConn(previous, 1000, 'replaced', true)
    }

    conn.phase = 'ready'
    conn.sessionId = randomUUID()
    this.active = conn
    const s = this.state
    s.connected = true
    s.sessionId = conn.sessionId
    s.hello = hello
    s.model = undefined
    s.audio = undefined
    s.stats = undefined
    s.dance = undefined
    s.sing = undefined
    s.sleep = undefined
    s.lastReportAt = this.now()

    this.log('info', 'stage connected', {
      conn: conn.id,
      remote: conn.remote,
      stage: hello.stage_id,
      ua: hello.ua,
    })
    this.sendJson(
      conn,
      StageDownstream.parse({
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        session_id: conn.sessionId,
        epoch: this.epochValue,
        server_time_ms: this.now(),
        dev: this.dev,
      })
    )
    this.sendSnapshots(conn)
    this.startHeartbeat(conn)

    this.counters.reportsIn++
    this.dispatch(hello)
    this.safeEmit('connected', { sessionId: conn.sessionId, hello })
  }

  private sendSnapshots(conn: Conn): void {
    const { scene, library, look, tuning, overlays } = this.snap
    if (scene) this.sendJson(conn, scene)
    if (library) this.sendJson(conn, library)
    if (look) this.sendJson(conn, look)
    if (tuning) this.sendJson(conn, tuning)
    for (const id of OverlayId.options) {
      const overlay = overlays.get(id)
      if (overlay) this.sendJson(conn, overlay)
    }
  }

  private reject(conn: Conn, code: string, message: string): void {
    this.log('warn', 'rejecting a stage connection', { conn: conn.id, code, message })
    // `error` is not part of StageDownstream (the closed set of orchestrator commands); it is a courtesy
    // frame for humans reading the socket, the close reason carries the same information.
    this.sendJson(conn, { type: 'error', code, message })
    this.closeConn(conn, 1008, message)
  }

  // ─────────── liveness ───────────

  private startHeartbeat(conn: Conn): void {
    conn.heartbeat = setInterval(
      () =>
        this.guard('heartbeat', () => {
          if (conn.phase !== 'ready') return
          const silentMs = this.now() - conn.lastRxAt
          if (silentMs > this.deadAfterMs) {
            this.log('warn', 'stage heartbeat timed out; terminating the socket', {
              conn: conn.id,
              silentMs,
            })
            conn.localCloseReason = 'heartbeat timeout'
            conn.ws.terminate()
            return
          }
          this.sendJson(conn, { type: 'ping', t: this.now() })
        }),
      this.pingIntervalMs
    )
    conn.heartbeat.unref()
  }

  // ─────────── closing ───────────

  /**
   * Local close: stop using the socket immediately, tell listeners once ('disconnected'), and let the
   * close handshake finish in the background (terminate after a short grace period).
   */
  private closeConn(conn: Conn, code: number, reason: string, replaced = false): void {
    if (conn.phase === 'closing' || conn.phase === 'closed') return
    const wasReady = conn.phase === 'ready'
    conn.phase = 'closing'
    conn.localCloseReason = reason
    this.clearTimers(conn)
    if (this.active === conn) {
      this.active = null
      this.state.connected = false
    }
    try {
      conn.ws.close(code, closeReason(reason))
    } catch (err) {
      this.log('warn', 'close() failed; terminating the socket', { conn: conn.id, err })
      this.safely(() => conn.ws.terminate())
    }
    conn.closeTimer = setTimeout(() => this.safely(() => conn.ws.terminate()), CLOSE_FALLBACK_MS)
    conn.closeTimer.unref()
    if (wasReady && conn.sessionId) {
      this.safeEmit('disconnected', { sessionId: conn.sessionId, code, reason, replaced })
    }
  }

  private onSocketClosed(conn: Conn, code: number, reason: string): void {
    if (conn.phase === 'closed') return
    const wasReady = conn.phase === 'ready'
    conn.phase = 'closed'
    this.clearTimers(conn)
    this.conns.delete(conn)
    if (this.active === conn) {
      this.active = null
      this.state.connected = false
    }
    if (wasReady && conn.sessionId) {
      this.log('info', 'stage disconnected', {
        conn: conn.id,
        code,
        reason: conn.localCloseReason ?? reason,
      })
      this.safeEmit('disconnected', {
        sessionId: conn.sessionId,
        code,
        reason: conn.localCloseReason ?? reason,
        replaced: false,
      })
    }
  }

  private clearTimers(conn: Conn): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer)
    if (conn.heartbeat) clearInterval(conn.heartbeat)
    conn.helloTimer = null
    conn.heartbeat = null
    if (conn.phase === 'closed' && conn.closeTimer) {
      clearTimeout(conn.closeTimer)
      conn.closeTimer = null
    }
  }

  // ─────────── sending ───────────

  private isStageReady(): boolean {
    return this.active !== null && this.active.phase === 'ready'
  }

  /** Sends an already validated downstream frame to the connected stage, if any. */
  private deliver(msg: object): boolean {
    const conn = this.active
    if (!conn || conn.phase !== 'ready') return false
    return this.sendJson(conn, msg)
  }

  private sendJson(conn: Conn, msg: object): boolean {
    if (conn.ws.readyState !== OPEN) return false
    try {
      conn.ws.send(JSON.stringify(msg), (err) => {
        if (err) this.log('warn', 'sending a frame to the stage failed', { conn: conn.id, err })
      })
      return true
    } catch (err) {
      this.log('warn', 'sending a frame to the stage threw', { conn: conn.id, err })
      return false
    }
  }

  private sendJsonOrThrow(conn: Conn, msg: object): void {
    if (conn.phase !== 'ready' || !this.sendJson(conn, msg)) {
      throw new StageSendError(
        'disconnected',
        'the stage disconnected before the utterance could be sent'
      )
    }
  }

  /**
   * Sends one binary frame of a pump after honouring back-pressure and cancellation.
   * Returns false when the utterance was cancelled meanwhile (nothing was sent).
   */
  private async sendFrame(pump: Pump, frame: Uint8Array): Promise<boolean> {
    if (++pump.sinceYield >= YIELD_EVERY_FRAMES) {
      pump.sinceYield = 0
      await yieldToEventLoop()
    }
    const { conn } = pump
    const { highWaterBytes, timeoutMs, pollMs } = this.bp
    let waitStarted: number | null = null
    for (;;) {
      if (pump.cancelled) return false
      if (conn.phase !== 'ready' || conn.ws.readyState !== OPEN) {
        throw new StageSendError(
          'disconnected',
          'the stage disconnected while an utterance was being sent'
        )
      }
      if (conn.ws.bufferedAmount <= highWaterBytes) break
      const nowMs = performance.now()
      waitStarted ??= nowMs
      if (nowMs - waitStarted >= timeoutMs) {
        throw new StageSendError(
          'backpressure',
          `the stage did not drain its socket (${conn.ws.bufferedAmount} bytes still buffered, limit ${highWaterBytes}) within ${timeoutMs} ms`
        )
      }
      await sleep(pollMs)
    }
    conn.ws.send(frame, { binary: true }, (err) => {
      if (err)
        this.log('warn', 'sending a binary frame to the stage failed', { conn: conn.id, err })
    })
    return true
  }

  // ─────────── safety nets ───────────

  private safeEmit<K extends keyof StageHubEvents>(event: K, ...args: StageHubEvents[K]): void {
    try {
      const emit = this.emit as (event: string, ...args: unknown[]) => boolean
      emit.call(this, event, ...args)
    } catch (err) {
      this.log('error', `a listener of '${String(event)}' threw`, { err })
    }
  }

  /** 'error' without a listener would throw inside emit(); log instead. */
  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) this.safeEmit('error', err)
    else this.log('error', 'stage hub error (no listener attached)', { err })
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.log('error', `stage hub handler failed: ${what}`, { err: errorMessage(err) })
    }
  }

  private safely(fn: () => void): void {
    try {
      fn()
    } catch {
      // best effort
    }
  }
}
