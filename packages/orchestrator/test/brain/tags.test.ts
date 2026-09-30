// Derived from AITuberKit (https://github.com/tegnike/aituber-kit), used under its Non-Commercial Use License; see licenses/AITuberKit-LICENSE.txt.
// Changed: the legacy tag-extractor and splitSentence test cases are ported with their inputs and expectations unchanged (names translated to English); new cases cover parseEmotion and parseMotionTag.

import { EMOTIONS } from '@animatus/protocol'
import { describe, expect, it } from 'vitest'
import {
  extractEmotion,
  extractMotionTag,
  extractSentence,
  isSpeakableText,
  parseEmotion,
  parseMotionTag,
  splitSentence,
} from '../../src/brain/tags.ts'

// ── Legacy cases (ported) ────────────────────────────────────────────────────

describe('tag extractors (legacy behaviour pinned)', () => {
  describe('extractEmotion', () => {
    it('extracts a leading emotion tag', () => {
      expect(extractEmotion('[happy]こんにちは')).toEqual({
        emotionTag: '[happy]',
        remainingText: 'こんにちは',
      })
    })

    it('finds the tag after leading whitespace', () => {
      expect(extractEmotion('  [sad] つらい')).toEqual({
        emotionTag: '[sad]',
        remainingText: 'つらい',
      })
    })

    it('does not treat a motion tag as an emotion tag', () => {
      expect(extractEmotion('[motion:think]うーん')).toEqual({
        emotionTag: '',
        remainingText: '[motion:think]うーん',
      })
    })

    it('returns the input unchanged when there is no tag', () => {
      expect(extractEmotion('タグなし')).toEqual({
        emotionTag: '',
        remainingText: 'タグなし',
      })
    })
  })

  describe('extractMotionTag', () => {
    it('extracts a leading motion tag', () => {
      expect(extractMotionTag('[motion:cheer]やった')).toEqual({
        motionTag: 'cheer',
        remainingText: 'やった',
      })
    })

    it('is case-insensitive', () => {
      expect(extractMotionTag('[Motion:think]うーん').motionTag).toBe('think')
    })

    it('ignores tags that are not motion tags', () => {
      expect(extractMotionTag('[happy]うれしい')).toEqual({
        motionTag: '',
        remainingText: '[happy]うれしい',
      })
    })
  })

  describe('extractSentence', () => {
    it('extracts up to the full stop as a sentence', () => {
      expect(extractSentence('こんにちは。続き')).toEqual({
        sentence: 'こんにちは。',
        remainingText: '続き',
      })
    })

    it('also breaks at a comma once there are 10 or more characters', () => {
      const { sentence } = extractSentence('これは十文字以上あるテキスト、続きです')
      expect(sentence).toBe('これは十文字以上あるテキスト、')
    })

    it('does not break at a comma within the first 9 characters', () => {
      expect(extractSentence('短い、文').sentence).toBe('')
    })

    it('breaks the sentence right before a tag', () => {
      expect(extractSentence('文のあと[happy]続き').sentence).toBe('文のあと')
    })

    it('does not treat a decimal point as a sentence end', () => {
      expect(extractSentence('価格は1分0.10から0.37ドル。')).toEqual({
        sentence: '価格は1分0.10から0.37ドル。',
        remainingText: '',
      })
    })

    it('holds back a period after a digit at the end of the text until more text arrives', () => {
      expect(extractSentence('価格は1分0.')).toEqual({
        sentence: '',
        remainingText: '価格は1分0.',
      })
    })

    it('does not treat a thousands separator as a break', () => {
      expect(extractSentence('再生回数は5,200万回です。')).toEqual({
        sentence: '再生回数は5,200万回です。',
        remainingText: '',
      })
    })

    it('holds back a comma after a digit at the end of the text until more text arrives', () => {
      expect(extractSentence('累計再生回数は5,')).toEqual({
        sentence: '',
        remainingText: '累計再生回数は5,',
      })
    })

    it('returns an empty sentence when there is no break', () => {
      expect(extractSentence('区切りなし')).toEqual({
        sentence: '',
        remainingText: '区切りなし',
      })
    })
  })

  describe('isSpeakableText', () => {
    it('is true for ordinary text', () => {
      expect(isSpeakableText('こんにちは')).toBe(true)
    })

    it('is false for the empty string', () => {
      expect(isSpeakableText('')).toBe(false)
    })

    it('is false for symbols and whitespace only', () => {
      expect(isSpeakableText('、。！？')).toBe(false)
      expect(isSpeakableText('   \n\t')).toBe(false)
      expect(isSpeakableText('（）「」')).toBe(false)
    })

    it('is true for text between symbols', () => {
      expect(isSpeakableText('「こんにちは」')).toBe(true)
    })
  })
})

describe('splitSentence', () => {
  it('should split on Japanese period (。)', () => {
    expect(splitSentence('こんにちは。元気ですか。')).toEqual(['こんにちは。', '元気ですか。'])
  })

  it('should split on fullwidth period (．)', () => {
    expect(splitSentence('テスト．OK．')).toEqual(['テスト．', 'OK．'])
  })

  it('should split on fullwidth exclamation (！)', () => {
    expect(splitSentence('すごい！やった！')).toEqual(['すごい！', 'やった！'])
  })

  it('should split on fullwidth question mark (？)', () => {
    expect(splitSentence('本当？なぜ？')).toEqual(['本当？', 'なぜ？'])
  })

  it('should split on newlines', () => {
    expect(splitSentence('line1\nline2\nline3')).toEqual(['line1\n', 'line2\n', 'line3'])
  })

  it('should filter out empty strings', () => {
    expect(splitSentence('')).toEqual([])
  })

  it('should return single element for text without split points', () => {
    expect(splitSentence('hello world')).toEqual(['hello world'])
  })

  it('should handle mixed punctuation', () => {
    const result = splitSentence('こんにちは。元気？はい！')
    expect(result).toEqual(['こんにちは。', '元気？', 'はい！'])
  })

  it('should keep punctuation at end of each segment', () => {
    const result = splitSentence('A。B。')
    result.forEach((segment, i) => {
      if (i < result.length - 1 || segment.endsWith('。')) {
        expect(segment).toMatch(/[。．！？\n]$/)
      }
    })
  })
})

