/**
 * Event bus types.
 *
 * Everything that happens (chat messages, gifts, timers, mode outcomes, screenshots) enters the
 * orchestrator as an event with a source. The source carries a trust level; from it the tool layer
 * decides what the event may trigger. Viewer text is always untrusted.
 */
import { z } from 'zod'
import { Id } from './common.ts'

/**
 * untrusted   text written by an audience member (or fetched from the web); may only trigger free tools
 * trusted     a moderator or another verified role on the platform
 * privileged  the host, via the console, or the system itself
 */
export const TrustLevel = z.enum(['untrusted', 'trusted', 'privileged'])
export type TrustLevel = z.infer<typeof TrustLevel>

export const SourceKind = z.enum(['viewer', 'moderator', 'host', 'system', 'agent', 'plugin', 'web'])
export type SourceKind = z.infer<typeof SourceKind>

export const EventSource = z.object({
  kind: SourceKind,
  trust: TrustLevel,
  platform: z.string().max(32).optional(),
  uid: z.string().max(64).optional(),
  name: z.string().max(100).optional(),
  roles: z.array(z.string().max(32)).max(16).default([]),
})
export type EventSource = z.infer<typeof EventSource>

/** Trust is a function of the kind, so nobody can write a viewer event with a privileged source. */
export function trustFor(kind: SourceKind): TrustLevel {
  switch (kind) {
    case 'host':
    case 'system':
      return 'privileged'
    case 'moderator':
      return 'trusted'
    default:
      return 'untrusted'
  }
}

export const makeSource = (
  kind: SourceKind,
  extra: Partial<Omit<EventSource, 'kind' | 'trust'>> = {}
): EventSource => ({ kind, trust: trustFor(kind), roles: [], ...extra })

const Base = {
  id: Id,
  /** Epoch milliseconds. */
  ts: z.number(),
  source: EventSource,
}

export const DanmakuEvent = z.object({
  ...Base,
  type: z.literal('danmaku'),
  text: z.string().max(500),
  room: z.string().max(64).optional(),
})

export const GiftEvent = z.object({
  ...Base,
  type: z.literal('gift'),
  gift_name: z.string().max(100),
  count: z.number().int().min(1),
  price_cny: z.number().min(0).optional(),
})

export const GuardEvent = z.object({
  ...Base,
  type: z.literal('guard'),
  /** 1 governor, 2 admiral, 3 captain (Bilibili naming). */
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  months: z.number().int().min(1).default(1),
})

export const SuperChatEvent = z.object({
  ...Base,
  type: z.literal('superchat'),
  text: z.string().max(500),
  price_cny: z.number().min(0),
})

export const EnterEvent = z.object({ ...Base, type: z.literal('enter') })

export const ScreenshotEvent = z.object({
  ...Base,
  type: z.literal('screenshot'),
  /** Reference into the orchestrator's temp store, not the pixels. */
  image_ref: Id,
})

/** Internal notices: "dance finished", "song finished", timers, mode changes. Always system-sourced. */
export const SystemEvent = z.object({
  ...Base,
  type: z.literal('system'),
  name: z.string().max(64),
  data: z.record(z.string(), z.unknown()).default({}),
})

export const AnimatusEvent = z.discriminatedUnion('type', [
  DanmakuEvent,
  GiftEvent,
  GuardEvent,
  SuperChatEvent,
  EnterEvent,
  ScreenshotEvent,
  SystemEvent,
])
export type AnimatusEvent = z.infer<typeof AnimatusEvent>
