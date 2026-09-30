// Derived from AITuberKit (https://github.com/tegnike/aituber-kit), used under its Non-Commercial Use License; see licenses/AITuberKit-LICENSE.txt.
// Changed: comments translated to English; added the motion-request, stream-delta and handler types used by the new orchestrator.

/**
 * Events emitted by `SpeechSegmenter`.
 *
 * - display: raw text to append to the chat log (tags included, code content excluded)
 * - speech: one sentence ready to be spoken (tags already extracted)
 * - code: one complete code block (implies a message boundary)
 */
export type SegmenterEvent =
  | { kind: 'display'; text: string }
  | {
      kind: 'speech'
      text: string
      emotionTag: string
      motionTag?: string
      /**
       * Whether a tag appeared explicitly right before this sentence.
       * false means the tag was carried over from an earlier sentence. A normalised display
       * writer should include the tag in the displayed text only when this is true.
       */
      emotionTagExplicit?: boolean
    }
  | { kind: 'code'; content: string }

export type SpeechEvent = Extract<SegmenterEvent, { kind: 'speech' }>

/** What a `[motion:...]` tag asks for; see `parseMotionTag`. */
export type MotionRequest = { kind: 'clip'; tag: string } | { kind: 'dance'; name?: string }

/** One delta of a model answer: visible text, or reasoning ("thinking") text that is never spoken. */
export type StreamDelta = { type: 'text' | 'thinking'; text: string }

export type StreamHandlers = {
  onThinking?: (text: string) => void
  /** Called with every non-empty text delta, right before it is pushed through the segmenter. */
  onTextChunk?: (text: string) => void
  onEvent: (event: SegmenterEvent) => void
}

export type ConsumeStreamOptions = {
  /** Aborting stops the loop without flushing; see `consumeStream`. */
  signal?: AbortSignal
}

export type ConsumeStreamResult = {
  /** true when the source (or a handler) threw. Aborting is not a failure. */
  failed: boolean
  /** The thrown value when `failed` is true, so the caller can log it. */
  error?: unknown
}
