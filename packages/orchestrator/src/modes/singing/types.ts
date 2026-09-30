/**
 * The song service's answers, as this program reads them (the contract is in docs/mode-sing.md, the code in
 * plugins/singing). An answer that does not fit is a `garbage` error of the client, not something to guess about;
 * fields the service adds later are ignored.
 */
import { z } from 'zod'

export const SongView = z.object({
  id: z.string(),
  title: z.string(),
  artists: z.array(z.string()).default([]),
  duration: z.number().default(0),
})
export type SongView = z.infer<typeof SongView>

export const ItemState = z.enum([
  'queued',
  'downloading',
  'processing',
  'ready',
  'playing',
  'failed',
])
export type ItemState = z.infer<typeof ItemState>

/** One entry of the queue: waiting, being sung, or failed a moment ago. */
export const QueueItem = z.object({
  qid: z.number().int(),
  song_id: z.string(),
  title: z.string(),
  artists: z.array(z.string()).default([]),
  duration: z.number().default(0),
  requester_uid: z.string().default(''),
  requester_name: z.string().default(''),
  state: ItemState,
  cached: z.boolean().default(false),
  /** Why it failed, in words for the audience. */
  reason: z.string().optional(),
  /** Why it failed, for the operator (a tool's own message). */
  error: z.string().optional(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  warnings: z.array(z.string()).default([]),
  transpose: z.number().nullable().optional(),
  requested_at: z.number().default(0),
  started_at: z.number().optional(),
  failed_at: z.number().optional(),
})
export type QueueItem = z.infer<typeof QueueItem>

export const QueueView = z.object({
  current: QueueItem.nullable(),
  items: z.array(QueueItem),
  failed: z.array(QueueItem).default([]),
  worker: z.object({
    state: z.string(),
    qid: z.number().optional(),
    title: z.string().optional(),
    step: z.string().optional(),
  }),
  source: z.object({
    kind: z.string(),
    halted: z
      .object({ reason: z.string().optional(), time: z.string().optional() })
      .nullable()
      .optional(),
  }),
  songs_dir: z.string(),
  limits: z.object({ max_per_user: z.number(), max_len: z.number() }),
})
export type QueueView = z.infer<typeof QueueView>

export const RequestResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('queued'),
    qid: z.number().int(),
    song: SongView,
    position: z.number().int(),
    cached: z.boolean(),
    duplicate: z.boolean().optional(),
  }),
  z.object({
    status: z.literal('rejected'),
    code: z.string(),
    reason: z.string(),
    song: SongView.optional(),
    duplicate: z.boolean().optional(),
  }),
])
export type RequestResult = z.infer<typeof RequestResult>

export const LyricLine = z.object({ t: z.number().min(0), text: z.string() })

export const ClaimResult = z.object({
  item: QueueItem.nullable(),
  pending: z.number().optional(),
  /** Where the two tracks are, relative to the songs library. */
  files: z.object({ dir: z.string(), vocals: z.string(), inst: z.string() }).optional(),
  lyrics: z.array(LyricLine).default([]),
  duration: z.number().default(0),
  transpose: z.number().nullable().optional(),
  warnings: z.array(z.string()).default([]),
})
export type ClaimResult = z.infer<typeof ClaimResult>

/** What `done`, `skip`, `cancel` and `remove` answer: it worked (with the entry), or why there was nothing to do. */
export const ActionResult = z.object({
  ok: z.boolean(),
  code: z.string().optional(),
  reason: z.string().optional(),
  item: QueueItem.optional(),
  was_playing: z.boolean().optional(),
})
export type ActionResult = z.infer<typeof ActionResult>

export const AbandonResult = z.object({ ok: z.boolean(), removed: z.boolean().default(false) })

export const OkResult = z.object({ ok: z.boolean() })

/** How a claimed song ended, as the service records it. `released` puts it back at the head of the queue. */
export type Outcome = 'done' | 'skipped' | 'stopped' | 'interrupted' | 'failed' | 'released'
