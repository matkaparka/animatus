/**
 * Tool tiers and approvals.
 *
 * Tools have three tiers:
 *   free      anything may trigger it, including text derived from viewers
 *   approval  needs the host's approval in the console; only trusted or privileged sources may even ask
 *   disabled  never runs
 *
 * The console is the only place approvals happen; it is not in the captured stage window.
 */
import { z } from 'zod'
import { Id } from './common.ts'
import { EventSource, type TrustLevel } from './events.ts'

export const ToolTier = z.enum(['free', 'approval', 'disabled'])
export type ToolTier = z.infer<typeof ToolTier>

export const ToolDefinition = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  tier: ToolTier,
  description: z.string().max(400),
  /** JSON Schema of the arguments. */
  args_schema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
})
export type ToolDefinition = z.infer<typeof ToolDefinition>

export const ToolCallRequest = z.object({
  id: Id,
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  /** The source of the event that led to this call. */
  origin: EventSource,
  turn_id: Id.optional(),
})
export type ToolCallRequest = z.infer<typeof ToolCallRequest>

export const ApprovalStatus = z.enum(['pending', 'approved', 'denied', 'expired'])
export type ApprovalStatus = z.infer<typeof ApprovalStatus>

export type ToolDecision =
  | { action: 'run' }
  | { action: 'queue_approval' }
  | { action: 'reject'; reason: 'disabled' | 'untrusted_origin' | 'unknown_tool' }

/**
 * The single rule that keeps viewers from reaching privileged tools.
 * Anything a viewer's text can lead to must be `free`, and a call whose origin is untrusted can
 * never be queued for approval either, so an injected instruction cannot even put a request in front
 * of the host.
 */
export function decideTool(tier: ToolTier | undefined, origin: TrustLevel): ToolDecision {
  if (tier === undefined) return { action: 'reject', reason: 'unknown_tool' }
  if (tier === 'disabled') return { action: 'reject', reason: 'disabled' }
  if (tier === 'free') return { action: 'run' }
  if (origin === 'untrusted') return { action: 'reject', reason: 'untrusted_origin' }
  return { action: 'queue_approval' }
}
