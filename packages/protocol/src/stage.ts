/**
 * Stage protocol v1: one WebSocket per stage page, JSON control frames plus binary media
 * frames (see binary.ts).
 *
 * Design rules
 *  - The stage is empty and stateless. It renders, plays audio, drives lip sync, plays motion and
 *    reports playback. It never decides anything and never accepts local input.
 *  - Downstream messages are either idempotent *state snapshots* (scene.set, library.set,
 *    look.set, tuning.set, overlay.set) that the orchestrator re-sends whenever a stage
 *    (re)connects, or *commands* (utterance.*, motion.play, dance.*, sing.*, sleep.*) that are not.
 *  - Upstream is a closed set of reports. It can never carry commands; the orchestrator validates
 *    every upstream frame against StageUpstream and drops anything else.
 *  - Large files (models, motions, music, songs) travel as asset URLs the stage fetches from the
 *    orchestrator over HTTP. Only per-utterance audio and live-generated VRMA travel as binary
 *    frames on the socket, so they can be streamed and cancelled.
 *  - All text shown on the stage is rendered with textContent, never as HTML.
 */
import { z } from 'zod'
import { AssetUrl, Emotion, Id, PROTOCOL_VERSION, Rect, StageText, U32, Vec3 } from './common.ts'

// ─────────────────────────────── shared pieces ───────────────────────────────

/** A motion clip (.vrma) the stage plays. `id` is for logs and caching; `url` is what gets fetched. */
export const ClipRef = z.object({ id: Id, url: AssetUrl })
export type ClipRef = z.infer<typeof ClipRef>

export const CharLayout = z.object({
  /** vw; the character is scaled about the bottom-right corner, then translated */
  x: z.number().min(-200).max(200),
  /** vh */
  y: z.number().min(-200).max(200),
  scale: z.number().min(0.05).max(4),
})
export type CharLayout = z.infer<typeof CharLayout>

export const Background = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('color'), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
  z.object({ kind: z.literal('image'), url: AssetUrl, dim: z.number().min(0).max(1).default(0) }),
])
export type Background = z.infer<typeof Background>

export const CameraFit = z.enum(['none', 'head', 'upper_body', 'full_body'])
export type CameraFit = z.infer<typeof CameraFit>

/**
 * How the operator has moved the camera with the mouse, relative to the pose the rest of `CameraConfig`
 * gives (fixed numbers, head height or a fit). Relative, so it stays meaningful when the model, its size or
 * the window changes. All zero and one means "not touched".
 */
export const CameraAdjust = z.object({
  /** Orbit around the target, radians (left drag). */
  yaw: z.number().min(-Math.PI).max(Math.PI).default(0),
  /** Orbit up (positive) or down, radians. */
  pitch: z.number().min(-1.5).max(1.5).default(0),
  /** Distance multiplier (mouse wheel): below 1 is closer. */
  zoom: z.number().min(0.1).max(8).default(1),
  /** Where the point looked at has moved, in world space, in units of the visible height at the base distance (right drag). */
  pan: z
    .tuple([z.number().min(-4).max(4), z.number().min(-4).max(4), z.number().min(-4).max(4)])
    .default([0, 0, 0]),
})
export type CameraAdjust = z.infer<typeof CameraAdjust>
export const NO_CAMERA_ADJUST: CameraAdjust = { yaw: 0, pitch: 0, zoom: 1, pan: [0, 0, 0] }

export const CameraConfig = z.object({
  fov: z.number().min(5).max(90).default(20),
  position: Vec3.default([0, 1.3, 1.5]),
  target: Vec3.default([0, 1.3, 0]),
  /** After the model loads, move camera height and target to the head bone (keeps x/z of `position`). */
  follow_head: z.boolean().default(true),
  /**
   * Frame the model by its measured size instead of fixed numbers, whatever scale it was made at:
   * head = head and shoulders, upper_body = head down to the hips, full_body = the whole figure.
   * Anything but `none` takes over `position`, `target` and `follow_head` once the model is up.
   */
  fit: CameraFit.default('none'),
  /** What mouse gestures on the stage window have changed; the stage reports it (`camera.adjusted`) and the orchestrator keeps it. */
  adjust: CameraAdjust.default(NO_CAMERA_ADJUST),
  /** The stage ignores the mouse (a locked composition, so nothing moves by accident during a broadcast). */
  locked: z.boolean().default(false),
})
export type CameraConfig = z.infer<typeof CameraConfig>

