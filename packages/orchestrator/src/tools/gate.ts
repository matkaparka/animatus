/**
 * The gate every tool call goes through. There is no other way to run a tool.
 *
 * A call is a name, arguments and an origin (who wrote the text that led to it). The gate:
 *   1. refuses a tool it does not know;
 *   2. works out the tool's tier (the configuration may lower a tool's privilege, never below its floor);
 *   3. applies the one rule of `decideTool`: free tools run, approval tools are queued for the streamer, disabled ones never run,
 *      and a call whose origin is untrusted is refused before anything is queued, so an injected instruction cannot
 *      even put a request in front of the streamer;
 *   4. checks the arguments against the tool's own schema, before running and before queueing;
 *   5. limits how often one origin may ask;
 *   6. writes every decision to the audit trail.
 * A queued call is run only by `approve`, with the arguments exactly as they were queued, once, and only before it expires.
 */
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { decideTool } from '@animatus/protocol'
import type {
  ApprovalOrigin,
  ApprovalView,
  EventSource,
  ToolAuditEntry,
  ToolTier,
} from '@animatus/protocol'
import { effectiveTier } from './registry.ts'
import type { ToolRegistry, ToolSpec } from './registry.ts'

export type RejectReason =
  'unknown_tool' | 'disabled' | 'untrusted_origin' | 'bad_args' | 'rate_limited' | 'queue_full'

export type GateResult =
  | { status: 'ran'; id: string; result?: string }
  | { status: 'failed'; id: string; error: string }
  | { status: 'queued'; id: string }
  | { status: 'rejected'; reason: RejectReason; detail?: string }

export type DecideResult =
  | { ok: true; view: ApprovalView }
  | { ok: false; code: 'not_found' | 'not_pending' | 'expired'; message: string }

export interface GateOptions {
  registry: ToolRegistry
  /** Tier overrides from the configuration, by tool name. */
  tiers?: Readonly<Record<string, ToolTier>>
  /** How long a queued call waits for a decision. Default 10 minutes. */
  ttlMs?: number
  /** Calls waiting at once. Default 20. */
  maxPending?: number
  /** Calls one origin may ask for per minute (every attempt counts). Default 20. */
  perMinute?: number
  /** Decisions kept for the console. Default 50. */
  keepRecent?: number
  audit?: (entry: ToolAuditEntry) => void
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

type Events = { change: [] }

interface Pending {
  view: ApprovalView
  spec: ToolSpec
  args: unknown
  source: EventSource
  turnId?: string
}

const originOf = (s: EventSource): ApprovalOrigin => ({
  kind: s.kind,
  trust: s.trust,
  ...(s.name ? { name: s.name.slice(0, 100) } : {}),
})

const shortArgs = (args: unknown): string => {
  try {
    return JSON.stringify(args).slice(0, 300)
  } catch {
    return '(not JSON)'
  }
}

export class ToolGate extends EventEmitter<Events> {
  private readonly o: Required<
    Pick<GateOptions, 'ttlMs' | 'maxPending' | 'perMinute' | 'keepRecent'>
  > &
    GateOptions
  private readonly pendingById = new Map<string, Pending>()
  private readonly recentViews: ApprovalView[] = []
  private readonly attempts = new Map<string, number[]>()
  private readonly now: () => number

  constructor(opts: GateOptions) {
    super()
    this.o = { ttlMs: 600_000, maxPending: 20, perMinute: 20, keepRecent: 50, ...opts }
    this.now = opts.now ?? Date.now
  }

  /** The tier of a tool as it is now (unknown tool: undefined). */
  tierOf(name: string): ToolTier | undefined {
    const spec = this.o.registry.get(name)
    return spec ? effectiveTier(spec, this.o.tiers?.[name]) : undefined
  }

  /** The tools a call with this trust could get somewhere with, for telling the model which ones it has. */
  usableBy(trust: EventSource['trust']): ToolSpec[] {
    return this.o.registry.list().filter((spec) => {
      if (spec.available?.() === false) return false
      const tier = effectiveTier(spec, this.o.tiers?.[spec.name])
      return decideTool(tier, trust).action !== 'reject'
    })
  }

  private audit(entry: Omit<ToolAuditEntry, 'ts'>): void {
    try {
      this.o.audit?.({ ts: this.now(), ...entry })
    } catch {
      // a broken audit sink must not decide what runs
    }
  }

  private limited(source: EventSource): boolean {
    const key = `${source.kind}:${source.uid ?? source.name ?? ''}`
    const t = this.now()
    const recent = (this.attempts.get(key) ?? []).filter((x) => t - x < 60_000)
    recent.push(t)
    this.attempts.set(key, recent)
    if (this.attempts.size > 500)
      for (const [k, v] of this.attempts)
        if (v.every((x) => t - x >= 60_000)) this.attempts.delete(k)
    return recent.length > this.o.perMinute
  }

