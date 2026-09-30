/**
 * Scripted replay: soak-tests the stage without the brain.
 *
 *   npm run replay -w @animatus/orchestrator -- <scenario.json> [--duration 1800] [--no-launch] [--port 5810]
 *
 * It starts the stage server, optionally opens the stage in a browser window, then speaks prerecorded
 * WAV files in a random order (with optional motion tags and scheduled dances) for the given
 * duration, and finally checks the stage's own counters (audio contexts, T-pose frames, underruns,
 * playback end reasons) against the scenario's expectations. Exit code: 0 PASS, 1 FAIL, 2 bad
 * usage or scenario, 130 interrupted.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { Emotion } from '@animatus/protocol'
import {
  pickTagClip,
  scanMotionLibrary,
  toDancePlay,
  toLibrarySet,
} from '../library/motionLibrary.ts'
import type { ClipRef, DanceInfo, MotionLibraryScan } from '../library/motionLibrary.ts'
import { isSafeSegment, resolveInsideRoot } from '../stage/assets.ts'
import { StageSendError, StageWaitError } from '../stage/hub.ts'
import type { Report } from '../stage/hub.ts'
import { buildStageBrowserArgs, launchStageWindow } from '../stage/launcher.ts'
import { createConsoleLogger, noopLogger } from '../stage/logger.ts'
import type { Logger } from '../stage/logger.ts'
import { createStageServer } from '../stage/server.ts'
import type { StageServer } from '../stage/server.ts'
import { errorMessage, sleep, stripBom } from '../stage/util.ts'

// ───────────────────────────── errors ─────────────────────────────

/** The scenario or the command line is wrong (exit code 2). */
export class ScenarioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScenarioError'
  }
}

/** The run itself failed (exit code 1). */
export class ReplayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayError'
  }
}

// ───────────────────────────── scenario ─────────────────────────────

const Expectations = z
  .object({
    maxAudioContexts: z.number().int().min(0).default(1),
    maxTposeFrames: z.number().int().min(0).default(0),
    maxUnderrunsPerMinute: z.number().min(0).default(3),
    /** The stage page must stay connected for the whole run. */
    maxDisconnects: z.number().int().min(0).default(0),
    /** Unset: stage `error` reports are printed but do not fail the run. */
    maxStageErrors: z.number().int().min(0).optional(),
  })
  .strict()
export type ReplayExpect = z.output<typeof Expectations>

export const ReplayScenario = z
  .object({
    /** Asset libraries to serve. `models` and `motions` are required; others (for example `lipsync`) are passed through. */
    libraries: z
      .record(z.string().min(1), z.string().min(1))
      .refine(
        (l) => 'models' in l && 'motions' in l,
        'libraries must define "models" and "motions"'
      ),
    /** File name (relative path) inside the `models` library. */
    model: z.string().min(1),
    /** Without it (or with --no-launch) the URL is printed and you open the stage yourself. */
    browser: z
      .object({
        executable: z.string().min(1),
        /** Must contain "animatus-stage" in its path. */
        profileDir: z.string().min(1),
        windowSize: z
          .tuple([z.number().int().min(320).max(7680), z.number().int().min(240).max(4320)])
          .default([1280, 720]),
      })
      .strict()
      .optional(),
    utterances: z
      .array(
        z
          .object({
            wav: z.string().min(1),
            text: z.string().max(2000).optional(),
            emotion: Emotion.default('neutral'),
            /** A motion tag from the motion library (`poses/<tag>.vrma`). */
            motion: z.string().min(1).max(64).optional(),
          })
          .strict()
      )
      .min(1),
    /** Random pause between utterances, [min, max] ms. */
    gapMs: z
      .tuple([z.number().int().min(0).max(600_000), z.number().int().min(0).max(600_000)])
      .refine(([min, max]) => min <= max, 'gapMs must be [min, max] with min <= max')
      .default([200, 900]),
    /** Dances to start (after the current utterance) once the run has lasted `atSeconds`. */
    dances: z
      .array(z.object({ atSeconds: z.number().min(0), name: z.string().min(1) }).strict())
      .default([]),
    expect: Expectations.default({
      maxAudioContexts: 1,
      maxTposeFrames: 0,
      maxUnderrunsPerMinute: 3,
      maxDisconnects: 0,
    }),
  })
  .strict()
export type ReplayScenario = z.output<typeof ReplayScenario>

const resolveFrom = (baseDir: string, p: string) => path.resolve(baseDir, p)

/**
 * Validates a scenario and makes its paths absolute (relative paths are relative to the scenario
 * file's folder). Throws ScenarioError listing every problem.
 */