export const SubtitleLine = z.object({
  text: StageText,
  start: z.number().min(0),
  end: z.number().min(0),
})
export const LyricLine = z.object({ t: z.number().min(0), text: z.string().max(400) })
export type LyricLine = z.infer<typeof LyricLine>

// ─────────────────────── downstream: orchestrator → stage ───────────────────────

/** First frame after `hello`. */
export const Welcome = z.object({
  type: z.literal('welcome'),
  protocol: z.literal(PROTOCOL_VERSION),
  session_id: Id,
  /** Increments whenever the orchestrator hard-resets playback; informational for logs. */
  epoch: z.number().int().min(0),
  server_time_ms: z.number(),
  /** When true the stage may honour debug.request. */
  dev: z.boolean().default(false),
})

/** Full scene snapshot. The stage reloads the model only when `model.url` changes. */
export const SceneSet = z.object({
  type: z.literal('scene.set'),
  model: z.object({ url: AssetUrl, name: z.string().max(80).optional() }).nullable(),
  layout: z.object({ char: CharLayout, frame: Rect.nullable().default(null) }),
  background: Background,
  /** Multiplier on the base light intensities (directional 1.8, ambient 1.2). */
  lighting: z.object({ intensity: z.number().min(0).max(4).default(1) }).default({ intensity: 1 }),
  camera: CameraConfig.default({
    fov: 20,
    position: [0, 1.3, 1.5],
    target: [0, 1.3, 0],
    follow_head: true,
    fit: 'none',
    adjust: NO_CAMERA_ADJUST,
    locked: false,
  }),
})

/** Motion library snapshot. Talk clips get automatic mirrored variants on the stage. */
export const LibrarySet = z.object({
  type: z.literal('library.set'),
  /** Default idle base pose (the pose the body returns to). */
  idle: ClipRef.nullable(),
  /** Extra idle poses rotated every few minutes while truly idle. */
  idle_variants: z.array(ClipRef).max(64).default([]),
  /** Clips rotated while speech plays and no motion tag or live clip is in force. */
  talk: z.array(ClipRef).max(256).default([]),
})

/** Look snapshot: everything a quiet/calm mode (sleep) changes about how the character looks and moves. */
export const LookSet = z.object({
  type: z.literal('look.set'),
  /** Extra multiplier on lighting.intensity. */
  light: z.number().min(0).max(4).default(1),
  /** Mouth opening multiplier (1 = normal speech). */
  mouth_scale: z.number().min(0).max(2).default(1),
  /** 0..1: procedural layer stops nodding along with speech, breathes slower, lids sit lower. */
  calm: z.number().min(0).max(1).default(0),
  /** Amplitude of the small procedural motions while calm (1 = same as idle). */
  motion_scale: z.number().min(0).max(2).default(1),
  /** Override of the lip-sync analyser's log10 volume window; null = analyser defaults. */
  lip_range: z.object({ min: z.number(), max: z.number() }).nullable().default(null),
  /** 0..1 night filter strength over the background when it has no dedicated night image. */
  dim: z.number().min(0).max(1).default(0),
})

/** Optional overrides of the stage's motion/procedural-layer constants. Unknown keys are ignored. */
export const TuningSet = z.object({
  type: z.literal('tuning.set'),
  motion: z.record(z.string(), z.number()).default({}),
  live: z.record(z.string(), z.number()).default({}),
})

export const OverlayId = z.enum(['credit', 'lyrics', 'subtitle', 'frame', 'notice'])
export type OverlayId = z.infer<typeof OverlayId>

/** How the spoken subtitle looks: a rounded translucent bubble, or bare text with a shadow. */
export const SubtitleVariant = z.enum(['bubble', 'plain'])
export type SubtitleVariant = z.infer<typeof SubtitleVariant>

/**
 * Overlay snapshot. `lyrics`, the spoken subtitle (`utterance.begin.subtitle`) and the sleep captions are
 * driven by the stage from the audio clock, so for those overlays this message only toggles visibility and
 * style. For `subtitle`, `text` is a name badge shown above the words (leave it out for none).
 */
