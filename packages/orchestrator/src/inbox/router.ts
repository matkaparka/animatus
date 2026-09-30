/**
 * The message router: viewer events in, batches for the brain out.
 *
 * A behavioural port of the legacy bridge's router. It filters and merges what viewers send, keeps six
 * priority queues, folds gifts together over time, recognises song commands, and decides which lines
 * form the next batch. Time comes from an injected clock (milliseconds) and nothing here does I/O.
 *
 * Things that look odd but are deliberate (they are what the legacy bridge did, and the tests pin them):
 *
 * - Serving order is SC, guard, dance, song results, gifts, chat (with small gifts riding along), then the
 *   cold-start line. Song results are numbered 5 but are served before gifts and chat.
 * - Any viewer event refreshes `lastActivity`, even one that is dropped or ignored. The cold-start line
 *   counts silence, not usefulness.
 * - `ignoreUids` applies to chat messages only; paid messages, guards and gifts from those users pass.
 * - The duplicate window is anchored at the first occurrence and a repeat does not extend it; duplicates
 *   are judged on the letters-and-digits form, across all viewers.
 * - Song commands bypass the ordinary chat filters (a two-letter "skip" repeated is still a command) and
 *   are swallowed whether or not the sender may use them.
 * - A song request from a viewer whose name is blocklisted is dropped, so the "anonymous viewer" branch
 *   for request names never runs; cancel, skip and list carry the cleaned name as is.
 * - Small gifts wait in an accumulator that expires 600 s after its first flush regardless of later
 *   additions, and a flushed small gift is sent even when there is no chat to ride along with.
 */
import { emptyBlocklist, type BlockChecker } from './blocklist.ts'
import { FORMATS } from './formats.ts'
import {
  PY_SPACE,
  cleanViewerText,
  codePointLength,
  distinctCodePoints,
  normKey,
  parseDecimalDigits,
  pyStrip,
  truncateChars,
} from './text.ts'
import {
  InboxConfigSchema,
  PRIORITY,
  type Batch,
  type BatchPart,
  type DanmakuInput,
  type DropHandler,
  type DropInfo,
  type DropReason,
  type GiftInput,
  type GuardInput,
  type InboxConfig,
  type InboxConfigInput,
  type InboxLogger,
  type PartKind,
  type Priority,
  type SongCommand,
  type SuperChatInput,
} from './types.ts'

/** Each queue keeps at most this many lines; the oldest is dropped to make room. */
const QUEUE_CAP = 50
/** A small-gift accumulator that never reaches a flush threshold is discarded this long after it started. */
const SMALL_GIFT_TTL_MS = 600_000
/** A song keyword is cut to this many characters. */
const SONG_KEYWORD_MAX = 40
/** At most this many flushed small gifts are appended to one chat batch. */
const SMALL_GIFTS_PER_BATCH = 2
/** A cold-start line is measured in minutes. */
const MINUTE_MS = 60_000

/**
 * Viewer-facing song command words (Chinese chat, so they are data): request `点歌 <keyword>` (also the
 * traditional-character form), cancel `取消点歌 [n]` (also `撤销点歌`, `撤回点歌`), skip `切歌`, list `歌单`.
 * `\s` is Python's whitespace and `\p{Nd}` matches digits of any script, as in the legacy patterns.
 */
const SPACE = `[${PY_SPACE}]`
const SONG_REQUEST = new RegExp(`^[点點]歌${SPACE}*[:：]?${SPACE}*(.+)$`, 'u')
const SONG_SKIP = new RegExp('^切歌[!！。.~～]*$', 'u')
const SONG_LIST = new RegExp('^歌单[?？!！。.~～]*$', 'u')
const SONG_CANCEL = new RegExp(`^(?:取消|撤销|撤回)[点點]歌${SPACE}*(\\p{Nd}*)[!！。.~～]*$`, 'u')