export function parseScenario(json: unknown, baseDir: string): ReplayScenario {
  const r = ReplayScenario.safeParse(json)
  if (!r.success) {
    const lines = r.error.issues.map(
      (i) => `  ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`
    )
    throw new ScenarioError(`invalid scenario:\n${lines.join('\n')}`)
  }
  const s = r.data
  return {
    ...s,
    libraries: Object.fromEntries(
      Object.entries(s.libraries).map(([name, dir]) => [name, resolveFrom(baseDir, dir)])
    ),
    browser: s.browser && { ...s.browser, profileDir: resolveFrom(baseDir, s.browser.profileDir) },
    utterances: s.utterances.map((u) => ({ ...u, wav: resolveFrom(baseDir, u.wav) })),
  }
}

// ───────────────────────────── WAV ─────────────────────────────

export class WavError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WavError'
  }
}

export interface DecodedWav {
  /** Little-endian mono PCM16 at the file's sample rate. */
  pcm16: Uint8Array
  sampleRate: number
  /** Channel count of the source file (mixed down to mono). */
  channels: number
  /** Sample frames in the output. */
  frames: number
}

/**
 * Decodes a RIFF/WAVE file (16-bit PCM or 32-bit IEEE float, any channel count) to mono PCM16 at the
 * file's own sample rate. Channels are averaged; float samples are clamped to [-1, 1]. Any other
 * sample format is rejected with a clear message.
 */
export function decodeWavToPcm16(bytes: Uint8Array): DecodedWav {
  const len = bytes.byteLength
  if (len < 12) throw new WavError('not a WAV file: too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, len)
  const fourcc = (o: number) =>
    String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
  if (fourcc(0) !== 'RIFF' || fourcc(8) !== 'WAVE')
    throw new WavError('not a WAV file: missing RIFF/WAVE header')

  let fmt: { tag: number; channels: number; sampleRate: number; bits: number } | null = null
  let dataStart = -1
  let dataLen = 0
  for (let pos = 12; pos + 8 <= len;) {
    const id = fourcc(pos)
    const size = dv.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > len) throw new WavError('the fmt chunk is truncated')
      let tag = dv.getUint16(body, true)
      if (tag === 0xfffe) {
        // WAVE_FORMAT_EXTENSIBLE: the real format code is the first two bytes of the sub-format GUID.
        if (size < 26 || body + 26 > len)
          throw new WavError('the extensible fmt chunk is truncated')
        tag = dv.getUint16(body + 24, true)
      }
      fmt = {
        tag,
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      dataStart = body
      dataLen = Math.min(size, len - body) // streamed files may claim 0xFFFFFFFF
      break
    }
    pos = body + size + (size % 2) // chunks are word aligned
  }
  if (!fmt) throw new WavError('the WAV file has no fmt chunk before its data')
  if (dataStart < 0) throw new WavError('the WAV file has no data chunk')

  const isPcm16 = fmt.tag === 1 && fmt.bits === 16
  const isFloat32 = fmt.tag === 3 && fmt.bits === 32
  if (!isPcm16 && !isFloat32) {
    const kind = fmt.tag === 1 ? 'integer PCM' : fmt.tag === 3 ? 'float' : `format code ${fmt.tag}`
    throw new WavError(
      `unsupported WAV format (${kind}, ${fmt.bits}-bit): only 16-bit PCM and 32-bit float are supported`
    )
  }
  if (fmt.channels < 1) throw new WavError('the WAV file declares zero channels')
  if (fmt.sampleRate < 1) throw new WavError('the WAV file declares a zero sample rate')

  const sampleBytes = fmt.bits / 8
  const frames = Math.floor(dataLen / (sampleBytes * fmt.channels))
  if (frames === 0) throw new WavError('the WAV file contains no audio samples')

  const pcm16 = new Uint8Array(frames * 2)
  if (isPcm16 && fmt.channels === 1) {
    pcm16.set(bytes.subarray(dataStart, dataStart + frames * 2)) // already what we need, keep it bit exact
  } else {
    const out = new DataView(pcm16.buffer)
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let c = 0; c < fmt.channels; c++) {
        const at = dataStart + (i * fmt.channels + c) * sampleBytes
        if (isPcm16) sum += dv.getInt16(at, true)
        else {
          const x = dv.getFloat32(at, true)
          sum += Number.isFinite(x) ? x : 0
        }
      }
      const mean = sum / fmt.channels
      let v: number
      if (isPcm16) v = Math.round(mean)
      else {
        const s = Math.max(-1, Math.min(1, mean))
        v = Math.round(s < 0 ? s * 32768 : s * 32767)
      }
      out.setInt16(i * 2, Math.max(-32768, Math.min(32767, v)), true)
    }
  }
  return { pcm16, sampleRate: fmt.sampleRate, channels: fmt.channels, frames }
}

