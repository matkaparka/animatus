import { describe, expect, it } from 'vitest'
import { SpeechFilter, cleanSpeechText, isSpeakable } from '../../src/tts/text.ts'

describe('cleanSpeechText', () => {
  it('removes leftover tags, emoji, format characters and Markdown punctuation', () => {
    expect(cleanSpeechText('[happy] Hello *world*!')).toBe('Hello world!')
    expect(cleanSpeechText('好的😀，收到🎉')).toBe('好的，收到')
    expect(cleanSpeechText('a​b‍c')).toBe('abc')
    expect(cleanSpeechText('# title `code` ~x~ a_b | c')).toBe('title code x ab c')
    expect(cleanSpeechText('ok️')).toBe('ok')
  })

  it('collapses whitespace and trims', () => {
    expect(cleanSpeechText('  a \n\t b   c  ')).toBe('a b c')
  })

  it('keeps ordinary punctuation, digits and CJK', () => {
    expect(cleanSpeechText('今天是2026年9月30日，天气不错。')).toBe(
      '今天是2026年9月30日，天气不错。'
    )
  })

  it('leaves bracketed text that is not a bare tag word', () => {
    expect(cleanSpeechText('(see [1])')).toBe('(see [1])')
  })
})

describe('isSpeakable', () => {
  it('needs at least one letter or number', () => {
    expect(isSpeakable('...!?')).toBe(false)
    expect(isSpeakable('')).toBe(false)
    expect(isSpeakable('  ')).toBe(false)
    expect(isSpeakable('。。a')).toBe(true)
    expect(isSpeakable('42')).toBe(true)
    expect(isSpeakable('好')).toBe(true)
  })
})

describe('SpeechFilter', () => {
  it('is a no-op with an empty list', () => {
    const f = new SpeechFilter([])
    expect(f.apply('anything')).toBe('anything')
    expect(f.size).toBe(0)
  })

  it('replaces listed words case-insensitively and reports each replacement', () => {
    const f = new SpeechFilter(['badword', 'Another.One'])
    const seen: string[] = []
    f.onReplace = (w) => seen.push(w)
    expect(f.apply('a BadWord and another.one, also AnotherXOne')).toBe(
      'a 哔 and 哔, also AnotherXOne'
    )
    expect(seen).toEqual(['BadWord', 'another.one'])
  })

  it('escapes regex metacharacters in words', () => {
    const f = new SpeechFilter(['a+b', '(x)'])
    expect(f.apply('a+b (x) aab')).toBe('哔 哔 aab')
  })

  it('setWords replaces the list; the replacement token is configurable', () => {
    const f = new SpeechFilter(['one'], '*')
    expect(f.apply('one two')).toBe('* two')
    f.setWords(['two'])
    expect(f.apply('one two')).toBe('one *')
  })

  it('parseList handles lines, commas, full-width commas, comments and blanks', () => {
    expect(SpeechFilter.parseList('# comment\nalpha, beta\n\ngamma，delta\n  # another\n')).toEqual(
      ['alpha', 'beta', 'gamma', 'delta']
    )
  })
})
