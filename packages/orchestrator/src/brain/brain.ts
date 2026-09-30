/**
 * The brain's turn loop: one audience batch (or one host message) in, one spoken reply out.
 *
 *   input text -> chat log -> system prompt + history -> LLM stream -> segmenter -> speech director
 *
 * The brain decides nothing about pacing (the inbox pacer does) and nothing about the stage (the speech
 * director does). It owns the order of things inside one reply: what goes into the prompt, how the streamed
 * answer is cut into sentences with their emotion and motion tags, that a stopped or superseded reply goes
 * quiet, and that the conversation record stays complete.
 *
 * Failure policy: a reply whose model call fails before any sentence exists is reported (`turn.end` with
 * status `failed`, plus the error) and stays silent. Nothing is invented in its place. Sentences that
 * were already accepted before the failure are still spoken.
 */
import { EventEmitter } from 'node:events'
import type { ClipRef, Emotion, TrustLevel } from '@animatus/protocol'
import type { ChatMessage, LlmDelta, LlmRequest } from '../llm/types.ts'
import type { SpeechItem } from '../speech/director.ts'
import { ChatLog } from './chatlog.ts'
import type { ChatEntry } from './chatlog.ts'
import { buildSystemPrompt } from './prompt.ts'
import type { ModePrompt } from './prompt.ts'
import { SpeechSegmenter } from './segmenter.ts'
import { consumeStream } from './stream.ts'
import { parseEmotion, parseMotionTag } from './tags.ts'
import type { SegmenterEvent, StreamDelta } from './types.ts'

/** Where the sentences of one reply go: a `SpeechTurn` fits. */
export interface TurnSink {
  /** False when the sentence was not accepted (nothing to say, or the reply was superseded or cancelled). */
  enqueue(item: SpeechItem): boolean
  /** No more sentences will come. */
  end(): void
}

/** What the brain needs from the speech side: a `SpeechDirector` fits. */
export interface DirectorLike {
  beginTurn(id: string): TurnSink
  cancelTurn(id: string): void
}

/** What the brain needs from the LLM layer: `LlmGateway` fits. */
export interface LlmLike {
  stream(req: LlmRequest): AsyncIterable<LlmDelta>
}

export interface BrainInput {
  /** The user message exactly as it goes into the conversation (already formatted and sanitised by the caller). */
  text: string
  /** Where it came from, for the record; trust never comes from the text. */
  source: NonNullable<ChatEntry['source']>
  trust: TrustLevel
  /** Display name of the audience member, for the record. */
  name?: string
  /** One-off prompt blocks for this reply only (for example a note about a gift). */
  extras?: readonly string[]
  /** Cancel the reply being generated (and its speech) before starting this one. */
  preempt?: boolean
}

export type TurnStatus = 'done' | 'failed' | 'cancelled'

export interface TurnSummary {
  turnId: string
  status: TurnStatus
  /** Sentences handed to the speech director. */
  sentences: number
  /** Milliseconds from the start of the turn to the first delta of visible text; null if none came. */
  firstTokenMs: number | null
  /** Milliseconds from the start of the turn to the first accepted sentence; null if none. */
  firstSentenceMs: number | null
  totalMs: number
  error?: Error
}

export type BrainEvents = {
  'turn.start': [info: { turnId: string; input: BrainInput }]
  /** One sentence went to the speech director. */
  sentence: [info: { turnId: string; text: string; emotion: Emotion; motion: ClipRef | null }]
  /** Reasoning text that is shown to the operator and never spoken. */
  thinking: [info: { turnId: string; text: string }]
  /** The model asked for a dance with `[motion:dance]` or `[motion:dance:<name>]`. The mode manager decides. */
  'dance.request': [info: { turnId: string; name?: string }]
  /** A motion tag named no clip the stage has. */
  'motion.unknown': [info: { turnId: string; tag: string }]
  /** The full visible text of the reply (tags included, code blocks left out), once the reply ended. */
  reply: [info: { turnId: string; text: string }]
  'turn.end': [summary: TurnSummary]
  error: [err: Error]
}

export type BrainLogger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  extra?: Record<string, unknown>
) => void

