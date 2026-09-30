/**
 * Game mode: a game agent (a program with its own model and tools) plays a game, and the character comments on what happens
 * and steers it with short directives. Ported from the legacy page's self-play module, on the Worker protocol
 * (docs/workers.md, docs/mode-game.md).
 *
 * Two loops run while the mode is on, and never wait for each other:
 *
 *   poll     every `poll_sec`: the agent's state and its new events. A restart of the agent (a new epoch) drops what the mode
 *            knew and is told to the model in its next comment. A failed poll raises one alarm, waits longer each time, and
 *            clears the alarm when the agent answers again.
 *   speak    when an event is due: wait until the voice is free (a viewer's reply comes first and is never cut short), tell the
 *            model in one message what is due, and wait for the next. `immediate` events are due at once, `soon` events after
 *            `comment_gap_sec` and only the newest of each kind, `later` events are background for the prompt.
 *
 * The operator's buttons and the model's `game_command` tool talk to the agent directly; nothing else does. What the agent
 * reports carries other people's words, so every reply to it is untrusted (`tellBrain` without `fromProgram`): whatever an
 * event says, a tool the model asks for after reading it can only be a free one.
 *
 * Nothing here holds the voice or sets a flag, and nothing draws on the stage, so a failure has little to leave behind: the
 * tool, the loops, the alarms and whether the agent keeps playing. `close` puts all four back, once, from every way a run can
 * end (the operator, another mode, shutdown, a start that was given up).
 *
 * The pieces live in `../game/`: settings, the waiting events, the prompt blocks, the panel, the tool.
 */
import type { ModePanelInput, WorkerEvent, WorkerState } from '@animatus/protocol'
import { WORKER_MAX_COMMAND_CHARS } from '@animatus/protocol'
import { sleep as realSleep } from '../../stage/util.ts'
import { WorkerError, WorkerFeed } from '../../workers/index.ts'
import type { Polled, WorkerApi } from '../../workers/index.ts'
import { createAlarms } from '../commentary/alarms.ts'
import { makeWorkerClient } from '../game/client.ts'
import { Digest } from '../game/events.ts'
import type { Due, GameEvent } from '../game/events.ts'
import { NOT_RUNNING, MAX_ROWS, buildPanel } from '../game/panel.ts'
import type { Doing, PanelView } from '../game/panel.ts'
import {
  MODE_ID,
  eventLines,
  keepEvent,
  missingPrompts,
  prompt,
  promptVars as buildPromptVars,
} from '../game/prompts.ts'
import { parseGameSettings } from '../game/settings.ts'
import { clip, firstLine, oneLine, workerWords } from '../game/text.ts'
import { COMMAND_TOOL, commandTool } from '../game/tool.ts'
import type { ModeControllerFull, ModeHost, TellResult } from '../host.ts'
import type { ModeContext } from '../manager.ts'

/** The service a game worker provides (`service: game` in its plugin manifest). */
const SERVICE = 'game'
const ALARM_SUBJECT = 'game'
/** A pause request on the way out may take this long: a worker that is gone must not hold the exit. */
const EXIT_PAUSE_MS = 2000
/** While the agent does not answer at start-up, it is asked again this often. */
const START_RETRY_MS = 500
/** The speaker looks at what is due at least this often, so a wait that ended (the gap, a dance) is noticed. */
const SPEAK_TICK_MS = 1000
/** While something keeps the comment back (a dance, no stage page) it is looked at this often. */
const BLOCKED_POLL_MS = 1000
/** A wait for the voice that timed out is tried again after this. */
const VOICE_RETRY_MS = 250
/** One wait for the voice is at most this long; the loop asks again. */
const VOICE_WAIT_MS = 10_000
/** The pause after the pacer's own settle time in which a viewer's waiting message is let through first. */
const MAX_GRACE_MS = 5000
/** After a comment that failed, the first retry comes after this many seconds and each next one after twice as many. */
const FAIL_RETRY_SEC = 5