export interface LoadedUtterance {
  wav: string
  text?: string
  emotion: z.output<typeof Emotion>
  motion?: string
  pcm16: Uint8Array
  sampleRate: number
  durationMs: number
}

/** Reads and decodes every WAV up front so a bad file fails the run before it starts. */
export async function loadUtterances(
  items: ReplayScenario['utterances']
): Promise<LoadedUtterance[]> {
  const out: LoadedUtterance[] = []
  for (const item of items) {
    let decoded: DecodedWav
    try {
      decoded = decodeWavToPcm16(new Uint8Array(await readFile(item.wav)))
    } catch (err) {
      throw new ScenarioError(`${item.wav}: ${errorMessage(err)}`)
    }
    if (decoded.sampleRate < 8000 || decoded.sampleRate > 96000) {
      throw new ScenarioError(
        `${item.wav}: sample rate ${decoded.sampleRate} Hz is outside the supported 8000..96000 Hz`
      )
    }
    out.push({
      wav: item.wav,
      ...(item.text !== undefined ? { text: item.text } : {}),
      emotion: item.emotion,
      ...(item.motion !== undefined ? { motion: item.motion } : {}),
      pcm16: decoded.pcm16,
      sampleRate: decoded.sampleRate,
      durationMs: (decoded.frames / decoded.sampleRate) * 1000,
    })
  }
  return out
}

// ───────────────────────────── pass / fail ─────────────────────────────

export interface ReplayObservations {
  /** Length of the speaking phase (from the stage being ready to the end of the run). */
  elapsedMs: number
  /** Utterances that ended with a `playback.ended` (any reason). */
  utterancesEnded: number
  /** `playback.ended` reasons, plus `harness_timeout` / `send_aborted` when the run itself gave up on an utterance. */
  endReasons: Record<string, number>
  /** Sum of `underruns` over all `playback.ended` reports. */
  underrunsFromEnded: number
  statsReports: number
  /** null: the stage never reported it. */
  audioContextsCreated: number | null
  tposeFrames: number | null
  underrunsTotal: number | null
  disconnects: number
  stageErrors: number
  dancesPlayed: number
  danceFailures: number
}

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

/** Compares what the stage reported with the scenario's expectations. Missing data fails closed. */
export function evaluateReplay(
  obs: ReplayObservations,
  expected: ReplayExpect
): { pass: boolean; checks: CheckResult[] } {
  const checks: CheckResult[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  add('utterances played', obs.utterancesEnded > 0, `${obs.utterancesEnded} ended`)
  add('stats reported', obs.statsReports > 0, `${obs.statsReports} stats reports received`)

  add(
    'audio contexts created',
    obs.audioContextsCreated !== null && obs.audioContextsCreated <= expected.maxAudioContexts,
    obs.audioContextsCreated === null
      ? 'never reported'
      : `${obs.audioContextsCreated} (max ${expected.maxAudioContexts})`
  )
  add(
    'T-pose frames',
    obs.tposeFrames !== null && obs.tposeFrames <= expected.maxTposeFrames,
    obs.tposeFrames === null
      ? 'never reported'
      : `${obs.tposeFrames} (max ${expected.maxTposeFrames})`
  )

  // Per-minute rates over runs shorter than a minute would be dominated by a single event.
  const minutes = Math.max(obs.elapsedMs / 60_000, 1)
  const underruns = Math.max(obs.underrunsTotal ?? 0, obs.underrunsFromEnded)
  const rate = underruns / minutes
  add(
    'underruns per minute',
    rate <= expected.maxUnderrunsPerMinute,
    `${underruns} in ${(obs.elapsedMs / 60_000).toFixed(1)} min = ${rate.toFixed(2)}/min (max ${expected.maxUnderrunsPerMinute}, rate over at least one minute)`
  )

  const bad = Object.entries(obs.endReasons).filter(([reason, n]) => reason !== 'done' && n > 0)
  add(
    'playback end reasons',
    bad.length === 0,
    bad.length === 0 ? 'all done' : bad.map(([reason, n]) => `${reason} x${n}`).join(', ')
  )

  add(
    'stage stayed connected',
    obs.disconnects <= expected.maxDisconnects,
    `${obs.disconnects} disconnects (max ${expected.maxDisconnects})`
  )
  add(
    'dances completed',
    obs.danceFailures === 0,
    `${obs.dancesPlayed} played, ${obs.danceFailures} failed`
  )
  if (expected.maxStageErrors !== undefined) {
    add(
      'stage errors',
      obs.stageErrors <= expected.maxStageErrors,
      `${obs.stageErrors} (max ${expected.maxStageErrors})`
    )
  }
  return { pass: checks.every((c) => c.ok), checks }
}

// ───────────────────────────── small pure helpers ─────────────────────────────

/** A shuffle bag: every index once in random order, then reshuffled; never the same index twice in a row. */
export function createShuffleBag(count: number, random: () => number): () => number {
  if (!Number.isInteger(count) || count < 1)
    throw new RangeError('count must be a positive integer')
  let bag: number[] = []
  let last = -1
  return () => {
    if (bag.length === 0) {
      bag = Array.from({ length: count }, (_, i) => i)
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.floor(random() * (i + 1)))
        ;[bag[i], bag[j]] = [bag[j] as number, bag[i] as number]
      }
      // the next value is taken from the end: make sure it is not a repeat of the previous one
      if (count > 1 && bag[bag.length - 1] === last) {
        ;[bag[0], bag[bag.length - 1]] = [bag[bag.length - 1] as number, bag[0] as number]
      }
    }
    last = bag.pop() as number
    return last
  }
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatStats(s: Report<'stats'>): string {
  const heap = s.js_heap_mb !== undefined ? ` heap=${s.js_heap_mb.toFixed(0)}MB` : ''
  return (
    `fps=${s.fps.toFixed(1)} p95=${s.frame_ms_p95.toFixed(1)}ms audio_ctx=${s.audio_contexts_open}/${s.audio_contexts_created} ` +
    `underruns=${s.underruns_total} tpose=${s.tpose_frames}/${s.frames_total} models=${s.models_loaded}${heap}`
  )
}