// ── New cases ────────────────────────────────────────────────────────────────

describe('extractors, edge cases beyond the legacy tests', () => {
  it('clamps the comma threshold to at least 2 characters', () => {
    expect(extractSentence('あい、う', { commaMinChars: 0 }).sentence).toBe('あい、')
    expect(extractSentence('あい、う', { commaMinChars: 1.9 }).sentence).toBe('あい、')
    expect(extractSentence('あ、いう', { commaMinChars: 1 }).sentence).toBe('')
  })

  it('a lower first-sentence threshold breaks at an earlier comma', () => {
    expect(extractSentence('こんにちは、マスター。', { commaMinChars: 5 }).sentence).toBe(
      'こんにちは、'
    )
    expect(extractSentence('こんにちは、マスター。').sentence).toBe('こんにちは、マスター。')
  })

  it('keeps a dance tag name intact', () => {
    expect(extractMotionTag('[motion:dance:waltz]どうぞ')).toEqual({
      motionTag: 'dance:waltz',
      remainingText: 'どうぞ',
    })
  })

  it('does not match a motion tag that contains whitespace', () => {
    expect(extractMotionTag('[motion:a b]x')).toEqual({
      motionTag: '',
      remainingText: '[motion:a b]x',
    })
  })

  it('reports an unknown bracketed word as an emotion tag (the caller decides what it means)', () => {
    expect(extractEmotion('[scene]森')).toEqual({ emotionTag: '[scene]', remainingText: '森' })
  })
})

describe('parseEmotion', () => {
  it('maps [Happy] to happy', () => {
    expect(parseEmotion('[Happy]')).toBe('happy')
  })

  it.each(EMOTIONS)('maps [%s] to itself', (name) => {
    expect(parseEmotion(`[${name}]`)).toBe(name)
  })

  it('ignores case and spaces inside the brackets', () => {
    expect(parseEmotion('[HAPPY]')).toBe('happy')
    expect(parseEmotion('[ Sad ]')).toBe('sad')
    expect(parseEmotion('  [relaxed]  ')).toBe('relaxed')
  })

  it('accepts a bare emotion name', () => {
    expect(parseEmotion('surprised')).toBe('surprised')
  })

  it.each([
    '',
    '   ',
    '[]',
    '[ ]',
    '[whisper]',
    '[scene]',
    '[motion:cheer]',
    '[happy',
    'happy]x',
    '[[happy]]',
    'joy',
  ])('maps %j to neutral', (tag) => {
    expect(parseEmotion(tag)).toBe('neutral')
  })

  it('agrees with extractEmotion on model output', () => {
    expect(parseEmotion(extractEmotion('[Sad] つらい').emotionTag)).toBe('sad')
    expect(parseEmotion(extractEmotion('タグなし').emotionTag)).toBe('neutral')
  })
})

describe('parseMotionTag', () => {
  it('returns null for a missing or empty tag', () => {
    expect(parseMotionTag(undefined)).toBeNull()
    expect(parseMotionTag('')).toBeNull()
    expect(parseMotionTag('   ')).toBeNull()
  })

  it('classifies an ordinary tag as a clip, lower-cased and trimmed', () => {
    expect(parseMotionTag('nod')).toEqual({ kind: 'clip', tag: 'nod' })
    expect(parseMotionTag('  Nod ')).toEqual({ kind: 'clip', tag: 'nod' })
    expect(parseMotionTag('SPREAD_ARMS')).toEqual({ kind: 'clip', tag: 'spread_arms' })
  })

  it('classifies dance as a dance request without a name', () => {
    expect(parseMotionTag('dance')).toStrictEqual({ kind: 'dance' })
    expect(parseMotionTag(' Dance ')).toStrictEqual({ kind: 'dance' })
  })

  it('classifies dance:<name> as a dance request with the (lower-cased) name', () => {
    expect(parseMotionTag('dance:waltz')).toEqual({ kind: 'dance', name: 'waltz' })
    expect(parseMotionTag('DANCE:Foo-Bar_1')).toEqual({ kind: 'dance', name: 'foo-bar_1' })
  })

  it.each([
    'dance:',
    'dance:a b',
    'dance:foo:bar',
    'dance:舞',
    'dancer',
    'dance2',
    'dance-x',
    'a dance',
  ])('treats %j as a clip, not a dance request', (tag) => {
    expect(parseMotionTag(tag)).toEqual({ kind: 'clip', tag: tag.trim().toLowerCase() })
  })

  it('agrees with extractMotionTag on model output', () => {
    expect(parseMotionTag(extractMotionTag('[motion:Dance:Waltz]どうぞ').motionTag)).toEqual({
      kind: 'dance',
      name: 'waltz',
    })
    expect(parseMotionTag(extractMotionTag('[motion:cheer]やった').motionTag)).toEqual({
      kind: 'clip',
      tag: 'cheer',
    })
    expect(parseMotionTag(extractMotionTag('[happy]うれしい').motionTag)).toBeNull()
  })
})
