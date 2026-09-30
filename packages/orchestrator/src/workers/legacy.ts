/**
 * An older game agent behind the Worker protocol.
 *
 * The two agents this program grew out of (a Civilization VI player and a Minecraft bot) speak a slightly different link:
 * `GET /status`, `GET /events?after=`, `GET /trace`, `POST /command`, `/pause`, `/forget`, on a port of their own choosing.
 * This adapter reads that link and says it in the terms of `worker.ts`, so the game mode has one thing to talk to and the
 * agents need no change.
 *
 * What it cannot give them: an epoch. It makes one up (a new one whenever the agent's newest event number goes backwards,
 * which is what a restart looks like from outside), so a restart that has produced more events than the reader had already
 * seen is not noticed, and the first ones of the new run are missed. An agent that speaks the real protocol has no such gap.
 */
import { randomBytes } from 'node:crypto'
import { WORKER_MAX_COMMAND_CHARS, WorkerEventsResponse, WorkerState } from '@animatus/protocol'
import type { WorkerEvent, WorkerFacts } from '@animatus/protocol'
import { z } from 'zod'
import { WorkerError, WorkerHttp } from './client.ts'
import type { WorkerApi, WorkerHttpOptions } from './client.ts'

/** What the older agents send; only what is used is checked, the rest (a Minecraft bot has many fields) is passed over. */
const LegacyStatus = z
  .object({
    game: z.string().optional(),
    online: z.boolean().optional(),
    paused: z.boolean().optional(),
    summary: z.string().nullish(),
    turn: z.number().nullish(),
    username: z.string().nullish(),
    planner: z
      .object({
        thinking: z.boolean().optional(),
        executing: z.unknown().optional(),
        pending: z.number().optional(),
        givenUp: z.boolean().optional(),
      })
      .optional(),
    lastCommand: z.object({ text: z.string(), at: z.number() }).nullish(),
    latestEventSeq: z.number().optional(),
  })
  .passthrough()

const LegacyEvent = z.object({
  seq: z.number().int().min(1),
  at: z.number(),
  kind: z.string(),
  text: z.string(),
  urgency: z.enum(['immediate', 'soon', 'later']).catch('later'),
})
const LegacyEvents = z.object({ events: z.array(LegacyEvent), latest: z.number().optional() })

/** How many events the older links return at most in one answer: if they returned that many, there may be more. */
const LEGACY_PAGE = 50

const newEpoch = (): string => `legacy-${randomBytes(6).toString('hex')}`

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A short text for what the agent is doing, whatever shape it sent. */
function describeExecuting(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return cut(v, 200)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['text', 'summary', 'name', 'tool', 'action', 'kind'])
      if (typeof o[k] === 'string') return cut(o[k], 200)
    try {
      return cut(JSON.stringify(v), 200)
    } catch {
      return null
    }
  }
  return cut(String(v), 200)
}

const scalar = (v: unknown): string | number | boolean | null | undefined =>
  typeof v === 'string'
    ? cut(v, 200)
    : typeof v === 'number' || typeof v === 'boolean'
      ? v
      : v === null
        ? null
        : undefined

/** The few things worth showing from what a game agent sends besides the common part. */
function factsOf(status: Record<string, unknown>): WorkerFacts {
  const facts: WorkerFacts = {}
  for (const key of [
    'turn',
    'username',
    'health',
    'food',
    'dimension',
    'gameMode',
    'isDay',
    'heldItem',
  ]) {
    const v = scalar(status[key])
    if (v !== undefined && v !== null) facts[key] = v
  }
  const pos = status.position
  if (pos && typeof pos === 'object') {
    const p = pos as Record<string, unknown>
    const parts = ['x', 'y', 'z'].map((k) =>
      typeof p[k] === 'number' ? Math.round(p[k] as number) : null
    )
    if (parts.every((n) => n !== null)) facts.position = parts.join(', ')
  }
  if (Array.isArray(status.inventory)) facts.inventory_items = status.inventory.length
  if (Array.isArray(status.otherPlayers)) facts.other_players = status.otherPlayers.length
  return facts
}