/**
 * `p`, or null as soon as `signal` aborts. The call behind `p` goes on until its own time limit and nobody waits for it; a
 * failure of it that comes later is handled here, so it is never an unhandled rejection.
 */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const gone = () => resolve(null)
    if (signal.aborted) gone()
    else signal.addEventListener('abort', gone, { once: true })
    p.then(
      (value) => {
        signal.removeEventListener('abort', gone)
        resolve(value)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', gone)
        reject(e)
      }
    )
  })
}

/** What the mode is, for tests and the panel. */
export interface GameStatus {
  running: boolean
  phase: PanelView['phase']
  doing: Doing
  /** The game agent's own report; null before its first. */
  online: boolean | null
  paused: boolean | null
  /** Polls that failed in a row; 0 while the agent answers. */
  failures: number
  /** Why the agent does not answer, or null. */
  down: string | null
  comments: number
  waiting: { immediate: number; soon: number; restarted: boolean }
  /** Background notes the model is shown. */
  notes: number
}

export interface GameDeps {
  /** How the game agent is spoken to, with this time limit for every call; replaced in tests (an in-process fake, a shorter limit). */
  makeClient?: (url: string, timeoutMs: number) => WorkerApi
  /** How the loops wait (resolves on time or when the signal aborts); replaced by tests that run in real time. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>
}

export type GameController = ModeControllerFull & { status(): GameStatus }

type Outcome = { ok: true } | { ok: false; reason: string }

/** Everything that belongs to one run of the mode; gone when the mode ends. */
interface Run {
  url: string
  client: WorkerApi
  feed: WorkerFeed
  /** Aborted when the run ends: every wait stops. */
  abort: AbortController
  phase: 'starting' | 'running'
  digest: Digest
  /** The agent's own report, the last time it answered. */
  state: WorkerState | null
  failures: number
  /** Why the agent does not answer, or null while it does. */
  down: string | null
  /** `host.now()` at which the next poll is due while the agent does not answer. */
  retryAt: number
  /** What the operator wants: playing (false) or paused (true). A restarted agent starts paused and is put back to this. */
  wantPaused: boolean
  /** A resume was sent, so leaving the mode pauses the agent again. */
  resumed: boolean
  /** The agent's pause state may not be what `wantPaused` says (it was restarted, or a resume was refused): tried again at each poll. */
  syncPause: boolean
  eventNo: number
  /** The panel's list, oldest first. */
  recent: GameEvent[]
  lastCommentAt: number
  comments: number
  /** No comment before this time, whatever its urgency: the last one failed. */
  holdUntil: number
  tellFailures: number
  lastDirective: { key: string; at: number } | null
  doing: Doing
  blockedBy: string | null
  inflight: Promise<Outcome> | null
  wake: { poll: () => void; speak: () => void }
  disposeTool: (() => void) | null
  closing: Promise<void> | null
}

export function createGameController(host: ModeHost, deps: GameDeps = {}): GameController {
  const cfg = parseGameSettings(host.config.modes[MODE_ID]?.config)
  const sleep = deps.sleep ?? realSleep
  const makeClient =
    deps.makeClient ?? ((url: string, ms: number) => makeWorkerClient(cfg, url, ms))
  const alarms = createAlarms(host, ALARM_SUBJECT)
  const pollMs = cfg.poll_sec * 1000
  const gapMs = cfg.comment_gap_sec * 1000

  let run: Run | null = null

  const alive = (r: Run): boolean => run === r && !r.abort.signal.aborted
  const title = (r: Run): string => cfg.title ?? r.state?.worker ?? cfg.name ?? 'the game'
  const wake = (r: Run, who: 'poll' | 'speak'): void => r.wake[who]()

  /** Waits `ms`, or until the run ends, or until `wake` is called for this loop. */
  const nap = (r: Run, ms: number, who: 'poll' | 'speak'): Promise<unknown> => {
    const nudge = new AbortController()
    r.wake[who] = () => nudge.abort()
    return sleep(ms, AbortSignal.any([r.abort.signal, nudge.signal]))
  }

  // ─────────────────────────────── reading the agent ───────────────────────────────

  /** The first answer, asked again while the agent is slow to come up: it has `start_timeout_sec`. */
  async function firstState(r: Run, signal: AbortSignal): Promise<WorkerState> {
    const late = new AbortController()
    const timer = setTimeout(() => late.abort(), cfg.start_timeout_sec * 1000)
    const stop = AbortSignal.any([signal, r.abort.signal, late.signal])
    let last: unknown
    try {
      // a start that was given up on before it began asks nothing
      while (!stop.aborted) {
        try {
          // the deadline is the start's, not the call's: a call that is slower than what is left is not waited for
          const state = await unlessAborted(r.client.state(), stop)
          if (state !== null) return state
        } catch (e) {
          // a worker that is not the one the operator named will not become it by waiting
          if (e instanceof WorkerError && e.code === 'wrong_worker')
            throw new Error(
              `the game service is not the worker that modes.game.config.name asks for: ${workerWords(e)}`
            )
          last = e
        }
        await sleep(START_RETRY_MS, stop)
      }
    } finally {
      clearTimeout(timer)
    }
    if (signal.aborted || r.abort.signal.aborted) throw new Error('aborted')
    throw new Error(
      `the game agent did not answer within ${cfg.start_timeout_sec} s (${workerWords(last)})`
    )
  }

  /** The agent's events into the mode's own records. True when one of them is worth a comment. */
  function ingest(r: Run, e: WorkerEvent): boolean {
    const kept = keepEvent(++r.eventNo, e, host.now())
    r.recent.push(kept)
    if (r.recent.length > MAX_ROWS) r.recent.splice(0, r.recent.length - MAX_ROWS)
    r.digest.add(kept)
    return kept.urgency !== 'later'
  }

  function settle(r: Run, state: WorkerState, polled: Polled): void {
    if (r.down !== null) {
      r.down = null
      alarms.clear('game_worker')
      host.event('mode', 'game: the game agent answers again')
    }
    r.failures = 0
    r.state = state
    let due = false
    if (polled.reset) {
      // A new run of the agent: what was known about the old one may be wrong, and it starts paused whatever it was doing.
      r.digest.reset()
      r.lastDirective = null
      r.syncPause = true
      host.event(
        'mode',
        'game: the game agent was restarted; what was known about the game is dropped'
      )
      due = true
    }
    for (const e of polled.events) if (ingest(r, e)) due = true
    if (due) wake(r, 'speak')
  }

  function failed(r: Run, e: unknown): Outcome {
    const reason = workerWords(e)
    const first = r.down === null
    r.failures++
    r.down = reason
    r.retryAt = host.now() + backoffMs(r)
    alarms.raise(
      'game_worker',
      'warn',
      `the game agent does not answer: ${reason}. The game mode is still on and keeps trying.`
    )
    if (first) {
      host.log('warn', `game: the game agent does not answer (${reason})`)
      host.event('mode', `game: the game agent does not answer (${reason})`, 'untrusted')
    }
    return { ok: false, reason }
  }

  /** After a restart (or a refused resume) the agent is put back to what the operator wants; a refusal is tried again next poll. */
  async function applyPause(r: Run): Promise<void> {
    try {
      const paused = await r.client.pause(r.wantPaused)
      if (!alive(r)) return
      r.syncPause = false
      if (r.state) r.state = { ...r.state, paused }
      if (!r.wantPaused)
        host.event(
          'mode',
          paused ? 'game: the game agent is still paused' : 'game: the game agent was resumed'
        )
    } catch (e) {
      if (alive(r))
        host.log(
          'warn',
          `game: could not put the game agent's pause state right: ${workerWords(e)}`
        )
    }
  }

  async function poll(r: Run): Promise<Outcome> {
    try {
      const state = await r.client.state()
      const polled = await r.feed.poll()
      if (!alive(r)) return { ok: true }
      settle(r, state, polled)
      if (r.syncPause) await applyPause(r)
      return { ok: true }
    } catch (e) {
      if (!alive(r)) return { ok: false, reason: 'the mode has ended' }
      return failed(r, e)
    }
  }

  /** One poll at a time: a second caller (the Refresh button) shares the one in progress. */
  function pollNow(r: Run): Promise<Outcome> {
    if (!r.inflight) {
      const p: Promise<Outcome> = poll(r).finally(() => {
        if (r.inflight === p) r.inflight = null
      })
      r.inflight = p
    }
    return r.inflight
  }

  /** How long to wait after a failed poll: it doubles each time, up to `max_backoff_sec`. */
  function backoffMs(r: Run): number {
    return Math.min(cfg.max_backoff_sec * 1000, pollMs * 2 ** r.failures)
  }

  async function pollLoop(r: Run): Promise<void> {
    while (alive(r)) {
      await nap(r, r.down === null ? pollMs : backoffMs(r), 'poll')
      if (!alive(r)) return
      await pollNow(r)
    }
  }

  // ─────────────────────────────── commenting ───────────────────────────────

  /** Why no comment can be made right now, or null. A dance is a short interlude that has the voice. */
  function blockedBy(): string | null {
    if (host.flags.dancing || host.modeState('dance') !== 'IDLE') return 'a dance is on'
    if (host.hub.connected === false) return 'the stage page is not connected'
    return null
  }

  /** When the next comment is due (`host.now()` scale), or null when nothing is waiting. */
  function nextDueAt(r: Run, now: number): number | null {
    const { immediate, soon } = r.digest.waiting()
    let at: number
    if (immediate > 0) at = now
    else if (soon > 0 || r.digest.restarted) at = Math.max(now, r.lastCommentAt + gapMs)
    else return null
    return Math.max(at, r.holdUntil)
  }

  /**
   * Waits until the voice is free and has stayed free for a moment, so that a viewer whose message the pacer is about to send
   * goes first: the pacer sends once the voice has been free for its settle time, and this waits a little longer than that.
   */
  async function voiceFree(r: Run): Promise<boolean> {
    if (!(await host.whenQuiet(VOICE_WAIT_MS)) || !alive(r)) return false
    const settleMs = Math.min(MAX_GRACE_MS, host.config.inbox.pacer.idleSettleSec * 1000 + 500)
    await sleep(settleMs, r.abort.signal)
    return alive(r) && !host.busy() && blockedBy() === null
  }

  async function tell(text: string): Promise<TellResult> {
    try {
      return await host.tellBrain(text)
    } catch (e) {
      return { status: 'failed', sentences: 0, error: firstLine(e) }
    }
  }

  /** One look at what is due. Returns how long to wait before the next. */
  async function speakStep(r: Run): Promise<number> {
    const stale = r.digest.dropStale(host.now())
    if (stale > 0)
      host.event(
        'mode',
        `game: ${stale} event(s) waited too long to be worth a comment; they are background now`
      )
    const now = host.now()
    const dueAt = nextDueAt(r, now)
    if (dueAt === null) {
      r.doing = 'idle'
      return SPEAK_TICK_MS
    }
    if (dueAt > now) {
      r.doing = 'waiting'
      return Math.min(dueAt - now, SPEAK_TICK_MS)
    }
    const why = blockedBy()
    if (why !== null) {
      r.doing = 'blocked'
      r.blockedBy = why
      return BLOCKED_POLL_MS
    }
    r.doing = 'voice'
    if (!(await voiceFree(r))) return VOICE_RETRY_MS

    // time passed while waiting: look again at what is due, so the comment carries the newest
    const at = host.now()
    const late = r.digest.dropStale(at)
    if (late > 0)
      host.event(
        'mode',
        `game: ${late} event(s) waited too long to be worth a comment; they are background now`
      )
    const soonOk = at - r.lastCommentAt >= gapMs
    const due = r.digest.due(soonOk)
    const restarted = r.digest.restarted
    if (due.events.length === 0 && !(restarted && soonOk)) {
      r.doing = 'idle'
      return SPEAK_TICK_MS
    }
    r.digest.takeRestart()
    r.doing = 'telling'
    const result = await tell(commentText(r, due, at, restarted))
    if (!alive(r)) return 0
    return commented(r, due, restarted, result)
  }

  function commentText(r: Run, due: Due, now: number, restarted: boolean): string {
    const game = title(r)
    return prompt(host, 'comment', {
      game_name: game,
      events: eventLines(due.events, due.omitted, now),
      restarted: restarted ? prompt(host, 'restarted', { game_name: game }) : '',
    })
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  /** What the model's answer means for the events: said and gone, or kept for another try after a pause. */
  function commented(r: Run, due: Due, restarted: boolean, result: TellResult): number {
    const at = host.now()
    if (result.status === 'done') {
      r.digest.done(due.taken)
      r.lastCommentAt = at
      r.comments++
      r.tellFailures = 0
      r.holdUntil = 0
      alarms.clear('game_model')
      const kinds = [...new Set(due.events.map((e) => e.kind))].join(', ')
      host.event(
        'mode',
        `game: commented on ${due.events.length} event(s)${kinds ? ` (${kinds})` : ''}${restarted ? ' and the restart' : ''}${result.sentences === 0 ? '; the model said nothing' : ''}`
      )
      r.doing = 'idle'
      return 0
    }
    // failed or cut off: nothing was said, so the events stay and the restart is still to be told
    if (restarted) r.digest.keepRestart()
    r.tellFailures++
    const waitSec = Math.min(cfg.max_backoff_sec, FAIL_RETRY_SEC * 2 ** (r.tellFailures - 1))
    r.holdUntil = at + waitSec * 1000
    r.doing = 'waiting'
    if (result.status === 'failed') {
      const why = clip(result.error ?? 'no reason given', 200)
      alarms.raise(
        'game_model',
        'warn',
        `the model could not answer the comment about the game (${why}); the events wait and the next try is in about ${waitSec} s`
      )
      host.log('warn', `game: the model could not comment (${why})`)
    } else
      host.event('mode', 'game: a comment was cut off before it was written; trying again shortly')
    return 0
  }

  async function speakLoop(r: Run): Promise<void> {
    while (alive(r)) {
      let wait = SPEAK_TICK_MS
      try {
        wait = await speakStep(r)
      } catch (e) {
        // a mistake in this code must not end the commentary: say so and go on, slowly
        if (!alive(r)) return
        host.log('error', `game: a comment failed unexpectedly: ${firstLine(e)}`)
        wait = 5000
      }
      if (!alive(r)) return
      await nap(r, wait, 'speak')
    }
  }

  // ─────────────────────────────── directives and the operator's buttons ───────────────────────────────

  /** A directive to the agent, from the character (through the tool) or the operator (through the panel). */
  async function sendDirective(
    r: Run,
    raw: string,
    from: 'character' | 'console'
  ): Promise<string> {
    if (!alive(r)) throw new Error(NOT_RUNNING)
    const text = oneLine(raw)
    if (text === '') throw new Error('the directive is empty')
    if (text.length > WORKER_MAX_COMMAND_CHARS)
      throw new Error(`a directive is 1 to ${WORKER_MAX_COMMAND_CHARS} characters`)
    // the model tends to say the same thing in two replies in a row: once is enough
    const key = text.toLowerCase()
    if (
      from === 'character' &&
      r.lastDirective?.key === key &&
      host.now() - r.lastDirective.at < cfg.duplicate_command_sec * 1000
    )
      return 'the same directive was sent a moment ago'
    try {
      await r.client.command(text)
    } catch (e) {
      throw new Error(workerWords(e))
    }
    if (from === 'character') r.lastDirective = { key, at: host.now() }
    host.event(
      'mode',
      `game: directive sent (${from === 'character' ? 'from the character' : 'from the console'}): ${clip(text, 120)}`,
      from === 'character' ? 'untrusted' : undefined
    )
    wake(r, 'poll') // what the agent says about it is read soon
    return 'sent to the game agent'
  }

  async function setPaused(r: Run, paused: boolean): Promise<{ ok: boolean; reason?: string }> {
    const before = r.wantPaused
    r.wantPaused = paused
    try {
      const now = await r.client.pause(paused)
      if (alive(r)) {
        r.syncPause = false
        if (r.state) r.state = { ...r.state, paused: now }
      }
      host.event(
        'mode',
        `game: the game agent was ${paused ? 'paused' : 'resumed'} from the console`
      )
      return { ok: true }
    } catch (e) {
      r.wantPaused = before
      return { ok: false, reason: workerWords(e) }
    }
  }

  async function forget(r: Run): Promise<{ ok: boolean; reason?: string }> {
    try {
      await r.client.forget()
    } catch (e) {
      return { ok: false, reason: workerWords(e) }
    }
    if (alive(r)) {
      r.digest.forget()
      r.lastDirective = null
      host.event('mode', 'game: the game agent and the mode forgot their notes and directives')
    }
    return { ok: true }
  }

  const refuse = (reason: string) => ({ ok: false as const, reason })

  // ─────────────────────────────── entering and leaving ───────────────────────────────

  function newRun(url: string): Run {
    const client = makeClient(url, cfg.request_timeout_sec * 1000)
    return {
      url,
      client,
      feed: new WorkerFeed(client),
      abort: new AbortController(),
      phase: 'starting',
      digest: new Digest({ notesKept: cfg.notes_kept, staleMs: cfg.stale_sec * 1000 }),
      state: null,
      failures: 0,
      down: null,
      retryAt: 0,
      wantPaused: false,
      resumed: false,
      syncPause: false,
      eventNo: 0,
      recent: [],
      lastCommentAt: Number.NEGATIVE_INFINITY,
      comments: 0,
      holdUntil: 0,
      tellFailures: 0,
      lastDirective: null,
      doing: 'idle',
      blockedBy: null,
      inflight: null,
      wake: { poll: () => {}, speak: () => {} },
      disposeTool: null,
      closing: null,
    }
  }

  /** Puts everything back, once, whatever ended the run: the loops, the tool, the alarms, and the agent's pause. Never rejects. */
  function close(r: Run, reason: string): Promise<void> {
    return (r.closing ??= (async () => {
      try {
        r.abort.abort()
        r.disposeTool?.()
        r.disposeTool = null
        if (run === r) alarms.clearAll()
        if (r.phase === 'running') host.event('mode', `game mode over (${reason})`)
        // A run that never got the agent going has nothing to pause. One that did is paused by a call of its own with a short
        // time limit: the one the run used may be stuck on the very thing that ended it.
        if (cfg.pause_on_exit && r.resumed) {
          try {
            await makeClient(r.url, Math.min(EXIT_PAUSE_MS, cfg.request_timeout_sec * 1000)).pause(
              true
            )
          } catch (e) {
            host.log('warn', `game: the game agent could not be paused: ${workerWords(e)}`)
            host.event(
              'mode',
              `game: the game agent could not be paused (${workerWords(e)}); it may keep playing`,
              'untrusted'
            )
          }
        }
      } catch (e) {
        host.log('error', `game: leaving the mode failed: ${firstLine(e)}`)
      } finally {
        if (run === r) run = null
      }
    })())
  }

  /** The tool and the loops start in one synchronous step, after the last thing a start waits for. */
  function activate(r: Run): void {
    r.phase = 'running'
    r.disposeTool = host.registerTool(
      commandTool({
        available: () => alive(r) && r.state?.online === true,
        send: (text) => sendDirective(r, text, 'character'),
      })
    )
    host.event(
      'mode',
      `game mode on (${title(r)}, ${cfg.protocol === 'legacy' ? 'older link' : 'worker protocol'})`
    )
    for (const loop of [pollLoop(r), speakLoop(r)])
      loop.catch((e) => host.log('error', `game: a loop stopped: ${firstLine(e)}`))
  }

  // ─────────────────────────────── the controller ───────────────────────────────

  const view = (r: Run | null): PanelView => {
    const now = host.now()
    const phase =
      r === null ? 'off' : r.closing !== null || r.abort.signal.aborted ? 'stopping' : r.phase
    return {
      phase,
      title: r ? title(r) : (cfg.title ?? cfg.name ?? 'the game'),
      protocol: cfg.protocol,
      state: r?.state ?? null,
      unreachable: r?.down ?? null,
      retryInSec: r && r.down !== null ? Math.max(0, Math.ceil((r.retryAt - now) / 1000)) : null,
      doing: r?.doing ?? 'idle',
      blockedBy: r?.blockedBy ?? null,
      comments: r?.comments ?? 0,
      lastCommentAgeMs: r && Number.isFinite(r.lastCommentAt) ? now - r.lastCommentAt : null,
      waiting: r
        ? { ...r.digest.waiting(), restarted: r.digest.restarted }
        : { immediate: 0, soon: 0, restarted: false },
      events: (r?.recent ?? []).map((e) => ({ ...e, ageMs: now - e.seenAt })).reverse(),
    }
  }

  const live = (): Run | null =>
    run !== null && alive(run) && run.phase === 'running' ? run : null

  return {
    status(): GameStatus {
      const v = view(run)
      return {
        running: run !== null,
        phase: v.phase,
        doing: v.doing,
        online: run?.state?.online ?? null,
        paused: run?.state?.paused ?? null,
        failures: run?.failures ?? 0,
        down: run?.down ?? null,
        comments: v.comments,
        waiting: v.waiting,
        notes: run?.digest.background().length ?? 0,
      }
    },

    async enter(ctx: ModeContext) {
      const missing = missingPrompts(host)
      if (missing.length > 0)
        throw new Error(`the game pack is incomplete: no ${missing.join(', ')}`)
      // a run that is still being put away (its exit was cut short) is finished first
      if (run) await close(run, 'a new start')
      if (ctx.signal.aborted) throw new Error('aborted') // given up on while it waited: nothing was done, nothing is asked
      const url = host.serviceUrl(SERVICE)
      if (url === null) throw new Error(`the "${SERVICE}" service is not running`)
      const r = newRun(url)
      run = r
      // A start that fails, or is given up while it waits, cleans up in the catch below. The manager also stops a run with
      // `exit`, in the same tick it aborts the signal, and that is what gives `close` the real reason. The one way out with no
      // `exit` is a start that finished just as the mode was being torn down: the microtask sees that nobody closed the run.
      const onAbort = () =>
        queueMicrotask(() => {
          if (!r.closing) void close(r, 'the mode was torn down')
        })
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const state = await firstState(r, ctx.signal)
        if (!alive(r) || ctx.signal.aborted) throw new Error('aborted')
        r.feed.startFrom(state) // what happened before the mode began is not news
        r.state = state
        r.resumed = true
        let paused: boolean
        try {
          paused = await r.client.pause(false)
        } catch (e) {
          throw new Error(`the game agent could not be resumed: ${workerWords(e)}`)
        }
        if (paused) throw new Error('the game agent is still paused after being asked to resume')
        // No `await` from here on: a start the manager has given up on ends here, before it has registered or started anything.
        if (!alive(r) || ctx.signal.aborted) throw new Error('aborted')
        r.state = { ...state, paused } // what was read before the resume says paused; the first poll is a while away
        activate(r)
      } catch (e) {
        void close(r, 'the start failed')
        throw e
      }
    },

    async exit(_ctx: ModeContext, reason: string) {
      if (run) await close(run, reason)
    },

    promptVars(): Record<string, string> {
      const r = run
      const steering =
        host.config.tools.enabled && host.config.tools.tiers[COMMAND_TOOL] !== 'disabled'
          ? (host.prompt(MODE_ID, 'steering') ?? '')
          : ''
      return buildPromptVars({
        title: r ? title(r) : (cfg.title ?? cfg.name ?? 'the game'),
        state: r?.state ?? null,
        unreachable: r?.down ?? null,
        notes: r?.digest.background() ?? [],
        now: host.now(),
        steering,
      })
    },

    panel(): ModePanelInput {
      return buildPanel(view(run))
    },

    async onConsoleRequest(req) {
      const action = typeof req.action === 'string' && req.action !== '' ? req.action : 'start'
      if (action === 'start')
        return host.enterMode(MODE_ID, {
          ...(req.replace === true ? { replace: true } : {}),
          ...(req.force === true ? { force: true } : {}),
        })
      const r = live()
      if (!r) return refuse(NOT_RUNNING)
      switch (action) {
        case 'pause':
        case 'resume':
          return setPaused(r, action === 'pause')
        case 'forget':
          return forget(r)
        case 'directive': {
          const text = typeof req.text === 'string' ? req.text : ''
          try {
            await sendDirective(r, text, 'console')
            return { ok: true }
          } catch (e) {
            return refuse(workerWords(e))
          }
        }
        case 'refresh': {
          const outcome = await pollNow(r)
          wake(r, 'poll')
          return outcome.ok ? { ok: true } : refuse(outcome.reason)
        }
        default:
          return refuse(`the game mode has no action "${clip(action, 40)}"`)
      }
    },
  }
}
