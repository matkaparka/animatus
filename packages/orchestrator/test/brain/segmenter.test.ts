// Derived from AITuberKit (https://github.com/tegnike/aituber-kit), used under its Non-Commercial Use License; see licenses/AITuberKit-LICENSE.txt.
// Changed: the legacy segmenter test cases are ported with their inputs and expectations unchanged (names translated to English; array access adapted to noUncheckedIndexedAccess; the engine-id table of the threshold lookup is now fixture data); new cases pin the port-specific guards and two legacy chunking quirks.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMMA_MIN_CHARS,
  SHORT_FIRST_COMMA_MIN_CHARS,
  SpeechSegmenter,
  getFirstSpeechCommaMinChars,
} from '../../src/brain/segmenter.ts'
import { isSpeakableText } from '../../src/brain/tags.ts'
import type { SegmenterEvent, SpeechEvent } from '../../src/brain/types.ts'

type CodeEvent = Extract<SegmenterEvent, { kind: 'code' }>
type DisplayEvent = Extract<SegmenterEvent, { kind: 'display' }>

const pushAll = (segmenter: SpeechSegmenter, chunks: string[]) => {
  const events: SegmenterEvent[] = []
  for (const chunk of chunks) {
    events.push(...segmenter.push(chunk))
  }
  return events
}

const speeches = (events: SegmenterEvent[]): SpeechEvent[] =>
  events.filter((e): e is SpeechEvent => e.kind === 'speech')
const speechTexts = (events: SegmenterEvent[]) => speeches(events).map((e) => e.text)
const displays = (events: SegmenterEvent[]) =>
  events
    .filter((e): e is DisplayEvent => e.kind === 'display')
    .map((e) => e.text)
    .join('')
const codes = (events: SegmenterEvent[]): CodeEvent[] =>
  events.filter((e): e is CodeEvent => e.kind === 'code')

// ── Legacy cases (ported) ────────────────────────────────────────────────────

