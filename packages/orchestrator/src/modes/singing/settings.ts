import { z } from 'zod'

/**
 * `modes.sing.config`. Every key is optional and has a default; a key that is not listed is an error that names it,
 * so a typo does not silently change nothing. Documented in docs/mode-sing.md.
 */
export const SingSettings = z.strictObject({
  /** How often the queue is looked at (a song ready to sing is noticed within this long). */
  poll_sec: z.number().min(0.1).max(60).default(2),
  /** How long a viewer's request may take (the search): it is also what the service is told to wait at most. */
  request_timeout_sec: z.number().min(1).max(100).default(20),
  /** How much longer than the service is told to take, a request may wait before it is given up on: the service
   * answers by its own deadline, so this only matters when it does not answer at all. */
  request_slack_sec: z.number().min(0.1).max(60).default(5),
  /** Every other call to the service (queue, claim, done, cancel ...). */
  call_timeout_sec: z.number().min(0.5).max(60).default(5),
  /** A ready song waits this long for the voice to be quiet before it tries again on the next look. */
  quiet_timeout_sec: z.number().min(1).max(60).default(30),
  /** The stage must report the song as playing within this long of being sent it (it loads two long tracks). */
  start_timeout_sec: z.number().min(1).max(100).default(60),
  /** After a stop the stage has its fade plus this long to report it is done, or the song is dropped. */
  stop_timeout_sec: z.number().min(1).max(60).default(10),
  /** A song the stage has not reported over this long after it should have ended is given up on. */
  watchdog_extra_sec: z.number().min(1).max(600).default(45),
  /** The length assumed for a song whose length the service does not know. */
  max_song_sec: z.number().min(30).max(3600).default(900),
  /** After a refusal to start (a dance is on) or a failure, how long before the next try. */
  retry_after_sec: z.number().min(1).max(600).default(10),
  /** Whether the model says a closing line after a song. */
  outro: z.boolean().default(true),
  /** The model has this long to start its closing line before the audience's queue is released anyway. */
  outro_window_sec: z.number().min(0.5).max(60).default(8),
  /** The lyrics overlay. */
  lyrics: z.boolean().default(true),
  /** The overlay that names the song, its artists and who asked. */
  credit: z.boolean().default(true),
  /** Both tracks start this long after the stage gets the command. */
  start_delay_s: z.number().min(0).max(5).default(0.2),
  /** How long the song fades out when it is cut short. */
  stop_fade_s: z.number().min(0).max(5).default(0.6),
  /** Whether the model is told when a song a viewer asked for could not be prepared. */
  announce_failures: z.boolean().default(true),
  /** The singing service must have been unreachable this long before it is an alarm (it takes a while to start). */
  service_alarm_after_sec: z.number().min(1).max(3600).default(30),
})
export type SingSettings = z.infer<typeof SingSettings>
