import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import type {
  DanmuMsg,
  GiftMsg,
  GuardBuyMsg,
  Message,
  MessageListener,
  MsgHandler,
  SuperChatMsg,
  UserActionMsg,
  startListen,
} from 'blive-message-listener'
import {
  checkLogin,
  fetchDanmuToken,
  requestHeaders,
  resolveRoom,
  RoomNotFoundError,
  type HttpDeps,
  type ResolvedRoom,
} from './api.ts'
import { systemClock, type Clock } from './clock.ts'
import { buildCookieHeader, cleanCookies, MIN_SECRET_LENGTH } from './cookies.ts'
import {
  isMaskedIdentity,
  normalizeDanmaku,
  normalizeEnter,
  normalizeGift,
  normalizeGiftV2,
  normalizeGuard,
  normalizeSuperChat,
  type GiftResult,
} from './normalize.ts'
import type {
  AlarmCode,
  BilibiliCookies,
  BilibiliSourceEvent,
  BilibiliSourceOptions,
  ListenOptions,
  SourceLogger,
  StatusEvent,
} from './types.ts'
import { describeError } from './util.ts'
import type { WbiKeys } from './wbi.ts'

/**
 * Bilibili live-room event source: connects through `blive-message-listener`, turns its messages into the
 * events of `types.ts`, raises alarms for what an operator has to fix, and reconnects.
 *
 * What the installed library (blive-message-listener 0.5.5 on tiny-bilibili-ws 1.1.0) does that this file
 * works around. Each point was read from the library's code. The missing User-Agent, `close()` during
 * setup, the dead `onGift` and the stale `listener.roomId` were also reproduced against the live service;
 * the process-wide cache and the throwing-callback case follow from the code alone.
 *
 * - It reconnects by itself every 5 s unless `keepalive: false`, reusing the old token and cookie. The
 *   source turns that off and owns the policy: backoff, a fresh login check, fresh cookies, a fresh token.
 * - It caches the room lookup, the connection token and the device id for the life of the process, so a
 *   cookie the operator changes later would never take effect. The source asks for its own token for every
 *   attempt and passes it as `ws.key`; if that request fails the library's lookup is the fallback.
 * - Its own requests drop the default User-Agent (a spread overrides `headers`) and the token request is
 *   refused without one, which leaves even an anonymous connection without a token. The User-Agent goes
 *   into `ws.headers`, which the library forwards untouched.
 * - `onError` is declared but never called. The underlying emitter (`listener.live`) does emit `error`.
 * - `close()` returns false and does nothing until the server has answered the handshake: a connection
 *   that is still being set up completes anyway and keeps delivering messages. The source ends the socket
 *   itself.
 * - `onGift` is never called: gifts arrive as `SEND_GIFT_V2`, which the library decodes but does not map.
 *   They are read through the `raw` handler.
 * - A parser that throws inside a library callback becomes an unhandled promise rejection, which ends the
 *   process. `live.emit` is wrapped so that a throw is logged instead.
 * - `listener.roomId` is a snapshot taken before the room lookup finished (0). It is not used.
 */

const ALARM_COOLDOWN_MS = 60_000
/** A connection that is still anonymous this long after it opened is reported. */
const GUEST_CHECK_DELAY_MS = 5_000
/** An attempt whose transport is not up by then is abandoned. */
const CONNECT_TIMEOUT_MS = 20_000
/** The server answers a heartbeat about every 30 s; three missed answers mean the connection is dead. */
const LIVENESS_TIMEOUT_MS = 90_000
/** `connection_lost` is raised from this many consecutive failures on. */
const LOST_ALARM_AFTER_FAILURES = 3
const GIFT_DEDUPE_MS = 60_000
const GIFT_SEEN_LIMIT = 500
const DEFAULT_MAX_DELAY_SEC = 30
const DEFAULT_STABLE_AFTER_SEC = 30

const GUEST_MESSAGE =
  'The connection is anonymous (guest), so user names are masked. Provide a valid login cookie.'
const MASKED_MESSAGE =
  'A message came from an anonymous or masked user: the login cookie is missing, invalid or expired.'

type Cancel = () => void

/** What the source uses of the library's underlying emitter (`MessageListener.live`). */
interface LiveLike {
  emit?: (event: string, ...args: unknown[]) => boolean
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
  tcpSocket?: Pick<Socket, 'destroy'> | null
}

/** One connection attempt. Once `dead`, everything the library still delivers for it is ignored. */
interface Connection {
  listener: MessageListener | null
  /** Identity the connection was made with: the logged-in uid, or 0 for a guest. */
  readonly uid: number
  openedAt: number | null
  lastActivity: number
  dead: boolean
  timers: { connect?: Cancel; guest?: Cancel; liveness?: Cancel }
}