export const OverlaySet = z.object({
  type: z.literal('overlay.set'),
  id: OverlayId,
  visible: z.boolean(),
  text: StageText.optional(),
  image: AssetUrl.optional(),
  rect: Rect.optional(),
  /** `subtitle` only. */
  variant: SubtitleVariant.optional(),
})

export const UtteranceBegin = z.object({
  type: z.literal('utterance.begin'),
  utterance_id: Id,
  /** Position in the orchestrator's playback order; for logs and gap detection. */
  seq: z.number().int().min(0),
  turn_id: Id.optional(),
  /** Handle used by the binary frames of this utterance. */
  handle: U32,
  emotion: Emotion,
  /** Body motion chosen by the orchestrator from a `[motion:...]` tag. Overrides talk clips. */
  motion: ClipRef.nullable().default(null),
  /** True when a VRMA stream (frame kind 2) follows before the audio. */
  live_motion: z.boolean().default(false),
  audio: z.object({
    codec: z.literal('pcm16'),
    sample_rate: z.number().int().min(8000).max(96000),
    channels: z.literal(1),
    /** Optional, for progress display and sanity checks. */
    total_samples: z.number().int().min(0).optional(),
  }),
  /** Shown on the `subtitle` overlay while this utterance plays. */
  subtitle: StageText.optional(),
  /** Overrides the default jitter-buffer pre-roll (ms). */
  prebuffer_ms: z.number().int().min(0).max(2000).optional(),
})

export const UtteranceCancel = z.object({
  type: z.literal('utterance.cancel'),
  scope: z.enum(['utterance', 'all']),
  utterance_id: Id.optional(),
  /** Fade of the audio being cut (ms). */
  fade_ms: z.number().int().min(0).max(2000).default(60),
})

/** One-shot body motion outside an utterance (console buttons, agent decisions). */
export const MotionPlay = z.object({
  type: z.literal('motion.play'),
  motion: ClipRef,
})

export const DancePlay = z.object({
  type: z.literal('dance.play'),
  dance_id: Id,
  name: z.string().max(80),
  title: z.string().max(120),
  motion_url: AssetUrl,
  music_url: AssetUrl.nullable(),
  /** Seconds the music starts after motion frame 0 (negative: motion starts later). */
  offset: z.number().min(-30).max(30).default(0),
  speed: z.number().min(0.25).max(3).default(1),
  volume: z.number().min(0).max(2).default(1),
  /** Shown on the `credit` overlay while dancing. */
  credit: z.string().max(200).default(''),
})
export const DanceStop = z.object({
  type: z.literal('dance.stop'),
  fade_s: z.number().min(0).max(5).default(0.5),
})
/** Live tuning of a running dance (console tuning panel). Moves the motion, not the music. */
export const DanceTune = z.object({
  type: z.literal('dance.tune'),
  offset: z.number().min(-30).max(30).optional(),
  speed: z.number().min(0.25).max(3).optional(),
})

export const SingPlay = z.object({
  type: z.literal('sing.play'),
  song_id: Id,
  title: z.string().max(200),
  artists: z.array(z.string().max(100)).max(16).default([]),
  requester: z.string().max(100).default(''),
  vocals_url: AssetUrl,
  inst_url: AssetUrl,
  /** Parsed lyrics; the stage shows the current line on the `lyrics` overlay when it is visible. */
  lyrics: z.array(LyricLine).max(2000).default([]),
  /** Both tracks start this many seconds after the command is processed. */
  start_delay_s: z.number().min(0).max(5).default(0.2),
})
export const SingStop = z.object({
  type: z.literal('sing.stop'),
  fade_s: z.number().min(0).max(5).default(0.6),
})

export const SleepPlay = z.object({
  type: z.literal('sleep.play'),
  track_id: Id,
  url: AssetUrl,
  volume: z.number().min(0).max(1).default(1),
  fade_in_s: z.number().min(0).max(10).default(1.5),
  /** Timeline of the words being whispered in this track, for the `subtitle` overlay. */
  captions: z.array(SubtitleLine).max(5000).default([]),
})
export const SleepPause = z.object({
  type: z.literal('sleep.pause'),
  fade_s: z.number().min(0).max(10).default(1),
})
export const SleepResume = z.object({
  type: z.literal('sleep.resume'),
  fade_s: z.number().min(0).max(10).default(1.5),
  volume: z.number().min(0).max(1).default(1),
})
export const SleepStop = z.object({
  type: z.literal('sleep.stop'),
  fade_s: z.number().min(0).max(10).default(1),
})

