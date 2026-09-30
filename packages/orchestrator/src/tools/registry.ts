/**
 * The tools the model may ask for. A tool is a name, a schema for its arguments, one line that tells the streamer what
 * it will do, and the code that does it. Whether a call may run is not the tool's business: the gate decides that from
 * the tool's tier and the trust of whoever the call came from (see `gate.ts`).
 */
import type { z } from 'zod'
import type { EventSource, ToolTier } from '@animatus/protocol'

export interface ToolContext {
  /** Who the call came from: the source of the turn that led to it. */
  origin: EventSource
  turnId?: string
  now(): number
}

export interface ToolSpec<A = unknown> {
  /** Lower case letters, digits and `_`, starting with a letter. */
  name: string
  /** One sentence for the model: what it is for. */
  description: string
  /** The arguments in one line for the model, e.g. `{"text": "...", "seconds": 8}`. */
  usage: string
  tier: ToolTier
  /**
   * The lowest tier the configuration may give it. A tool that changes what the program does (enters a mode, writes
   * memory) has `approval` here: the operator can switch it off, never make it free.
   */
  floor?: 'free' | 'approval'
  /** Checked before anything else, even before a call is queued, so that garbage never reaches the streamer. */
  schema: z.ZodType<A>
  /** What it will do with these arguments, one line, written by the tool: shown in the approval. */
  summarize(args: A): string
  /** Does it. The returned text (short) is the result the streamer sees. */
  run(args: A, ctx: ToolContext): Promise<string | void>
}

const NAME = /^[a-z][a-z0-9_]{0,47}$/

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>()

  register<A>(spec: ToolSpec<A>): void {
    if (!NAME.test(spec.name)) throw new Error(`not a tool name: ${JSON.stringify(spec.name)}`)
    if (this.tools.has(spec.name)) throw new Error(`tool "${spec.name}" is registered twice`)
    this.tools.set(spec.name, spec as ToolSpec)
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name)
  }

  list(): ToolSpec[] {
    return [...this.tools.values()]
  }
}

const RANK: Record<ToolTier, number> = { free: 0, approval: 1, disabled: 2 }

/** The tier a tool really has: what the configuration says, but never below the tool's floor. */
export function effectiveTier(
  spec: Pick<ToolSpec, 'tier' | 'floor'>,
  configured: ToolTier | undefined
): ToolTier {
  const wanted = configured ?? spec.tier
  const floor: ToolTier = spec.floor ?? 'free'
  return RANK[wanted] >= RANK[floor] ? wanted : floor
}
