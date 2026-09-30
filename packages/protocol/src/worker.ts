/**
 * The Worker protocol: how the orchestrator talks to an agent that plays a game (or does any long job) on its own
 * while the character comments on it.
 *
 * A worker is an ordinary plugin (a process the supervisor starts, on a port the orchestrator picks) that also
 * serves these routes on 127.0.0.1. The orchestrator polls; the worker never calls the orchestrator or the stage.
 *
 *   GET  /worker/state                      what the worker is doing now
 *   GET  /worker/events?after=<seq>&epoch=  what happened since; the epoch says which run of the worker the seq is from
 *   GET  /worker/trace?limit=<n>            the last steps it took, for diagnosis (free-form)
 *   POST /worker/command {text}             a directive from the character (409 while not in a game)
 *   POST /worker/pause {paused}             pause or resume; the worker starts paused
 *   POST /worker/forget                     drop the notes and standing directives it carries
 *
 * What the two older agents did differently (and this fixes): they started in different states, `/pause` and `/forget` meant
 * different things, and after a restart the event numbers began again at 1 with nothing to say so, so a reader that had
 * seen 200 events missed the first 200 of the new run. Now every run has an `epoch`, the numbers are only meaningful inside
 * one, and a reader that names a different epoch is told to start over.
 */
import { z } from 'zod'

export const WORKER_PROTOCOL = 1 as const
export const WORKER_MAX_COMMAND_CHARS = 300
export const WORKER_EVENTS_PER_RESPONSE = 50

/** When the character should speak of an event: at once, at the next quiet moment, or only as background. */
export const WorkerUrgency = z.enum(['immediate', 'soon', 'later'])
export type WorkerUrgency = z.infer<typeof WorkerUrgency>

export const WorkerId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)

/** A new random string every time the worker process starts. Only compared for equality. */
export const WorkerEpoch = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/)
export type WorkerEpoch = z.infer<typeof WorkerEpoch>

export const WorkerEvent = z.object({
  /** 1, 2, 3 ... inside one epoch. */
  seq: z.number().int().min(1),
  /** Milliseconds since the Unix epoch. */
  at: z.number(),
  /** A short word for what kind of thing it is (`turn`, `death`, `command`). */
  kind: z.string().min(1).max(40),
  text: z.string().max(600),
  urgency: WorkerUrgency,
})
export type WorkerEvent = z.infer<typeof WorkerEvent>

/** What is special to this game, kept small: a few numbers and words for the console and the model's prompt. */
export const WorkerFacts = z
  .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
  .refine((r) => Object.keys(r).length <= 30, 'at most 30 facts')
export type WorkerFacts = z.infer<typeof WorkerFacts>

export const WorkerState = z.object({
  protocol: z.literal(WORKER_PROTOCOL),
  worker: WorkerId,
  epoch: WorkerEpoch,
  /** In a game (connected to whatever it plays). */
  online: z.boolean(),
  /** Paused workers make no decisions and take no steps; events may still arrive (the game goes on). */
  paused: z.boolean(),
  planner: z.object({
    thinking: z.boolean(),
    /** What it is doing right now, in a few words, or null. */
    executing: z.string().max(200).nullable(),
    /** Directives that arrived and were not looked at yet. */
    pending: z.number().int().min(0),
    /** It tried and gave up on the current goal. */
    given_up: z.boolean(),
  }),
  last_command: z
    .object({ text: z.string().max(WORKER_MAX_COMMAND_CHARS), at: z.number() })
    .nullable(),
  latest_seq: z.number().int().min(0),
  /** One line about how the game stands, for the model to be told. */
  summary: z.string().max(600),
  facts: WorkerFacts,
})
export type WorkerState = z.infer<typeof WorkerState>

export const WorkerEventsResponse = z.object({
  epoch: WorkerEpoch,
  latest: z.number().int().min(0),
  /**
   * True when the epoch the caller named is not this worker's (or it named none and asked from the middle): the caller's
   * cursor means nothing, and the events start from the beginning of this run.
   */
  reset: z.boolean(),
  /** In order, oldest first, at most `WORKER_EVENTS_PER_RESPONSE`. */
  events: z.array(WorkerEvent).max(WORKER_EVENTS_PER_RESPONSE),
  /** There are more after the last one: ask again from its `seq`. */
  more: z.boolean(),
})
export type WorkerEventsResponse = z.infer<typeof WorkerEventsResponse>

export const WorkerCommandRequest = z.object({
  text: z.string().trim().min(1).max(WORKER_MAX_COMMAND_CHARS),
})
export type WorkerCommandRequest = z.infer<typeof WorkerCommandRequest>

export const WorkerPauseRequest = z.object({ paused: z.boolean() })
export type WorkerPauseRequest = z.infer<typeof WorkerPauseRequest>

/** The answer to a command, a pause and a forget. */
export const WorkerAck = z.object({ ok: z.literal(true), epoch: WorkerEpoch, paused: z.boolean() })
export type WorkerAck = z.infer<typeof WorkerAck>

export const WORKER_ERROR_CODES = [
  'bad_request',
  'not_online',
  'not_found',
  'too_large',
  'forbidden_host',
] as const
export const WorkerErrorBody = z.object({
  ok: z.literal(false),
  code: z.enum(WORKER_ERROR_CODES),
  message: z.string().max(300),
})
export type WorkerErrorBody = z.infer<typeof WorkerErrorBody>
