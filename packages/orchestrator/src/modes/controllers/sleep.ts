/**
 * Sleep mode, ported from the legacy page's sleep module.
 *
 * While it is active a prerendered whisper track plays on the stage (a playlist of the files in the `asmr` library),
 * everything that is said is said in the whisper voice, and the audience's chat is answered only now and then: the
 * inbox pacer already picks one message, marks it (`【助眠】`) and sends it no more often than `inbox.sleep` allows.
 * This controller adds what the pacer cannot know about:
 *
 *  - **the playlist**: play the tracks in turn (or shuffled), start the next one when the stage says one ended, skip a
 *    track the stage cannot play, and when none can be played say so and stay up, because the whispers are still wanted;
 *  - **a reply**: when a chat line reaches `onBatch` the track fades out, the model answers in a whisper, and the track
 *    comes back a moment after everything is quiet. Whatever goes wrong meanwhile (no answer, a failing model, a stage that
 *    goes away) the track comes back, and two replies never make two pauses;
 *  - **the stage coming and going**: commands are not re-sent to a page that connects later, so the track is sent again.
 *
 * Not its job (the pack's `stage:` section and the stage do them): the calm look (slow breathing, small motion, no nodding
 * along, a small mouth, dimmed light, the night background), the fades, the captions from the audio clock.
 *
 * Entering does its side effects in one synchronous step after the last `await`, so an entry the manager has given up on
 * (the operator pressed stop while the folder was being read) can never set a flag or send a track afterwards.
 */
import path from 'node:path'
import { z } from 'zod'
import type { ModePanelInput, SleepState, StageDownstreamInput } from '@animatus/protocol'
import type { Batch } from '../../inbox/types.ts'
import { sleep } from '../../stage/util.ts'
import type { ModeControllerFull, ModeHost } from '../host.ts'
import { readJson, writeJson } from '../jsonfile.ts'
import type { ModeContext } from '../manager.ts'
import { clip, sleepPanel } from './sleepPanel.ts'
import { planRound } from './sleepRound.ts'
import { scanSleepTracks } from './sleepTracks.ts'
import type { TrackFile, TrackScan } from './sleepTracks.ts'

export const SleepSettings = z.strictObject({
  /** How loud the track is: 0 silent, 1 as it was made. */
  volume: z.number().min(0).max(1).default(1),
  /** The fade-in of a track when it starts and when it comes back after a reply, seconds. */
  fade_in_s: z.number().min(0).max(10).default(1.5),
  /** The fade-out when the track gives way to a reply and when the mode ends, seconds. */
  fade_s: z.number().min(0).max(10).default(1),
  /** How long everything has to stay quiet after a reply before the track comes back, seconds. */
  reply_resume_delay_s: z.number().min(0).max(30).default(1.5),
  /** The longest a reply may keep the track waiting; after this it comes back whatever is going on, seconds. */
  reply_max_wait_s: z.number().min(5).max(600).default(120),
  /** The stage must report a track as playing within this long of being sent it, or the track counts as failed. */
  start_timeout_s: z.number().min(5).max(120).default(20),
  /** Play the tracks in random order, each once per round. */
  shuffle: z.boolean().default(false),
  /** Start again after the last track; false stops there (whispered replies still work). */
  loop: z.boolean().default(true),
  /** Send each track's caption timeline to the stage (shown on the subtitle overlay when that is on). */
  captions: z.boolean().default(true),
  /** The key in `tts.styles` (a reference recording) that everything is spoken in while the mode is active. */
  whisper_style: z.string().min(1).max(32).default('whisper'),
})
export type SleepSettings = z.infer<typeof SleepSettings>

/** Why no track is wanted right now: there are none, the playlist is over, or every one failed. */
export type SleepIdle = 'empty' | 'finished' | 'failed'

export interface SleepStatus {
  running: boolean
  /** The key of the track the stage is meant to be playing. */
  track: string | null
  /** What the stage last reported about it. */
  stage: SleepState['phase'] | null
  /** A reply (or a test line) has the track waiting. */
  replying: boolean
  idle: SleepIdle | null
  volume: number
  tracks: number
}

/**
 * What a test may replace: reading the folder, reading the saved state (real disk I/O has no place under fake timers)
 * and the dice.
 */
export interface SleepDeps {
  scan?: (dir: string) => Promise<TrackScan>
  readState?: () => Promise<unknown>
  random?: () => number
}