export interface BrainOptions {
  llm: LlmLike
  director: DirectorLike
  chat: ChatLog
  /** The persona text, read at the start of every reply so an edit takes effect at once. */
  persona: () => string
  /** Motion tags the stage can play right now. */
  motionTags?: () => readonly string[]
  /** Clip for a tag, or null when there is none. */
  resolveMotion?: (tag: string) => ClipRef | null
  /** Prompts of the modes that are active right now. */
  modePrompts?: () => readonly ModePrompt[]
  /** Recalled memory lines for this input (a viewer's text never becomes an instruction). */
  memory?: (input: BrainInput) => readonly string[]
  /** Latest chat entries sent along with a request (the new message included). Default 10 + 1. */
  historyMessages?: number
  temperature?: number
  maxOutputTokens?: number
  /** Time budget of one provider attempt. */
  timeoutMs?: number
  /** Characters before a comma may end the first sentence (segmenter option). */
  firstCommaMinChars?: number
  /** Changes the segmenter, for tests. */
  makeSegmenter?: () => SpeechSegmenter
  log?: BrainLogger
  now?: () => number
}

interface Turn {
  id: string
  abort: AbortController
  cancelled: boolean
}

export class Brain extends EventEmitter<BrainEvents> {
  private readonly o: BrainOptions
  private readonly log: BrainLogger
  private readonly now: () => number
  private tail: Promise<unknown> = Promise.resolve()
  private waiting = 0
  private active: Turn | null = null
  private counter = 0

  constructor(options: BrainOptions) {
    super()
    this.o = options
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
  }

  /** A reply is being generated. */
  get processing(): boolean {
    return this.active !== null
  }

  /** Messages accepted and not yet started on. */
  get queued(): number {
    return this.waiting
  }

  get currentTurn(): string | null {
    return this.active?.id ?? null
  }

  /**
   * Answer one message. Replies are generated one at a time, in the order they were submitted. The promise
   * resolves when the model's answer is complete (or failed, or was cancelled); the speech may still be playing.
   */
  respond(input: BrainInput): Promise<TurnSummary> {
    if (input.preempt) this.cancelActive('preempted')
    this.waiting++
    const run = async (): Promise<TurnSummary> => {
      this.waiting--
      return this.runTurn(input)
    }
    const p = this.tail.then(run, run)
    this.tail = p.catch(() => undefined)
    return p
  }

  /** Stop the reply being generated and everything it queued. Later replies still work. */
  cancelActive(reason = 'cancelled'): void {
    const t = this.active
    if (!t) return
    this.log('info', `brain: cancel ${t.id} (${reason})`)
    t.cancelled = true
    t.abort.abort()
    this.o.director.cancelTurn(t.id)
  }

  // ───────────────────────────── one reply ─────────────────────────────

  private buildMessages(input: BrainInput): ChatMessage[] {
    const o = this.o
    const n = (o.historyMessages ?? 10) + 1
    const { text, historyInlined } = buildSystemPrompt({
      persona: o.persona(),
      ...(o.motionTags ? { motionTags: o.motionTags() } : {}),
      modePrompts: o.modePrompts?.() ?? [],
      memory: o.memory?.(input) ?? [],
      extras: input.extras ?? [],
      // The placeholder carries the exchanges before this message; the message itself follows separately.
      historyText: o.chat.historyText(n - 1, 1),
    })
    const history = historyInlined ? o.chat.toMessages(1) : o.chat.toMessages(n)
    return [{ role: 'system', content: text }, ...history]
  }

