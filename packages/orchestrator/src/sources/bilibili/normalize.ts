import type {
  DanmuMsg,
  GiftMsg,
  GuardBuyMsg,
  Message,
  SuperChatMsg,
  UserActionMsg,
} from 'blive-message-listener'
import type { DanmakuEvent, EnterEvent, GiftEvent, GuardEvent, SuperChatEvent } from './types.ts'
import { isRecord } from './util.ts'

/**
 * Pure mapping from the library's `Message<T>` bodies (and, where the library drops a field, from
 * `Message.raw`) to the source's own events. Nothing here touches the network or a clock: the caller
 * passes the receive time. Network data is untrusted, so every read is defensive even where the
 * library's types promise more.
 */

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positiveInt(value: unknown): number | undefined {
  const n = finite(value)
  return n !== undefined && n >= 1 ? Math.trunc(n) : undefined
}

/** Uids are positive integers; anything else (missing, zero, garbage) is the guest uid 0. */
function toUid(value: unknown): number {
  const n = finite(value)
  return n !== undefined && n > 0 ? Math.trunc(n) : 0
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The `data` object of a raw command (`{ cmd, data: {...} }`), if it has one. */
function rawData(raw: unknown): Record<string, unknown> | undefined {
  return isRecord(raw) && isRecord(raw.data) ? raw.data : undefined
}

/** `info[0][12]` of the raw `DANMU_MSG` command: 0 text, 1 emoticon sticker, 2 voice. */
function rawDmType(raw: unknown): number | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.info)) return undefined
  const head: unknown = raw.info[0]
  return Array.isArray(head) ? finite(head[12]) : undefined
}

export function normalizeDanmaku(
  msg: Message<DanmuMsg>,
  ts: number,
  roomOwnerUid: number
): DanmakuEvent {
  const body = msg.body
  const raw = rawDmType(msg.raw)
  // The library fills `emoticon` only for sticker messages. If the raw field says "text" while a sticker
  // object is present, the object is the stronger evidence.
  const dmType = body.emoticon && (raw === undefined || raw === 0) ? 1 : (raw ?? 0)
  return {
    type: 'danmaku',
    uid: toUid(body.user?.uid),
    uname: toText(body.user?.uname),
    text: toText(body.content),
    dmType,
    admin: body.user?.identity?.room_admin === true,
    roomOwnerUid,
    ts,
  }
}

export interface GiftResult {
  event: GiftEvent
  /**
   * Identifies the transaction, so that the same gift arriving as both `SEND_GIFT` and `SEND_GIFT_V2` is
   * reported once. Null when the message carries no transaction id.
   */
  dedupeKey: string | null
}

function giftKey(uid: number, giftId: unknown, rnd: unknown): string | null {
  const id = finite(giftId)
  const transaction = typeof rnd === 'number' ? String(rnd) : rnd
  return id !== undefined && typeof transaction === 'string' && transaction !== ''
    ? `${uid}:${id}:${transaction}`
    : null
}

/** `SEND_GIFT` through the library's typed handler. */
export function normalizeGift(msg: Message<GiftMsg>, ts: number): GiftResult | null {
  const body = msg.body
  const gift = toText(body.gift_name)
  if (gift === '') return null
  const num = positiveInt(body.amount) ?? 1
  const uid = toUid(body.user?.uid)
  const data = rawData(msg.raw)
  return {
    event: {
      type: 'gift',
      uid,
      uname: toText(body.user?.uname),
      gift,
      num,
      coinType: body.coin_type === 'gold' ? 'gold' : 'silver',
      totalCoin: finite(data?.total_coin) ?? (finite(body.price) ?? 0) * num,
      ts,
    },
    dedupeKey: giftKey(uid, body.gift_id, data?.rnd),
  }
}

/**
 * `SEND_GIFT_V2`, which is how the platform delivers gifts today. The library decodes its protobuf
 * payload into `{ cmd, data }` but `blive-message-listener` has no typed handler for it, so it arrives
 * through the `raw` handler as an untyped object.
 */
export function normalizeGiftV2(raw: unknown, ts: number): GiftResult | null {
  const data = rawData(raw)
  if (!data) return null
  const gift = toText(data.gift_name)
  if (gift === '') return null
  const num = positiveInt(data.num) ?? 1
  const uid = toUid(data.uid)
  return {
    event: {
      type: 'gift',
      uid,
      uname: toText(data.uname),
      gift,
      num,
      coinType: data.coin_type === 'gold' ? 'gold' : 'silver',
      totalCoin: finite(data.total_coin) ?? (finite(data.price) ?? 0) * num,
      ts,
    },
    dedupeKey: giftKey(uid, data.gift_id, data.rnd),
  }
}

/** Null when the guard level is not 1..3. The month count is not in the library's body; it is in the raw command. */
export function normalizeGuard(msg: Message<GuardBuyMsg>, ts: number): GuardEvent | null {
  const body = msg.body
  const level = Number(body.guard_level)
  if (level !== 1 && level !== 2 && level !== 3) return null
  return {
    type: 'guard',
    uid: toUid(body.user?.uid),
    uname: toText(body.user?.uname),
    level,
    num: positiveInt(rawData(msg.raw)?.num) ?? 1,
    ts,
  }
}

export function normalizeSuperChat(msg: Message<SuperChatMsg>, ts: number): SuperChatEvent {
  const body = msg.body
  return {
    type: 'superchat',
    uid: toUid(body.user?.uid),
    uname: toText(body.user?.uname),
    price: finite(body.price) ?? 0,
    text: toText(body.content),
    ts,
  }
}

/** Null for follows, shares, likes and anything else that is not a viewer entering the room. */
export function normalizeEnter(msg: Message<UserActionMsg>, ts: number): EnterEvent | null {
  if (msg.body.action !== 'enter') return null
  return {
    type: 'enter',
    uid: toUid(msg.body.user?.uid),
    uname: toText(msg.body.user?.uname),
    ts,
  }
}

const MASKED_NAME = /\*{2,}/

/** What the platform sends to a guest connection: uid 0 or a name with two or more asterisks. */
export function isMaskedIdentity(uid: number, uname: string): boolean {
  return uid === 0 || MASKED_NAME.test(uname)
}
