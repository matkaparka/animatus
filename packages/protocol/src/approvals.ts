/**
 * Approvals, as the console sees them: tool calls that need the streamer's yes before they run.
 *
 *   GET  /api/approvals               what waits, and the last decisions
 *   POST /api/approvals/:id/approve   run it, with the arguments exactly as they were queued
 *   POST /api/approvals/:id/deny      drop it
 *
 * Only the console can decide: the stage has no way to send a command, and the audience's text can never put a
 * call in this list (see `decideTool` in tools.ts: an untrusted origin is refused before anything is queued).
 */
import { z } from 'zod'
import { Id } from './common.ts'
import { SourceKind, TrustLevel } from './events.ts'
import { ApprovalStatus } from './tools.ts'

export const ApprovalOrigin = z.object({
  kind: SourceKind,
  trust: TrustLevel,
  name: z.string().max(100).optional(),
})
export type ApprovalOrigin = z.infer<typeof ApprovalOrigin>

export const ApprovalView = z.object({
  id: Id,
  tool: z.string().max(48),
  /** One line saying what it will do, written by the tool, not by the model. */
  summary: z.string().max(300),
  /** The arguments as they will be run (already checked against the tool's schema). */
  args: z.record(z.string(), z.unknown()),
  origin: ApprovalOrigin,
  status: ApprovalStatus,
  requested_at: z.number(),
  expires_at: z.number(),
  decided_at: z.number().optional(),
  /** What happened when it ran (or why it did not). */
  result: z.string().max(400).optional(),
})
export type ApprovalView = z.infer<typeof ApprovalView>

export const ApprovalsResponse = z.object({
  pending: z.array(ApprovalView),
  /** The last decisions, newest first. */
  recent: z.array(ApprovalView),
})
export type ApprovalsResponse = z.infer<typeof ApprovalsResponse>

/** One entry of the audit trail of every tool call the program was asked to make. */
export const ToolAuditEntry = z.object({
  ts: z.number(),
  tool: z.string().max(48),
  origin: ApprovalOrigin,
  decision: z.enum(['ran', 'queued', 'approved', 'denied', 'expired', 'rejected', 'failed']),
  reason: z.string().max(200).optional(),
  id: Id.optional(),
  /** The arguments, cut short. */
  args: z.string().max(300).optional(),
})
export type ToolAuditEntry = z.infer<typeof ToolAuditEntry>