export class LegacyLinkClient implements WorkerApi {
  readonly kind = 'legacy' as const
  private readonly http: WorkerHttp
  private epoch = newEpoch()
  private latest = 0

  /** `worker` is what to call it when the agent does not say (a Minecraft bot does not send `game`). */
  constructor(o: WorkerHttpOptions & { worker: string }) {
    this.http = new WorkerHttp(o)
    this.worker = o.worker
  }
  private readonly worker: string

  /** The agent's newest event number went backwards: it was restarted. */
  private seeLatest(latest: number): void {
    if (latest < this.latest) this.epoch = newEpoch()
    this.latest = latest
  }

  async state(): Promise<WorkerState> {
    const raw = await this.http.call('GET', '/status')
    const parsed = LegacyStatus.safeParse(raw)
    if (!parsed.success)
      throw new WorkerError(
        'bad_response',
        'the status of the older agent is not what its link says'
      )
    const s = parsed.data
    const latest = Math.max(0, Math.trunc(s.latestEventSeq ?? 0))
    this.seeLatest(latest)
    const worker = /^[a-z][a-z0-9_-]{0,31}$/.test(s.game ?? '') ? (s.game as string) : this.worker
    return WorkerState.parse({
      protocol: 1,
      worker,
      epoch: this.epoch,
      online: s.online === true,
      paused: s.paused === true,
      planner: {
        thinking: s.planner?.thinking === true,
        executing: describeExecuting(s.planner?.executing),
        pending: Math.max(0, Math.trunc(s.planner?.pending ?? 0)),
        given_up: s.planner?.givenUp === true,
      },
      last_command: s.lastCommand
        ? { text: cut(s.lastCommand.text, WORKER_MAX_COMMAND_CHARS), at: s.lastCommand.at }
        : null,
      latest_seq: latest,
      summary: cut(s.summary ?? '', 600),
      facts: factsOf(s),
    })
  }

  async events(after: number, epoch: string | null): Promise<WorkerEventsResponse> {
    // a reader that names another epoch has the numbers of another run: it is told to start over
    const stale = epoch !== null && epoch !== this.epoch
    const from = stale ? 0 : Math.max(0, Math.trunc(after))
    const raw = await this.http.call('GET', `/events?after=${from}`)
    const parsed = LegacyEvents.safeParse(raw)
    if (!parsed.success)
      throw new WorkerError(
        'bad_response',
        'the events of the older agent are not what its link says'
      )
    const latest = Math.max(0, Math.trunc(parsed.data.latest ?? 0))
    this.seeLatest(latest)
    // the restart may have been seen just now: then the caller's epoch is stale after all
    const reset = stale || (epoch !== null && epoch !== this.epoch)
    const events: WorkerEvent[] = parsed.data.events.map((e) => ({
      seq: e.seq,
      at: e.at,
      kind: cut(e.kind, 40) || 'event',
      text: cut(e.text, 600),
      urgency: e.urgency,
    }))
    if (reset && from !== 0) {
      // asked from the middle of a run that is gone: read again from the start of this one
      return { ...(await this.events(0, this.epoch)), reset: true }
    }
    return WorkerEventsResponse.parse({
      epoch: this.epoch,
      latest,
      reset,
      events,
      more: events.length >= LEGACY_PAGE,
    })
  }

  async command(text: string): Promise<void> {
    const t = text.trim()
    if (t === '' || t.length > WORKER_MAX_COMMAND_CHARS)
      throw new WorkerError(
        'bad_request',
        `a directive is 1 to ${WORKER_MAX_COMMAND_CHARS} characters`
      )
    await this.http.call('POST', '/command', { text: t })
  }

  async pause(paused: boolean): Promise<boolean> {
    const r = await this.http.call('POST', '/pause', { paused })
    return typeof r === 'object' && r !== null && 'paused' in r
      ? (r as { paused: unknown }).paused === true
      : paused
  }

  async forget(): Promise<void> {
    await this.http.call('POST', '/forget', {})
  }

  async trace(limit = 20): Promise<unknown[]> {
    const r = await this.http.call(
      'GET',
      `/trace?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}`
    )
    return Array.isArray(r) ? r.slice(-200) : []
  }
}
