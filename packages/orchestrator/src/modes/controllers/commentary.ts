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
 */
import path from 'node:path'
import type { ModePanelInput } from '@animatus/protocol'
import type { ChatPart } from '../../llm/types.ts'
import { parseAnalysis, parseIdentification, parseSummary } from '../commentary/answers.ts'
import type { Identification } from '../commentary/answers.ts'
import { CaptureError, createCaptureClient } from '../commentary/captureClient.ts'
import type { CaptureClient, CapturedFrame, WindowInfo } from '../commentary/captureClient.ts'
import {
  MAX_PENDING,
  cleanNote,
  cleanTitle,
  clip,
  emptyMemory,
  memoryFileContent,
  parseMemory,
  sameGame,
} from '../commentary/memory.ts'
import type { MemoryState, WindowPick } from '../commentary/memory.ts'
import { ago, buildPanel } from '../commentary/panel.ts'
import {
  MAX_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  parseCommentarySettings,
} from '../commentary/settings.ts'
import type { CommentarySettings } from '../commentary/settings.ts'
import type { ModeControllerFull, ModeHost } from '../host.ts'
import { readJson, writeJson } from '../jsonfile.ts'
import type { ModeContext } from '../manager.ts'

const MODE_ID = 'commentary'
const ALARM_SUBJECT = 'commentary'
/** The first look comes a moment after the mode starts, when the stage has taken the new layout. */
const FIRST_LOOK_MS = 1500
/** How often a paused loop, or one that waits for a window, the stage or the voice, checks again. */
const POLL_MS = 1000
/** The longest a comment is waited for to be spoken before the pause to the next picture starts anyway. */
const SPEECH_WAIT_MS = 60_000
/** The window list is read again when the panel is drawn and the list is older than this. */
const WINDOWS_MAX_AGE_MS = 10_000

/** The prompt files the pack must have; a missing one stops the mode from starting instead of being replaced by a guess. */
const REQUIRED_PROMPTS = [
  'round',
  'identify',
  'analyze',
  'summarize',
  'screen_known',
  'screen_unsure',
  'seen',
  'progress',
] as const

const NO_WINDOW =
  'commentary is on but no window is chosen: pick one on the mode panel, or set modes.commentary.config.window'
const SERVICE_DOWN = 'the screen capture service is not running'

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

type IdentifyReason = 'first' | 'unsure' | 'switch' | 'timer' | 'manual'