describe('SpeechSegmenter', () => {
  describe('low-latency TTS threshold', () => {
    // The library no longer carries a table of TTS engines; the legacy ids are fixture data here.
    const LEGACY_SHORT_FIRST_SEGMENT_VOICES = [
      'voicevox',
      'aivis_speech',
      'google',
      'openai',
      'aivis_cloud_api',
    ]

    it.each(LEGACY_SHORT_FIRST_SEGMENT_VOICES)('%s uses the short first comma break', (voice) => {
      expect(getFirstSpeechCommaMinChars(voice, LEGACY_SHORT_FIRST_SEGMENT_VOICES)).toBe(5)
    })

    it('other TTS engines keep the normal threshold', () => {
      expect(getFirstSpeechCommaMinChars('azure', LEGACY_SHORT_FIRST_SEGMENT_VOICES)).toBe(10)
    })
  })

  describe('sentence splitting', () => {
    it('ends a sentence at a full stop', () => {
      const seg = new SpeechSegmenter()
      const events = [...seg.push('こんにちは。元気ですか。'), ...seg.flush()]
      expect(speechTexts(events)).toEqual(['こんにちは。', '元気ですか。'])
    })

    it('joins a sentence that spans chunks', () => {
      const seg = new SpeechSegmenter()
      const events = pushAll(seg, ['こんに', 'ちは。元気', 'ですか。'])
      expect(speechTexts(events)).toEqual(['こんにちは。', '元気ですか。'])
    })

    it('splits correctly with one-character chunks', () => {
      const seg = new SpeechSegmenter()
      const events = pushAll(seg, 'やあ。元気？'.split(''))
      expect(speechTexts(events)).toEqual(['やあ。', '元気？'])
    })

    it('only the first utterance breaks early at a comma after 6 or more characters', () => {
      const seg = new SpeechSegmenter({ firstSpeechCommaMinChars: 5 })
      const events = seg.push('こんにちは、マスター。')
      expect(speechTexts(events)).toEqual(['こんにちは、', 'マスター。'])
    })

    it('does not split the first utterance at a comma that comes too early', () => {
      const seg = new SpeechSegmenter({ firstSpeechCommaMinChars: 5 })
      const events = seg.push('はい、承知しました。')
      expect(speechTexts(events)).toEqual(['はい、承知しました。'])
    })

    it('from the second utterance on, does not split at a comma before 10 characters', () => {
      const seg = new SpeechSegmenter({ firstSpeechCommaMinChars: 5 })
      const events = seg.push('最初です。こんにちは、マスター。')
      expect(speechTexts(events)).toEqual(['最初です。', 'こんにちは、マスター。'])
    })

    it('speaks an early-confirmed comma break only once even when it spans chunks', () => {
      const seg = new SpeechSegmenter({ firstSpeechCommaMinChars: 5 })
      const events = pushAll(seg, ['こんに', 'ちは、', 'マスター。'])
      expect(speechTexts(events)).toEqual(['こんにちは、', 'マスター。'])
    })

    it('keeps the 10-character threshold when no option is given', () => {
      const seg = new SpeechSegmenter()
      const events = seg.push('こんにちは、マスター。')
      expect(speechTexts(events)).toEqual(['こんにちは、マスター。'])
    })

    it('flush confirms an unfinished remainder as an utterance', () => {
      const seg = new SpeechSegmenter()
      const pushed = seg.push('句点のないテキスト')
      expect(speeches(pushed)).toHaveLength(0)
      const flushed = seg.flush()
      expect(speechTexts(flushed)).toEqual(['句点のないテキスト'])
    })

    it('does not split at a decimal point on a chunk boundary', () => {
      const seg = new SpeechSegmenter()
      const events = [
        ...pushAll(seg, [
          '価格も、外部サービスの利用が1分0.',
          '10から0.',
          '37ドル、自前構成の計算費用が0.',
          '06から0.',
          '12ドルという記事上の目安があります。',
        ]),
        ...seg.flush(),
      ]
      const spoken = speechTexts(events)

      expect(spoken.join('')).toBe(
        '価格も、外部サービスの利用が1分0.10から0.37ドル、自前構成の計算費用が0.06から0.12ドルという記事上の目安があります。'
      )
      expect(spoken.some((text) => /\d\.$/.test(text))).toBe(false)
    })

    it('does not split at a thousands separator on a chunk boundary', () => {
      const seg = new SpeechSegmenter()
      const events = [
        ...pushAll(seg, ['動画の累計再生回数は5,', '200万回でした。']),
        ...seg.flush(),
      ]
      const spoken = speechTexts(events)

      expect(spoken.join('')).toBe('動画の累計再生回数は5,200万回でした。')
      expect(spoken).not.toContain('動画の累計再生回数は5,')
    })
  })

  describe('emotion and motion tags', () => {
    it('extracts an emotion tag and attaches it to the speech event', () => {
      const seg = new SpeechSegmenter()
      const events = seg.push('[happy]やったね。')
      const s = speeches(events)[0]
      expect(s?.text).toBe('やったね。')
      expect(s?.emotionTag).toBe('[happy]')
    })

    it('joins and extracts a tag that spans chunks', () => {
      const seg = new SpeechSegmenter()
      const events = pushAll(seg, ['[hap', 'py]やあ。'])
      const s = speeches(events)[0]
      expect(s?.emotionTag).toBe('[happy]')
      expect(s?.text).toBe('やあ。')
    })

    it('extracts a motion tag and attaches it to the speech event', () => {
      const seg = new SpeechSegmenter()
      const events = seg.push('[happy][motion:cheer]やったー！')
      const s = speeches(events)[0]
      expect(s?.emotionTag).toBe('[happy]')
      expect(s?.motionTag).toBe('cheer')
    })

    it('a tag carries over to later sentences on the same line', () => {
      const seg = new SpeechSegmenter()
      const events = seg.push('[happy]一文目。二文目。')
      const all = speeches(events)
      expect(all).toHaveLength(2)
      expect(all[1]?.emotionTag).toBe('[happy]')
    })

    it('only the sentence with an explicit tag has emotionTagExplicit true', () => {
      const seg = new SpeechSegmenter()
      const events = seg.push('[happy]一文目。二文目。[sad]三文目。')
      const all = speeches(events)
      expect(all.map((e) => e.emotionTagExplicit)).toEqual([true, false, true])
    })

    it('crossing a newline resets the tag carry-over', () => {
      const seg = new SpeechSegmenter()
      const events = [...seg.push('[happy]一文目。\n二文目。'), ...seg.flush()]
      const all = speeches(events)
      expect(all).toHaveLength(2)
      expect(all[0]?.emotionTag).toBe('[happy]')
      expect(all[1]?.emotionTag).toBe('')
    })

    it('a new tag overrides the carried-over one', () => {
      const seg = new SpeechSegmenter()
      const events = seg.push('[happy]嬉しい。[sad]悲しい。')
      const all = speeches(events)
      expect(all[0]?.emotionTag).toBe('[happy]')
      expect(all[1]?.emotionTag).toBe('[sad]')
    })

    it('tags stay in the display events (as in the legacy app)', () => {
      const seg = new SpeechSegmenter()
      const events = seg.push('[happy]やったね。')
      expect(displays(events)).toBe('[happy]やったね。')
    })
  })

  describe('code blocks', () => {
    it('separates a code block as a code event', () => {
      const seg = new SpeechSegmenter()
      const events = seg.push('コードです。\n```js\nconst a = 1\n```以上です。')
      const c = codes(events)
      expect(c).toHaveLength(1)
      expect(c[0]?.content).toBe('const a = 1\n')
      expect(displays(events)).toBe('コードです。\n以上です。')
      expect(speechTexts(events)).toEqual(['コードです。', '以上です。'])
    })

    it('detects a ``` split across chunks (legacy defect D5)', () => {
      const seg = new SpeechSegmenter()
      const events = [
        ...pushAll(seg, ['コード。\n``', '`js\nconst a', ' = 1\n``', '`後続。']),
        ...seg.flush(),
      ]
      const c = codes(events)
      expect(c).toHaveLength(1)
      expect(c[0]?.content).toBe('const a = 1\n')
      expect(displays(events)).toBe('コード。\n後続。')
    })

    it('an unfinished sentence right before a code block is confirmed as speech (legacy defect D2)', () => {
      const seg = new SpeechSegmenter()
      const events = pushAll(seg, ['未完の文``', '`\ncode\n```'])
      expect(speechTexts(events)).toEqual(['未完の文'])
      const c = codes(events)
      expect(c[0]?.content).toBe('code\n')
    })

    it('removes the language line even when it spans chunks (legacy defect C9)', () => {
      const seg = new SpeechSegmenter()
      const events = pushAll(seg, ['```j', 's\nabc\n```'])
      const c = codes(events)
      expect(c[0]?.content).toBe('abc\n')
    })

    it('an unclosed code block is confirmed as a code event by flush (legacy defect D6)', () => {
      const seg = new SpeechSegmenter()
      const pushed = seg.push('テキスト。```\nabc')
      const flushed = seg.flush()
      const c = codes([...pushed, ...flushed])
      expect(c).toHaveLength(1)
      expect(c[0]?.content).toBe('abc')
    })

    it('a response that starts with ``` is separated as code too (legacy defect C8)', () => {
      const seg = new SpeechSegmenter()
      const events = seg.push('```\nonly code\n```')
      expect(codes(events)).toHaveLength(1)
      expect(displays(events)).toBe('')
    })

    it('an empty code block emits no code event', () => {
      const seg = new SpeechSegmenter()
      const events = [...seg.push('```\n```あと。'), ...seg.flush()]
      expect(codes(events)).toHaveLength(0)
      expect(speechTexts(events)).toEqual(['あと。'])
    })

    it('a code-block boundary resets the tag carry-over', () => {
      const seg = new SpeechSegmenter()
      const events = [...seg.push('[happy]コード。\n```\nabc\n```続き。'), ...seg.flush()]
      const all = speeches(events)
      expect(all[0]?.emotionTag).toBe('[happy]')
      const last = all[all.length - 1]
      expect(last?.text).toBe('続き。')
      expect(last?.emotionTag).toBe('')
    })
  })

  describe('display cursor', () => {
    it('holds a trailing backtick fragment back from display until the next chunk', () => {
      const seg = new SpeechSegmenter()
      const first = seg.push('インライン`')
      expect(displays(first)).toBe('インライン')
      const second = seg.push('code`です。')
      expect(displays(second)).toBe('`code`です。')
    })

    it('flush confirms a held-back backtick as display and speech', () => {
      const seg = new SpeechSegmenter()
      const pushed = seg.push('記号``')
      const flushed = seg.flush()
      expect(displays([...pushed, ...flushed])).toBe('記号``')
    })

    it('flush does not emit already displayed text twice', () => {
      const seg = new SpeechSegmenter()
      const pushed = seg.push('未確定のテキスト')
      expect(displays(pushed)).toBe('未確定のテキスト')
      const flushed = seg.flush()
      expect(flushed.filter((e) => e.kind === 'display')).toHaveLength(0)
    })

    it('the display events add up to the full text minus the code content', () => {
      const seg = new SpeechSegmenter()
      const events = [...pushAll(seg, ['前半。', '```\ncode\n``', '`後半。']), ...seg.flush()]
      expect(displays(events)).toBe('前半。後半。')
    })
  })
})