interface Track extends TrackFile {
  url: string
}

/** One stretch during which the track is kept waiting for whispered speech. */
interface Cycle {
  /** Ends the stretch whatever is going on. */
  cap: NodeJS.Timeout
}

/** Everything that belongs to one entry of the mode; gone when the mode is left. */
interface Run {
  /** Aborted when the run ends, so every wait stops. */
  abort: AbortController
  /** What is left of this round, in the order it will be played. */
  queue: Track[]
  /** Tracks the stage could not play in this round. */
  failed: Set<string>
  /** Tracks in a row that could not be played. */
  streak: number
  /** The track the stage is meant to be playing. */
  current: Track | null
  /** The `track_id` of the last `sleep.play`: reports for any other id are old news. */
  playId: string
  /** What the stage last reported for `playId`. */
  phase: SleepState['phase'] | null
  idle: SleepIdle | null
  lastError: string | null
  cycle: Cycle | null
  /**
   * A pause was sent and no resume or play has followed. Whether to resume goes by this, not by what the stage reported:
   * a quick reply can end before the stage's `paused` report arrives.
   */
  paused: boolean
  /** The volume the stage was last told for the track; the operator may have changed it since. */
  sentVolume: number
  /** The stage has to be sent the track again (a new page, or none was connected when it was sent). */
  needsPlay: boolean
  /** The track ended or failed while a reply was being whispered: move on afterwards. */
  needsAdvance: boolean
  /** The operator picked a track or "next" while a reply was being whispered: do it afterwards. */
  jump: Track | 'next' | null
  /** Gives up on a track the stage never starts. */
  watchdog: NodeJS.Timeout | null
  /** Holds the voice until the track has faded out. */
  fadeHold: NodeJS.Timeout | null
}

/** The library is looked at again this often while the program runs (the console polls the panel every 2 s). */
const RESCAN_MS = 15_000
/** A folder that takes longer than this to read counts as unreadable. */
const SCAN_TIMEOUT_MS = 10_000
/** Changing the volume of a playing track: the stage can only fade up from silence, so keep it short. */
const VOLUME_FADE_S = 0.5

/**
 * Used when the pack has no such prompt file. An operator's override folder cannot remove one, so this is a safety net;
 * the documented defaults are the files in `modes/sleep/prompts/`.
 */
const FALLBACK_REPLY_LINE =
  '(Sleep time. Answer the message marked 【助眠】 in one or two very short whispered sentences and wish them a good night. No questions, no exclamations, no emoji, no motion tags.)'
const FALLBACK_TEST_LINE = '闭上眼睛，慢慢呼吸，晚安。'

const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split(/\r?\n/, 1)[0] ?? ''
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : null

