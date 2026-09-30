import { describe, expect, it, vi } from 'vitest'
import { SpeechSegmenter } from '../../src/brain/segmenter.ts'
import { consumeStream } from '../../src/brain/stream.ts'
import type {
  ConsumeStreamOptions,
  SegmenterEvent,
  SpeechEvent,
  StreamDelta,
  StreamHandlers,
} from '../../src/brain/types.ts'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function* deltas(items: StreamDelta[]): AsyncGenerator<StreamDelta> {
  for (const item of items) yield item
}

const texts = (chunks: string[]): StreamDelta[] => chunks.map((text) => ({ type: 'text', text }))

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const item = (text: string): IteratorResult<StreamDelta> => ({
  done: false,
  value: { type: 'text', text },
})

const finished: IteratorResult<StreamDelta> = { done: true, value: undefined }

/** A next() that never settles: a stalled connection. */
const stall = () => new Promise<IteratorResult<StreamDelta>>(() => {})

/** An async iterable whose iterator is built by hand, to control next() and return() exactly. */
const manualSource = (script: {
  next: () => Promise<IteratorResult<StreamDelta>>
  return?: () => Promise<IteratorResult<StreamDelta>>
}): AsyncIterable<StreamDelta> => ({
  [Symbol.asyncIterator]: () => ({ next: script.next, return: script.return }),
})

const speeches = (events: SegmenterEvent[]): SpeechEvent[] =>
  events.filter((e): e is SpeechEvent => e.kind === 'speech')
const speechTexts = (events: SegmenterEvent[]) => speeches(events).map((e) => e.text)

async function run(
  source: AsyncIterable<StreamDelta>,
  opts?: ConsumeStreamOptions,
  segmenter = new SpeechSegmenter(),
  handlers: Partial<StreamHandlers> = {}
) {
  const events: SegmenterEvent[] = []
  const result = await consumeStream(
    source,
    segmenter,
    {
      ...handlers,
      onEvent: (event) => {
        events.push(event)
        handlers.onEvent?.(event)
      },
    },
    opts
  )
  return { events, result }
}

// ── Normal flow ──────────────────────────────────────────────────────────────

describe('consumeStream, normal flow', () => {
  it('pushes text deltas through the segmenter and flushes at the end', async () => {
    const { events, result } = await run(
      deltas(texts(['こんにちは。元気', 'ですか。', '最後の未完']))
    )
    expect(result).toEqual({ failed: false })
    expect(speechTexts(events)).toEqual(['こんにちは。', '元気ですか。', '最後の未完'])
  })

  it('an empty stream produces no events', async () => {
    const { events, result } = await run(deltas([]))
    expect(result).toEqual({ failed: false })
    expect(events).toEqual([])
  })

  it('sends thinking deltas to onThinking and never speaks them', async () => {
    const thinking: string[] = []
    const { events, result } = await run(
      deltas([
        { type: 'thinking', text: '考え中' },
        { type: 'text', text: 'こんにちは。' },
        { type: 'thinking', text: 'まだ考える' },
        { type: 'text', text: 'さようなら。' },
      ]),
      undefined,
      new SpeechSegmenter(),
      { onThinking: (t) => thinking.push(t) }
    )
    expect(result).toEqual({ failed: false })
    expect(thinking).toEqual(['考え中', 'まだ考える'])
    expect(speechTexts(events)).toEqual(['こんにちは。', 'さようなら。'])
    expect(events.flatMap((e) => (e.kind === 'display' ? [e.text] : [])).join('')).toBe(
      'こんにちは。さようなら。'
    )
  })

  it('calls onTextChunk with each text delta before the events it produces', async () => {
    const log: string[] = []
    await run(deltas(texts(['やあ。', 'さよなら'])), undefined, new SpeechSegmenter(), {
      onTextChunk: (t) => log.push(`chunk:${t}`),
      onEvent: (e) => log.push(`event:${e.kind}`),
    })
    expect(log).toEqual([
      'chunk:やあ。',
      'event:display',
      'event:speech',
      'chunk:さよなら',
      'event:display',
      'event:speech', // from the flush at the end
    ])
  })

  it('skips empty deltas of either type', async () => {
    const onThinking = vi.fn()
    const onTextChunk = vi.fn()
    const { events } = await run(
      deltas([
        { type: 'text', text: '' },
        { type: 'thinking', text: '' },
        { type: 'text', text: 'やあ。' },
      ]),
      undefined,
      new SpeechSegmenter(),
      { onThinking, onTextChunk }
    )
    expect(onThinking).not.toHaveBeenCalled()
    expect(onTextChunk).toHaveBeenCalledTimes(1)
    expect(speechTexts(events)).toEqual(['やあ。'])
  })

  it('works with only onEvent given, ignoring thinking', async () => {
    const events: SegmenterEvent[] = []
    const result = await consumeStream(
      deltas([
        { type: 'thinking', text: '考え' },
        { type: 'text', text: 'やあ。' },
      ]),
      new SpeechSegmenter(),
      { onEvent: (e) => events.push(e) }
    )
    expect(result).toEqual({ failed: false })
    expect(speechTexts(events)).toEqual(['やあ。'])
  })

  it('uses the segmenter it is given (first-sentence comma threshold)', async () => {
    const { events } = await run(
      deltas(texts(['こんにちは、マスター。'])),
      undefined,
      new SpeechSegmenter({ firstSpeechCommaMinChars: 5 })
    )
    expect(speechTexts(events)).toEqual(['こんにちは、', 'マスター。'])
  })
})