/**
 * Combines the counters of finished stage sessions with the running one (a page reload restarts them).
 * T-pose frames and underruns are events, so they add up; audio contexts are per page, so the worst
 * single session counts.
 */
class SessionCounters {
  private done = { tpose: 0, underruns: 0, contexts: 0 }
  private current = { tpose: 0, underruns: 0, contexts: 0 }
  private seen = { stats: false, contexts: false }

  onStats(s: Report<'stats'>): void {
    this.seen.stats = true
    this.seen.contexts = true
    this.current.tpose = s.tpose_frames
    this.current.underruns = s.underruns_total
    this.current.contexts = Math.max(this.current.contexts, s.audio_contexts_created)
  }

  onAudioState(a: Report<'audio.state'>): void {
    this.seen.contexts = true
    this.current.contexts = Math.max(this.current.contexts, a.contexts_created)
  }

  endSession(): void {
    this.done.tpose += this.current.tpose
    this.done.underruns += this.current.underruns
    this.done.contexts = Math.max(this.done.contexts, this.current.contexts)
    this.current = { tpose: 0, underruns: 0, contexts: 0 }
  }

  get tposeFrames(): number | null {
    return this.seen.stats ? this.done.tpose + this.current.tpose : null
  }
  get underrunsTotal(): number | null {
    return this.seen.stats ? this.done.underruns + this.current.underruns : null
  }
  get audioContextsCreated(): number | null {
    return this.seen.contexts ? Math.max(this.done.contexts, this.current.contexts) : null
  }
}

// ───────────────────────────── the run ─────────────────────────────

export interface ReplayTimeouts {
  /** Waiting for the stage to connect (hello), also after a page reload. */
  connectMs: number
  /** Waiting for the model to finish loading. */
  modelMs: number
  /** Added to an utterance's audio length while waiting for its `playback.ended`. */
  endedSlackMs: number
  /** Waiting for a dance to return to idle. */
  danceMs: number
  /** Waiting for one last `stats` report at the end. */
  finalStatsMs: number
}

export interface ReplayRunOptions {
  /** A scenario from `parseScenario` (absolute paths). */
  scenario: ReplayScenario
  durationS: number
  /** 0 picks a free port. */
  port: number
  /** Open the browser window from `scenario.browser` (ignored when the scenario has none). */
  launch: boolean
  /** Folder of the stage build; `undefined` = packages/stage/dist when it exists, `null` = none. */
  stageDir?: string | null
  out?: (line: string) => void
  logger?: Logger
  /** Aborting stops the run cleanly (Ctrl+C). */
  signal?: AbortSignal
  /** Called once the server listens (before the stage connects). */
  onServerReady?: (server: StageServer) => void
  random?: () => number
  /** How often the latest stats are printed. Default 30 s. */
  statsEveryMs?: number
  timeouts?: Partial<ReplayTimeouts>
}

export interface ReplayResult {
  pass: boolean
  interrupted: boolean
  url: string
  observations: ReplayObservations
  checks: CheckResult[]
}

export function defaultStageDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'stage',
    'dist'
  )
}

const safeSegmentsOf = (relative: string): string[] | null => {
  const parts = relative.split(/[\\/]/)
  return parts.length > 0 && parts.every(isSafeSegment) ? parts : null
}

