// Derived from AITuberKit (https://github.com/tegnike/aituber-kit), used under its Non-Commercial Use License; see licenses/AITuberKit-LICENSE.txt.
// Changed: comments translated to English; the table of TTS engines that want a short first segment is gone (the caller passes the number); non-finite thresholds fall back to the default; a code block reports the word after its opening fence (its language) and whether the stream ended before it was closed.

import { extractEmotion, extractMotionTag, extractSentence } from './tags.ts'
import type { SegmenterEvent } from './types.ts'

const CODE_DELIMITER = '```'
// Defensive iteration cap. push/flush always consume their input, so this cannot be reached in
// theory; it only keeps a future regex change from freezing the process if that ever regresses.
const MAX_ITERATIONS = 100000

/** Characters that must precede a comma before it may end a sentence. */
export const DEFAULT_COMMA_MIN_CHARS = 10
/** The threshold the legacy app used for the first sentence with low-latency TTS engines (5 characters before the comma, 6 with it). */
export const SHORT_FIRST_COMMA_MIN_CHARS = 5

export type SpeechSegmenterOptions = {
  /**
   * Minimum number of characters before a comma may end the *first* sentence of the answer.
   * Later sentences always use DEFAULT_COMMA_MIN_CHARS. Engines that are slow to synthesise a whole
   * sentence use a small value (SHORT_FIRST_COMMA_MIN_CHARS) so the first audio starts earlier.
   * Default: DEFAULT_COMMA_MIN_CHARS. A non-finite value falls back to the default.
   */
  firstSpeechCommaMinChars?: number
}

/**
 * The legacy per-engine lookup, with the table supplied by the caller: SHORT_FIRST_COMMA_MIN_CHARS
 * when `voice` is one of `shortFirstSegmentVoices`, DEFAULT_COMMA_MIN_CHARS otherwise.
 * The orchestrator normally passes `firstSpeechCommaMinChars` to the segmenter directly.
 */
export function getFirstSpeechCommaMinChars(
  voice: string,
  shortFirstSegmentVoices: Iterable<string>
): number {
  for (const candidate of shortFirstSegmentVoices) {
    if (candidate === voice) return SHORT_FIRST_COMMA_MIN_CHARS
  }
  return DEFAULT_COMMA_MIN_CHARS
}

/**
 * State machine that turns streamed text into display, speech and code-block events, one push at
 * a time. It has no side effects. Use one instance per answer.
 *
 * - Display cursor (displayHold): confirmed on every push. The only text held back is a trailing
 *   run of one or two backticks at the end of a chunk, which may be the start of a code fence.
 * - Speech cursor (speechBuffer): waits until extractSentence confirms a sentence.
 * - Tag carry-over: an emotion or motion tag applies until the next tag, a code-block boundary,
 *   a newline, or flush().
 *
 * Apart from the legacy quirks pinned in the tests (whitespace that opens a chunk right after a
 * finished sentence), chunking does not change which sentences and code blocks come out. Display
 * events are confirmed per push, so only their concatenation is chunk-independent.
 */
export class SpeechSegmenter {
  private mode: 'text' | 'code' = 'text'
  private speechBuffer = ''
  private displayHold = ''
  private codeBuffer = ''
  private emotionTag = ''
  private motionTag = ''
  // True while an explicit tag has appeared and no sentence has been spoken since (lets a
  // normalised display avoid repeating a carried-over tag; see emotionTagExplicit).
  private tagExplicitPending = false
  // True right after a code block opens, until the language line (```js) has been removed.
  private awaitingLangLine = false
  // The language word of the code block being read ('' when the fence had none).
  private codeLang = ''
  private hasEmittedSpeech = false
  private readonly firstSpeechCommaMinChars: number

  constructor(options: SpeechSegmenterOptions = {}) {
    const first = options.firstSpeechCommaMinChars
    this.firstSpeechCommaMinChars =
      first !== undefined && Number.isFinite(first) ? first : DEFAULT_COMMA_MIN_CHARS
  }

  push(chunk: string): SegmenterEvent[] {
    const events: SegmenterEvent[] = []
    let work = chunk
    let iterations = 0
    while (work.length > 0 && iterations++ < MAX_ITERATIONS) {
      work = this.mode === 'text' ? this.consumeText(work, events) : this.consumeCode(work, events)
    }
    return events
  }

  flush(): SegmenterEvent[] {
    const events: SegmenterEvent[] = []
    if (this.mode === 'text') {
      // Confirm a held-back backtick fragment as ordinary text.
      if (this.displayHold) {
        events.push({ kind: 'display', text: this.displayHold })
        this.speechBuffer += this.displayHold
        this.displayHold = ''
      }
      this.drainSentences(events, { force: true })
    } else {
      // The stream ended inside a code block: emit it as code (as the legacy app did), marked as cut short.
      this.emitCode(events, this.codeBuffer, true)
      this.codeBuffer = ''
      this.mode = 'text'
      this.awaitingLangLine = false
    }
    this.emotionTag = ''
    this.motionTag = ''
    this.tagExplicitPending = false
    return events
  }

