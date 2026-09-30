/** The settings of the game mode (`modes.game.config`): all optional, all bounded. */
import { WorkerId } from '@animatus/protocol'
import { z } from 'zod'
import { ConfigError } from '../../config.ts'

export const GameSettings = z
  .strictObject({
    /** `worker` speaks the Worker protocol (docs/workers.md); `legacy` an older Civilization VI or Minecraft agent through the adapter. */
    protocol: z.enum(['worker', 'legacy']).default('worker'),
    /**
     * With `worker`: the id the worker must have (a different one is refused when the mode starts). With `legacy`: what
     * to call the game when the agent does not say (a Minecraft bot does not). Leave out to accept any worker.
     */
    name: WorkerId.optional(),
    /** How the game is called in prompts and on the panel; default the worker's own id. */
    title: z.string().trim().min(1).max(60).optional(),
    /** The game agent has to answer within this long when the mode starts (a slow first answer is asked again), or the start fails. */
    start_timeout_sec: z.number().min(1).max(120).default(10),
    /** The time limit of every other call to it. */
    request_timeout_sec: z.number().min(1).max(30).default(5),
    /** How often the agent is asked what happened. */
    poll_sec: z.number().min(0.5).max(60).default(2),
    /** After a failed poll the wait doubles each time, up to this. */
    max_backoff_sec: z.number().min(1).max(600).default(30),
    /** Two comments are at least this far apart, except for an event the agent calls `immediate`. */
    comment_gap_sec: z.number().min(0).max(3600).default(20),
    /** An event that has waited this long without being commented on is only background. */
    stale_sec: z.number().min(10).max(3600).default(90),
    /** How many background notes (the agent's `later` events) the model is shown. */
    notes_kept: z.number().int().min(0).max(30).default(8),
    /** The same directive from the character within this long is sent once (the model tends to repeat itself); 0 sends every one. */
    duplicate_command_sec: z.number().min(0).max(600).default(30),
    /** Pause the agent when the mode ends, so it stops spending its own model calls and playing while nobody comments. */
    pause_on_exit: z.boolean().default(true),
  })
  .refine((s) => s.max_backoff_sec >= s.poll_sec, {
    path: ['max_backoff_sec'],
    message: 'must not be smaller than poll_sec',
  })
export type GameSettings = z.infer<typeof GameSettings>

/** Validates `modes.game.config`. A mistake stops the program at start-up with the setting's name, like the rest of the configuration. */
export function parseGameSettings(raw: unknown): GameSettings {
  const parsed = GameSettings.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  const lines = parsed.error.issues.map(
    (i) => `  modes.game.config${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`
  )
  throw new ConfigError(`invalid configuration:\n${lines.join('\n')}`)
}