/** Dev-only diagnostics. Ignored by the stage unless `welcome.dev` is true. */
export const DebugRequest = z.object({
  type: z.literal('debug.request'),
  request_id: Id,
  op: z.enum(['stats', 'bones', 'reload_model']),
})

export const Ping = z.object({ type: z.literal('ping'), t: z.number() })

export const StageDownstream = z.discriminatedUnion('type', [
  Welcome,
  SceneSet,
  LibrarySet,
  LookSet,
  TuningSet,
  OverlaySet,
  UtteranceBegin,
  UtteranceCancel,
  MotionPlay,
  DancePlay,
  DanceStop,
  DanceTune,
  SingPlay,
  SingStop,
  SleepPlay,
  SleepPause,
  SleepResume,
  SleepStop,
  DebugRequest,
  Ping,
])
export type StageDownstream = z.infer<typeof StageDownstream>
export type StageDownstreamInput = z.input<typeof StageDownstream>

// ─────────────────────── upstream: stage → orchestrator ───────────────────────

export const Hello = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  /** Random per page load. */
  stage_id: Id,
  ua: z.string().max(400).default(''),
  capabilities: z
    .object({
      webgl2: z.boolean().default(false),
      audio_context: z.boolean().default(false),
      output_latency_api: z.boolean().default(false),
    })
    .default({ webgl2: false, audio_context: false, output_latency_api: false }),
  perf_now_ms: z.number().optional(),
})

export const ModelState = z.object({
  type: z.literal('model.state'),
  status: z.enum(['none', 'loading', 'ready', 'error']),
  url: z.string().max(2048).optional(),
  error: z.string().max(400).optional(),
  info: z
    .object({
      vrm_version: z.enum(['0', '1']),
      blend_shapes: z.number().int().min(0),
      /** eyeBlinkLeft/Right exist, so the procedural blink drives them directly. */
      arkit_blink: z.boolean(),
      /** Falls back to the VRM preset `blink` when there are no ARKit blink shapes. */
      vrm_blink: z.boolean(),
      spring_joints: z.number().int().min(0),
    })
    .optional(),
})

export const AudioState = z.object({
  type: z.literal('audio.state'),
  state: z.enum(['running', 'suspended', 'closed', 'unavailable']),
  sample_rate: z.number(),
  base_latency: z.number(),
  output_latency: z.number(),
  contexts_created: z.number().int().min(0),
  contexts_open: z.number().int().min(0),
})

export const PlaybackStarted = z.object({
  type: z.literal('playback.started'),
  utterance_id: Id,
  seq: z.number().int().min(0),
  /** AudioContext time at which the first sample was scheduled to sound. */
  audio_time_s: z.number(),
  perf_ms: z.number(),
})

export const PlaybackEnded = z.object({
  type: z.literal('playback.ended'),
  utterance_id: Id,
  seq: z.number().int().min(0),
  reason: z.enum(['done', 'cancelled', 'error', 'timeout', 'audio_suspended', 'superseded']),
  underruns: z.number().int().min(0),
  played_ms: z.number().min(0),
})

export const DanceState = z.object({
  type: z.literal('dance.state'),
  dance_id: Id,
  phase: z.enum(['loading', 'playing', 'ending', 'idle']),
  reason: z.enum(['finished', 'stopped', 'error', 'cancelled']).optional(),
  error: z.string().max(400).optional(),
})

export const SingState = z.object({
  type: z.literal('sing.state'),
  song_id: Id,
  phase: z.enum(['loading', 'playing', 'ending', 'idle']),
  reason: z.enum(['done', 'stopped', 'error', 'cancelled']).optional(),
  error: z.string().max(400).optional(),
})

export const SleepState = z.object({
  type: z.literal('sleep.state'),
  track_id: Id.optional(),
  phase: z.enum(['off', 'loading', 'playing', 'paused', 'ended', 'error']),
  error: z.string().max(400).optional(),
})