export interface RouterOptions {
  /** Clock in milliseconds; defaults to `Date.now`. */
  now?: () => number
  log?: InboxLogger
  /** Called for everything that is dropped, with a stable reason code. */
  onDrop?: DropHandler
  /** Called for each song command found in chat. Without a handler, commands are logged and discarded. */
  onSongCommand?: (cmd: SongCommand) => void
}

export interface RouterStats {
  /** Lines waiting in each queue. */
  queued: Record<Priority, number>
  /** Small gifts that reached their threshold and wait to ride along with chat. */
  smallReady: number
  /** Small gifts still accumulating. */
  smallAccumulating: number
  /** Gift and dance windows still open. */
  giftWindows: number
  danceWindows: number
  /** Chat texts remembered for duplicate detection. */
  recentTexts: number
}

interface Item {
  prio: Priority
  kind: PartKind
  ts: number
  text: string
  uid?: number
  uname?: string
}

/** Gifts of one kind from one sender, being merged. `firstTs` is when the window opened. */
interface GiftAcc {
  uid: number
  uname: string
  gift: string
  num: number
  /** Gold seeds, 1000 to the yuan. */
  gold: number
  firstTs: number
}

/** Same sender (their id, or their name when the id is unknown) and same gift. */
function giftKey(uid: number, uname: string, gift: string): string {
  return JSON.stringify([uid || uname, gift])
}

function identity(
  uid: number | undefined,
  uname: string | undefined
): { uid?: number; uname?: string } {
  return {
    ...(uid ? { uid } : {}),
    ...(uname !== undefined ? { uname } : {}),
  }
}

function toPart(item: Item): BatchPart {
  const { prio, kind, text, uid, uname } = item
  return { prio, kind, text, ...identity(uid, uname) }
}

function batchOf(parts: BatchPart[]): Batch {
  return { text: parts.map((p) => p.text).join('\n'), parts }
}

export class Router {
  readonly config: InboxConfig
  onDrop: DropHandler | undefined
  onSongCommand: ((cmd: SongCommand) => void) | undefined