/** How many utterances in a row may fail (no playback.ended, send aborted) before the run gives up. */
const MAX_CONSECUTIVE_FAILURES = 3

export async function runReplay(opts: ReplayRunOptions): Promise<ReplayResult> {
  const sc = opts.scenario
  const out = opts.out ?? ((line: string) => console.log(line))
  const logger = opts.logger ?? noopLogger
  const random = opts.random ?? Math.random
  const timeouts: ReplayTimeouts = {
    connectMs: 60_000,
    modelMs: 120_000,
    endedSlackMs: 20_000,
    danceMs: 20 * 60_000,
    finalStatsMs: 7000,
    ...opts.timeouts,
  }
  if (!(opts.durationS > 0)) throw new ScenarioError('the duration must be greater than zero')

  // ── everything that can be wrong is checked before anything is started ──
  const modelSegments = safeSegmentsOf(sc.model)
  if (!modelSegments)
    throw new ScenarioError(`model is not a safe relative path: ${JSON.stringify(sc.model)}`)
  const modelsDir = sc.libraries.models as string
  const motionsDir = sc.libraries.motions as string
  if (!(await resolveInsideRoot(modelsDir, modelSegments))) {
    throw new ScenarioError(
      `model file not found in the models library: ${path.join(modelsDir, ...modelSegments)}`
    )
  }
  let motions: MotionLibraryScan
  try {
    motions = await scanMotionLibrary(motionsDir, 'motions')
  } catch (err) {
    throw new ScenarioError(errorMessage(err))
  }
  const danceByName = new Map<string, DanceInfo>(motions.dances.map((d) => [d.name, d]))
  for (const d of sc.dances) {
    if (!danceByName.has(d.name)) {
      throw new ScenarioError(
        `dance "${d.name}" not found in ${path.join(motionsDir, 'dance')} (found: ${[...danceByName.keys()].join(', ') || 'none'})`
      )
    }
  }
  const utterances = await loadUtterances(sc.utterances)
  const browser = opts.launch ? sc.browser : undefined
  if (browser) {
    try {
      buildStageBrowserArgs({
        url: 'http://127.0.0.1:1/',
        profileDir: browser.profileDir,
        windowSize: browser.windowSize,
      })
    } catch (err) {
      throw new ScenarioError(errorMessage(err))
    }
  }
  const stageDir =
    opts.stageDir === undefined
      ? existsSync(defaultStageDir())
        ? defaultStageDir()
        : null
      : opts.stageDir

  // ── state of the run ──
  const counters = new SessionCounters()
  const obs: ReplayObservations = {
    elapsedMs: 0,
    utterancesEnded: 0,
    endReasons: {},
    underrunsFromEnded: 0,
    statsReports: 0,
    audioContextsCreated: null,
    tposeFrames: null,
    underrunsTotal: null,
    disconnects: 0,
    stageErrors: 0,
    dancesPlayed: 0,
    danceFailures: 0,
  }
  const stop = new AbortController()
  const onOuterAbort = () => stop.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  if (opts.signal?.aborted) {
    // Nothing has been started yet, so there is nothing to clean up.
    opts.signal.removeEventListener('abort', onOuterAbort)
    out('interrupted before the replay started')
    return { pass: false, interrupted: true, url: '', observations: obs, checks: [] }
  }

  const server = createStageServer({
    port: opts.port,
    libraries: sc.libraries,
    staticDir: stageDir ?? undefined,
    logger,
  })
  const hub = server.hub
  let child: ChildProcess | null = null
  let statsTimer: NodeJS.Timeout | undefined
  let finishing = false
  const t0 = performance.now()
  let startedAt = t0 // moves to "stage ready" once the loop starts
  const say = (line: string) => out(`[${formatElapsed(performance.now() - t0)}] ${line}`)

  hub.on('stats', (s) => {
    obs.statsReports++
    counters.onStats(s)
  })
  hub.on('audio.state', (a) => counters.onAudioState(a))
  hub.on('stage.error', (e) => {
    obs.stageErrors++
    say(`stage error ${e.code}: ${e.message}`)
  })
  hub.on('disconnected', (info) => {
    counters.endSession()
    if (finishing) return
    obs.disconnects++
    say(`stage disconnected (${info.code} ${info.reason})`)
  })

  try {
    try {
      await server.start()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new ReplayError(
          `port ${opts.port} is already in use (is the orchestrator running? pick another with --port)`
        )
      }
      throw err
    }
    opts.onServerReady?.(server)
    const url = `${server.url}/`
    out(`stage server: ${url}`)
    if (stageDir === null)
      out(
        'warning: the stage has not been built (packages/stage/dist is missing); the page will answer 503'
      )

    // Snapshots are stored in the hub, so they are also re-sent when the page reloads mid-run.
    const modelUrl = `/asset/models/${modelSegments.map(encodeURIComponent).join('/')}`
    hub.setScene({
      type: 'scene.set',
      model: { url: modelUrl, name: (modelSegments[modelSegments.length - 1] ?? '').slice(0, 80) },
      layout: { char: { x: 0, y: 0, scale: 1 } },
      background: { kind: 'none' },
      camera: { fit: 'upper_body' },
    })
    hub.setLibrary(toLibrarySet(motions))
    hub.setLook({ type: 'look.set' })
    out(
      `motion library: ${motions.talk.length} talk, ${motions.idleVariants.length} idle variants, ${motions.tags.size} tags, ` +
        `${motions.dances.length} dances${motions.skipped.length ? `, ${motions.skipped.length} files skipped` : ''}`
    )

    if (browser) {
      child = launchStageWindow({
        executable: browser.executable,
        profileDir: browser.profileDir,
        windowSize: browser.windowSize,
        url,
        logger,
      })
      out(`browser launched (pid ${child.pid ?? 'unknown'})`)
    } else {
      out(`open ${url} in a browser window to start`)
    }

    // ── waiting for the stage ──
    const waitModelReady = async () => {
      const current = hub.state.model
      if (current?.status === 'ready') return
      if (current?.status === 'error')
        throw new ReplayError(
          `the stage could not load the model: ${current.error ?? 'no details'}`
        )
      let r: Report<'model.state'>
      try {
        r = await hub.waitFor(
          (rep): rep is Report<'model.state'> =>
            rep.type === 'model.state' && (rep.status === 'ready' || rep.status === 'error'),
          { timeoutMs: timeouts.modelMs, signal: stop.signal, rejectOnDisconnect: true }
        )
      } catch (err) {
        if (err instanceof StageWaitError && err.reason === 'timeout') {
          throw new ReplayError(`the model was not ready within ${timeouts.modelMs / 1000} s`)
        }
        throw err
      }
      if (r.status === 'error')
        throw new ReplayError(`the stage could not load the model: ${r.error ?? 'no details'}`)
    }
    const waitConnected = async (what: string) => {
      try {
        await hub.waitForConnected({ timeoutMs: timeouts.connectMs, signal: stop.signal })
      } catch (err) {
        if (err instanceof StageWaitError && err.reason === 'timeout') {
          throw new ReplayError(`the stage did not ${what} within ${timeouts.connectMs / 1000} s`)
        }
        throw err
      }
    }
    const ensureStage = async () => {
      if (!hub.connected) {
        say('waiting for the stage to reconnect ...')
        await waitConnected('reconnect')
      }
      await waitModelReady()
    }

    try {
      await waitConnected('connect')
      say(`stage connected: ${hub.state.hello?.ua || 'unknown user agent'}`)
      await waitModelReady()
      say('model ready, starting the replay')
    } catch (err) {
      // Ctrl+C while waiting for the page is a clean stop, not a failure.
      if (stop.signal.aborted && err instanceof StageWaitError && err.reason === 'aborted') {
        out('interrupted before the replay started')
        return {
          pass: false,
          interrupted: true,
          url,
          observations: { ...obs, endReasons: {} },
          checks: [],
        }
      }
      throw err
    }

    // ── the loop ──
    startedAt = performance.now()
    const runMs = () => performance.now() - startedAt
    const endAt = opts.durationS * 1000
    statsTimer = setInterval(() => {
      if (hub.state.stats) say(`stats ${formatStats(hub.state.stats)}`)
    }, opts.statsEveryMs ?? 30_000)

    const pendingDances = [...sc.dances].sort((a, b) => a.atSeconds - b.atSeconds)
    for (const d of pendingDances) {
      if (d.atSeconds >= opts.durationS)
        say(
          `note: dance "${d.name}" at ${d.atSeconds} s is after the end of the run and will not be played`
        )
    }
    const nextIndex = createShuffleBag(utterances.length, random)
    const lastPicks = new Map<string, string>()
    const warnedTags = new Set<string>()
    let seq = 0
    let danceSeq = 0
    let consecutiveFailures = 0

    /** The run gives up on this utterance (not the stage's fault to report as `done`); several in a row end the run. */
    const noteFailure = (reason: string, detail: string) => {
      obs.endReasons[reason] = (obs.endReasons[reason] ?? 0) + 1
      say(`#${seq} ${reason}: ${detail}`)
      seq++
      hub.cancelAll()
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new ReplayError(
          `${MAX_CONSECUTIVE_FAILURES} utterances in a row failed (last: ${reason}: ${detail})`
        )
      }
    }

    const speak = async (u: LoadedUtterance) => {
      const utteranceId = `replay-${seq}`
      let clip: ClipRef | null = null
      if (u.motion !== undefined) {
        clip = pickTagClip(motions, u.motion, lastPicks, random)
        if (!clip && !warnedTags.has(u.motion)) {
          warnedTags.add(u.motion)
          say(`warning: no motion clips for tag "${u.motion}"; speaking without a body motion`)
        }
      }
      // Registered before sending: the report cannot be missed, whatever the timing.
      const waiter = new AbortController()
      const ended = hub.waitFor(
        (r): r is Report<'playback.ended'> =>
          r.type === 'playback.ended' && r.utterance_id === utteranceId,
        {
          timeoutMs: u.durationMs + timeouts.endedSlackMs,
          signal: AbortSignal.any([stop.signal, waiter.signal]),
          rejectOnDisconnect: true,
        }
      )
      ended.catch(() => {}) // the real handling is below; this only prevents an unhandled rejection if we bail out first
      const sentAt = performance.now()
      try {
        await hub.beginUtterance(
          {
            utterance_id: utteranceId,
            seq,
            emotion: u.emotion,
            motion: clip,
            audio: { sample_rate: u.sampleRate },
            ...(u.text !== undefined ? { subtitle: u.text.slice(0, 2000) } : {}),
          },
          { pcm16: u.pcm16 }
        )
      } catch (err) {
        waiter.abort()
        if (err instanceof StageSendError && err.code === 'backpressure')
          return noteFailure('send_aborted', err.message)
        throw err
      }
      let report: Report<'playback.ended'>
      try {
        report = await ended
      } catch (err) {
        if (err instanceof StageWaitError && err.reason === 'timeout')
          return noteFailure('harness_timeout', err.message)
        throw err
      }
      consecutiveFailures = 0
      obs.utterancesEnded++
      obs.endReasons[report.reason] = (obs.endReasons[report.reason] ?? 0) + 1
      obs.underrunsFromEnded += report.underruns
      const label = u.text ? ` "${u.text.length > 40 ? `${u.text.slice(0, 37)}...` : u.text}"` : ''
      say(
        `#${seq} ${u.emotion}${clip ? ` ${clip.id}` : ''}${label} audio=${(u.durationMs / 1000).toFixed(1)}s ` +
          `ended=${report.reason} played=${Math.round(report.played_ms)}ms underruns=${report.underruns} ` +
          `turnaround=${Math.round(performance.now() - sentAt)}ms`
      )
      seq++
    }

    const playDance = async (entry: { atSeconds: number; name: string }) => {
      const info = danceByName.get(entry.name) as DanceInfo
      const danceId = `replay-dance-${++danceSeq}`
      const idle = hub.waitFor(
        (r): r is Report<'dance.state'> =>
          r.type === 'dance.state' && r.dance_id === danceId && r.phase === 'idle',
        { timeoutMs: timeouts.danceMs, signal: stop.signal, rejectOnDisconnect: true }
      )
      idle.catch(() => {})
      hub.send(toDancePlay(info, danceId))
      say(`dance "${info.name}" started`)
      try {
        const r = await idle
        obs.dancesPlayed++
        if (r.reason === 'error') {
          obs.danceFailures++
          say(`dance "${info.name}" failed: ${r.error ?? 'no details'}`)
        } else {
          say(`dance "${info.name}" ended (${r.reason ?? 'no reason given'})`)
        }
      } catch (err) {
        if (!(err instanceof StageWaitError && err.reason === 'timeout')) throw err
        obs.danceFailures++
        say(`dance "${info.name}" did not finish: ${err.message}`)
        hub.send({ type: 'dance.stop' })
      }
    }

    while (!stop.signal.aborted && runMs() < endAt) {
      try {
        await ensureStage()
        for (
          let next = pendingDances[0];
          next && runMs() >= next.atSeconds * 1000;
          next = pendingDances[0]
        ) {
          await playDance(next)
          pendingDances.shift() // only after it ran: a page reload during the dance retries it
        }
        if (runMs() >= endAt) break
        await speak(utterances[nextIndex()] as LoadedUtterance)
        const [minGap, maxGap] = sc.gapMs
        await sleep(minGap + random() * (maxGap - minGap), stop.signal)
      } catch (err) {
        if (stop.signal.aborted) break
        const stageLeft =
          (err instanceof StageWaitError && err.reason === 'disconnected') ||
          (err instanceof StageSendError &&
            (err.code === 'disconnected' || err.code === 'no_stage'))
        if (!stageLeft) throw err
        // The page went away (reload or crash). The next round waits for it to come back, or fails.
        await sleep(250, stop.signal)
      }
    }

    // ── finish ──
    finishing = true
    clearInterval(statsTimer)
    statsTimer = undefined
    if (hub.connected && !stop.signal.aborted) {
      await hub.waitFor('stats', { timeoutMs: timeouts.finalStatsMs }).catch(() => undefined)
    }
    obs.elapsedMs = performance.now() - startedAt
    obs.audioContextsCreated = counters.audioContextsCreated
    obs.tposeFrames = counters.tposeFrames
    obs.underrunsTotal = counters.underrunsTotal
    if (hub.state.stats) out(`final stats: ${formatStats(hub.state.stats)}`)
    const verdict = evaluateReplay(obs, sc.expect)
    for (const c of verdict.checks) out(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
    const interrupted = stop.signal.aborted
    out(
      `${verdict.pass ? 'PASS' : 'FAIL'}${interrupted ? ' (interrupted, partial run)' : ''} after ${formatElapsed(obs.elapsedMs)}`
    )
    return {
      pass: verdict.pass,
      interrupted,
      url,
      observations: { ...obs, endReasons: { ...obs.endReasons } },
      checks: verdict.checks,
    }
  } finally {
    finishing = true
    if (statsTimer) clearInterval(statsTimer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
    try {
      if (hub.connected) {
        hub.cancelAll()
        hub.send({ type: 'dance.stop' })
      }
    } catch {
      // best effort: the stage is about to be closed anyway
    }
    stop.abort()
    if (child && child.exitCode === null) child.kill()
    await server.stop()
  }
}