// ── Chunk boundaries ─────────────────────────────────────────────────────────

// Sample answers for the split property. None has whitespace or a newline right after a sentence
// end outside a code block: legacy quirks (pinned in the segmenter tests) make the output depend
// on the split there.
const SAMPLES: Record<string, string> = {
  plain: 'こんにちは。元気ですか。今日はいい天気ですね、散歩に行きたいです。',
  tags: '[happy]やったね。二文目です。[sad]悲しいな。[happy][motion:cheer]もう一度、ありがとう！',
  numbers: '価格は1分0.10から0.37ドルで、再生回数は5,200万回です。以上です。',
  inlineCode: 'インライン`code`です。さらに``二重``もあります。',
  codeBlock: 'コードです。```js\nconst a = 1\nconst b = 2\n```以上です。続きの文です。',
  codeThenTag: '[happy]先に。```\nabc\n```[sad]後に。',
  unclosedFence: 'テキスト。```py\nprint(1)',
  mixedScripts:
    '[motion:dance:waltz]踊るよ。これは English words and numbers like 3.14, 1,000 です。[angry]怒った！',
  noTerminator: '句点のないテキスト',
  onlyFence: '```\nonly code\n```',
  tagBeforeText: '前置き[happy]本文です。さらに続く長い文章がここに入ります、そして終わります。',
}

/**
 * What must not depend on chunking: the speech and code events in order, and the concatenated
 * display text. Display events themselves are confirmed per push, so their boundaries (and their
 * interleaving with speech events) follow the chunks by design.
 */
function canonical(events: SegmenterEvent[]) {
  return {
    display: events.flatMap((e) => (e.kind === 'display' ? [e.text] : [])).join(''),
    rest: events.filter((e) => e.kind !== 'display'),
  }
}

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Splits `s` at `cuts` random positions (duplicates give empty chunks). */
function randomSplit(s: string, cuts: number, rand: () => number): string[] {
  const points = Array.from({ length: cuts }, () => Math.floor(rand() * (s.length + 1))).sort(
    (a, b) => a - b
  )
  const chunks: string[] = []
  let from = 0
  for (const p of points) {
    chunks.push(s.slice(from, p))
    from = p
  }
  chunks.push(s.slice(from))
  return chunks
}