/** Thrown inside an attempt that `stop()` (or a newer attempt) made obsolete. */
class Superseded extends Error {}

async function loadDefaultFactory(): Promise<typeof startListen> {
  const library = await import('blive-message-listener')
  return library.startListen
}

export class BilibiliSource extends EventEmitter<{ event: [BilibiliSourceEvent] }> {
  /** The room as configured; may be a short id. */
  readonly roomId: number

  private readonly getCookies: BilibiliSourceOptions['getCookies']
  private readonly clock: Clock
  private readonly fetchFn: typeof fetch
  private factory: typeof startListen | undefined
  private readonly logger: SourceLogger
  private readonly maxDelaySec: number
  private readonly stableAfterMs: number

  private phase: 'idle' | 'running' | 'stopped' = 'idle'
  /** Set once the final `closed` status went out; nothing is emitted after it. */
  private closed = false
  private readonly abort = new AbortController()
  private inflight: Promise<void> | null = null
  private attemptSeq = 0
  /** Consecutive failed attempts; reset by a connection that stayed open long enough. */
  private failures = 0
  private conn: Connection | null = null
  private cancelReconnect: Cancel | null = null
  private room: ResolvedRoom | null = null
  private knownLogin: { sessdata: string; uid: number } | null = null
  /** Every secret seen so far (cookie values, tokens); scrubbed from anything logged or emitted. */
  private readonly secrets = new Set<string>()
  private readonly alarmAt = new Map<AlarmCode, number>()
  private readonly giftSeen = new Map<string, number>()