// ── New cases ────────────────────────────────────────────────────────────────

describe('SpeechSegmenter, port-specific behaviour', () => {
  it('exposes the two thresholds as constants', () => {
    expect(DEFAULT_COMMA_MIN_CHARS).toBe(10)
    expect(SHORT_FIRST_COMMA_MIN_CHARS).toBe(5)
  })

  it('the short first threshold gives the early comma break', () => {
    const seg = new SpeechSegmenter({ firstSpeechCommaMinChars: SHORT_FIRST_COMMA_MIN_CHARS })
    expect(speechTexts(seg.push('こんにちは、マスター。'))).toEqual(['こんにちは、', 'マスター。'])
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'a non-finite firstSpeechCommaMinChars (%s) falls back to the default',
    (value) => {
      const seg = new SpeechSegmenter({ firstSpeechCommaMinChars: value })
      expect(speechTexts(seg.push('こんにちは、マスター。'))).toEqual(['こんにちは、マスター。'])
    }
  )

  it('a null or undefined firstSpeechCommaMinChars means the default', () => {
    const viaUndefined = new SpeechSegmenter({ firstSpeechCommaMinChars: undefined })
    const viaNull = new SpeechSegmenter({
      firstSpeechCommaMinChars: null as unknown as number,
    })
    for (const seg of [viaUndefined, viaNull]) {
      expect(speechTexts(seg.push('こんにちは、マスター。'))).toEqual(['こんにちは、マスター。'])
    }
  })

  it('getFirstSpeechCommaMinChars works with any iterable and an empty table', () => {
    expect(getFirstSpeechCommaMinChars('x', new Set(['x']))).toBe(SHORT_FIRST_COMMA_MIN_CHARS)
    expect(getFirstSpeechCommaMinChars('x', [])).toBe(DEFAULT_COMMA_MIN_CHARS)
  })

  it('a motion tag carries over like an emotion tag and ends at a newline', () => {
    const seg = new SpeechSegmenter()
    const events = [...seg.push('[motion:cheer]一文目。二文目。\n三文目。'), ...seg.flush()]
    expect(speechTexts(events)).toEqual(['一文目。', '二文目。', '三文目。'])
    expect(speeches(events).map((e) => e.motionTag)).toEqual(['cheer', 'cheer', undefined])
  })

  it('a second flush has nothing left to emit', () => {
    const seg = new SpeechSegmenter()
    seg.push('未確定のテキスト')
    expect(speechTexts(seg.flush())).toEqual(['未確定のテキスト'])
    expect(seg.flush()).toEqual([])
  })

  it('an empty chunk changes nothing', () => {
    const seg = new SpeechSegmenter()
    expect(seg.push('')).toEqual([])
    expect(speechTexts(pushAll(seg, ['', 'やあ。', '']))).toEqual(['やあ。'])
  })
})

// The port keeps the legacy state machine as it is, including these three quirks. They are pinned
// so that fixing them later is a conscious change (a fix would also let the stream test's split
// property cover newline and space after a sentence end).
describe('SpeechSegmenter, known legacy chunking quirks', () => {
  it('a chunk that opens with a newline right after a finished sentence holds back later text until flush', () => {
    const chunks = ['一文目。', '\n\n', '二文目。', '三文目。']

    const oneChunk = new SpeechSegmenter()
    const together = [...oneChunk.push(chunks.join('')), ...oneChunk.flush()]
    expect(speechTexts(together)).toEqual(['一文目。', '二文目。', '三文目。'])

    const streamed = new SpeechSegmenter()
    const events = pushAll(streamed, chunks)
    expect(speechTexts(events)).toEqual(['一文目。'])
    expect(speechTexts(streamed.flush())).toEqual(['\n\n二文目。三文目。'])
  })

  it('the newline stall does not happen when a tag follows it or the newline is glued to the sentence end', () => {
    for (const chunks of [
      ['一文目。', '\n\n', '[happy]二文目。', '三文目。'],
      ['一文目。\n\n', '二文目。', '三文目。'],
    ]) {
      const seg = new SpeechSegmenter()
      // Everything is spoken before flush(): nothing is held back.
      expect(speechTexts(pushAll(seg, chunks))).toEqual(['一文目。', '二文目。', '三文目。'])
      expect(seg.flush()).toEqual([])
    }
  })

  it('a newline that arrives alone before a code fence becomes a whitespace-only speech event', () => {
    const fenced = '```js\nconst a = 1\n```続き。'
    const nonDisplay = (events: SegmenterEvent[]) =>
      events.flatMap((e) =>
        e.kind === 'speech' ? [`speech:${e.text}`] : e.kind === 'code' ? [`code:${e.content}`] : []
      )

    const together = new SpeechSegmenter()
    expect(nonDisplay([...together.push(`説明です。\n${fenced}`), ...together.flush()])).toEqual([
      'speech:説明です。',
      'code:const a = 1\n',
      'speech:続き。',
    ])

    const split = new SpeechSegmenter()
    const events = [...pushAll(split, ['説明です。', `\n${fenced}`]), ...split.flush()]
    expect(nonDisplay(events)).toEqual([
      'speech:説明です。',
      'speech:\n',
      'code:const a = 1\n',
      'speech:続き。',
    ])
    // Downstream, the speakable-text check drops the whitespace-only event.
    expect(isSpeakableText('\n')).toBe(false)
  })

  it('a space that opens a chunk right after a finished sentence stays in the next sentence (cosmetic)', () => {
    const together = new SpeechSegmenter()
    expect(speechTexts([...together.push('One. Two.'), ...together.flush()])).toEqual([
      'One.',
      'Two.',
    ])

    const split = new SpeechSegmenter()
    expect(speechTexts([...pushAll(split, ['One.', ' Two.']), ...split.flush()])).toEqual([
      'One.',
      ' Two.',
    ])
  })
})

// ── Links and email addresses stay whole (new in this port) ──────────────────

describe('a full stop inside a link or an email address is not the end of a sentence', () => {
  const run = (chunks: string[]) => {
    const seg = new SpeechSegmenter()
    return speechTexts([...pushAll(seg, chunks), ...seg.flush()])
  }

  it('a link with a scheme, in one piece or across chunks, is one piece of one sentence', () => {
    expect(run(['See https://example.com/a/b?c=1 for more.'])).toEqual([
      'See https://example.com/a/b?c=1 for more.',
    ])
    expect(run(['See https://exam', 'ple.', 'com/x', ' for more.'])).toEqual([
      'See https://example.com/x for more.',
    ])
  })

  it('a link starting with www, and an email address', () => {
    expect(run(['Try www.example.co.uk/page today.'])).toEqual([
      'Try www.example.co.uk/page today.',
    ])
    expect(run(['Write to first.last@mail.example.org please.'])).toEqual([
      'Write to first.last@mail.example.org please.',
    ])
  })

  it('a stop right after the link, followed by a space, still ends the sentence', () => {
    expect(run(['Look at https://example.com/x. Then more words.'])).toEqual([
      'Look at https://example.com/x.',
      'Then more words.',
    ])
  })

  it('a stop that ends a chunk right after a link waits for the next character before it decides', () => {
    const seg = new SpeechSegmenter()
    expect(speechTexts(seg.push('Look at https://example.com/x.'))).toEqual([])
    expect(speechTexts(seg.push(' And then words.'))).toEqual([
      'Look at https://example.com/x.',
      'And then words.',
    ])
    // and the link may just as well go on
    const more = new SpeechSegmenter()
    expect(speechTexts(more.push('Look at https://example.com/x.'))).toEqual([])
    expect(speechTexts([...more.push('html and more.'), ...more.flush()])).toEqual([
      'Look at https://example.com/x.html and more.',
    ])
  })

  it('a question mark, an exclamation mark or a comma inside a link does not end it either', () => {
    // the comma after the link is a comma like any other; the marks inside the link are not
    expect(run(['Open https://example.com/a?b=1&c=2, then the rest.'])).toEqual([
      'Open https://example.com/a?b=1&c=2,',
      'then the rest.',
    ])
    expect(run(['Did you see https://example.com/x? It was fun.'])).toEqual([
      'Did you see https://example.com/x?',
      'It was fun.',
    ])
  })

  it('ordinary text with dots is cut as before', () => {
    expect(run(['Hello there. This is a test. Version 3.14 is out.'])).toEqual([
      'Hello there.',
      'This is a test.',
      'Version 3.14 is out.',
    ])
  })
})