function parseSettings(raw: unknown): SleepSettings {
  const r = SleepSettings.safeParse(raw ?? {})
  if (r.success) return r.data
  const issues = r.error.issues
    .map((i) => `${i.path.join('.') || '(settings)'}: ${i.message}`)
    .join('; ')
  throw new Error(`invalid settings for the sleep mode (modes.sleep.config): ${issues}`)
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export function createSleepController(
  host: ModeHost,
  deps: SleepDeps = {}
): ModeControllerFull & { status(): SleepStatus } {
  const cfg = parseSettings(host.config.modes.sleep?.config)
  const stateFile = path.join(host.dataDir, 'sleep-state.json')
  const scan = deps.scan ?? scanSleepTracks
  const random = deps.random ?? Math.random

  let run: Run | null = null
  /** Set from the console while the mode is running; a fresh start goes back to `modes.sleep.config.volume`. */
  let volume = cfg.volume
  let tracks: Track[] = []
  let skipped: TrackScan['skipped'] = []
  let library: string | null = null
  /** Why the library could not be read the last time; the previous list is kept then. */
  let problem: string | null = null
  let scanning: Promise<void> | null = null
  let scanAt = Number.NEGATIVE_INFINITY
  let loading: Promise<void> | null = null
  /** The key of the last track that played, remembered across restarts so the next night starts on another one. */
  let lastTrack: string | null = null
  let playCounter = 0
  /** A track the console asked for while the mode was not running; used by the entry that follows. */
  let wanted: string | null = null
  /** Alarm code to what is on the board, so an unchanged problem is not raised again (that would refresh its time). */
  const raised = new Map<string, string>()

  // ─────────────────────────────── small things ───────────────────────────────

  /** False when there is no stage to receive it, or the message was refused (logged). */
  const send = (msg: StageDownstreamInput): boolean => {
    try {
      return host.hub.send(msg)
    } catch (e) {
      host.log('error', `sleep: ${msg.type} was refused: ${firstLine(e)}`)
      return false
    }
  }

  const hasWhisper = () => Object.hasOwn(host.config.tts.styles, cfg.whisper_style)

  const find = (name: string): Track | undefined =>
    tracks.find((t) => t.key === name) ??
    tracks.find((t) => t.key.toLowerCase() === name.toLowerCase())

  const setAlarm = (code: string, level: 'warn' | 'error', message: string | null) => {
    if (message === null) {
      if (raised.delete(code)) host.clearAlarm(code, 'sleep')
      return
    }
    const id = `${level}:${message}`
    if (raised.get(code) === id) return
    raised.set(code, id)
    host.alarm(code, level, message, 'sleep')
  }

  /** The two things worth an alarm, worked out from the state each time it changes so none can be left behind. */
  const syncAlarms = () => {
    const r = run
    if (!r) {
      setAlarm('sleep_whisper_style', 'warn', null)
      setAlarm('sleep_tracks', 'warn', null)
      return
    }
    setAlarm(
      'sleep_whisper_style',
      'warn',
      hasWhisper()
        ? null
        : `sleep mode: tts.styles has no "${cfg.whisper_style}" entry, so whispered lines are spoken in the normal voice (add a reference recording under that name)`
    )
    if (r.idle === 'failed')
      setAlarm(
        'sleep_tracks',
        'error',
        `sleep mode: none of the ${tracks.length} track(s) could be played (${r.lastError ?? 'no reason given'}); only whispered replies until a track is played from the console`
      )
    else if (tracks.length === 0)
      setAlarm(
        'sleep_tracks',
        'warn',
        `sleep mode has no track to play: ${problem ?? 'no audio files were found in the asmr folder'}; only whispered replies`
      )
    else setAlarm('sleep_tracks', 'warn', null)
  }

  // ─────────────────────────────── the library and what is remembered ───────────────────────────────

  /** Reads the saved state once; every caller waits for the same read, so nothing runs on half-loaded state. */
  const load = (): Promise<void> =>
    (loading ??= (async () => {
      const raw = await (deps.readState?.() ?? readJson<unknown>(stateFile, {}))
      const v = isObject(raw) ? raw.last_track : undefined
      lastTrack = typeof v === 'string' && v !== '' && v.length <= 120 ? v : null
    })())

  const remember = (track: Track) => {
    if (lastTrack === track.key) return
    lastTrack = track.key
    void writeJson(stateFile, { last_track: track.key }, (m) => host.log('warn', m))
  }

  /** Looks at the folder now, or when it was last looked at long enough ago. Never rejects; one look at a time. */
  const refresh = (force: boolean): Promise<void> => {
    if (scanning) return scanning
    if (!force && host.now() - scanAt < RESCAN_MS) return Promise.resolve()
    scanAt = host.now()
    scanning = (async () => {
      library = host.libraryDir('asmr')
      if (!library) {
        tracks = []
        skipped = []
        problem = 'paths.asmr is not set, so there is no folder to read tracks from'
        return
      }
      try {
        const result = await withTimeout(
          scan(library),
          SCAN_TIMEOUT_MS,
          'reading the folder took too long'
        )
        const found: Track[] = []
        const left = [...result.skipped]
        for (const t of result.tracks) {
          try {
            found.push({ ...t, url: host.assetUrl('asmr', ...t.parts) })
          } catch (e) {
            left.push({ path: t.key, reason: firstLine(e) })
          }
        }
        tracks = found
        skipped = left
        problem = null
      } catch (e) {
        problem = `the asmr folder cannot be read (${firstLine(e)})`
      }
    })()
      .then(() => {
        const r = run
        // tracks that appear while the mode has nothing to play start playing
        if (r && !r.cycle && r.idle === 'empty' && tracks.length > 0) restart(r)
        syncAlarms()
      })
      .catch((e) => host.log('error', `sleep: after reading the folder: ${firstLine(e)}`))
      .finally(() => (scanning = null))
    return scanning
  }

  // ─────────────────────────────── the playlist ───────────────────────────────

  const startRound = (r: Run, first?: Track) => {
    r.failed.clear()
    r.queue = planRound(tracks, {
      shuffle: cfg.shuffle,
      ...(first ? { first } : {}),
      avoid: r.current?.key ?? lastTrack,
      random,
    })
  }

  const restart = (r: Run) => {
    r.idle = null
    r.streak = 0
    r.lastError = null
    startRound(r)
    advance(r)
  }

  /** The next track of the round; when the round is over, a new one, or an end to the playlist. */
  function advance(r: Run): void {
    for (;;) {
      const next = r.queue.shift()
      if (next === undefined) break
      if (r.failed.has(next.key)) continue
      play(r, next)
      return
    }
    if (tracks.length === 0) {
      r.idle = 'empty'
      r.current = null
      syncAlarms()
    } else if (!cfg.loop) {
      r.idle = 'finished'
      host.event('mode', 'sleep: the playlist has ended; whispered replies only from here')
    } else {
      startRound(r)
      advance(r)
    }
  }

  function play(r: Run, track: Track): void {
    clearWatchdog(r)
    r.current = track
    r.phase = null
    r.paused = false
    r.needsPlay = false
    r.sentVolume = volume
    r.playId = `sleep-${++playCounter}`
    let sent: boolean
    try {
      sent = host.hub.send({
        type: 'sleep.play',
        track_id: r.playId,
        url: track.url,
        volume,
        fade_in_s: cfg.fade_in_s,
        captions: cfg.captions ? track.captions : [],
      })
    } catch (e) {
      trackFailed(r, track, `the stage protocol refused it (${firstLine(e)})`)
      return
    }
    if (!sent) {
      // No stage page is connected: it is sent when one connects.
      r.needsPlay = true
      host.event('mode', `sleep: "${track.title}" is waiting for a stage page to connect`)
      return
    }
    armWatchdog(r)
    host.event('mode', `sleep: playing "${track.title}"`)
  }

  function resume(r: Run): void {
    r.paused = false
    r.sentVolume = volume
    if (!send({ type: 'sleep.resume', fade_s: cfg.fade_in_s, volume })) {
      r.needsPlay = true
      return
    }
    armWatchdog(r)
  }

  function clearWatchdog(r: Run): void {
    if (r.watchdog) clearTimeout(r.watchdog)
    r.watchdog = null
  }

  /** A stage that never says a track is playing must not leave the mode silent for good. */
  function armWatchdog(r: Run): void {
    clearWatchdog(r)
    const timer = setTimeout(() => {
      r.watchdog = null
      if (r.current)
        trackFailed(r, r.current, `the stage did not start it within ${cfg.start_timeout_s} s`)
    }, cfg.start_timeout_s * 1000)
    timer.unref?.()
    r.watchdog = timer
  }

  function trackFailed(r: Run, track: Track, why: string): void {
    clearWatchdog(r)
    r.failed.add(track.key)
    r.streak++
    r.lastError = `"${track.title}": ${why}`
    host.log('warn', `sleep: ${r.lastError}`)
    host.event('mode', `sleep: ${r.lastError}`)
    if (r.streak >= tracks.length) {
      // every track has failed in a row: stop trying, the whispers are still wanted
      r.idle = 'failed'
      syncAlarms()
    } else if (r.cycle) r.needsAdvance = true
    else advance(r)
  }

  function jumpTo(r: Run, target: Track | 'next'): void {
    r.idle = null
    r.streak = 0
    r.lastError = null
    r.needsAdvance = false
    if (target === 'next') {
      if (r.queue.length === 0) startRound(r)
    } else startRound(r, target)
    advance(r)
    syncAlarms()
  }

  /** Now, or after the reply when one is being whispered: nothing is put on top of a whisper. */
  const queueJump = (r: Run, target: Track | 'next') => {
    if (r.cycle) r.jump = target
    else jumpTo(r, target)
  }

  /** What to do about the track once nothing keeps it waiting. */
  function settle(r: Run): void {
    if (r.cycle) return
    if (r.jump !== null) {
      const j = r.jump
      r.jump = null
      jumpTo(r, j)
      return
    }
    if (r.idle === 'empty') {
      if (tracks.length > 0) restart(r)
      return
    }
    if (r.idle !== null) return
    if (r.needsAdvance) {
      r.needsAdvance = false
      advance(r)
      return
    }
    const track = r.current
    if (!track) return
    if (r.needsPlay) play(r, track)
    else if (r.paused) resume(r)
  }

  // ─────────────────────────────── replies ───────────────────────────────

  /**
   * The track gives way to whispered speech. Opening a second stretch while one is open changes nothing: one pause, one
   * resume. The voice is held until the track has faded, so the whisper never lands on top of it.
   */
  function openCycle(r: Run): void {
    if (r.cycle) return
    const cap = setTimeout(() => {
      host.log(
        'warn',
        `sleep: a reply kept the track waiting for ${cfg.reply_max_wait_s} s; it comes back now`
      )
      endCycle(r)
    }, cfg.reply_max_wait_s * 1000)
    cap.unref?.()
    const cycle: Cycle = { cap }
    r.cycle = cycle
    const audible =
      r.current !== null &&
      r.phase !== 'ended' &&
      r.phase !== 'error' &&
      r.phase !== 'off' &&
      r.phase !== 'paused'
    if (audible) {
      r.paused = send({ type: 'sleep.pause', fade_s: cfg.fade_s })
      releaseFadeHold(r)
      if (cfg.fade_s > 0) {
        host.holdSpeech('sleep', true)
        r.fadeHold = setTimeout(() => releaseFadeHold(r), cfg.fade_s * 1000 + 50)
        r.fadeHold.unref?.()
      }
    }
    void finishAfterQuiet(r, cycle)
  }

  function releaseFadeHold(r: Run): void {
    if (!r.fadeHold) return
    clearTimeout(r.fadeHold)
    r.fadeHold = null
    host.holdSpeech('sleep', false)
  }

  /** Waits until everything has been said and stayed quiet for a moment, then lets the track back in. */
  async function finishAfterQuiet(r: Run, cycle: Cycle): Promise<void> {
    try {
      for (;;) {
        const quiet = await host.whenQuiet(cfg.reply_max_wait_s * 1000)
        if (r.cycle !== cycle) return
        if (!quiet) {
          host.log('warn', 'sleep: the reply was not finished in time; the track comes back anyway')
          break
        }
        await sleep(cfg.reply_resume_delay_s * 1000, r.abort.signal)
        if (r.cycle !== cycle) return
        // something else started talking during the wait: wait for that too
        if (!host.busy()) break
      }
      endCycle(r)
    } catch (e) {
      host.log('error', `sleep: the reply could not be finished: ${firstLine(e)}`)
    }
  }

  function endCycle(r: Run): void {
    const cycle = r.cycle
    if (!cycle) return
    clearTimeout(cycle.cap)
    r.cycle = null
    releaseFadeHold(r)
    settle(r)
  }

  // ─────────────────────────────── the stage's reports ───────────────────────────────

  /**
   * The operator's volume, when the track is not playing at it. The stage has no live volume message: a pause and a resume
   * with a short fade, which starts from silence, is the way to a new level. A track that is loading or waiting for a reply
   * gets it when it plays or comes back.
   */
  function applyVolume(r: Run): void {
    if (r.phase !== 'playing' || r.cycle !== null || r.sentVolume === volume) return
    if (!send({ type: 'sleep.pause', fade_s: 0 })) return
    send({ type: 'sleep.resume', fade_s: VOLUME_FADE_S, volume })
    r.sentVolume = volume
  }

  function onPlaying(r: Run): void {
    clearWatchdog(r)
    r.streak = 0
    r.lastError = null
    if (r.current) remember(r.current)
    // a pause that reached the stage while it was still loading did nothing: say it again
    if (r.cycle) r.paused = send({ type: 'sleep.pause', fade_s: cfg.fade_s })
    else applyVolume(r)
    syncAlarms()
  }

  const onState = (m: SleepState) => {
    const r = run
    if (!r || m.track_id === undefined || m.track_id !== r.playId) return
    r.phase = m.phase
    switch (m.phase) {
      case 'playing':
        onPlaying(r)
        break
      case 'ended':
        if (r.cycle) r.needsAdvance = true
        else advance(r)
        break
      case 'error':
        if (r.current) trackFailed(r, r.current, m.error ?? 'the stage could not play it')
        break
      default:
        break // loading, paused, off: the panel shows them
    }
  }

  /** A page that connects has no track, whatever the last one was playing: the current track starts again from its beginning. */
  const onConnected = () => {
    const r = run
    if (!r) return
    r.phase = null
    r.streak = 0
    r.failed.clear()
    // a page that has not seen the tracks fail gets to try them, also when it comes during a reply
    if (r.idle === 'failed') r.idle = null
    if (r.cycle) r.needsPlay = true
    else if (r.idle === null && r.current) play(r, r.current)
    syncAlarms()
  }

  const onDisconnected = () => {
    const r = run
    if (!r) return
    clearWatchdog(r)
    r.phase = null
    r.needsPlay = true
  }

  // ─────────────────────────────── entering and leaving ───────────────────────────────

  function begin(r: Run): void {
    if (tracks.length === 0) {
      r.idle = 'empty'
      return
    }
    let first: Track | undefined
    if (wanted !== null) {
      first = find(wanted)
      if (!first) host.event('mode', `sleep: there is no track "${wanted}"; starting the playlist`)
    } else if (cfg.loop && !cfg.shuffle && lastTrack !== null) {
      // the next night starts on the track after the one heard last
      const i = tracks.findIndex((t) => t.key === lastTrack)
      if (i >= 0) first = tracks[(i + 1) % tracks.length]
    }
    startRound(r, first)
    advance(r)
  }

  function activate(): void {
    const r: Run = {
      abort: new AbortController(),
      queue: [],
      failed: new Set(),
      streak: 0,
      current: null,
      playId: '',
      phase: null,
      idle: null,
      lastError: null,
      cycle: null,
      paused: false,
      sentVolume: volume,
      needsPlay: false,
      needsAdvance: false,
      jump: null,
      watchdog: null,
      fadeHold: null,
    }
    run = r
    host.flags.sleeping = true
    try {
      host.stopSpeech('sleep mode')
      host.setVoiceStyle(cfg.whisper_style)
      host.event('mode', `sleep mode on (${tracks.length} track(s))`)
      begin(r)
      syncAlarms()
    } catch (e) {
      deactivate('start failed')
      throw e
    }
  }

  /** Puts everything back. Safe to call any number of times, and from any state. */
  function deactivate(reason: string): void {
    const r = run
    if (!r) return
    run = null
    r.abort.abort()
    clearWatchdog(r)
    releaseFadeHold(r)
    if (r.cycle) {
      // a whisper cut in half is better than its second half in the normal voice
      clearTimeout(r.cycle.cap)
      r.cycle = null
      host.stopSpeech('sleep mode ended')
    }
    send({ type: 'sleep.stop', fade_s: cfg.fade_s })
    host.setVoiceStyle(null)
    host.flags.sleeping = false
    syncAlarms()
    host.event('mode', `sleep mode over (${reason})`)
  }

  // ─────────────────────────────── the console ───────────────────────────────

  const refuse = (reason: string) => ({ ok: false as const, reason })

  const setVolume = (v: number) => {
    volume = v
    if (run) applyVolume(run)
  }

  const testLine = () => host.prompt('sleep', 'whisper_test') ?? FALLBACK_TEST_LINE

  return {
    status: () => ({
      running: run !== null,
      track: run?.current?.key ?? null,
      stage: run?.phase ?? null,
      replying: run?.cycle != null,
      idle: run?.idle ?? null,
      volume,
      tracks: tracks.length,
    }),

    attach() {
      host.hub.on('sleep.state', onState)
      host.hub.on('connected', onConnected)
      host.hub.on('disconnected', onDisconnected)
      void load()
      void refresh(true)
      return () => {
        host.hub.off('sleep.state', onState)
        host.hub.off('connected', onConnected)
        host.hub.off('disconnected', onDisconnected)
      }
    },

    async enter(ctx: ModeContext) {
      await load()
      await refresh(true)
      // No `await` from here on: an entry that was given up on stops here, before it has done anything.
      if (ctx.signal.aborted) throw new Error('aborted')
      activate()
    },

    async exit(_ctx: ModeContext, reason: string) {
      deactivate(reason)
    },

    onBatch(batch: Batch): string[] {
      const r = run
      if (!r || !batch.parts.some((p) => p.kind === 'sleep')) return []
      openCycle(r)
      host.event('mode', 'sleep: whispering a reply to a chat line')
      // The line itself is the user message; what goes into the prompt is the instruction, never the viewer's words.
      return [host.prompt('sleep', 'reply') ?? FALLBACK_REPLY_LINE]
    },

    panel(): ModePanelInput {
      // The console asks every couple of seconds while it is open: that is what keeps the list current.
      void refresh(false)
      const r = run
      const inbox = host.config.inbox.sleep
      return sleepPanel({
        running: r !== null,
        idle: r?.idle ?? null,
        replying: r?.cycle != null,
        phase: r?.phase ?? null,
        connected: host.hub.connected,
        currentKey: r?.current?.key ?? null,
        upcoming: r?.queue.map((t) => t.key) ?? [],
        lastError: r?.lastError ?? null,
        tracks: tracks.map((t) => ({
          key: t.key,
          title: t.title,
          durationS: t.durationS,
          lines: t.captions.length,
          ext: t.ext,
          notes: t.notes,
        })),
        skipped,
        library,
        problem,
        volume,
        whisper: { style: cfg.whisper_style, found: hasWhisper() },
        order: { shuffle: cfg.shuffle, loop: cfg.loop },
        replies: {
          enabled: inbox.enabled,
          firstAfterS: inbox.firstReplyAfterSec,
          everyS: inbox.replyIntervalSec,
        },
        testLine: testLine(),
      })
    },

    async onConsoleRequest(req) {
      const action = typeof req.action === 'string' ? req.action : 'start'
      switch (action) {
        case 'start':
        case 'play': {
          // a button on a row names the track in `row`; the API can also send `track`
          const name =
            typeof req.row === 'string' ? req.row : typeof req.track === 'string' ? req.track : null
          if (name !== null) {
            await refresh(true)
            if (!find(name)) return refuse(`there is no track "${clip(name, 60)}"`)
          }
          const r = run
          if (r) {
            if (name !== null) queueJump(r, find(name) as Track)
            return { ok: true }
          }
          wanted = name
          try {
            return await host.enterMode('sleep', {
              ...(req.replace === true ? { replace: true } : {}),
              ...(req.force === true ? { force: true } : {}),
            })
          } finally {
            wanted = null
          }
        }
        case 'next':
          if (!run) return refuse('sleep mode is not running')
          if (tracks.length === 0) return refuse('there are no tracks')
          queueJump(run, 'next')
          return { ok: true }
        case 'skip': {
          // the button of a row names the track in `row`; without a name it is the one that is playing
          const r = run
          if (!r) return refuse('sleep mode is not running')
          if (r.idle !== null) return refuse('nothing is playing')
          const name =
            typeof req.row === 'string' ? req.row : typeof req.track === 'string' ? req.track : null
          const track = name === null ? r.current : find(name)
          if (!track)
            return refuse(
              name === null ? 'nothing is playing' : `there is no track "${clip(name, 60)}"`
            )
          if (track.key === r.current?.key) {
            queueJump(r, 'next')
            return { ok: true }
          }
          // one that is still to come is left out of the rest of this round (it is back in the next)
          const before = r.queue.length
          r.queue = r.queue.filter((t) => t.key !== track.key)
          if (r.queue.length === before)
            return refuse(`"${track.title}" is not coming up in this round`)
          host.event('mode', `sleep: "${track.title}" is left out of the rest of this round`)
          return { ok: true }
        }
        case 'volume': {
          const v = asNumber(req.volume)
          if (v === null || !Number.isFinite(v))
            return refuse('the volume must be a number from 0 to 1')
          setVolume(Math.min(1, Math.max(0, v)))
          return { ok: true }
        }
        case 'whisper_test': {
          const r = run
          if (!r) return refuse('sleep mode is not running')
          if (r.cycle) return refuse('something is being whispered right now')
          const typed = typeof req.text === 'string' ? req.text.trim() : ''
          openCycle(r)
          try {
            host.say({
              text: clip(typed || testLine(), 200),
              emotion: 'neutral',
              style: cfg.whisper_style,
            })
          } catch (e) {
            endCycle(r)
            return refuse(`the line could not be spoken: ${firstLine(e)}`)
          }
          host.event('mode', 'sleep: whispering a test line')
          return { ok: true }
        }
        case 'stop':
          if (!run) return refuse('sleep mode is not running')
          await host.exitMode('sleep', 'console')
          return { ok: true }
        default:
          return refuse(`sleep mode has no action "${clip(action, 40)}"`)
      }
    },
  }
}