  constructor(options: BilibiliSourceOptions) {
    super()
    if (!Number.isSafeInteger(options.roomId) || options.roomId <= 0) {
      throw new RangeError('roomId must be a positive integer')
    }
    const maxDelaySec = options.reconnect?.maxDelaySec ?? DEFAULT_MAX_DELAY_SEC
    const stableAfterSec = options.reconnect?.stableAfterSec ?? DEFAULT_STABLE_AFTER_SEC
    if (!(maxDelaySec > 0) || !(stableAfterSec >= 0)) {
      throw new RangeError('reconnect.maxDelaySec must be positive and stableAfterSec not negative')
    }
    this.roomId = options.roomId
    this.getCookies = options.getCookies
    this.clock = options.clock ?? systemClock
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init))
    this.factory = options.listenerFactory
    this.logger = options.logger ?? (() => {})
    this.maxDelaySec = maxDelaySec
    this.stableAfterMs = stableAfterSec * 1000
  }

  /** The long room id the source connects to; null until the room-init API has answered. */
  get realRoomId(): number | null {
    return this.room?.roomId ?? null
  }

  /** Uid of the room's owner; null until the room-init API has answered. */
  get roomOwnerUid(): number | null {
    return this.room?.ownerUid ?? null
  }

  /**
   * Starts listening. Resolves once the first attempt has been set up (or has failed and been scheduled
   * for a retry), not when the connection is open: watch the `status` events for that. Runtime failures
   * never reject; they become `status` and `alarm` events and are retried until `stop()`.
   */
  async start(): Promise<void> {
    if (this.phase === 'stopped') throw new Error('BilibiliSource was stopped; create a new one')
    if (this.phase === 'running') return
    this.phase = 'running'
    await this.beginAttempt()
  }

  /**
   * Closes the connection, cancels every timer and in-flight request, and never reconnects. Emits the
   * final `closed` status, after which nothing more is emitted. Safe to call twice.
   */
  async stop(): Promise<void> {
    if (this.phase === 'stopped') return
    const wasRunning = this.phase === 'running'
    this.phase = 'stopped'
    this.abort.abort(new Error('source stopped'))
    this.cancelReconnect?.()
    this.cancelReconnect = null
    const conn = this.conn
    this.conn = null
    if (conn) this.dispose(conn)
    if (wasRunning) this.emitStatus('closed')
    await this.inflight
  }

  // ---- attempts

  private beginAttempt(): Promise<void> {
    const run: Promise<void> = this.attempt().finally(() => {
      if (this.inflight === run) this.inflight = null
    })
    this.inflight = run
    return run
  }

  /** Never rejects. */
  private async attempt(): Promise<void> {
    if (this.phase !== 'running') return
    const id = ++this.attemptSeq
    this.emitStatus('connecting', this.failures > 0 ? `attempt ${this.failures + 1}` : undefined)
    try {
      await this.connect(id)
    } catch (err) {
      if (err instanceof Superseded || this.phase !== 'running' || id !== this.attemptSeq) return
      if (err instanceof RoomNotFoundError) this.alarm('connection_lost', err.message)
      this.scheduleReconnect(describeError(err))
    }
  }

  private async connect(id: number): Promise<void> {
    const ensureCurrent = (): void => {
      if (this.phase !== 'running' || this.attemptSeq !== id) throw new Superseded()
    }

    const cookies = await this.readCookies()
    ensureCurrent()
    const cookieHeader = buildCookieHeader(cookies)
    const deps: HttpDeps = { fetch: this.fetchFn, clock: this.clock, signal: this.abort.signal }

    const room = this.room ?? (await resolveRoom(deps, this.roomId))
    ensureCurrent()
    this.room = room

    // Login check, like the legacy `check_login`. It also tells us which uid the handshake must carry.
    let uid = 0
    let wbi: WbiKeys | null = null
    if (cookies.sessdata) {
      const check = await checkLogin(deps, cookieHeader)
      ensureCurrent()
      if (check.kind === 'logged_in') {
        uid = check.uid
        wbi = check.wbi
        this.knownLogin = { sessdata: cookies.sessdata, uid }
        this.logger('info', 'login check passed', { uid })
      } else if (check.kind === 'not_logged_in') {
        wbi = check.wbi
        this.alarm(
          'cookie_invalid',
          'The login check says the cookie is not logged in. Update the login cookie; until then the ' +
            'source connects as a guest and user names are masked.'
        )
      } else {
        // The check itself failed (network, HTTP status): a warning, not an alarm. Keep the identity we
        // last saw for this cookie, if any; the next attempt checks again.
        uid = this.knownLogin?.sessdata === cookies.sessdata ? this.knownLogin.uid : 0
        this.logger('warn', 'login check failed', { reason: this.safe(check.reason) })
        this.emitStatus(
          'connecting',
          `login check failed (${check.reason}); connecting ${uid === 0 ? 'as a guest' : 'with the last known login'}`
        )
      }
    } else {
      this.logger('info', 'no login cookie configured; connecting as a guest')
    }

    // A token that belongs to the cookie we are about to use (see the notes at the top of the file).
    let key: string | undefined
    if (wbi) {
      let failure: unknown
      try {
        key = await fetchDanmuToken(deps, room.roomId, cookieHeader, wbi)
      } catch (err) {
        failure = err
      }
      ensureCurrent()
      if (key !== undefined) this.secrets.add(key)
      else {
        this.logger('warn', 'no connection token of our own; falling back to the library lookup', {
          reason: this.safe(describeError(failure)),
        })
      }
    }

    const factory = this.factory ?? (this.factory = await loadDefaultFactory())
    ensureCurrent()

    const ws: NonNullable<ListenOptions['ws']> = {
      // The library forwards these headers to its own requests. It does not put them on the socket.
      headers: requestHeaders(cookieHeader),
      uid,
      keepalive: false,
    }
    if (key !== undefined) ws.key = key

    const conn: Connection = {
      listener: null,
      uid,
      openedAt: null,
      lastActivity: this.clock.now(),
      dead: false,
      timers: {},
    }
    this.conn = conn
    conn.timers.connect = this.clock.setTimeout(
      () => this.handleDown(conn, `no connection after ${CONNECT_TIMEOUT_MS / 1000} s`),
      CONNECT_TIMEOUT_MS
    )
    try {
      conn.listener = factory(room.roomId, this.handlerFor(conn), { ws })
    } catch (err) {
      this.dispose(conn)
      if (this.conn === conn) this.conn = null
      throw err
    }
    this.attachLiveGuards(conn)
    this.logger('info', 'connecting to the live room', {
      roomId: room.roomId,
      uid,
      tokenSource: key === undefined ? 'library' : 'own',
    })
  }

  private async readCookies(): Promise<BilibiliCookies> {
    if (!this.getCookies) return {}
    let provided: BilibiliCookies
    try {
      provided = await this.getCookies()
    } catch (err) {
      this.logger('warn', 'the cookie provider failed', { error: this.safe(describeError(err)) })
      this.alarm('cookie_invalid', 'The cookie provider failed; connecting as a guest.')
      return {}
    }
    for (const value of [provided.sessdata, provided.biliJct, provided.buvid3]) {
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (trimmed.length >= MIN_SECRET_LENGTH) this.secrets.add(trimmed)
    }
    const { cookies, rejected } = cleanCookies(provided)
    for (const name of rejected) {
      this.logger('warn', 'a cookie value was dropped: it is not valid in a Cookie header', {
        cookie: name,
      })
    }
    return cookies
  }

  // ---- the library's callbacks

  private handlerFor(conn: Connection): MsgHandler {
    /** Ignores a dead connection, counts the call as activity, and keeps a throw inside our own code from escaping. */
    const guarded =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A): void => {
        if (conn.dead) return
        conn.lastActivity = this.clock.now()
        try {
          fn(...args)
        } catch (err) {
          this.logger('error', 'failed to handle a message', {
            error: this.safe(describeError(err)),
          })
        }
      }

    return {
      onOpen: () => this.handleOpen(conn),
      onClose: () => this.handleDown(conn, 'connection closed'),
      onError: (err) => this.handleDown(conn, `connection error: ${describeError(err)}`),
      onStartListen: () => {
        if (conn.dead) this.closeListener(conn.listener)
      },
      // The server's answer to a heartbeat, about every 30 s: proof that the connection is alive.
      onAttentionChange: guarded(() => {}),
      onIncomeDanmu: guarded((msg: Message<DanmuMsg>) => this.handleDanmaku(msg)),
      onGift: guarded((msg: Message<GiftMsg>) =>
        this.deliverGift(normalizeGift(msg, this.clock.now()))
      ),
      onGuardBuy: guarded((msg: Message<GuardBuyMsg>) => {
        const event = normalizeGuard(msg, this.clock.now())
        if (event) this.emitEvent(event)
        else this.logger('warn', 'a guard purchase with an unexpected level was dropped')
      }),
      onIncomeSuperChat: guarded((msg: Message<SuperChatMsg>) => this.handleSuperChat(msg)),
      onUserAction: guarded((msg: Message<UserActionMsg>) => {
        const event = normalizeEnter(msg, this.clock.now())
        if (event) this.emitEvent(event)
      }),
      raw: {
        SEND_GIFT_V2: guarded((raw: unknown) =>
          this.deliverGift(normalizeGiftV2(raw, this.clock.now()))
        ),
        // Sent once to every anonymous connection: the server itself says the client is not logged in.
        LOG_IN_NOTICE: guarded(() => this.alarm('guest_connection', GUEST_MESSAGE)),
      },
    }
  }

  private handleDanmaku(msg: Message<DanmuMsg>): void {
    const event = normalizeDanmaku(msg, this.clock.now(), this.room?.ownerUid ?? 0)
    if (isMaskedIdentity(event.uid, event.uname)) this.alarm('masked_names', MASKED_MESSAGE)
    this.emitEvent(event)
  }

  private handleSuperChat(msg: Message<SuperChatMsg>): void {
    const event = normalizeSuperChat(msg, this.clock.now())
    if (isMaskedIdentity(event.uid, event.uname)) this.alarm('masked_names', MASKED_MESSAGE)
    this.emitEvent(event)
  }

  private deliverGift(result: GiftResult | null): void {
    if (!result) {
      this.logger('debug', 'a gift message without a usable body was dropped')
      return
    }
    if (result.dedupeKey !== null) {
      const now = this.clock.now()
      const seen = this.giftSeen.get(result.dedupeKey)
      if (seen !== undefined && now - seen < GIFT_DEDUPE_MS) return
      this.giftSeen.set(result.dedupeKey, now)
      if (this.giftSeen.size > GIFT_SEEN_LIMIT) {
        for (const [key, at] of this.giftSeen) {
          if (now - at >= GIFT_DEDUPE_MS) this.giftSeen.delete(key)
        }
      }
    }
    this.emitEvent(result.event)
  }

  // ---- connection life cycle

  private handleOpen(conn: Connection): void {
    if (conn.dead) {
      // Stopped, superseded or timed out while the library was still connecting. Its close() does
      // nothing before the server has answered, so end the socket here.
      this.destroySocket(conn.listener)
      return
    }
    const now = this.clock.now()
    conn.openedAt = now
    conn.lastActivity = now
    conn.timers.connect?.()
    delete conn.timers.connect
    conn.timers.guest = this.clock.setTimeout(() => {
      if (!conn.dead && conn.uid === 0) this.alarm('guest_connection', GUEST_MESSAGE)
    }, GUEST_CHECK_DELAY_MS)
    this.armLiveness(conn)
    this.emitStatus('open')
  }

  /** Reconnects when nothing, not even a heartbeat answer, has arrived for too long (a half-open socket never errors). */
  private armLiveness(conn: Connection): void {
    const check = (): void => {
      if (conn.dead) return
      const idle = this.clock.now() - conn.lastActivity
      if (idle >= LIVENESS_TIMEOUT_MS) {
        this.handleDown(conn, `no data for ${Math.round(idle / 1000)} s`)
        return
      }
      conn.timers.liveness = this.clock.setTimeout(check, LIVENESS_TIMEOUT_MS - idle)
    }
    conn.timers.liveness = this.clock.setTimeout(check, LIVENESS_TIMEOUT_MS)
  }

  /** The connection is gone or failed to come up: dispose it and schedule the next attempt. Idempotent per connection. */
  private handleDown(conn: Connection, reason: string): void {
    if (conn.dead) return
    const openFor = conn.openedAt === null ? 0 : this.clock.now() - conn.openedAt
    const wasOpen = conn.openedAt !== null
    this.dispose(conn)
    if (this.conn === conn) this.conn = null
    if (this.phase !== 'running') return
    if (wasOpen && openFor >= this.stableAfterMs) this.failures = 0
    this.scheduleReconnect(reason)
  }

  private scheduleReconnect(reason: string): void {
    const delaySec = Math.min(this.maxDelaySec, 2 ** Math.min(this.failures, 5))
    this.failures += 1
    this.emitStatus('reconnecting', `retry in ${delaySec} s (failure ${this.failures}): ${reason}`)
    if (this.failures >= LOST_ALARM_AFTER_FAILURES) {
      this.alarm(
        'connection_lost',
        `The live-room connection has failed ${this.failures} times in a row: ${reason}`
      )
    }
    if (this.phase !== 'running') return // a listener of the events above may have called stop()
    this.cancelReconnect?.()
    this.cancelReconnect = this.clock.setTimeout(() => {
      this.cancelReconnect = null
      void this.beginAttempt()
    }, delaySec * 1000)
  }

  /** Marks the connection dead, cancels its timers, and closes the library's listener and socket. */
  private dispose(conn: Connection): void {
    if (conn.dead) return
    conn.dead = true
    for (const cancel of Object.values(conn.timers)) cancel?.()
    conn.timers = {}
    const listener = conn.listener
    if (listener) {
      this.closeListener(listener)
      this.destroySocket(listener)
    }
  }

  private closeListener(listener: MessageListener | null): void {
    try {
      listener?.close()
    } catch (err) {
      this.logger('debug', 'closing the listener failed', { error: this.safe(describeError(err)) })
    }
  }

  /** The library's close() is a no-op until the handshake was answered, so end the socket directly. */
  private destroySocket(listener: MessageListener | null): void {
    const live = listener?.live as unknown as LiveLike | undefined
    try {
      live?.tcpSocket?.destroy()
    } catch {
      // already gone
    }
  }

  private attachLiveGuards(conn: Connection): void {
    const live = conn.listener?.live as unknown as LiveLike | undefined
    if (!live) return
    const emit = live.emit
    if (typeof emit === 'function') {
      live.emit = (event, ...args) => {
        try {
          return emit.call(live, event, ...args)
        } catch (err) {
          this.logger('error', 'a library callback threw', {
            event,
            error: this.safe(describeError(err)),
          })
          return false
        }
      }
    }
    live.on?.('error', (err) => this.handleDown(conn, `connection error: ${describeError(err)}`))
  }

  // ---- output

  /** At most one alarm per code in any 60 s. */
  private alarm(code: AlarmCode, message: string): void {
    const now = this.clock.now()
    const last = this.alarmAt.get(code)
    if (last !== undefined && now - last < ALARM_COOLDOWN_MS) {
      this.logger('debug', 'alarm suppressed (rate limit)', { code })
      return
    }
    this.alarmAt.set(code, now)
    const text = this.safe(message)
    this.logger('error', `ALARM ${code}: ${text}`)
    this.emitEvent({ type: 'alarm', code, message: text })
  }

  private emitStatus(state: StatusEvent['state'], detail?: string): void {
    this.emitEvent(
      detail === undefined
        ? { type: 'status', state }
        : { type: 'status', state, detail: this.safe(detail) }
    )
    if (state === 'closed') this.closed = true
  }

  /**
   * Listeners are called one by one, so that one that throws neither stops the listeners after it nor
   * takes the connection (or the process) down with it.
   */
  private emitEvent(event: BilibiliSourceEvent): void {
    if (this.closed) return
    for (const listener of this.rawListeners('event')) {
      try {
        Reflect.apply(listener, this, [event])
      } catch (err) {
        this.logger('error', 'an event listener threw', { error: this.safe(describeError(err)) })
      }
    }
  }

  /** Replaces every secret seen so far with `***`. Applied to everything that leaves the source as text. */
  private safe(text: string): string {
    let out = text
    for (const secret of this.secrets) out = out.split(secret).join('***')
    return out
  }
}