  /** Text mode: consumes the work area and returns what is left over (to be handled in code mode). */
  private consumeText(work: string, events: SegmenterEvent[]): string {
    const combined = this.displayHold + work
    this.displayHold = ''

    const delimiterIndex = combined.indexOf(CODE_DELIMITER)
    if (delimiterIndex !== -1) {
      const before = combined.slice(0, delimiterIndex)
      if (before) {
        events.push({ kind: 'display', text: before })
        this.speechBuffer += before
      }
      // An unfinished sentence right before a code block is forced out as speech (legacy fix D2).
      this.drainSentences(events, { force: true })
      this.mode = 'code'
      this.codeBuffer = ''
      this.codeLang = ''
      this.awaitingLangLine = true
      return combined.slice(delimiterIndex + CODE_DELIMITER.length)
    }

    // A trailing run of one or two backticks may be the start of a fence: hold it back (legacy fix D5).
    const holdMatch = combined.match(/`{1,2}$/)
    const holdLength = holdMatch ? holdMatch[0].length : 0
    const displayText = holdLength ? combined.slice(0, -holdLength) : combined
    this.displayHold = holdLength ? combined.slice(-holdLength) : ''

    if (displayText) {
      events.push({ kind: 'display', text: displayText })
      this.speechBuffer += displayText
      this.drainSentences(events)
    }
    return ''
  }

  /** Code mode: consumes the work area and returns what is left over (to be handled in text mode). */
  private consumeCode(work: string, events: SegmenterEvent[]): string {
    this.codeBuffer += work

    if (this.awaitingLangLine) {
      // The language line is held until its newline arrives, then removed (independent of
      // chunking, legacy fix C9).
      const langMatch = this.codeBuffer.match(/^ *(\w+)? *\n/)
      if (langMatch) {
        this.codeLang = langMatch[1] ?? ''
        this.codeBuffer = this.codeBuffer.slice(langMatch[0].length)
        this.awaitingLangLine = false
      } else if (/^ *(\w*)? *$/.test(this.codeBuffer)) {
        // Could still be a language line (no newline yet): wait for the next push.
        return ''
      } else {
        this.awaitingLangLine = false
      }
    }

    const delimiterIndex = this.codeBuffer.indexOf(CODE_DELIMITER)
    if (delimiterIndex === -1) {
      // Keep the whole buffer (including any partial closing fence) and wait for the next push.
      return ''
    }

    this.emitCode(events, this.codeBuffer.slice(0, delimiterIndex))
    const rest = this.codeBuffer.slice(delimiterIndex + CODE_DELIMITER.length).trimStart()
    this.codeBuffer = ''
    this.mode = 'text'
    this.awaitingLangLine = false
    // Tag carry-over ends at a code-block boundary (as the legacy app did).
    this.emotionTag = ''
    this.motionTag = ''
    this.tagExplicitPending = false
    return rest
  }

  private emitCode(events: SegmenterEvent[], content: string, unterminated = false) {
    if (content.trim()) {
      events.push({
        kind: 'code',
        content,
        ...(this.codeLang ? { lang: this.codeLang } : {}),
        ...(unterminated ? { unterminated: true as const } : {}),
      })
    }
    this.codeLang = ''
  }

  private drainSentences(events: SegmenterEvent[], { force = false }: { force?: boolean } = {}) {
    let iterations = 0
    while (this.speechBuffer.length > 0 && iterations++ < MAX_ITERATIONS) {
      const { emotionTag, remainingText: afterEmotion } = extractEmotion(this.speechBuffer)
      if (emotionTag) {
        this.emotionTag = emotionTag
        this.tagExplicitPending = true
      }
      const { motionTag, remainingText: afterMotion } = extractMotionTag(afterEmotion)
      if (motionTag) this.motionTag = motionTag

      const { sentence, remainingText: afterSentence } = extractSentence(afterMotion, {
        commaMinChars: this.hasEmittedSpeech
          ? DEFAULT_COMMA_MIN_CHARS
          : this.firstSpeechCommaMinChars,
      })

      if (sentence) {
        this.emitSpeech(events, sentence)
        // Crossing a newline ends the tag carry-over. extractSentence trims the start of the
        // remainder, so look for the newline both at the end of the sentence and in the trimmed gap.
        const trimmedGap = afterMotion.slice(
          sentence.length,
          afterMotion.length - afterSentence.length
        )
        if (sentence.endsWith('\n') || trimmedGap.includes('\n')) {
          this.emotionTag = ''
          this.motionTag = ''
        }
        this.speechBuffer = afterSentence
        continue
      }

      if (force) {
        // flush() or a code-block boundary: whatever is left becomes a sentence.
        if (afterMotion) {
          this.emitSpeech(events, afterMotion)
        }
        this.speechBuffer = ''
      }
      break
    }
  }

  private emitSpeech(events: SegmenterEvent[], text: string) {
    events.push({
      kind: 'speech',
      text,
      emotionTag: this.emotionTag,
      motionTag: this.motionTag || undefined,
      emotionTagExplicit: this.tagExplicitPending,
    })
    this.tagExplicitPending = false
    this.hasEmittedSpeech = true
  }
}