interface Run {
  id: number
  abort: AbortController
  signal: AbortSignal
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

const firstLine = (e: unknown): string =>
  clip(((e instanceof Error ? e.message : String(e)).split(/\r?\n/, 1)[0] ?? '').trim(), 200)

export function createCommentaryController(
  host: ModeHost,
  deps: CommentaryDeps = {}
): CommentaryController {
  const cfg: CommentarySettings = parseCommentarySettings(host.config.modes[MODE_ID]?.config)
  const stateFile = path.join(host.dataDir, 'commentary-state.json')
  const makeClient = deps.makeClient ?? createCaptureClient
  const sleep = deps.sleep ?? realSleep

  // ── what is remembered for the whole stream
  let mem: MemoryState = emptyMemory()
  let loading: Promise<void> | null = null
  /** Bumped when the memory is cleared or the game changes: a model answer that started before is about something else. */
  let epoch = 0

  // ── the loop
  let run: Run | null = null
  let runCounter = 0
  let paused = false
  let phase: Phase = 'off'
  let nextAt = 0
  let reidentify: 'manual' | 'switch' | null = null
  /** Comments since the screen was last read; starts high so the first pass reads it. */
  let sinceRead = Number.MAX_SAFE_INTEGER
  let summarizing = false

  // ── what is wrong now, by cause; each clears when its own step works again
  const issue = {
    capture: null as string | null,
    black: null as string | null,
    model: null as string | null,
  }
  let blackFrames = 0
  let blackStreak = 0
  let modelFailures = 0
  let unreadable = 0
  let lastCapture: Shot | null = null
  let lastTest: Shot | null = null

  // ── the capture service
  let client: { url: string; api: CaptureClient } | null = null
  let windows: readonly WindowInfo[] = []
  let windowsAt = 0
  let windowsBusy = false
  let windowsNote: string | null = null

  /** Reads the saved state once; every caller waits for the same read, so nothing runs on half-loaded state. */
  const load = (): Promise<void> =>
    (loading ??= (async () => {
      mem = parseMemory(await readJson<unknown>(stateFile, null), cfg.summary_max_chars)
    })())
  const save = () => void writeJson(stateFile, memoryFileContent(mem), (m) => host.log('warn', m))

  // ─────────────────────────────── alarms ───────────────────────────────

  const raised = new Map<string, string>()
  /** Raises the alarm, or refreshes its words; true when this changed what the operator sees. */
  const raise = (code: string, level: 'info' | 'warn' | 'error', message: string): boolean => {
    if (raised.get(code) === message) return false
    if (raised.has(code)) host.clearAlarm(code, ALARM_SUBJECT)
    host.alarm(code, level, message, ALARM_SUBJECT)
    raised.set(code, message)
    return true
  }
  const clear = (code: string) => {
    if (raised.delete(code)) host.clearAlarm(code, ALARM_SUBJECT)
  }

  // ─────────────────────────────── small helpers ───────────────────────────────

  const alive = (r: Run) => run === r && !r.signal.aborted
  const intervalMs = () => (mem.interval ?? cfg.interval_sec) * 1000
  const sure = () => mem.game !== '' && mem.confidence >= cfg.confidence_min

  const prompt = (name: (typeof REQUIRED_PROMPTS)[number], vars: Record<string, string> = {}) => {
    const text = host.prompt(MODE_ID, name, vars)
    if (text === null) throw new Error(`the commentary pack has no prompts/${name}.md`)
    return text
  }

  /** The window as the operator would name it. */
  const targetLabel = (): string | null => {
    const pick = mem.window
    if (pick) return pick.title || (pick.process ? `exe:${pick.process}` : `window ${pick.id}`)
    return cfg.window
  }

  /** The ways to name the window, most exact first: the operator's pick by id, by title, by program; or the configured one. */
  const targetQueries = (): string[] => {
    const pick = mem.window
    if (pick) {
      const queries = [pick.id, pick.title, pick.process ? `exe:${pick.process}` : null]
      return [...new Set(queries.filter((q): q is string => q !== null && q !== ''))]
    }
    return cfg.window ? [cfg.window] : []
  }

  const clientFor = (): CaptureClient => {
    const url = host.serviceUrl(cfg.service)
    if (!url)
      throw new CaptureError('service_down', `${SERVICE_DOWN}: it starts with the mode`, true)
    if (client?.url !== url)
      client = { url, api: makeClient(url, { timeoutMs: cfg.capture_timeout_sec * 1000 }) }
    return client.api
  }

  const describeShot = (f: CapturedFrame) =>
    `${f.sourceWidth}x${f.sourceHeight} sent as ${f.width}x${f.height}, brightness ${Math.round(f.brightness)}${
      f.black ? ' (black)' : ''
    }, ${f.method}`

  /** After a capture by a fallback name worked, keep what the window is called now, so the next pass finds it at once. */
  const rememberPick = (w: CapturedFrame['window']) => {
    const pick = mem.window
    // a window the operator typed the name of stays as typed ("part of a title" would not survive being made exact)
    if (!pick || pick.id === null) return
    const next: WindowPick = {
      id: w.id,
      title: cleanTitle(w.title),
      process: cleanTitle(w.process, 260),
    }
    if (pick.id === next.id && pick.title === next.title && pick.process === next.process) return
    mem.window = next
    save()
  }

  /** One picture. Only "no such window" moves on to the next way of naming it; anything else would fail the same way. */
  const captureFrame = async (r: Run | null, queries: string[]): Promise<CapturedFrame> => {
    const api = clientFor()
    let last: unknown
    for (const query of queries) {
      try {
        const frame = await api.capture({
          window: query,
          maxWidth: cfg.capture_width,
          quality: cfg.capture_quality,
          blackThreshold: cfg.black_threshold,
          method: cfg.capture_method,
          ...(r ? { signal: r.signal } : {}),
        })
        rememberPick(frame.window)
        return frame
      } catch (e) {
        last = e
        if (!(e instanceof CaptureError) || e.code !== 'window_not_found') throw e
      }
    }
    throw last
  }

  // ─────────────────────────────── the loop ───────────────────────────────

  const pause = (ms: number, r: Run): Promise<void> => {
    const wake = new AbortController()
    r.wake = () => wake.abort()
    nextAt = host.now() + ms
    return sleep(ms, AbortSignal.any([r.signal, wake.signal]))
  }

  const startRun = (): Run => {
    const abort = new AbortController()
    const r: Run = { id: ++runCounter, abort, signal: abort.signal, wake: () => {}, nudge: null }
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
    for (const code of [...raised.keys()]) clear(code)
  }

  /** The wait that follows the pass in progress is the pause between comments (which the operator can change). */
  let intervalWait = false

  /** Wakes the loop: to look at once (the default), or to measure the wait again because the interval changed. */
  const poke = (how: 'now' | 'retime' = 'now') => {
    const r = run
    if (!r) return
    if (how === 'now' || r.nudge === null) r.nudge = how // a request to look at once wins over a re-timing
    r.wake()
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
    const interval = intervalMs()
    if (paused) return idle('paused', POLL_MS)
    if (host.flags.dancing || host.flags.singing || host.flags.sleeping)
      return idle('waiting', POLL_MS)
    // nothing can be said (or heard) while the stage page is away; pictures would only cost model calls
    if (host.hub.connected === false) return idle('stage', POLL_MS)
    const queries = targetQueries()
    if (queries.length === 0) {
      raise('commentary_window', 'info', NO_WINDOW)
      return idle('no_window', POLL_MS)
    }
    clear('commentary_window')

    // a viewer's reply, or the last thing said here, goes first
    if (host.busy()) {
      phase = 'voice'
      const quiet = await host.whenQuiet(Math.max(interval, 5_000))
      if (!alive(r)) return 0
      if (!quiet) return POLL_MS
    }

    phase = 'capturing'
    let frame: CapturedFrame
    try {
      frame = await captureFrame(r, queries)
    } catch (e) {
      if (!alive(r)) return 0
      return captureFailed(e)
    }
    if (!alive(r)) return 0
    issue.capture = null
    clear('commentary_capture')
    lastCapture = { at: host.now(), text: describeShot(frame) }
    if (frame.black) return blackPicture(frame)
    blackStreak = 0
    issue.black = null
    clear('commentary_black')

    try {
      await study(r, frame)
    } catch (e) {
      if (!alive(r)) return 0
      return modelFailed(e)
    }
    if (!alive(r)) return 0

    // a viewer began while the picture was being read: it is stale now, and the viewer has the voice
    if (host.busy()) return POLL_MS

    phase = 'speaking'
    try {
      await host.tellBrain(prompt('round'), {
        images: [{ mime: frame.mime, base64: frame.base64 }],
      })
    } catch (e) {
      if (!alive(r)) return 0
      return modelFailed(e)
    }
    if (!alive(r)) return 0
    modelFailures = 0
    issue.model = null
    clear('commentary_model')
    finishRound(r)

    // the pause to the next picture runs from the end of the speech, not from the start of the pass
    phase = 'voice'
    await host.whenQuiet(SPEECH_WAIT_MS)
    if (!alive(r)) return 0
    return rest()
  }

  const captureFailed = (e: unknown): number => {
    const why = e instanceof CaptureError ? e.message : firstLine(e)
    const target = targetLabel()
    issue.capture = `cannot capture ${target ? `"${clip(target, 60)}"` : 'the window'}: ${why}`
    if (raise('commentary_capture', 'warn', issue.capture))
      host.log('warn', `commentary: capture failed: ${why}`)
    return rest()
  }

  const blackPicture = (frame: CapturedFrame): number => {
    blackFrames++
    blackStreak++
    issue.black = 'the window is black: exclusive fullscreen? (this picture is skipped)'
    if (blackStreak >= cfg.black_alarm_after)
      raise(
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
      raise(
        'commentary_model',
        'warn',
        `the model did not answer (${why}): commentary waits longer between tries until it does`
      )
    )
      host.log('warn', `commentary: the model failed (${why}); backing off`)
    return idle('waiting', wait)
  }

  // ─────────────────────────────── reading the picture ───────────────────────────────

  const identifyReason = (): IdentifyReason | null => {
    if (reidentify) return reidentify
    if (mem.game === '') return 'first'
    if (mem.confidence < cfg.confidence_min) return 'unsure'
    if (
      cfg.reidentify_minutes > 0 &&
      host.now() - mem.identifiedAt > cfg.reidentify_minutes * 60_000
    )
      return 'timer'
    return null
  }

  /** Asks the model about the picture (attached to the question, never stored). Rejects when the model cannot be reached. */
  const ask = (r: Run, tag: string, text: string, frame: CapturedFrame) => {
    const user: ChatPart[] = [
      { type: 'text', text },
      { type: 'image', mime: frame.mime, base64: frame.base64 },
    ]
    return host.llmText({
      tag,
      user,
      temperature: 0.2,
      maxOutputTokens: 300,
      timeoutMs: cfg.model_timeout_sec * 1000,
      signal: r.signal,
    })
  }

  const pushScene = (scene: string) => {
    if (scene === '' || mem.pending.at(-1) === scene) return
    mem.pending.push(scene)
    if (mem.pending.length > MAX_PENDING) mem.pending.splice(0, mem.pending.length - MAX_PENDING)
  }

  const unreadableAnswer = (what: string, answer: string) => {
    unreadable++
    host.log(
      'warn',
      `commentary: the model's ${what} could not be read: ${clip(cleanNote(answer, 100), 80)}`
    )
    if (unreadable >= 3)
      raise(
        'commentary_analysis',
        'warn',
        `the model's answers about the screen could not be read ${unreadable} times in a row: the game memory is not being updated`
      )
  }

  const readable = () => {
    unreadable = 0
    clear('commentary_analysis')
  }

  const applyIdentification = (found: Identification, reason: IdentifyReason) => {
    const now = host.now()
    if (found.game !== '' && found.confidence >= cfg.confidence_min) {
      const first = mem.game === ''
      const changed = !first && !sameGame(mem.game, found.game)
      mem.game = found.game
      mem.confidence = found.confidence
      mem.identifiedAt = now
      if (found.scene) mem.scene = found.scene
      if (changed) {
        // another game: the story so far is about something else
        mem.summary = ''
        mem.pending = []
        mem.sinceSummary = 0
        epoch++
      }
      pushScene(found.scene)
      reidentify = null
      if (first || changed)
        host.event('mode', `commentary: this is ${changed ? 'now ' : ''}"${found.game}"`)
    } else if (sure() && reason === 'timer') {
      // nothing better than what is known (a loading screen, say): keep it, and look again after the usual time
      mem.identifiedAt = now
      if (found.scene) mem.scene = found.scene
      pushScene(found.scene)
    } else {
      // not sure: the last sure game stays on record (to tell a return from a change), but nothing claims it now
      mem.confidence = found.confidence
      mem.identifiedAt = now
      if (found.scene) mem.scene = found.scene
      pushScene(found.scene)
      reidentify = null
      host.event(
        'mode',
        `commentary: not sure which game this is (confidence ${found.confidence.toFixed(2)})`
      )
    }
    save()
  }

  const identify = async (r: Run, frame: CapturedFrame, reason: IdentifyReason) => {
    phase = 'identifying'
    const answer = await ask(
      r,
      'commentary-identify',
      prompt('identify', { game: mem.game, language: cfg.language }),
      frame
    )
    if (!alive(r)) return
    const found = parseIdentification(answer)
    if (!found) return unreadableAnswer('identification', answer)
    readable()
    applyIdentification(found, reason)
  }

  const analyse = async (r: Run, frame: CapturedFrame) => {
    phase = 'analysing'
    const text = prompt('analyze', { game: mem.game, scene: mem.scene, language: cfg.language })
    const answer = await ask(r, 'commentary-analyze', text, frame)
    if (!alive(r)) return
    const found = parseAnalysis(answer)
    if (!found) return unreadableAnswer('note on the screen', answer)
    readable()
    if (found.scene) {
      mem.scene = found.scene
      pushScene(found.scene)
      save()
    }
    if (found.switched) {
      host.event('mode', 'commentary: the picture looks like another game; identifying it again')
      reidentify = 'switch'
      await identify(r, frame, 'switch')
    }
  }

  /** Before the comment: which game this is, or what is on screen now. Rejects when the model cannot be reached. */
  const study = async (r: Run, frame: CapturedFrame) => {
    const reason = identifyReason()
    if (reason) {
      await identify(r, frame, reason)
      sinceRead = 0
      return
    }
    if (cfg.analysis_every === 0 || sinceRead < cfg.analysis_every) return
    await analyse(r, frame)
    sinceRead = 0
  }

  // ─────────────────────────────── after a comment ───────────────────────────────

  const finishRound = (r: Run) => {
    mem.rounds++
    mem.sinceSummary++
    sinceRead++
    save()
    if (cfg.summary_every > 0 && mem.sinceSummary >= cfg.summary_every && mem.pending.length > 0)
      void summarize(r)
  }

  /** Renews the story so far from the notes since the last one. In the background; a failure leaves the notes for the next try. */
  const summarize = async (r: Run) => {
    if (summarizing) return
    summarizing = true
    const mine = epoch
    const notes = [...mem.pending]
    try {
      const text = prompt('summarize', {
        game: mem.game || 'unknown',
        summary: mem.summary,
        scenes: notes.map((s, i) => `${i + 1}. ${s}`).join('\n'),
        language: cfg.language,
        limit: String(cfg.summary_max_chars),
      })
      const answer = await host.llmText({
        tag: 'commentary-summary',
        user: text,
        temperature: 0.3,
        maxOutputTokens: 800,
        timeoutMs: cfg.model_timeout_sec * 1000,
        signal: r.signal,
      })
      if (mine !== epoch) return // another game, or the operator cleared the memory, while the model was writing
      const summary = parseSummary(answer, cfg.summary_max_chars)
      if (!summary)
        return host.log('warn', 'commentary: the model gave no usable story; the notes are kept')
      mem.summary = summary
      mem.pending = mem.pending.slice(notes.length)
      mem.sinceSummary = 0
      save()
      host.event('mode', 'commentary: the story so far was renewed')
    } catch (e) {
      if (!r.signal.aborted)
        host.log('warn', `commentary: the story could not be renewed: ${firstLine(e)}`)
    } finally {
      summarizing = false
    }
  }

  // ─────────────────────────────── the operator ───────────────────────────────

  const refreshWindows = async (force: boolean): Promise<{ ok: boolean; reason?: string }> => {
    if (host.serviceUrl(cfg.service) === null) {
      windows = []
      windowsNote = `${SERVICE_DOWN}: it starts with the mode`
      return { ok: false, reason: windowsNote }
    }
    if (windowsBusy || (!force && host.now() - windowsAt < WINDOWS_MAX_AGE_MS)) return { ok: true }
    windowsBusy = true
    try {
      windows = await clientFor().windows()
      windowsNote = null
      return { ok: true }
    } catch (e) {
      windowsNote = `the window list could not be read: ${firstLine(e)}`
      return { ok: false, reason: windowsNote }
    } finally {
      windowsAt = host.now()
      windowsBusy = false
    }
  }

  const choose = (pick: WindowPick) => {
    mem.window = pick
    // a new window deserves a fresh try now, not after a wait that belonged to the old one
    modelFailures = 0
    blackStreak = 0
    issue.capture = issue.black = null
    for (const code of ['commentary_capture', 'commentary_black', 'commentary_window']) clear(code)
    save()
    host.event('mode', `commentary: now watching "${clip(targetLabel() ?? '', 60)}"`)
    poke()
  }

  const clearMemory = () => {
    mem = { ...emptyMemory(), window: mem.window, interval: mem.interval }
    epoch++
    reidentify = null
    sinceRead = Number.MAX_SAFE_INTEGER
    save()
    host.event('mode', 'commentary: the game and the story so far were forgotten')
  }

  /** A picture now, to see what the mode would see; no model is asked. */
  const takeTest = async (): Promise<{ ok: boolean; reason?: string }> => {
    const queries = targetQueries()
    if (queries.length === 0) return { ok: false, reason: 'no window is chosen yet' }
    try {
      lastTest = { at: host.now(), text: describeShot(await captureFrame(null, queries)) }
      return { ok: true }
    } catch (e) {
      const why = e instanceof CaptureError ? e.message : firstLine(e)
      lastTest = { at: host.now(), text: `failed: ${why}` }
      return { ok: false, reason: why }
    }
  }

  const problem = (): string | null => issue.capture ?? issue.black ?? issue.model

  const status = (): CommentaryStatus => ({
    phase,
    running: run !== null,
    paused,
    rounds: mem.rounds,
    game: mem.game,
    confidence: mem.confidence,
    sure: sure(),
    scene: mem.scene,
    summary: mem.summary,
    pending: mem.pending.length,
    blackFrames,
    blackStreak,
    modelFailures,
    window: targetLabel(),
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
      void load()
      return () => stopRun()
    },

    async enter(ctx: ModeContext) {
      await load()
      const missing = REQUIRED_PROMPTS.filter((name) => host.prompt(MODE_ID, name) === null)
      if (missing.length > 0)
        throw new Error(
          `the commentary pack is incomplete: no ${missing.map((n) => `prompts/${n}.md`).join(', ')}`
        )
      if (ctx.signal.aborted) return
      stopRun()
      paused = false
      blackFrames = blackStreak = modelFailures = unreadable = 0
      lastCapture = null
      const r = startRun()
      // the manager aborts this when the mode is torn down, also when the start itself did not finish
      ctx.signal.addEventListener('abort', () => stopRun(r), { once: true })
      void refreshWindows(true)
      const target = targetLabel()
      host.event(
        'mode',
        `commentary started (${target ? `watching "${clip(target, 60)}"` : 'no window chosen yet'})`
      )
    },

    async exit(_ctx: ModeContext, reason: string) {
      const was = run !== null
      stopRun()
      if (was) host.event('mode', `commentary stopped (${reason})`)
    },

    promptVars() {
      const seen = mem.scene ? host.prompt(MODE_ID, 'seen', { scene: mem.scene }) : ''
      const screen = sure()
        ? host.prompt(MODE_ID, 'screen_known', { game: mem.game, seen: seen ?? '' })
        : host.prompt(MODE_ID, 'screen_unsure')
      const progress = mem.summary ? host.prompt(MODE_ID, 'progress', { summary: mem.summary }) : ''
      return { screen: screen ?? '', progress: progress ?? '' }
    },

    panel(): ModePanelInput {
      const serviceUp = host.serviceUrl(cfg.service) !== null
      void refreshWindows(false) // also when the service is down: it then forgets a list that is out of date
      const now = host.now()
      const shot = (s: Shot | null) => (s ? `${s.text}, ${ago(now - s.at)}` : null)
      const pick = mem.window
      return buildPanel({
        running: run !== null,
        paused,
        status: statusLine(),
        serviceUp,
        target: pick?.title && pick.process ? `${pick.title} (${pick.process})` : targetLabel(),
        targetId: pick?.id ?? null,
        intervalSec: mem.interval ?? cfg.interval_sec,
        game: mem.game,
        confidence: mem.confidence,
        sure: sure(),
        identifiedAgo: mem.identifiedAt > 0 ? ago(now - mem.identifiedAt) : null,
        scene: mem.scene,
        summary: mem.summary,
        rounds: mem.rounds,
        untilSummary:
          cfg.summary_every > 0 ? Math.max(0, cfg.summary_every - mem.sinceSummary) : null,
        blackFrames,
        lastCapture: shot(lastCapture),
        lastTest: shot(lastTest),
        windows,
        windowsNote,
      })
    },

    async onConsoleRequest(req) {
      const action = typeof req.action === 'string' && req.action !== '' ? req.action : 'start'
      switch (action) {
        case 'start':
          await load()
          return host.enterMode(MODE_ID, {
            ...(req.replace === true ? { replace: true } : {}),
            ...(req.force === true ? { force: true } : {}),
          })
        case 'use_window': {
          await load()
          const typed = typeof req.title === 'string' ? cleanTitle(req.title) : ''
          const chosen =
            typeof req.row === 'string' ? req.row : typeof req.window === 'string' ? req.window : ''
          if (typed !== '') choose({ id: null, title: typed, process: '' })
          else if (chosen !== '') {
            const w = windows.find((x) => x.id === chosen)
            if (w)
              choose({ id: w.id, title: cleanTitle(w.title), process: cleanTitle(w.process, 260) })
            else if (/^\d{1,20}$/.test(chosen)) choose({ id: chosen, title: '', process: '' })
            else choose({ id: null, title: cleanTitle(chosen), process: '' })
          } else
            return { ok: false, reason: 'choose a window from the list, or type part of its title' }
          return { ok: true }
        }
        case 'refresh':
          return refreshWindows(true)
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
          await load()
          mem.interval = Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, n))
          save()
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
          reidentify = 'manual'
          host.event('mode', 'commentary: the next picture will be used to identify the game again')
          poke()
          return { ok: true }
        case 'test':
          await load()
          return takeTest()
        case 'clear_memory':
          await load()
          clearMemory()
          return { ok: true }
        default:
          return { ok: false, reason: `the commentary mode has no action "${action.slice(0, 40)}"` }
      }
    },
  }
}