// ───────────────────────────── command line ─────────────────────────────

const USAGE = `usage: npm run replay -w @animatus/orchestrator -- <scenario.json> [--duration 1800] [--no-launch] [--port 5810]

  <scenario.json>  libraries, model, utterances, ... (see the ReplayScenario schema in src/dev/replay.ts);
                   relative paths inside it are relative to the scenario file
  --duration       seconds to keep speaking (default 1800)
  --no-launch      do not open the browser window; open the printed URL yourself
  --port           stage server port (default 5810, 0 = any free port)
`

const parseCli = (argv: string[]) =>
  parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      duration: { type: 'string' },
      'no-launch': { type: 'boolean' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })

/** Runs the CLI and returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  let cli: ReturnType<typeof parseCli>
  try {
    cli = parseCli(argv)
  } catch (err) {
    console.error(`${errorMessage(err)}\n\n${USAGE}`)
    return 2
  }
  const { values, positionals } = cli
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (positionals.length !== 1) {
    console.error(USAGE)
    return 2
  }
  const durationS = values.duration === undefined ? 1800 : Number(values.duration)
  const port = values.port === undefined ? 5810 : Number(values.port)
  if (!Number.isFinite(durationS) || durationS <= 0) {
    console.error('--duration must be a positive number of seconds')
    return 2
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('--port must be an integer between 0 and 65535')
    return 2
  }

  // `npm run -w` starts the script in the package folder; INIT_CWD is the folder the command was typed in.
  const scenarioFile = path.resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0] as string)
  let scenario: ReplayScenario
  try {
    let json: unknown
    try {
      json = JSON.parse(stripBom(await readFile(scenarioFile, 'utf8')))
    } catch (err) {
      throw new ScenarioError(`cannot read ${scenarioFile}: ${errorMessage(err)}`)
    }
    scenario = parseScenario(json, path.dirname(scenarioFile))
    // A typo in a library path is reported before anything starts.
    for (const [name, dir] of Object.entries(scenario.libraries)) {
      const isDir = await stat(dir).then(
        (s) => s.isDirectory(),
        () => false
      )
      if (!isDir) throw new ScenarioError(`library "${name}" is not a folder: ${dir}`)
    }
  } catch (err) {
    console.error(errorMessage(err))
    return err instanceof ScenarioError ? 2 : 1
  }

  const abort = new AbortController()
  let interrupts = 0
  process.on('SIGINT', () => {
    if (++interrupts > 1) process.exit(130)
    console.log('\nCtrl+C: stopping after the current step (press again to force)')
    abort.abort()
  })
  try {
    const result = await runReplay({
      scenario,
      durationS,
      port,
      launch: !values['no-launch'],
      signal: abort.signal,
      logger: createConsoleLogger('warn'),
    })
    return result.interrupted ? 130 : result.pass ? 0 : 1
  } catch (err) {
    console.error(`FAIL: ${errorMessage(err)}`)
    return err instanceof ScenarioError ? 2 : 1
  }
}

const isMain = (): boolean => {
  const entry = process.argv[1]
  if (!entry) return false
  return (
    path.resolve(entry).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()
  )
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
    // Everything is closed by now; the timer only guards against a stray handle keeping the process alive.
    setTimeout(() => process.exit(code), 3000).unref()
  })
}
