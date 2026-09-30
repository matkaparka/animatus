/**
 * Screen commentary: the character watches one window (a game, usually) and comments on it as it goes.
 *
 * The loop, one pass at a time, never two at once:
 *   wait until the voice is free -> capture the window (the capture service) -> skip the picture if it is black ->
 *   work out which game it is (first picture, unsure, a switch, every N minutes, on demand) or read what is on
 *   screen (a short model call, also the check for a switch) -> tell the model to comment, with the picture ->
 *   wait until the comment has been spoken -> pause `interval_sec` -> again.
 * Viewers come first: no pass starts while a reply is being written or spoken, and one that finds a viewer's reply
 * under way after reading the picture drops its comment (the picture is stale by then).
 *
 * Why two model calls instead of the legacy single reply with `[scene]` and `[switch]` lines: the brain treats any
 * leading `[...]` as an emotion tag and speaks the text after it, so those two lines would have been spoken and put
 * on the subtitle. The analysis (`host.llmText`, JSON) and the spoken comment (`host.tellBrain`) are separate.
 *
 * The memory (game, scene, story so far) is kept in `data/commentary-state.json` for the whole stream; only the
 * operator clears it. While the mode is active the game and the story are added to the prompt of every reply, so a
 * viewer who asks what game this is gets an answer.
 *
 * Nothing here holds the voice or a flag, and nothing draws on the stage, so a failure has nothing to leave behind:
 * it raises one alarm with the reason, the loop backs off, and the alarm goes when the next pass works.
 *
 * The pieces live in `../commentary/`: settings, the capture client and the window being watched, reading the
 * pictures, the memory file, the panel. This file is the loop and the operator's buttons.
 */
import path from 'node:path'
import type { ModePanelInput } from '@animatus/protocol'
import { createAlarms } from '../commentary/alarms.ts'
import { CaptureError } from '../commentary/captureClient.ts'
import type { CaptureClient, CapturedFrame } from '../commentary/captureClient.ts'
import { cleanTitle, clip, firstLine } from '../commentary/memory.ts'
import type { WindowPick } from '../commentary/memory.ts'
import { ago, buildPanel } from '../commentary/panel.ts'
import { MODE_ID, missingPrompts, prompt } from '../commentary/prompts.ts'
import { createReader } from '../commentary/reading.ts'
import type { Live } from '../commentary/reading.ts'
import {
  MAX_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  parseCommentarySettings,
} from '../commentary/settings.ts'
import { MemoryStore } from '../commentary/store.ts'
import { createTarget, describeShot } from '../commentary/target.ts'
import { createWindowList } from '../commentary/windows.ts'
import type { ModeControllerFull, ModeHost } from '../host.ts'
import type { ModeContext } from '../manager.ts'

const ALARM_SUBJECT = 'commentary'
/** The first look comes a moment after the mode starts, when the stage has taken the new layout. */
const FIRST_LOOK_MS = 1500
/** How often a paused loop, or one that waits for a window, the stage or the voice, checks again. */
const POLL_MS = 1000
/** The longest a comment is waited for to be spoken before the pause to the next picture starts anyway. */
const SPEECH_WAIT_MS = 60_000

const NO_WINDOW =
  'commentary is on but no window is chosen: pick one on the mode panel, or set modes.commentary.config.window'

type Phase =
  | 'off'
  | 'waiting'
  | 'paused'
  | 'stage'
  | 'no_window'
  | 'voice'
  | 'capturing'
  | 'identifying'
  | 'analysing'
  | 'speaking'

interface Run extends Live {
  abort: AbortController
  /** Ends the wait for the next pass early; `nudge` says why. */
  wake: () => void
  /** `now`: look at once. `retime`: the interval changed, so the wait is measured again and no pass is due because of it. */
  nudge: 'now' | 'retime' | null
}

/** What the last capture (or the last test picture) was like, for the panel. */
interface Shot {
  at: number
  text: string
}