describe('consumeStream, chunk boundaries', () => {
  const collect = async (
    source: AsyncIterable<StreamDelta>,
    firstSpeechCommaMinChars: number | undefined
  ) => {
    const { events, result } = await run(
      source,
      undefined,
      new SpeechSegmenter({ firstSpeechCommaMinChars })
    )
    expect(result).toEqual({ failed: false })
    return canonical(events)
  }

  describe.each(Object.entries(SAMPLES))('%s', (_name, sample) => {
    it.each([undefined, 5])(
      'gives the same speech and code events wherever it is split (first comma threshold %s)',
      async (firstComma) => {
        const whole = await collect(deltas(texts([sample])), firstComma)
        // Not vacuous: every sample produces something to compare.
        expect(whole.rest.length).toBeGreaterThan(0)

        // Every two-way split.
        for (let i = 0; i <= sample.length; i++) {
          const parts = [sample.slice(0, i), sample.slice(i)]
          expect(await collect(deltas(texts(parts)), firstComma), `split at ${i}`).toEqual(whole)
        }

        // One character per chunk.
        expect(
          await collect(deltas(texts(sample.split(''))), firstComma),
          'one char per chunk'
        ).toEqual(whole)

        // Random splits into up to seven chunks (seeded, so a failure reproduces).
        const rand = mulberry32(20260930)
        for (let n = 0; n < 200; n++) {
          const parts = randomSplit(sample, 1 + Math.floor(rand() * 6), rand)
          expect(
            await collect(deltas(texts(parts)), firstComma),
            `chunks ${JSON.stringify(parts)}`
          ).toEqual(whole)
        }
      }
    )
  })

  it('produces the expected sentences for the tag sample, however it is split', async () => {
    const sample = SAMPLES.tags ?? ''
    const { events } = await run(deltas(texts(sample.split(''))))
    expect(
      speeches(events).map((e) => [e.text, e.emotionTag, e.motionTag, e.emotionTagExplicit])
    ).toEqual([
      ['やったね。', '[happy]', undefined, true],
      ['二文目です。', '[happy]', undefined, false],
      ['悲しいな。', '[sad]', undefined, true],
      ['もう一度、ありがとう！', '[happy]', 'cheer', true],
    ])
  })

  it('interleaved thinking deltas do not change the events', async () => {
    for (const sample of Object.values(SAMPLES)) {
      const plain = await collect(deltas(texts([sample])), undefined)
      const interleaved = sample.split('').flatMap((ch): StreamDelta[] => [
        { type: 'thinking', text: 'hmm' },
        { type: 'text', text: ch },
      ])
      expect(await collect(deltas(interleaved), undefined)).toEqual(plain)
    }
  })
})

// ── Failure ──────────────────────────────────────────────────────────────────

describe('consumeStream, failure', () => {
  it('flushes what was parsed, reports failed and returns the cause when the source throws', async () => {
    const boom = new Error('connection reset')
    async function* failing(): AsyncGenerator<StreamDelta> {
      yield { type: 'text', text: '一文目。二文目の途' }
      throw boom
    }
    const { events, result } = await run(failing())
    expect(result.failed).toBe(true)
    expect(result.error).toBe(boom)
    // The sentence that was complete came out during the stream, the unfinished one at the flush.
    expect(speechTexts(events)).toEqual(['一文目。', '二文目の途'])
  })

  it('a failure before any text gives failed with no events', async () => {
    const boom = new Error('refused')
    async function* failing(): AsyncGenerator<StreamDelta> {
      throw boom
    }
    const { events, result } = await run(failing())
    expect(result).toEqual({ failed: true, error: boom })
    expect(events).toEqual([])
  })

  it('does not ask a source that threw to clean up', async () => {
    const returnSpy = vi.fn(async () => finished)
    let calls = 0
    const source = manualSource({
      next: async () => {
        if (calls++ === 0) return item('あ')
        throw new Error('boom')
      },
      return: returnSpy,
    })
    const { result } = await run(source)
    expect(result.failed).toBe(true)
    expect(returnSpy).not.toHaveBeenCalled()
  })

  it('a next() that throws synchronously is a failure too', async () => {
    const boom = new Error('sync')
    const source = manualSource({
      next: () => {
        throw boom
      },
    })
    const { result } = await run(source)
    expect(result).toEqual({ failed: true, error: boom })
  })

  it('a throwing handler is a failure: the source is closed and later events of that push are lost', async () => {
    let closed = false
    async function* source(): AsyncGenerator<StreamDelta> {
      try {
        yield { type: 'text', text: 'あ。い。' } // display, speech 'あ。', speech 'い。'
        yield { type: 'text', text: 'う' }
      } finally {
        closed = true
      }
    }
    const boom = new Error('handler bug')
    const seen: string[] = []
    const result = await consumeStream(source(), new SpeechSegmenter(), {
      onEvent: (event) => {
        seen.push(event.kind === 'speech' ? `speech:${event.text}` : event.kind)
        if (event.kind === 'speech' && event.text === 'あ。') throw boom
      },
    })
    expect(result).toEqual({ failed: true, error: boom })
    // As in the legacy loop, the rest of the failed push ('い。') is lost: the segmenter had
    // already handed it over, so the flush has nothing left to add.
    expect(seen).toEqual(['display', 'speech:あ。'])
    await delay(0)
    expect(closed).toBe(true)
  })

  it('a handler that throws during the final flush is a failure and does not hang', async () => {
    const boom = new Error('late handler bug')
    const result = await consumeStream(deltas(texts(['あいう'])), new SpeechSegmenter(), {
      onEvent: (event) => {
        if (event.kind === 'speech') throw boom
      },
    })
    expect(result).toEqual({ failed: true, error: boom })
  })

  it('keeps the first error when the flush after a failure throws as well', async () => {
    const first = new Error('source failed')
    async function* failing(): AsyncGenerator<StreamDelta> {
      yield { type: 'text', text: '未完の文' }
      throw first
    }
    const result = await consumeStream(failing(), new SpeechSegmenter(), {
      onEvent: (event) => {
        if (event.kind === 'speech') throw new Error('handler also failed')
      },
    })
    expect(result).toEqual({ failed: true, error: first })
  })

  it('a source that is not async iterable fails cleanly', async () => {
    const { result } = await run({} as unknown as AsyncIterable<StreamDelta>)
    expect(result.failed).toBe(true)
    expect(result.error).toBeInstanceOf(TypeError)
  })

  it('does not report an error on success', async () => {
    const { result } = await run(deltas(texts(['やあ。'])))
    expect(result).toStrictEqual({ failed: false })
  })
})

