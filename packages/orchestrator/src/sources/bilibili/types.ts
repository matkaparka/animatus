import type { startListen } from 'blive-message-listener'
import type { Clock } from './clock.ts'

/**
 * Normalised events emitted by the Bilibili live-room source. Plain data only: nothing here depends on
 * the types of the library that produces the raw messages, so the rest of the orchestrator never has to.
 *
 * Every `ts` is the time (ms since the Unix epoch, from the source's injectable clock) at which the
 * source received the message. It is not the platform's own timestamp, so it is comparable with the
 * clock used for staleness checks downstream.
 */

/** A chat message. */
export interface DanmakuEvent {
  type: 'danmaku'
  /** Sender uid. `0` for a guest connection (the platform hides the real uid from anonymous clients). */
  uid: number
  /** Sender name. Masked (`a***`) for a guest connection. */
  uname: string
  text: string
  /**
   * `0` = plain text, `1` = emoticon sticker, `2` = voice message; any other value the platform may add
   * is passed through unchanged.
   *
   * Source: `info[0][12]` of the raw `DANMU_MSG` command, read from `Message.raw`. The library does not
   * surface that field (its own `DanmuMsg.type` is the display mode: scrolling, bottom or top), but it
   * fills `DanmuMsg.emoticon` from `info[0][13]` for sticker messages, which is used when the raw field
   * is unavailable. Verified against live traffic: both agree.
   */
  dmType: number
  /**
   * The sender is a room moderator. Source: `DanmuMsg.user.identity.room_admin`, which the library sets
   * from `info[2][2] === 1` of the raw `DANMU_MSG` command (the moderator flag the platform attaches to
   * every message). It is read fresh from each message, never remembered, so a revoked moderator loses
   * the flag with their next message. The room owner does not necessarily carry this flag: compare
   * `uid` with `roomOwnerUid`.
   */
  admin: boolean
  /** Uid of the room's owner, from the room-init API. `0` if the room could not be resolved. */
  roomOwnerUid: number
  ts: number
}

/** A gift. `num` is the count in this message; combo animations are not aggregated here. */
export interface GiftEvent {
  type: 'gift'
  uid: number
  uname: string
  /** Gift name. */
  gift: string
  num: number
  /** `gold` gifts are paid, `silver` gifts are free. Anything the platform sends other than `gold` counts as `silver`. */
  coinType: 'gold' | 'silver'
  /** Total cost of this message in the platform's coin unit (gold coins: 1000 = 1 yuan). */
  totalCoin: number
  ts: number
}

/** Someone bought or renewed a captain / admiral / governor membership. */
export interface GuardEvent {
  type: 'guard'
  uid: number
  uname: string
  /** 1 = governor (highest), 2 = admiral, 3 = captain. */
  level: 1 | 2 | 3
  /** Number of months bought. `1` if the platform did not say. */
  num: number
  ts: number
}

/** A paid highlighted message. */
export interface SuperChatEvent {
  type: 'superchat'
  uid: number
  uname: string
  /** Price in yuan. */
  price: number
  text: string
  ts: number
}

/** A viewer entered the room. Follows, shares and likes are not reported. */
export interface EnterEvent {
  type: 'enter'
  uid: number
  uname: string
  ts: number
}

export type AlarmCode = 'cookie_invalid' | 'masked_names' | 'guest_connection' | 'connection_lost'

/**
 * Something an operator has to look at. At most one alarm per `code` in any 60 s; the rest are dropped
 * (and counted in the debug log). The message never contains a cookie, a token or a viewer's name.
 *
 * - `cookie_invalid`: the login check says the cookie is not logged in, or the cookie provider failed.
 * - `masked_names`: a chat message or super chat came from uid 0 or a masked name (`\*{2,}`), which is
 *   what the platform sends to guests: the cookie is missing, invalid or expired.
 * - `guest_connection`: the connection is anonymous. Raised a few seconds after the connection opens
 *   when the source connected with uid 0, and whenever the server itself says the client is not logged in.
 * - `connection_lost`: the third consecutive failed attempt to hold a connection (and every failure after
 *   it), or the configured room does not exist.
 */
export interface AlarmEvent {
  type: 'alarm'
  code: AlarmCode
  message: string
}

/**
 * Connection life cycle. `connecting` opens every attempt (a login-check warning is a second
 * `connecting` with a `detail`), `open` means the transport is up, `reconnecting` follows every lost or
 * failed connection and carries the delay before the next attempt, `closed` is final and follows `stop()`.
 */
export interface StatusEvent {
  type: 'status'
  state: 'connecting' | 'open' | 'closed' | 'reconnecting'
  detail?: string
}

export type BilibiliSourceEvent =
  DanmakuEvent | GiftEvent | GuardEvent | SuperChatEvent | EnterEvent | AlarmEvent | StatusEvent

/**
 * Login cookies, as the operator copied them from a logged-in browser session. Values are secrets: they
 * are sent to the platform in a `Cookie` header and nowhere else, and never logged or emitted.
 */
export interface BilibiliCookies {
  sessdata?: string
  biliJct?: string
  buvid3?: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Same shape as the stage gateway's logger, so one function serves both. `extra` never carries secrets. */
export type SourceLogger = (level: LogLevel, msg: string, extra?: Record<string, unknown>) => void

/** Options of the library's `startListen`, as the source passes them. */
export type ListenOptions = NonNullable<Parameters<typeof startListen>[2]>

export interface BilibiliSourceOptions {
  /** The room to listen to. Short ids are accepted; the source resolves the long id the library needs. */
  roomId: number
  /**
   * Called before every connection attempt, so a cookie the operator updates while the source is running
   * is used by the next reconnect. Without it, or when it returns no `sessdata`, the source connects as
   * a guest (and says so with a `guest_connection` alarm).
   */
  getCookies?: () => Promise<BilibiliCookies> | BilibiliCookies
  reconnect?: {
    /** Cap of the reconnect delay, in seconds. Default 30. The delay is `min(cap, 2 ** min(failures, 5))`. */
    maxDelaySec?: number
    /** A connection that stayed open at least this long resets the failure count. Default 30 s. */
    stableAfterSec?: number
  }
  clock?: Clock
  fetch?: typeof fetch
  /** Defaults to `startListen` of `blive-message-listener`, loaded on first use. */
  listenerFactory?: typeof startListen
  logger?: SourceLogger
}
