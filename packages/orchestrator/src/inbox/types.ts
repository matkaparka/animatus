/**
 * Inbox types: the configuration (with its defaults), the batch handed to the brain, and what the router
 * reports about the things it drops.
 *
 * The inbox is the input side of the live-chat pipeline. Viewer events go in through `Router`; `Pacer`
 * decides when the next batch may go to the brain. Both are a behavioural port of a legacy chat bridge, so
 * thresholds, orderings and edge cases match it on purpose (see router.ts for the details worth knowing).
 */
import { z } from 'zod'

// ---- configuration

/** A platform user id. Zero means "unknown" (a guest or a masked account) and is a legal value. */
const Uid = z.number().int().nonnegative()
const NonNegative = z.number().nonnegative()
const Seconds = NonNegative

export const FilterConfigSchema = z.strictObject({
  /** A queued chat message older than this is dropped instead of being read out late. */
  danmakuMaxAgeSec: Seconds.default(30),
  /** At most this many chat messages (or guard, song and gift lines) go into one batch. */
  maxMerge: z.number().int().min(1).default(3),
  /** After removing emotes and punctuation, fewer letters than this is "too short". */
  minChars: z.number().int().nonnegative().default(2),
  /** Longer messages are cut to this many characters and end with an ellipsis. */
  maxChars: z.number().int().min(1).default(80),
  /** The same words within this window count once (only the first is kept). */
  repeatWindowSec: Seconds.default(60),
})

export const GiftConfigSchema = z.strictObject({
  /** The same person sending the same gift within this window is merged into one. */
  mergeWindowSec: Seconds.default(10),
  /** A merged gift worth at least this many yuan is "big" and answered on its own priority. */
  bigGiftYuan: NonNegative.default(10),
  /** Small gifts accumulate until they are worth this many yuan ... */
  smallFlushYuan: NonNegative.default(5),
  /** ... or until there are this many of them, and are then thanked together with chat messages. */
  smallFlushCount: z.number().int().nonnegative().default(10),
  /** Whether free (silver) gifts count at all. */
  includeFreeGifts: z.boolean().default(false),
})

export const ColdConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Minutes without any viewer event before a cold-start line is produced (and the gap between two). */
  minutes: NonNegative.default(3),
})

export const DanceConfigSchema = z.strictObject({
  /** Gift names that mean "please dance". Matched exactly; these are not thanked as ordinary gifts. */
  gifts: z.array(z.string()).default(() => []),
  /** The same person sending the same dance gift within this window is one request. */
  mergeSec: Seconds.default(3),
})

export const SingingConfigSchema = z.strictObject({
  /** Whether chat messages are scanned for song commands at all. */
  enabled: z.boolean().default(true),
  /** Extra user ids that may manage the queue (the room owner is passed in with each message). */
  ownerUids: z.array(Uid).default(() => []),
  /** Whether room moderators may skip and remove songs. */
  adminsCanSkip: z.boolean().default(true),
  /** A queued song-result line older than this is dropped. */
  ackMaxAgeSec: Seconds.default(600),
})

export const PacerConfigSchema = z.strictObject({
  /** The brain must have been idle this long, without a break, before the next batch is sent. */
  idleSettleSec: Seconds.default(1.5),
  /** After a send, wait at most this long for the brain to start working before sending again. */
  busyTimeoutSec: Seconds.default(20),
  /** Minimum gap between two sends. */
  minIntervalSec: Seconds.default(2),
})

export const SleepConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** In sleep mode, at most one reply per this many seconds. */
  replyIntervalSec: Seconds.default(90),
  /** After entering sleep mode, wait this long before the first reply. */
  firstReplyAfterSec: Seconds.default(30),
  /** In sleep mode chat messages wait this long (replies are rare, so longer than the normal limit). */
  maxAgeSec: Seconds.default(180),
})

/** Every field has a default, so `InboxConfigSchema.parse({})` is the stock configuration. */
export const InboxConfigSchema = z.strictObject({
  filter: FilterConfigSchema.prefault({}),
  gift: GiftConfigSchema.prefault({}),
  cold: ColdConfigSchema.prefault({}),
  dance: DanceConfigSchema.prefault({}),
  singing: SingingConfigSchema.prefault({}),
  /** Viewers whose chat messages are ignored outright (bots, the channel's own helper accounts). */
  ignoreUids: z.array(Uid).default(() => []),
  pacer: PacerConfigSchema.prefault({}),
  sleep: SleepConfigSchema.prefault({}),
})