// ── Abort ────────────────────────────────────────────────────────────────────

describe('consumeStream, abort', () => {
  it('returns at once, without touching the source, when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const opened = vi.fn()
    const source: AsyncIterable<StreamDelta> = {
      [Symbol.asyncIterator]: () => {
        opened()
        return { next: async () => item('あ。') }
      },
    }
    const { events, result } = await run(source, { signal: controller.signal })
    expect(result).toEqual({ failed: false })
    expect(opened).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('stops without flushing when a handler aborts, delivers nothing more and closes the source', async () => {
    const controller = new AbortController()
    let closed = false
    async function* source(): AsyncGenerator<StreamDelta> {
      try {
        yield { type: 'text', text: 'あ。い。' } // display, speech 'あ。', speech 'い。'
        yield { type: 'text', text: 'う' }
      } finally {
        closed = true
      }
    }
    const { events, result } = await run(
      source(),
      { signal: controller.signal },
      new SpeechSegmenter(),
      {
        onEvent: (event) => {
          if (event.kind === 'speech') controller.abort()
        },
      }
    )
    expect(result).toEqual({ failed: false })
    // The event that triggered the abort was delivered; the next one from the same chunk was not.
    expect(events.map((e) => e.kind)).toEqual(['display', 'speech'])
    expect(speechTexts(events)).toEqual(['あ。'])
    await delay(0)
    expect(closed).toBe(true)
  })

  it('an abort right after the last delta wins over the final flush', async () => {
    const controller = new AbortController()
    const { events, result } = await run(
      deltas([
        { type: 'text', text: 'あ。う' },
        { type: 'thinking', text: 'stop now' },
      ]),
      { signal: controller.signal },
      new SpeechSegmenter(),
      { onThinking: () => controller.abort() }
    )
    expect(result).toEqual({ failed: false })
    expect(speechTexts(events)).toEqual(['あ。']) // the unfinished 'う' is not flushed
  })

  it('an abort wins over an answer the source has already given', async () => {
    const controller = new AbortController()
    const script: IteratorResult<StreamDelta>[] = [
      item('あ。う'),
      { done: false, value: { type: 'thinking', text: 'stop now' } },
      item('後続。'),
      finished,
    ]
    let i = 0
    // next() settles at once every time, so the next answer is ready by the time the abort is seen.
    const source = manualSource({ next: () => Promise.resolve(script[i++] ?? finished) })
    const chunks: string[] = []
    const { events, result } = await run(
      source,
      { signal: controller.signal },
      new SpeechSegmenter(),
      { onThinking: () => controller.abort(), onTextChunk: (t) => chunks.push(t) }
    )
    expect(result).toEqual({ failed: false })
    // No handler is called after the abort: not for the ready chunk, and no flush of the unfinished 'う'.
    expect(chunks).toEqual(['あ。う'])
    expect(speechTexts(events)).toEqual(['あ。'])
  })

  it('stops promptly when aborted while the source is stalled, and asks it to clean up', async () => {
    const controller = new AbortController()
    let closed = false
    let calls = 0
    const source = manualSource({
      next: () => (calls++ === 0 ? Promise.resolve(item('こんにちは。続きは')) : stall()),
      return: () => {
        closed = true
        return Promise.resolve(finished)
      },
    })
    const events: SegmenterEvent[] = []
    const pending = consumeStream(
      source,
      new SpeechSegmenter(),
      { onEvent: (e) => events.push(e) },
      {
        signal: controller.signal,
      }
    )
    await delay(10) // let it reach the stalled next()
    controller.abort()
    const outcome = await Promise.race([pending, delay(1000).then(() => 'timed out' as const)])
    expect(outcome).toEqual({ failed: false })
    expect(closed).toBe(true)
    expect(speechTexts(events)).toEqual(['こんにちは。']) // '続きは' was not flushed
  })

  it('does not wait for a stalled async generator to answer return()', async () => {
    const controller = new AbortController()
    async function* stalled(): AsyncGenerator<StreamDelta> {
      yield { type: 'text', text: 'こんにちは。' }
      await new Promise(() => {}) // never resumes, so its return() would never settle
    }
    const pending = run(stalled(), { signal: controller.signal })
    await delay(10)
    controller.abort()
    const outcome = await Promise.race([pending, delay(1000).then(() => 'timed out' as const)])
    expect(outcome).not.toBe('timed out')
    expect(outcome).toMatchObject({ result: { failed: false } })
  })

  it('a source that throws because of the abort is not a failure and nothing is flushed', async () => {
    const controller = new AbortController()
    async function* abortable(): AsyncGenerator<StreamDelta> {
      yield { type: 'text', text: 'あいう' }
      await new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
        )
      })
    }
    const pending = run(abortable(), { signal: controller.signal })
    await delay(10)
    controller.abort()
    const { events, result } = await pending
    expect(result).toEqual({ failed: false })
    expect(speeches(events)).toEqual([])
  })

  it('an error thrown after the abort is not reported as a failure either', async () => {
    const controller = new AbortController()
    const source = manualSource({
      next: async () => {
        controller.abort()
        throw new Error('anything, after the caller gave up')
      },
    })
    const { result } = await run(source, { signal: controller.signal })
    expect(result).toEqual({ failed: false })
  })

  it('an abandoned next() that rejects later is not an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const controller = new AbortController()
      let calls = 0
      const source = manualSource({
        next: () =>
          calls++ === 0
            ? Promise.resolve(item('あ。'))
            : new Promise<IteratorResult<StreamDelta>>((_, reject) =>
                setTimeout(() => reject(new Error('late failure')), 30)
              ),
      })
      const pending = run(source, { signal: controller.signal })
      await delay(5)
      controller.abort()
      expect((await pending).result).toEqual({ failed: false })
      await delay(80) // long enough for the abandoned promise to reject
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })

  it('removes its abort listener however the stream ends', async () => {
    const attached = (controller: AbortController) => {
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      return () => remove.mock.calls.filter(([type]) => type === 'abort').length
    }

    const normal = new AbortController()
    const normalRemoved = attached(normal)
    await run(deltas(texts(['やあ。'])), { signal: normal.signal })
    expect(normalRemoved()).toBe(1)

    const failing = new AbortController()
    const failingRemoved = attached(failing)
    async function* boom(): AsyncGenerator<StreamDelta> {
      throw new Error('boom')
    }
    await run(boom(), { signal: failing.signal })
    expect(failingRemoved()).toBe(1)

    const aborted = new AbortController()
    const abortedRemoved = attached(aborted)
    const pending = run(manualSource({ next: stall }), { signal: aborted.signal })
    await delay(5)
    aborted.abort()
    await pending
    expect(abortedRemoved()).toBe(1)
  })

  it('an unaborted signal changes nothing', async () => {
    const controller = new AbortController()
    const withSignal = await run(deltas(texts(['こんにちは。元気', 'ですか。'])), {
      signal: controller.signal,
    })
    const without = await run(deltas(texts(['こんにちは。元気', 'ですか。'])))
    expect(withSignal.events).toEqual(without.events)
    expect(withSignal.result).toEqual({ failed: false })
  })
})
