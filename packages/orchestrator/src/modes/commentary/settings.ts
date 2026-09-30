/** The settings of the commentary mode (`modes.commentary.config`): all optional, all bounded. */
import { PluginId } from '@animatus/protocol'
import { z } from 'zod'
import { ConfigError } from '../../config.ts'

export const CommentarySettings = z.strictObject({
  /** Seconds between one comment and the next look at the screen, counted from the end of the comment's speech. */
  interval_sec: z.number().min(3).max(600).default(8),
  /**
   * The window to watch until the operator picks one on the mode's panel (the pick wins and is remembered): a window
   * id, part of its title, or `exe:<program>`. Leave out to wait for a pick.
   */
  window: z.string().trim().min(1).max(300).nullable().default(null),
  /** The name of the service that captures windows (`service` in its plugin manifest). */
  service: PluginId.default('screencap'),
  /** The picture's width in pixels; 0 keeps the window's size. Models bill by tiles, so wider costs more. */
  capture_width: z
    .number()
    .int()
    .refine((w) => w === 0 || (w >= 64 && w <= 4096), 'must be 0 or between 64 and 4096')
    .default(768),
  /** JPEG quality. */
  capture_quality: z.number().int().min(30).max(95).default(80),
  /** `auto` prints the window and copies the screen only when that comes out black; see docs/mode-commentary.md. */
  capture_method: z.enum(['auto', 'printwindow', 'screen']).default('auto'),
  /** How long the capture service may take to answer. */
  capture_timeout_sec: z.number().min(2).max(60).default(10),
  /** A picture whose brightness (0 to 255) is below this everywhere is "black" and skipped; 0 turns the check off. */
  black_threshold: z.number().min(0).max(255).default(10),
  /** Black pictures in a row before the operator gets an alarm. */
  black_alarm_after: z.number().int().min(1).max(100).default(3),
  /** Look again at which game this is every so many minutes; 0 = only on a switch, on demand, or when unsure. */
  reidentify_minutes: z.number().min(0).max(1440).default(15),
  /** Below this confidence the game counts as "not sure" and the next picture is used to identify it again. */
  confidence_min: z.number().min(0).max(1).default(0.6),
  /**
   * A short model call on every N-th picture reads what is on screen (for the game memory) and notices a switch to
   * another game. 1 = every picture, 0 = never (the memory then only learns from identifications).
   */
  analysis_every: z.number().int().min(0).max(50).default(1),
  /** The "story so far" is renewed after this many comments; 0 = no summary. */
  summary_every: z.number().int().min(0).max(200).default(10),
  /** The longest the story so far may be, in characters. */
  summary_max_chars: z.number().int().min(100).max(1000).default(300),
  /** The language game names, notes on the screen and the story are written in. */
  language: z.string().trim().min(1).max(40).default('English'),
  /** How long one of the mode's own model calls (identify, analyse, summarise) may take. */
  model_timeout_sec: z.number().min(5).max(180).default(30),
  /** After the model fails, the pause before the next try doubles each time up to this. */
  max_backoff_sec: z.number().min(10).max(3600).default(120),
})
export type CommentarySettings = z.infer<typeof CommentarySettings>

/** The shortest interval the panel may set; the same as the lower bound of `interval_sec`. */
export const MIN_INTERVAL_SEC = 3
export const MAX_INTERVAL_SEC = 600

/** Validates `modes.commentary.config`. A mistake stops the program at start-up with the setting's name, like the rest of the configuration. */
export function parseCommentarySettings(raw: unknown): CommentarySettings {
  const parsed = CommentarySettings.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  const lines = parsed.error.issues.map(
    (i) => `  modes.commentary.config${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`
  )
  throw new ConfigError(`invalid configuration:\n${lines.join('\n')}`)
}
