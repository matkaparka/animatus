/**
 * What a mode controller may use of the running program, and what it has to provide in return.
 *
 * A controller is the code of one mode (dance, sleep, sing, draw, ...). It never reaches into the App:
 * it gets a `ModeHost`, which is the narrow set of things a mode legitimately needs (send to the stage,
 * hold the voice, ask the model, read the configuration, raise an alarm). That keeps modes testable with
 * a handful of fakes and keeps the App free of mode-specific code.
 */
import type { ClipRef, Emotion, RunEvent } from '@animatus/protocol'
import type { AppConfig } from '../config.ts'
import type { Batch } from '../inbox/types.ts'
import type { StageHub } from '../stage/hub.ts'
import type { MotionLibrary } from '../library/motionLibrary.ts'
import type { SecretStore } from '../plugins/secrets.ts'
import type { ModeContext, ModeController } from './manager.ts'

/** Flags the pacer reads: while one is set the audience's messages wait. */
export interface ActivityFlags {
  dancing: boolean
  singing: boolean
  sleeping: boolean
}

export type Level = 'debug' | 'info' | 'warn' | 'error'

export interface SayOptions {
  text: string
  emotion?: Emotion
  style?: string
  speed?: number
  /** Words on screen; default the text, '' for none. */
  subtitle?: string
  /** A motion clip that goes with the line. */
  motion?: ClipRef | null
}

export interface ModeHost {
  readonly config: AppConfig
  readonly hub: StageHub
  readonly motions: MotionLibrary | null
  readonly secrets: SecretStore
  readonly flags: ActivityFlags
  /** Where the program keeps its files (`data/`). */
  readonly dataDir: string
  now(): number
  log(level: Level, msg: string, extra?: Record<string, unknown>): void

  /** A line for the operator's run page. */
  event(kind: RunEvent['kind'], text: string, trust?: RunEvent['trust']): void
  alarm(code: string, level: 'info' | 'warn' | 'error', message: string, subject?: string): void
  clearAlarm(code: string, subject?: string): void

  // ── speech
  /** Stop everything that is being said or queued, and the reply being written. */
  stopSpeech(reason: string): void
  /** While held, nothing new goes to the stage (dance and song hold the voice). */
  holdSpeech(reason: string, on: boolean): void
  /** Say a line without the model. */
  say(opts: SayOptions): void
  /** Resolves when nothing is being said, generated or queued; false on timeout. */
  whenQuiet(timeoutMs: number): Promise<boolean>
  /** True while a reply is being written or spoken. */
  busy(): boolean

  // ── the model
  /**
   * A privileged system message ("you just finished a dance"): it goes through the same brain as a chat reply
   * (persona, history, tags, speech). Resolves when the model's answer is written, not when it is spoken.
   */
  tellBrain(text: string, opts?: { extras?: string[]; preempt?: boolean }): Promise<void>
  /** True while the brain is writing a reply. */
  brainBusy(): boolean

  // ── services and other modes
  /** Base URL of the ready plugin that provides the service, or null. */
  serviceUrl(service: string): string | null
  modeState(id: string): 'IDLE' | 'STARTING' | 'ACTIVE' | 'STOPPING'
  /** Enter another mode (or this one, once its preconditions are met). */
  enterMode(
    id: string,
    opts?: { replace?: boolean; force?: boolean }
  ): Promise<{ ok: boolean; reason?: string }>
  exitMode(id: string, reason: string): Promise<void>

  // ── prompts of the mode pack
  /** A prompt file of a mode's pack with `{{vars}}` filled in, or null if the pack has no such file. */
  prompt(modeId: string, name: string, vars?: Record<string, string>): string | null
}

/** What a controller can add to the mode manager's `enter`/`exit`. Every hook is optional. */
export interface ModeControllerHooks {
  /** Called once when the service is built: subscribe to stage reports here. Return a disposer. */
  attach?(): void | (() => void)
  /**
   * Advertise the mode to the model while it is enabled and could be entered: the name of a prompt file of the
   * pack and its variables, or null for nothing. Called before every reply, so it may depend on state.
   */
  advertise?(): { prompt: string; vars?: Record<string, string> } | null
  /**
   * A batch is about to go to the model. Return extra prompt lines for that reply only; the controller may start
   * the mode here (a dance gift). Runs before the model is called and must not take long.
   */
  onBatch?(batch: Batch): Promise<string[]> | string[]
  /** The model wrote a request for the mode as a tag (`[motion:dance:name]`). */
  onModelRequest?(request: { name?: string }): Promise<void> | void
  /** The operator asked for the mode from the console, with optional details. */
  onConsoleRequest?(request: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }>
}

export type ModeControllerFull = ModeController & ModeControllerHooks

export type ControllerFactory = (host: ModeHost) => ModeControllerFull

export type { ModeContext }
