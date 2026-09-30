// Derived from AITuberKit (https://github.com/tegnike/aituber-kit), used under its Non-Commercial Use License; see licenses/AITuberKit-LICENSE.txt.
// Changed: reads an async iterable instead of a ReadableStream reader, tells thinking from text by type instead of a marker prefix, adds an AbortSignal, returns the failure cause instead of logging it, and flushes the segmenter after a failure.

import type { SpeechSegmenter } from './segmenter.ts'
import type {
  ConsumeStreamOptions,
  ConsumeStreamResult,
  SegmenterEvent,
  StreamDelta,
  StreamHandlers,
} from './types.ts'

const ABORTED = Symbol('aborted')

/**
 * Reads a model answer stream, sends thinking deltas to `onThinking`, pushes text deltas through
 * the segmenter and hands every resulting event to `onEvent`. Use one segmenter per answer.
 *
 * Normal end: the segmenter is flushed and `{ failed: false }` comes back.
 *
 * Failure (the source or a handler throws): what the segmenter still holds is flushed (best effort)
 * and `{ failed: true, error }` comes back. The legacy code did not flush here: text that had
 * been displayed but not yet closed into a sentence was never spoken. Delivering it keeps display
 * and speech consistent; the caller decides what a failed answer means. The legacy code logged
 * the error itself; this module has no logger, so the cause is returned instead.
 *
 * Abort (`opts.signal`): the loop stops at once, without flushing, and `{ failed: false }` comes
 * back. No handler is called after the signal is aborted, not even for events that a chunk already
 * produced, and a source that throws because it was aborted is not a failure. The source is asked
 * to clean up (`return()`) without waiting for it, since a stalled source may never answer.
 * The legacy code had no abort: after a stop it kept reading to the end so the chat log stayed
 * complete, and only the speech dispatcher ignored the rest. Here the caller owns that choice:
 * to keep the log complete, do not abort; drop events in `onEvent` instead.
 *
 * Empty deltas are skipped. Thinking deltas never reach the segmenter.
 */
export async function consumeStream(
  source: AsyncIterable<StreamDelta>,
  segmenter: SpeechSegmenter,
  handlers: StreamHandlers,
  opts: ConsumeStreamOptions = {}
): Promise<ConsumeStreamResult> {
  const { signal } = opts
  // Already aborted: the source is never touched, so there is nothing to clean up.
  if (signal?.aborted) return { failed: false }

  const watch = watchAbort(signal)
  let iterator: AsyncIterator<StreamDelta> | undefined
  // True once the iterator has finished by itself (done, or it threw): no return() is needed.
  let sourceFinished = false

  /** Hands events to the handler; stops (returns false) as soon as the signal is aborted. */
  const deliver = (events: SegmenterEvent[]): boolean => {
    for (const event of events) {
      if (signal?.aborted) return false
      handlers.onEvent(event)
    }
    return true
  }

  try {
    iterator = source[Symbol.asyncIterator]()
    for (;;) {
      let step: IteratorResult<StreamDelta> | typeof ABORTED
      try {
        const pending = iterator.next()
        step = watch.aborted ? await Promise.race([pending, watch.aborted]) : await pending
      } catch (error) {
        sourceFinished = true
        throw error
      }
      if (step === ABORTED || signal?.aborted) return { failed: false }
      if (step.done) {
        sourceFinished = true
        break
      }

      const { type, text } = step.value
      if (!text) continue
      if (type === 'thinking') {
        handlers.onThinking?.(text)
        continue
      }
      handlers.onTextChunk?.(text)
      if (!deliver(segmenter.push(text))) return { failed: false }
    }

    deliver(segmenter.flush())
    return { failed: false }
  } catch (error) {
    // A source that throws because we aborted it (an AbortError, say) is a clean stop.
    if (signal?.aborted) return { failed: false }
    try {
      deliver(segmenter.flush())
    } catch {
      // Best effort: the error that started the failure is the one worth reporting.
    }
    return { failed: true, error }
  } finally {
    watch.dispose()
    if (iterator && !sourceFinished) closeSource(iterator)
  }
}

/** A promise that resolves when the signal aborts, plus the way to detach its listener. */
function watchAbort(signal: AbortSignal | undefined): {
  aborted: Promise<typeof ABORTED> | undefined
  dispose: () => void
} {
  if (!signal) return { aborted: undefined, dispose: () => {} }
  let listener: () => void = () => {}
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    listener = () => resolve(ABORTED)
    signal.addEventListener('abort', listener, { once: true })
  })
  return { aborted, dispose: () => signal.removeEventListener('abort', listener) }
}

/**
 * Asks the source to release its resources. Not awaited: an async generator queues return()
 * behind a pending next(), so waiting could hang on a stalled source.
 */
function closeSource(iterator: AsyncIterator<StreamDelta>): void {
  try {
    void Promise.resolve(iterator.return?.()).catch(() => {})
  } catch {
    // A broken source must not turn a clean stop into an error.
  }
}