  private async runTurn(input: BrainInput): Promise<TurnSummary> {
    const o = this.o
    const id = `turn-${++this.counter}`
    const started = this.now()
    const turn: Turn = { id, abort: new AbortController(), cancelled: false }
    this.active = turn
    const director = o.director.beginTurn(id)
    this.safeEmit('turn.start', { turnId: id, input })

    const summary: TurnSummary = {
      turnId: id,
      status: 'done',
      sentences: 0,
      firstTokenMs: null,
      firstSentenceMs: null,
      totalMs: 0,
    }
    let displayed = ''
    try {
      // The user's line is part of the record before the model sees it, and stays there whatever happens next.
      o.chat.append({
        role: 'user',
        content: input.text,
        ts: started,
        source: input.source,
        ...(input.name !== undefined ? { name: input.name } : {}),
      })
      const messages = this.buildMessages(input)
      const req: LlmRequest = {
        messages,
        tag: 'chat',
        signal: turn.abort.signal,
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        ...(o.maxOutputTokens !== undefined ? { maxOutputTokens: o.maxOutputTokens } : {}),
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      }

      const segmenter =
        o.makeSegmenter?.() ??
        new SpeechSegmenter(
          o.firstCommaMinChars !== undefined
            ? { firstSpeechCommaMinChars: o.firstCommaMinChars }
            : {}
        )

      const onEvent = (ev: SegmenterEvent) => {
        if (turn.cancelled) return
        if (ev.kind === 'display') {
          displayed += ev.text
        } else if (ev.kind === 'speech') {
          this.onSentence(turn, director, ev, summary, started)
        }
        // Code blocks are shown in the record only (the segmenter leaves their content out of the display text).
      }

      const result = await consumeStream(
        textDeltas(o.llm.stream(req)),
        segmenter,
        {
          onThinking: (text) => this.safeEmit('thinking', { turnId: id, text }),
          onTextChunk: () => {
            if (summary.firstTokenMs === null) summary.firstTokenMs = this.now() - started
          },
          onEvent,
        },
        { signal: turn.abort.signal }
      )

      if (turn.cancelled) summary.status = 'cancelled'
      else if (result.failed) {
        summary.status = 'failed'
        summary.error =
          result.error instanceof Error ? result.error : new Error(String(result.error))
      }
    } catch (e) {
      // Building the prompt failed (an unreadable persona, say): report it, do not crash the loop.
      summary.status = turn.cancelled ? 'cancelled' : 'failed'
      if (!turn.cancelled) summary.error = e instanceof Error ? e : new Error(String(e))
    } finally {
      director.end()
      if (this.active === turn) this.active = null
    }

    const reply = displayed.trim()
    if (reply) {
      o.chat.append({ role: 'assistant', content: reply, ts: this.now() })
      this.safeEmit('reply', { turnId: id, text: reply })
    }
    summary.totalMs = this.now() - started
    if (summary.error) {
      this.log('error', `brain: ${id} failed: ${summary.error.message}`)
      this.safeEmit('error', summary.error)
    }
    this.safeEmit('turn.end', summary)
    return summary
  }

  private onSentence(
    turn: Turn,
    director: TurnSink,
    ev: Extract<SegmenterEvent, { kind: 'speech' }>,
    summary: TurnSummary,
    startedAt: number
  ): void {
    const emotion = parseEmotion(ev.emotionTag)
    let motion: ClipRef | null = null
    const request = parseMotionTag(ev.motionTag)
    if (request?.kind === 'dance') {
      this.safeEmit('dance.request', {
        turnId: turn.id,
        ...(request.name !== undefined ? { name: request.name } : {}),
      })
    } else if (request?.kind === 'clip') {
      motion = this.o.resolveMotion?.(request.tag) ?? null
      if (!motion) this.safeEmit('motion.unknown', { turnId: turn.id, tag: request.tag })
    }
    // The subtitle is the sentence as written (tags already taken out by the segmenter), shown while it is spoken.
    const item: SpeechItem = {
      text: ev.text,
      emotion,
      motion,
      style: emotion,
      subtitle: ev.text.trim().slice(0, 400),
    }
    if (!director.enqueue(item)) return
    summary.sentences++
    if (summary.firstSentenceMs === null) summary.firstSentenceMs = this.now() - startedAt
    this.safeEmit('sentence', { turnId: turn.id, text: ev.text, emotion, motion })
  }

  /** A listener that throws must not take the reply down. */
  private safeEmit<K extends keyof BrainEvents>(event: K, ...args: BrainEvents[K]): void {
    try {
      if (event === 'error' && this.listenerCount('error') === 0) return
      ;(this.emit as (event: string, ...args: unknown[]) => boolean)(event, ...args)
    } catch (e) {
      this.log('error', `brain: a listener of '${String(event)}' threw`, {
        err: (e as Error)?.message,
      })
    }
  }
}

/** The gateway's deltas without the usage snapshots. */
async function* textDeltas(source: AsyncIterable<LlmDelta>): AsyncGenerator<StreamDelta> {
  for await (const d of source) {
    if (d.type === 'text' || d.type === 'thinking') yield d
  }
}