export interface CommentaryDeps {
  /** How the capture service is spoken to; replaced in tests. */
  makeClient?: (baseUrl: string, opts: { timeoutMs: number }) => CaptureClient
  /** How the loop waits between passes (resolves on time or when the signal aborts); replaced by tests that run in real time. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface CommentaryStatus {
  phase: Phase
  running: boolean
  paused: boolean
  rounds: number
  game: string
  confidence: number
  /** The game is known with enough confidence. */
  sure: boolean
  scene: string
  summary: string
  pending: number
  blackFrames: number
  blackStreak: number
  modelFailures: number
  /** The window being watched, as it is named; null when none is chosen. */
  window: string | null
  /** The one line about what is wrong right now, if anything. */
  problem: string | null
}

export type CommentaryController = ModeControllerFull & { status(): CommentaryStatus }

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

export function createCommentaryController(
  host: ModeHost,
  deps: CommentaryDeps = {}
): CommentaryController {
  const cfg = parseCommentarySettings(host.config.modes[MODE_ID]?.config)
  const sleep = deps.sleep ?? realSleep
  const store = new MemoryStore(
    path.join(host.dataDir, 'commentary-state.json'),
    cfg.summary_max_chars,
    (message) => host.log('warn', message)
  )
  const mem = () => store.state
  const alarms = createAlarms(host, ALARM_SUBJECT)
  const target = createTarget({
    host,
    cfg,
    store,
    ...(deps.makeClient ? { makeClient: deps.makeClient } : {}),
  })
  const windows = createWindowList({ host, cfg, target })

  // ── the loop
  let run: Run | null = null
  let paused = false
  let phase: Phase = 'off'
  let nextAt = 0
  /** The wait that follows the pass in progress is the pause between comments (which the operator can change). */
  let intervalWait = false

  const reader = createReader({
    host,
    cfg,
    store,
    alarms,
    phase: (now) => {
      phase = now
    },
  })

  // ── what is wrong now, by cause; each clears when its own step works again
  const issue = {
    capture: null as string | null,
    black: null as string | null,
    model: null as string | null,
  }
  let blackFrames = 0
  let blackStreak = 0
  let modelFailures = 0
  let lastCapture: Shot | null = null
  let lastTest: Shot | null = null

  const intervalMs = () => (mem().interval ?? cfg.interval_sec) * 1000
  const problem = (): string | null => issue.capture ?? issue.black ?? issue.model

  // ─────────────────────────────── the loop ───────────────────────────────

  const pause = (ms: number, r: Run): Promise<void> => {
    const wake = new AbortController()
    r.wake = () => wake.abort()
    nextAt = host.now() + ms
    return sleep(ms, AbortSignal.any([r.signal, wake.signal]))
  }

  /** Wakes the loop: to look at once (the default), or to measure the wait again because the interval changed. */
  const poke = (how: 'now' | 'retime' = 'now') => {
    const r = run
    if (!r) return
    if (how === 'now' || r.nudge === null) r.nudge = how // a request to look at once wins over a re-timing
    r.wake()
  }

  const startRun = (): Run => {
    const abort = new AbortController()
    const r: Run = {
      abort,
      signal: abort.signal,
      alive: () => run === r && !abort.signal.aborted,
      wake: () => {},
      nudge: null,
    }
    run = r
    loop(r).catch((e) => host.log('error', `commentary: the loop stopped: ${firstLine(e)}`))
    return r
  }

  const stopRun = (only?: Run) => {
    const r = run
    if (!r || (only && r !== only)) return
    run = null
    r.abort.abort()
    phase = 'off'
    nextAt = 0
    issue.capture = issue.black = issue.model = null
    alarms.clearAll()
  }

  const loop = async (r: Run) => {
    let delay = FIRST_LOOK_MS
    /** When the pause between comments began; null while the wait in progress is some other wait. */
    let restingSince: number | null = null
    let due = host.now() + delay
    while (!r.signal.aborted) {
      r.nudge = null
      await pause(delay, r)
      if (r.signal.aborted) return
      if (r.nudge === 'retime') {
        // the interval was changed during the wait: what is left of it is measured again, and nothing is due yet
        if (restingSince !== null) due = restingSince + intervalMs()
        if (due > host.now()) {
          delay = due - host.now()
          continue
        }
      }
      intervalWait = false
      try {
        delay = await attempt(r)
      } catch (e) {
        // a mistake in this code must not end the commentary: say so and go on, slowly
        if (r.signal.aborted) return
        host.log('error', `commentary: a pass failed unexpectedly: ${firstLine(e)}`)
        delay = modelFailed(e)
      }
      restingSince = intervalWait ? host.now() : null
      due = host.now() + delay
    }
  }

  /** Marks the loop as waiting for something other than the screen and returns how long to wait. */
  const idle = (why: Phase, delay: number): number => {
    phase = why
    return delay
  }

  /** Marks the loop as in the pause between comments, which lasts `interval_sec` from now. */
  const rest = (): number => {
    intervalWait = true
    return idle('waiting', intervalMs())
  }

  /** One pass. Returns how many milliseconds to wait before the next. */
  const attempt = async (r: Run): Promise<number> => {
    if (paused) return idle('paused', POLL_MS)
    if (host.flags.dancing || host.flags.singing || host.flags.sleeping)
      return idle('waiting', POLL_MS)
    // nothing can be said (or heard) while the stage page is away; pictures would only cost model calls
    if (host.hub.connected === false) return idle('stage', POLL_MS)
    if (target.queries().length === 0) {
      alarms.raise('commentary_window', 'info', NO_WINDOW)
      return idle('no_window', POLL_MS)
    }
    alarms.clear('commentary_window')

    // a viewer's reply, or the last thing said here, goes first
    if (host.busy()) {
      phase = 'voice'
      const quiet = await host.whenQuiet(Math.max(intervalMs(), 5_000))
      if (!r.alive()) return 0
      if (!quiet) return POLL_MS
    }

    phase = 'capturing'
    let frame: CapturedFrame
    try {
      frame = await target.capture(r.signal)
    } catch (e) {
      if (!r.alive()) return 0
      return captureFailed(e)
    }
    if (!r.alive()) return 0
    issue.capture = null
    alarms.clear('commentary_capture')
    lastCapture = { at: host.now(), text: describeShot(frame) }
    if (frame.black) return blackPicture(frame)
    blackStreak = 0
    issue.black = null
    alarms.clear('commentary_black')

    try {
      await reader.study(r, frame)
    } catch (e) {
      if (!r.alive()) return 0
      return modelFailed(e)
    }
    if (!r.alive()) return 0

    // a viewer began while the picture was being read: it is stale now, and the viewer has the voice
    if (host.busy()) return POLL_MS

    phase = 'speaking'
    try {
      await host.tellBrain(prompt(host, 'round'), {
        images: [{ mime: frame.mime, base64: frame.base64 }],
      })
    } catch (e) {
      if (!r.alive()) return 0
      return modelFailed(e)
    }
    if (!r.alive()) return 0
    modelFailures = 0
    issue.model = null
    alarms.clear('commentary_model')
    reader.finishRound(r)

    // the pause to the next picture runs from the end of the speech, not from the start of the pass
    phase = 'voice'
    await host.whenQuiet(SPEECH_WAIT_MS)
    if (!r.alive()) return 0
    return rest()
  }

  const captureFailed = (e: unknown): number => {
    const why = e instanceof CaptureError ? e.message : firstLine(e)
    const label = target.label()
    issue.capture = `cannot capture ${label ? `"${clip(label, 60)}"` : 'the window'}: ${why}`
    if (alarms.raise('commentary_capture', 'warn', issue.capture))
      host.log('warn', `commentary: capture failed: ${why}`)
    return rest()
  }

  const blackPicture = (frame: CapturedFrame): number => {
    blackFrames++
    blackStreak++
    issue.black = 'the window is black: exclusive fullscreen? (this picture is skipped)'
    if (blackStreak >= cfg.black_alarm_after)
      alarms.raise(
        'commentary_black',
        'warn',
        `the window "${clip(frame.window.title, 60)}" has been black for ${blackStreak} pictures in a row: ` +
          'an exclusive-fullscreen game shows nothing to a capture (switch it to windowed or borderless), ' +
          'or an overlay window was picked instead of the game'
      )
    return rest()
  }

  /** A model call failed: alarm, and wait longer each time, up to a limit. */
  const modelFailed = (e: unknown): number => {
    modelFailures++
    const why = firstLine(e)
    const wait = Math.min(intervalMs() * 2 ** modelFailures, cfg.max_backoff_sec * 1000)
    issue.model = `the model is not answering (${why}); trying again in ${Math.round(wait / 1000)} s`
    if (
      alarms.raise(
        'commentary_model',
        'warn',
        `the model did not answer (${why}): commentary waits longer between tries until it does`
      )
    )
      host.log('warn', `commentary: the model failed (${why}); backing off`)
    return idle('waiting', wait)
  }

  // ─────────────────────────────── the operator ───────────────────────────────

  const choose = (pick: WindowPick) => {
    mem().window = pick
    // a new window deserves a fresh try now, not after a wait that belonged to the old one
    modelFailures = 0
    blackStreak = 0
    issue.capture = issue.black = null
    for (const code of ['commentary_capture', 'commentary_black', 'commentary_window'])
      alarms.clear(code)
    store.save()
    host.event('mode', `commentary: now watching "${clip(target.label() ?? '', 60)}"`)
    poke()
  }

  /** A picture now, to see what the mode would see; no model is asked. */
  const takeTest = async (): Promise<{ ok: boolean; reason?: string }> => {
    if (target.queries().length === 0) return { ok: false, reason: 'no window is chosen yet' }
    try {
      lastTest = { at: host.now(), text: describeShot(await target.capture()) }
      return { ok: true }
    } catch (e) {
      const why = e instanceof CaptureError ? e.message : firstLine(e)
      lastTest = { at: host.now(), text: `failed: ${why}` }
      return { ok: false, reason: why }
    }
  }

  const status = (): CommentaryStatus => ({
    phase,
    running: run !== null,
    paused,
    rounds: mem().rounds,
    game: mem().game,
    confidence: mem().confidence,
    sure: reader.sure(),
    scene: mem().scene,
    summary: mem().summary,
    pending: mem().pending.length,
    blackFrames,
    blackStreak,
    modelFailures,
    window: target.label(),
    problem: problem(),
  })

  const statusLine = (): string => {
    if (!run) return 'not running'
    const wrong = problem()
    if (wrong) return wrong
    switch (phase) {
      case 'paused':
        return 'paused'
      case 'stage':
        return 'waiting for the stage page to connect'
      case 'no_window':
        return 'waiting: no window is chosen'
      case 'voice':
        return 'waiting for the voice to be free'
      case 'capturing':
        return 'capturing the window'
      case 'identifying':
        return 'working out which game this is'
      case 'analysing':
        return 'reading the screen'
      case 'speaking':
        return 'commenting'
      default:
        return `watching; the next look is in about ${Math.max(0, Math.round((nextAt - host.now()) / 1000))} s`
    }
  }

  // ─────────────────────────────── the controller ───────────────────────────────

  return {
    status,

    attach() {
      void store.load()
      return () => stopRun()
    },

    async enter(ctx: ModeContext) {
      await store.load()
      const missing = missingPrompts(host)
      if (missing.length > 0)
        throw new Error(`the commentary pack is incomplete: no ${missing.join(', ')}`)
      if (ctx.signal.aborted) return
      stopRun()
      paused = false
      blackFrames = blackStreak = modelFailures = 0
      lastCapture = null
      reader.begin()
      const r = startRun()
      // the manager aborts this when the mode is torn down, also when the start itself did not finish
      ctx.signal.addEventListener('abort', () => stopRun(r), { once: true })
      void windows.refresh(true)
      const label = target.label()
      host.event(
        'mode',
        `commentary started (${label ? `watching "${clip(label, 60)}"` : 'no window chosen yet'})`
      )
    },

    async exit(_ctx: ModeContext, reason: string) {
      const was = run !== null
      stopRun()
      if (was) host.event('mode', `commentary stopped (${reason})`)
    },

    promptVars() {
      const m = mem()
      const seen = m.scene ? host.prompt(MODE_ID, 'seen', { scene: m.scene }) : ''
      const screen = reader.sure()
        ? host.prompt(MODE_ID, 'screen_known', { game: m.game, seen: seen ?? '' })
        : host.prompt(MODE_ID, 'screen_unsure')
      const progress = m.summary ? host.prompt(MODE_ID, 'progress', { summary: m.summary }) : ''
      return { screen: screen ?? '', progress: progress ?? '' }
    },

    panel(): ModePanelInput {
      const m = mem()
      const serviceUp = host.serviceUrl(cfg.service) !== null
      void windows.refresh(false) // also when the service is down: it then forgets a list that is out of date
      const now = host.now()
      const shot = (s: Shot | null) => (s ? `${s.text}, ${ago(now - s.at)}` : null)
      const pick = m.window
      return buildPanel({
        running: run !== null,
        paused,
        status: statusLine(),
        serviceUp,
        target: pick?.title && pick.process ? `${pick.title} (${pick.process})` : target.label(),
        targetId: pick?.id ?? null,
        intervalSec: m.interval ?? cfg.interval_sec,
        game: m.game,
        confidence: m.confidence,
        sure: reader.sure(),
        identifiedAgo: m.identifiedAt > 0 ? ago(now - m.identifiedAt) : null,
        scene: m.scene,
        summary: m.summary,
        rounds: m.rounds,
        untilSummary:
          cfg.summary_every > 0 ? Math.max(0, cfg.summary_every - m.sinceSummary) : null,
        blackFrames,
        lastCapture: shot(lastCapture),
        lastTest: shot(lastTest),
        windows: windows.windows(),
        windowsNote: windows.note(),
      })
    },

    async onConsoleRequest(req) {
      const action = typeof req.action === 'string' && req.action !== '' ? req.action : 'start'
      switch (action) {
        case 'start':
          await store.load()
          return host.enterMode(MODE_ID, {
            ...(req.replace === true ? { replace: true } : {}),
            ...(req.force === true ? { force: true } : {}),
          })
        case 'use_window': {
          await store.load()
          const typed = typeof req.title === 'string' ? cleanTitle(req.title) : ''
          const chosen =
            typeof req.row === 'string' ? req.row : typeof req.window === 'string' ? req.window : ''
          if (typed !== '') choose({ id: null, title: typed, process: '' })
          else if (chosen !== '') {
            const w = windows.windows().find((x) => x.id === chosen)
            if (w)
              choose({ id: w.id, title: cleanTitle(w.title), process: cleanTitle(w.process, 260) })
            else if (/^\d{1,20}$/.test(chosen)) choose({ id: chosen, title: '', process: '' })
            else choose({ id: null, title: cleanTitle(chosen), process: '' })
          } else
            return { ok: false, reason: 'choose a window from the list, or type part of its title' }
          return { ok: true }
        }
        case 'refresh':
          return windows.refresh(true)
        case 'set_interval': {
          // a number, or text that is one: an empty field is not "0 seconds"
          const typed = typeof req.interval === 'string' ? req.interval.trim() : ''
          const n =
            typeof req.interval === 'number'
              ? req.interval
              : typed === ''
                ? Number.NaN
                : Number(typed)
          if (!Number.isFinite(n))
            return { ok: false, reason: 'the interval has to be a number of seconds' }
          await store.load()
          mem().interval = Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, n))
          store.save()
          poke('retime') // no comment is due because of this: the pause in progress is only measured again
          return { ok: true }
        }
        case 'pause':
        case 'resume':
          if (!run) return { ok: false, reason: 'the mode is not running' }
          paused = action === 'pause'
          poke()
          return { ok: true }
        case 'reidentify':
          reader.requestIdentification()
          host.event('mode', 'commentary: the next picture will be used to identify the game again')
          poke()
          return { ok: true }
        case 'test':
          await store.load()
          return takeTest()
        case 'clear_memory':
          await store.load()
          store.clear()
          reader.reset()
          host.event('mode', 'commentary: the game and the story so far were forgotten')
          return { ok: true }
        default:
          return { ok: false, reason: `the commentary mode has no action "${action.slice(0, 40)}"` }
      }
    },
  }
}