export type InboxConfig = z.infer<typeof InboxConfigSchema>
/** What a caller may pass: any subset of the fields. */
export type InboxConfigInput = z.input<typeof InboxConfigSchema>
export type PacerConfig = z.infer<typeof PacerConfigSchema>
export type SleepConfig = z.infer<typeof SleepConfigSchema>

export function defaultInboxConfig(): InboxConfig {
  return InboxConfigSchema.parse({})
}

// ---- what the router produces

/**
 * The queue an item waits in. The numbers are the legacy priorities; the order in which the queues are
 * served is not simply numeric: song results (5) are served before gifts (3) and chat (4).
 */
export const PRIORITY = { SC: 0, GUARD: 1, DANCE: 2, GIFT: 3, DANMAKU: 4, SONG: 5 } as const
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY]

export type PartKind =
  'superchat' | 'guard' | 'dance' | 'song' | 'gift' | 'danmaku' | 'cold' | 'sleep'

/** One line of a batch, with enough provenance for the brain to attach a source record to it. */
export interface BatchPart {
  prio: Priority
  kind: PartKind
  /** The exact line as sent to the brain. */
  text: string
  /** The platform user id, when it is known (zero and missing ids are left out). */
  uid?: number
  /**
   * The name as it appears in `text`: already cleaned, and the anonymous placeholder when the real name
   * matched the blocklist. Never the raw name of a viewer whose name was filtered.
   */
  uname?: string
}

export interface Batch {
  /** The parts' lines joined with a newline: byte-identical to what the legacy bridge sent. */
  text: string
  parts: BatchPart[]
}

/** A song command found in a chat message. Everything else about it is the song service's business. */
export type SongCommand =
  | { kind: 'request'; uid: number; name: string; keyword: string }
  /** `position` is the 1-based queue position a moderator asked to remove; without it, "my latest song". */
  | { kind: 'cancel'; uid: number; name: string; position?: number }
  | { kind: 'skip'; uid: number; name: string }
  | { kind: 'list'; uid: number; name: string }

/**
 * A chat message a mode may take for itself because it starts with one of the mode's command words (`画 …`).
 * Text and name are already cleaned like every viewer text.
 */
export interface ChatCommandInput {
  uid: number
  uname: string
  /** The whole cleaned message. */
  text: string
  /** True for a room moderator. */
  admin: boolean
  /** True for the room owner (the streamer). */
  owner: boolean
}

export const DROP_REASONS = [
  // chat messages
  'ignored_uid',
  'emote_sticker',
  'pure_emote',
  'too_short',
  'spam',
  'blocked_word',
  'duplicate',
  // gifts
  'free_gift',
  // song commands
  'song_not_allowed',
  'song_rejected',
  // queued lines
  'expired',
  'queue_overflow',
] as const
export type DropReason = (typeof DROP_REASONS)[number]

export interface DropInfo {
  uid?: number
  uname?: string
  /** The text that was dropped (a chat message, a gift name, or a queued line). */
  text?: string
  /** The blocklist entry that matched, for `blocked_word` and `song_rejected`. */
  word?: string
  /** The queue a line was dropped from, for `expired` and `queue_overflow`. */
  prio?: Priority
}

export type DropHandler = (reason: DropReason, info: DropInfo) => void

// ---- inputs

export interface DanmakuInput {
  uid: number
  uname: string
  msg: string
  /** Platform message type; 1 is an emote sticker, which carries no text and is never a command. */
  dmType: number
  /** The sender is a room moderator. */
  admin?: boolean
  /** The channel owner's user id, when known (0 or missing: unknown). */
  roomOwnerUid?: number
}

export interface SuperChatInput {
  uid: number
  uname: string
  /** Price in yuan. */
  price: number
  msg: string
}

export interface GuardInput {
  uid: number
  uname: string
  /** 1, 2 or 3 (governor, admiral, captain); anything else is treated as 3. */
  level: number
  /** Months bought. */
  num: number
}

export interface GiftInput {
  uid: number
  uname: string
  gift: string
  num: number
  /** `'gold'` for paid gifts; anything else (silver) is free. */
  coinType: string
  /** Total price in gold seeds, 1000 to the yuan. Ignored for free gifts. */
  totalCoin: number
}

// ---- logging

export type InboxLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Same shape as the orchestrator's logger; kept local so this module stands alone. */
export type InboxLogger = (
  level: InboxLogLevel,
  msg: string,
  extra?: Record<string, unknown>
) => void