/** Periodic health report (every ~5 s) and the soak-test counters. */
export const Stats = z.object({
  type: z.literal('stats'),
  fps: z.number().min(0),
  frame_ms_p95: z.number().min(0),
  audio_contexts_created: z.number().int().min(0),
  audio_contexts_open: z.number().int().min(0),
  underruns_total: z.number().int().min(0),
  /** Frames in which every checked humanoid bone sat at its bind (T-pose) rotation. */
  tpose_frames: z.number().int().min(0),
  frames_total: z.number().int().min(0),
  models_loaded: z.number().int().min(0),
  js_heap_mb: z.number().min(0).optional(),
})

export const StageError = z.object({
  type: z.literal('error'),
  code: z.string().max(64),
  message: z.string().max(400),
})

export const DebugReply = z.object({
  type: z.literal('debug.reply'),
  request_id: Id,
  ok: z.boolean(),
  data: z.unknown().optional(),
})

export const Pong = z.object({ type: z.literal('pong'), t: z.number() })

/**
 * The operator moved the camera with the mouse on the stage window (a gesture ended). A report, not a
 * command: the orchestrator decides whether to keep it, stores it and echoes it back in `scene.set`.
 */
export const CameraAdjusted = z.object({ type: z.literal('camera.adjusted'), adjust: CameraAdjust })

export const StageUpstream = z.discriminatedUnion('type', [
  Hello,
  ModelState,
  AudioState,
  PlaybackStarted,
  PlaybackEnded,
  DanceState,
  SingState,
  SleepState,
  Stats,
  StageError,
  DebugReply,
  Pong,
  CameraAdjusted,
])
export type StageUpstream = z.infer<typeof StageUpstream>

// ───────────────────────── per-message types ─────────────────────────
// Value and type share a name: `DancePlay` is the schema, `DancePlay` the parsed (defaults applied) type.

export type Welcome = z.infer<typeof Welcome>
export type SceneSet = z.infer<typeof SceneSet>
export type LibrarySet = z.infer<typeof LibrarySet>
export type LookSet = z.infer<typeof LookSet>
export type TuningSet = z.infer<typeof TuningSet>
export type OverlaySet = z.infer<typeof OverlaySet>
export type UtteranceBegin = z.infer<typeof UtteranceBegin>
export type UtteranceCancel = z.infer<typeof UtteranceCancel>
export type MotionPlay = z.infer<typeof MotionPlay>
export type DancePlay = z.infer<typeof DancePlay>
export type DanceStop = z.infer<typeof DanceStop>
export type DanceTune = z.infer<typeof DanceTune>
export type SingPlay = z.infer<typeof SingPlay>
export type SingStop = z.infer<typeof SingStop>
export type SleepPlay = z.infer<typeof SleepPlay>
export type SleepPause = z.infer<typeof SleepPause>
export type SleepResume = z.infer<typeof SleepResume>
export type SleepStop = z.infer<typeof SleepStop>
export type DebugRequest = z.infer<typeof DebugRequest>
export type Ping = z.infer<typeof Ping>
export type Hello = z.infer<typeof Hello>
export type ModelState = z.infer<typeof ModelState>
export type AudioState = z.infer<typeof AudioState>
export type PlaybackStarted = z.infer<typeof PlaybackStarted>
export type PlaybackEnded = z.infer<typeof PlaybackEnded>
export type DanceState = z.infer<typeof DanceState>
export type SingState = z.infer<typeof SingState>
export type SleepState = z.infer<typeof SleepState>
export type Stats = z.infer<typeof Stats>
export type StageError = z.infer<typeof StageError>
export type DebugReply = z.infer<typeof DebugReply>
export type Pong = z.infer<typeof Pong>
export type CameraAdjusted = z.infer<typeof CameraAdjusted>

// ───────────────────────────────── helpers ─────────────────────────────────

/** Largest upstream JSON frame the orchestrator will parse. */
export const MAX_UPSTREAM_BYTES = 64 * 1024

export function parseUpstream(raw: string): StageUpstream | null {
  if (raw.length > MAX_UPSTREAM_BYTES) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const r = StageUpstream.safeParse(json)
  return r.success ? r.data : null
}

/** Stage-side parse of a downstream frame. Unknown or invalid frames return null (log and ignore). */
export function parseDownstream(raw: string): StageDownstream | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const r = StageDownstream.safeParse(json)
  return r.success ? r.data : null
}
