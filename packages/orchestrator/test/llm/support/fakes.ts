/**
 * In-memory providers and a manual clock for the gateway tests. No network, no timers.
 */
import { LlmError } from '../../../src/llm/types.ts'
import type {
  LlmDelta,
  LlmErrorCode,
  LlmErrorInit,
  LlmProvider,
  LlmRequest,
} from '../../../src/llm/types.ts'

export type Behaviour = (req: LlmRequest, call: number) => AsyncIterable<LlmDelta>

export class FakeProvider implements LlmProvider {
  readonly kind = 'fake'
  calls = 0
  /** How many of its streams were closed before they finished (the consumer walked away). */
  abandoned = 0
  readonly requests: LlmRequest[] = []
  redact?: (text: string) => string
  closed = false

  constructor(
    readonly id: string,
    private readonly behaviour: Behaviour
  ) {}

  stream(req: LlmRequest): AsyncIterable<LlmDelta> {
    this.calls++
    this.requests.push(req)
    return this.behaviour(req, this.calls)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

export const fake = (
  id: string,
  behaviour: Behaviour,
  redact?: (text: string) => string
): FakeProvider => {
  const p = new FakeProvider(id, behaviour)
  if (redact) p.redact = redact
  return p
}

export const text = (t: string): LlmDelta => ({ type: 'text', text: t })
export const thinking = (t: string): LlmDelta => ({ type: 'thinking', text: t })
export const usage = (inputTokens?: number, outputTokens?: number): LlmDelta => ({
  type: 'usage',
  ...(inputTokens !== undefined ? { inputTokens } : {}),
  ...(outputTokens !== undefined ? { outputTokens } : {}),
})

/** Yields the given deltas (strings become text deltas), then finishes normally. */
export const says = (...items: (string | LlmDelta)[]): Behaviour =>
  async function* () {
    for (const item of items) yield typeof item === 'string' ? text(item) : item
  }

/** Yields the deltas, then throws. Before the first text delta this is a failover-eligible failure. */
export const failsAfter = (
  items: (string | LlmDelta)[],
  code: LlmErrorCode,
  init: Partial<LlmErrorInit> = {},
  message?: string,
  providerId = 'x'
): Behaviour =>
  async function* () {
    for (const item of items) yield typeof item === 'string' ? text(item) : item
    throw new LlmError(code, message ?? `${code} failure`, { providerId, ...init })
  }

export const fails = (
  code: LlmErrorCode,
  init: Partial<LlmErrorInit> = {},
  message?: string,
  providerId = 'x'
): Behaviour => failsAfter([], code, init, message, providerId)

/** A stream that ends with no text at all. */
export const silent: Behaviour = async function* () {}

/** Runs `inner`, and counts a stream that was closed before it finished. */
export function tracked(provider: FakeProvider, inner: Behaviour): Behaviour {
  return async function* (req, call) {
    let finished = false
    try {
      yield* inner(req, call)
      finished = true
    } finally {
      if (!finished) provider.abandoned++
    }
  }
}

/** Manual clock in ms. */
export function clock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    get t() {
      return t
    },
  }
}

/** A promise you resolve by hand. */
export function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

export const req = (extra: Partial<LlmRequest> = {}): LlmRequest => ({
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
})