  /** Ask for a tool to be run. Never throws. */
  async request(req: {
    tool: string
    args: unknown
    origin: EventSource
    turnId?: string
  }): Promise<GateResult> {
    this.sweep()
    const origin = originOf(req.origin)
    const base = { tool: req.tool.slice(0, 48), origin, args: shortArgs(req.args) }
    const reject = (reason: RejectReason, detail?: string): GateResult => {
      this.audit({
        ...base,
        decision: 'rejected',
        reason: detail ? `${reason}: ${detail}` : reason,
      })
      return { status: 'rejected', reason, ...(detail ? { detail } : {}) }
    }

    const spec = this.o.registry.get(req.tool)
    if (!spec) return reject('unknown_tool')
    const tier = effectiveTier(spec, this.o.tiers?.[spec.name])
    const decision = decideTool(tier, req.origin.trust)
    if (decision.action === 'reject') return reject(decision.reason)
    if (this.limited(req.origin)) return reject('rate_limited')

    const parsed = spec.schema.safeParse(req.args ?? {})
    if (!parsed.success)
      return reject('bad_args', parsed.error.issues[0]?.message.slice(0, 120) ?? 'not valid')
    const args = parsed.data as unknown

    if (decision.action === 'run') {
      const id = this.newId()
      try {
        const result = await spec.run(args, {
          origin: req.origin,
          ...(req.turnId ? { turnId: req.turnId } : {}),
          now: this.now,
        })
        this.audit({
          ...base,
          decision: 'ran',
          id,
          ...(result ? { reason: String(result).slice(0, 200) } : {}),
        })
        return { status: 'ran', id, ...(result ? { result: String(result) } : {}) }
      } catch (e) {
        const error = (e as Error).message.split('\n')[0]?.slice(0, 200) ?? 'failed'
        this.audit({ ...base, decision: 'failed', id, reason: error })
        return { status: 'failed', id, error }
      }
    }

    // queue_approval
    if (this.pendingById.size >= this.o.maxPending) return reject('queue_full')
    const id = this.newId()
    const t = this.now()
    const view: ApprovalView = {
      id,
      tool: spec.name,
      summary: spec.summarize(args as never).slice(0, 300),
      args: structuredClone(args) as Record<string, unknown>,
      origin,
      status: 'pending',
      requested_at: t,
      expires_at: t + this.o.ttlMs,
    }
    this.pendingById.set(id, {
      view,
      spec,
      args,
      source: req.origin,
      ...(req.turnId ? { turnId: req.turnId } : {}),
    })
    this.audit({ ...base, decision: 'queued', id })
    this.emit('change')
    return { status: 'queued', id }
  }

  private newId(): string {
    return `ap-${randomBytes(6).toString('hex')}`
  }

  private remember(view: ApprovalView): void {
    this.recentViews.unshift(view)
    if (this.recentViews.length > this.o.keepRecent) this.recentViews.length = this.o.keepRecent
  }

  /** Expire what waited too long. Called on every access, so nothing depends on a timer. */
  sweep(): void {
    const t = this.now()
    let changed = false
    for (const [id, p] of [...this.pendingById]) {
      if (p.view.expires_at > t) continue
      this.pendingById.delete(id)
      p.view.status = 'expired'
      p.view.decided_at = t
      this.remember(p.view)
      this.audit({ tool: p.view.tool, origin: p.view.origin, decision: 'expired', id })
      changed = true
    }
    if (changed) this.emit('change')
  }

  pending(): ApprovalView[] {
    this.sweep()
    return [...this.pendingById.values()].map((p) => p.view)
  }

  recent(): ApprovalView[] {
    this.sweep()
    return [...this.recentViews]
  }

  /** The streamer says yes: it runs now, with the queued arguments, once. */
  async approve(id: string): Promise<DecideResult> {
    this.sweep()
    const p = this.pendingById.get(id)
    if (!p) return this.gone(id)
    // taken out of the queue before it runs: a second approval of the same call finds nothing
    this.pendingById.delete(id)
    p.view.status = 'approved'
    p.view.decided_at = this.now()
    try {
      const result = await p.spec.run(p.args, {
        origin: p.source,
        ...(p.turnId ? { turnId: p.turnId } : {}),
        now: this.now,
      })
      p.view.result = String(result ?? 'done').slice(0, 400)
      this.audit({
        tool: p.view.tool,
        origin: p.view.origin,
        decision: 'approved',
        id,
        ...(result ? { reason: String(result).slice(0, 200) } : {}),
      })
    } catch (e) {
      const error = (e as Error).message.split('\n')[0]?.slice(0, 200) ?? 'failed'
      p.view.result = `failed: ${error}`
      this.audit({
        tool: p.view.tool,
        origin: p.view.origin,
        decision: 'failed',
        id,
        reason: error,
      })
    }
    this.remember(p.view)
    this.emit('change')
    return { ok: true, view: p.view }
  }

  /** The streamer says no. */
  deny(id: string): DecideResult {
    this.sweep()
    const p = this.pendingById.get(id)
    if (!p) return this.gone(id)
    this.pendingById.delete(id)
    p.view.status = 'denied'
    p.view.decided_at = this.now()
    this.remember(p.view)
    this.audit({ tool: p.view.tool, origin: p.view.origin, decision: 'denied', id })
    this.emit('change')
    return { ok: true, view: p.view }
  }

  private gone(id: string): DecideResult {
    const seen = this.recentViews.find((v) => v.id === id)
    if (!seen) return { ok: false, code: 'not_found', message: 'there is no such request' }
    if (seen.status === 'expired')
      return { ok: false, code: 'expired', message: 'that request waited too long and expired' }
    return { ok: false, code: 'not_pending', message: `that request was already ${seen.status}` }
  }
}