  private readonly now: () => number
  private readonly log: InboxLogger
  private readonly block: BlockChecker
  private readonly ignoreUids: ReadonlySet<number>
  private readonly danceGifts: ReadonlySet<string>
  private readonly ownerUids: ReadonlySet<number>
  private readonly queues: Record<Priority, Item[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] }
  private readonly danceWindow = new Map<string, GiftAcc>()
  private readonly giftWindow = new Map<string, GiftAcc>()
  private readonly giftSmall = new Map<string, GiftAcc>()
  private readonly smallReady = new Map<string, GiftAcc>()
  private readonly recentText = new Map<string, number>()
  private isSinging = false
  private singingSeen = -Infinity
  private activityAt: number
  private lastColdAt = -Infinity

  constructor(
    config: InboxConfigInput = {},
    block: BlockChecker = emptyBlocklist,
    options: RouterOptions = {}
  ) {
    this.config = InboxConfigSchema.parse(config)
    this.block = block
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    this.onDrop = options.onDrop
    this.onSongCommand = options.onSongCommand
    this.ignoreUids = new Set(this.config.ignoreUids)
    this.danceGifts = new Set(this.config.dance.gifts)
    this.ownerUids = new Set(this.config.singing.ownerUids)
    this.activityAt = this.now()
  }

  /** When a viewer event (of any kind, dropped or not) was last received. */
  get lastActivity(): number {
    return this.activityAt
  }

  /** Whether the streamer is singing right now, as last reported through `setSinging`. */
  get singing(): boolean {
    return this.isSinging
  }

  /** The last time `setSinging(true)` was called; `-Infinity` if never. */
  get singingSeenAt(): number {
    return this.singingSeen
  }

  /**
   * Report whether the streamer is singing. Chat keeps queueing during a song but only starts to age
   * once the singing stops, measured from the last time it was reported.
   */
  setSinging(on: boolean): void {
    this.isSinging = on
    if (on) this.singingSeen = this.now()
  }

  stats(): RouterStats {
    return {
      queued: {
        0: this.queues[0].length,
        1: this.queues[1].length,
        2: this.queues[2].length,
        3: this.queues[3].length,
        4: this.queues[4].length,
        5: this.queues[5].length,
      },
      smallReady: this.smallReady.size,
      smallAccumulating: this.giftSmall.size,
      giftWindows: this.giftWindow.size,
      danceWindows: this.danceWindow.size,
      recentTexts: this.recentText.size,
    }
  }

  // ---- inputs

  onDanmaku(ev: DanmakuInput): void {
    const now = this.now()
    const { uid, dmType } = ev
    const uname = cleanViewerText(ev.uname)
    const text = cleanViewerText(ev.msg)
    const filter = this.config.filter
    this.activityAt = now

    const drop = (reason: DropReason, word?: string): void =>
      this.reportDrop(reason, 'danmaku', {
        uid,
        uname,
        text,
        ...(word !== undefined ? { word } : {}),
      })

    if (this.ignoreUids.has(uid)) return drop('ignored_uid')
    // Song commands skip the ordinary filters below.
    if (
      this.config.singing.enabled &&
      dmType !== 1 &&
      this.songCommand(uid, uname, text, ev.admin ?? false, ev.roomOwnerUid ?? 0)
    ) {
      return
    }
    if (dmType === 1) return drop('emote_sticker')
    const key = normKey(text)
    if (key === '') return drop('pure_emote')
    const length = codePointLength(key)
    if (length < filter.minChars) return drop('too_short')
    if (length >= 3 && distinctCodePoints(key) === 1) return drop('spam')
    const word = this.block.hit(text, uname)
    if (word !== null) return drop('blocked_word', word)
    this.forgetOldTexts(now)
    if (this.recentText.has(key)) return drop('duplicate')
    this.recentText.set(key, now)
    const shown = truncateChars(text, filter.maxChars)
    this.push({
      prio: PRIORITY.DANMAKU,
      kind: 'danmaku',
      ts: now,
      text: FORMATS.danmaku(uname, shown),
      ...identity(uid, uname),
    })
    this.log('info', 'queued danmaku', { uid, uname, text: shown })
  }

  onSuperChat(ev: SuperChatInput): void {
    const now = this.now()
    let uname = cleanViewerText(ev.uname)
    let text = cleanViewerText(ev.msg)
    this.activityAt = now
    if (this.block.hit(uname) !== null) uname = FORMATS.anonymousViewer
    const word = this.block.hit(text)
    if (word !== null) {
      // A paid message is never thrown away: it is thanked, but its content is not passed on.
      this.log('info', 'paid message content matched the blocklist; keeping the thanks only', {
        uid: ev.uid,
        word,
      })
      text = FORMATS.superChatRedacted
    } else {
      text = truncateChars(text, this.config.filter.maxChars)
    }
    this.push({
      prio: PRIORITY.SC,
      kind: 'superchat',
      ts: now,
      text: FORMATS.superChat(ev.price, uname, text),
      ...identity(ev.uid, uname),
    })
    this.log('info', 'queued paid message', { uid: ev.uid, uname, price: ev.price, text })
  }

  onGuard(ev: GuardInput): void {
    const now = this.now()
    let uname = cleanViewerText(ev.uname)
    this.activityAt = now
    if (this.block.hit(uname) !== null) uname = FORMATS.anonymousViewer
    this.push({
      prio: PRIORITY.GUARD,
      kind: 'guard',
      ts: now,
      text: FORMATS.guard(uname, ev.level, ev.num),
      ...identity(ev.uid, uname),
    })
    this.log('info', 'queued guard', { uid: ev.uid, uname, level: ev.level, months: ev.num })
  }

  onGift(ev: GiftInput): void {
    const now = this.now()
    const { uid, gift, num } = ev
    const uname = cleanViewerText(ev.uname)
    this.activityAt = now
    const key = giftKey(uid, uname, gift)

    if (this.danceGifts.has(gift)) {
      // Dance gifts are asked for, not thanked as gifts (the dance line thanks the sender), and free ones count.
      const acc = this.danceWindow.get(key)
      if (acc === undefined) {
        this.danceWindow.set(key, { uid, uname, gift, num, gold: 0, firstTs: now })
      } else {
        acc.num += num
      }
      this.log('info', 'received dance gift', { uid, uname, gift, num })
      return
    }

    const paid = ev.coinType === 'gold'
    if (!paid && !this.config.gift.includeFreeGifts) {
      this.reportDrop('free_gift', 'gift', { uid, uname, text: gift })
      return
    }
    const gold = paid ? ev.totalCoin : 0
    const acc = this.giftWindow.get(key)
    if (acc === undefined) {
      this.giftWindow.set(key, { uid, uname, gift, num, gold, firstTs: now })
    } else {
      acc.num += num
      acc.gold += gold
    }
    this.log('info', 'received gift', {
      uid,
      uname,
      gift,
      num,
      coinType: ev.coinType,
      totalCoin: ev.totalCoin,
    })
  }

  /** Queue a finished song-result line (see `FORMATS.songQueued` and friends) for the song priority. */
  addSongLine(text: string): void {
    this.push({ prio: PRIORITY.SONG, kind: 'song', ts: this.now(), text })
    this.log('info', 'queued song line', { text })
  }

  // ---- song commands

  /** True when `text` is a song command (which is then fully handled here, allowed or not). */
  private songCommand(
    uid: number,
    uname: string,
    text: string,
    admin: boolean,
    roomOwnerUid: number
  ): boolean {
    const owner = this.ownerUids.has(uid) || (Boolean(roomOwnerUid) && uid === roomOwnerUid)
    const mayManage = owner || (this.config.singing.adminsCanSkip && admin)
    const drop = (reason: 'song_not_allowed' | 'song_rejected', word?: string): void =>
      this.reportDrop(reason, 'song command', {
        uid,
        uname,
        text,
        ...(word !== undefined ? { word } : {}),
      })

    const cancel = SONG_CANCEL.exec(text)
    if (cancel) {
      // "Cancel" removes the sender's own latest request; "cancel 2" removes queue entry 2 and is for staff.
      const digits = cancel[1] ?? ''
      if (digits !== '' && !mayManage) {
        drop('song_not_allowed')
        return true
      }
      this.emitSong({
        kind: 'cancel',
        uid,
        name: uname,
        ...(digits !== '' ? { position: parseDecimalDigits(digits) } : {}),
      })
      return true
    }

    const request = SONG_REQUEST.exec(text)
    if (request) {
      const keyword = pyStrip(request[1] ?? '')
      const word = this.block.hit(keyword, uname)
      if (keyword === '' || word !== null) {
        drop('song_rejected', word ?? undefined)
        return true
      }
      // Unreachable in practice: a blocklisted name already made `hit(keyword, uname)` match above.
      const name = this.block.hit(uname) !== null ? FORMATS.anonymousViewer : uname
      this.emitSong({
        kind: 'request',
        uid,
        name,
        keyword: truncateChars(keyword, SONG_KEYWORD_MAX, ''),
      })
      return true
    }

    if (SONG_SKIP.test(text)) {
      if (mayManage) this.emitSong({ kind: 'skip', uid, name: uname })
      else drop('song_not_allowed')
      return true
    }

    if (SONG_LIST.test(text)) {
      this.emitSong({ kind: 'list', uid, name: uname })
      return true
    }
    return false
  }

  private emitSong(cmd: SongCommand): void {
    this.log('info', `song command: ${cmd.kind}`, { ...cmd })
    const handler = this.onSongCommand
    if (handler === undefined) {
      this.log('warn', 'song command discarded: no handler is set', { kind: cmd.kind })
      return
    }
    try {
      handler(cmd)
    } catch (error) {
      this.log('error', 'song command handler threw', { kind: cmd.kind, error })
    }
  }

  // ---- timed merging

  /**
   * Close the gift windows that have run their course. Call it regularly (the legacy loop did every
   * half second): dance gifts become dance lines, big gifts become gift lines, small gifts accumulate.
   */
  tick(): void {
    const now = this.now()
    const gift = this.config.gift

    for (const [key, acc] of [...this.danceWindow]) {
      if (now - acc.firstTs < this.config.dance.mergeSec * 1000) continue
      this.danceWindow.delete(key)
      const name = this.displayName(acc.uname)
      const text = FORMATS.dance(name, acc.num, acc.gift)
      this.push({
        prio: PRIORITY.DANCE,
        kind: 'dance',
        ts: now,
        text,
        ...identity(acc.uid, name),
      })
      this.log('info', 'queued dance request', { text })
    }

    for (const [key, acc] of [...this.giftWindow]) {
      if (now - acc.firstTs < gift.mergeWindowSec * 1000) continue
      this.giftWindow.delete(key)
      if (acc.gold >= gift.bigGiftYuan * 1000) {
        const { name, text } = this.giftLine(acc)
        this.push({ prio: PRIORITY.GIFT, kind: 'gift', ts: now, text, ...identity(acc.uid, name) })
        this.log('info', 'queued big gift', { text })
        continue
      }
      // Small gifts accumulate across windows and are sent once they add up.
      let small = this.giftSmall.get(key)
      if (small === undefined) {
        small = { uid: acc.uid, uname: acc.uname, gift: acc.gift, num: 0, gold: 0, firstTs: now }
        this.giftSmall.set(key, small)
      }
      small.num += acc.num
      small.gold += acc.gold
      if (small.gold >= gift.smallFlushYuan * 1000 || small.num >= gift.smallFlushCount) {
        this.giftSmall.delete(key)
        let ready = this.smallReady.get(key)
        if (ready === undefined) {
          ready = {
            uid: small.uid,
            uname: small.uname,
            gift: small.gift,
            num: 0,
            gold: 0,
            firstTs: now,
          }
          this.smallReady.set(key, ready)
        }
        ready.num += small.num
        ready.gold += small.gold
        this.log('info', 'small gifts reached their threshold', {
          gift: ready.gift,
          num: ready.num,
        })
      } else {
        this.log('info', 'small gifts accumulating', { gift: acc.gift, num: small.num })
      }
    }

    for (const [key, small] of [...this.giftSmall]) {
      if (now - small.firstTs > SMALL_GIFT_TTL_MS) this.giftSmall.delete(key)
    }
  }

  // ---- outputs

  /**
   * The next batch for the brain, or null when there is nothing to say. Lines that have waited too long
   * are dropped first. The highest-priority non-empty queue supplies the batch (up to its merge limit);
   * chat is served last, with up to two flushed small gifts appended; the cold-start line comes only
   * when everything else is empty.
   */
  pick(): Batch | null {
    const now = this.now()
    const filter = this.config.filter
    const chat = this.queues[PRIORITY.DANMAKU]
    // Chat that arrived during a song ages from the moment the song ended.
    this.expireHead(
      chat,
      (item) => now - Math.max(item.ts, this.singingSeen) > filter.danmakuMaxAgeSec * 1000
    )
    const songs = this.queues[PRIORITY.SONG]
    this.expireHead(songs, (item) => now - item.ts > this.config.singing.ackMaxAgeSec * 1000)

    const n = filter.maxMerge
    const order: readonly (readonly [Priority, number])[] = [
      [PRIORITY.SC, 1],
      [PRIORITY.GUARD, n],
      [PRIORITY.DANCE, 1],
      [PRIORITY.SONG, n],
      [PRIORITY.GIFT, n],
    ]
    for (const [prio, limit] of order) {
      const q = this.queues[prio]
      if (q.length > 0) return batchOf(q.splice(0, Math.min(limit, q.length)).map(toPart))
    }

    if (chat.length > 0 || this.smallReady.size > 0) {
      const parts = chat.splice(0, Math.min(n, chat.length)).map(toPart)
      for (const key of [...this.smallReady.keys()].slice(0, SMALL_GIFTS_PER_BATCH)) {
        const acc = this.smallReady.get(key)
        this.smallReady.delete(key)
        if (acc === undefined) continue
        const { name, text } = this.giftLine(acc)
        parts.push({ prio: PRIORITY.GIFT, kind: 'gift', text, ...identity(acc.uid, name) })
      }
      return batchOf(parts)
    }

    const cold = this.config.cold
    if (cold.enabled) {
      const idleMinutes = (now - this.activityAt) / MINUTE_MS
      if (idleMinutes >= cold.minutes && (now - this.lastColdAt) / MINUTE_MS >= cold.minutes) {
        this.lastColdAt = now
        const text = FORMATS.cold(Math.trunc(idleMinutes))
        return batchOf([{ prio: PRIORITY.DANMAKU, kind: 'cold', text }])
      }
    }
    return null
  }

  /**
   * Sleep mode answers one chat message at a time: the newest one, marked with the sleep prefix. Older
   * ones wait (and expire after `maxAgeSec`, which is longer than normal because replies are rare). Nothing
   * else is served in sleep mode; paid messages, gifts and songs wait for the mode to end.
   */
  pickSleep(maxAgeSec: number): Batch | null {
    const now = this.now()
    const chat = this.queues[PRIORITY.DANMAKU]
    this.expireHead(chat, (item) => now - item.ts > maxAgeSec * 1000)
    const item = chat.pop()
    if (item === undefined) return null
    const prefix = FORMATS.danmakuPrefix
    const rest = item.text.startsWith(prefix) ? item.text.slice(prefix.length) : item.text
    return batchOf([
      {
        prio: item.prio,
        kind: 'sleep',
        text: FORMATS.sleepPrefix + rest,
        ...identity(item.uid, item.uname),
      },
    ])
  }

  // ---- internals

  private displayName(name: string): string {
    return this.block.hit(name) !== null ? FORMATS.anonymousViewer : name
  }

  /** The gift line for an accumulator, with the sender's name replaced when it is blocklisted. */
  private giftLine(acc: GiftAcc): { name: string; text: string } {
    const name = this.displayName(acc.uname)
    return { name, text: FORMATS.gift(name, acc.num, acc.gift) }
  }

  private push(item: Item): void {
    const q = this.queues[item.prio]
    q.push(item)
    if (q.length > QUEUE_CAP) {
      const lost = q.shift()
      if (lost !== undefined) {
        this.reportDrop('queue_overflow', 'queued line', { prio: lost.prio, text: lost.text })
      }
    }
  }

  private expireHead(q: Item[], expired: (item: Item) => boolean): void {
    for (;;) {
      const head = q[0]
      if (head === undefined || !expired(head)) return
      q.shift()
      this.reportDrop('expired', 'queued line', { prio: head.prio, text: head.text })
    }
  }

  private forgetOldTexts(now: number): void {
    const windowMs = this.config.filter.repeatWindowSec * 1000
    for (const [key, at] of this.recentText) {
      if (now - at > windowMs) this.recentText.delete(key)
    }
  }

  private reportDrop(reason: DropReason, what: string, info: DropInfo): void {
    this.log('info', `dropped ${what} [${reason}]`, { ...info })
    const handler = this.onDrop
    if (handler === undefined) return
    try {
      handler(reason, info)
    } catch (error) {
      this.log('error', 'drop handler threw', { reason, error })
    }
  }
}
