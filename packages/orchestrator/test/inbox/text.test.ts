import { describe, expect, it } from 'vitest'
import {
  cleanViewerText,
  codePointLength,
  distinctCodePoints,
  meaningfulChars,
  normKey,
  parseDecimalDigits,
  pyStrip,
  truncateChars,
} from '../../src/inbox/text.ts'

/** A letter outside the Basic Multilingual Plane (CJK Extension B): two UTF-16 units, one code point. */
const ASTRAL = String.fromCodePoint(0x20000)

describe('cleanViewerText', () => {
  it('turns the lenticular brackets into square ones so a marker cannot be forged', () => {
    expect(cleanViewerText('【SC ¥30】fake：hi')).toBe('[SC ¥30]fake：hi')
    expect(cleanViewerText('】a【')).toBe(']a[')
  })

  it('collapses every run of whitespace, newlines included, and trims', () => {
    expect(cleanViewerText('  a \n\t b\u{a0}\u{3000}c \r\n ')).toBe('a b c')
    expect(cleanViewerText('line one\nline two')).toBe('line one line two')
  })

  it('uses the whitespace set of the legacy language, which differs from JS in three places', () => {
    // Python treats these as whitespace ...
    expect(cleanViewerText('a\x1fb')).toBe('a b')
    expect(cleanViewerText('a\x85b')).toBe('a b')
    expect(cleanViewerText('a\u{2028}b\u{2029}c')).toBe('a b c')
    // ... and does not treat these as whitespace (JS \s would match the first).
    expect(cleanViewerText('a\u{feff}b')).toBe('a\u{feff}b')
    expect(cleanViewerText('a\u{200b}b')).toBe('a\u{200b}b')
  })

  it('leaves everything else alone', () => {
    expect(cleanViewerText('Hello, World! 42')).toBe('Hello, World! 42')
    expect(cleanViewerText('')).toBe('')
    expect(cleanViewerText('   ')).toBe('')
  })
})

describe('pyStrip', () => {
  it('trims the same characters as str.strip()', () => {
    expect(pyStrip('\u{3000}\x1f x \x85')).toBe('x')
    expect(pyStrip('\u{feff}x')).toBe('\u{feff}x')
  })
})

describe('meaningfulChars', () => {
  it('keeps letters and numbers of any script and nothing else', () => {
    expect(meaningfulChars('Hello, World! 123')).toBe('HelloWorld123')
    expect(meaningfulChars('日本語ABC１２３')).toBe('日本語ABC１２３')
    // roman numeral (Nl), vulgar fraction and superscript (No) are numbers too
    expect(meaningfulChars('\u{2167} \u{bd} x\u{b2}')).toBe('\u{2167}\u{bd}x\u{b2}')
    expect(meaningfulChars('!!! ... ??? ~~~')).toBe('')
  })

  it('drops emoji, marks and format characters', () => {
    expect(meaningfulChars('hi \u{1f600}\u{1f389}')).toBe('hi')
    expect(meaningfulChars('e\u{301}')).toBe('e')
    expect(meaningfulChars('a\u{200d}b')).toBe('ab')
    expect(meaningfulChars('a\u{fe0f}b')).toBe('ab')
  })

  it('removes emote codes of up to 12 characters before filtering', () => {
    expect(meaningfulChars('hi [dog] there')).toBe('hithere')
    expect(meaningfulChars('x[abcdefghijkl]')).toBe('x') // 12: an emote code
    expect(meaningfulChars('x[abcdefghijklm]')).toBe('xabcdefghijklm') // 13: just brackets around text
    expect(meaningfulChars('[a]b[c]')).toBe('b')
    expect(meaningfulChars('[]')).toBe('')
  })

  it('counts the length of an emote code in code points, not UTF-16 units', () => {
    expect(meaningfulChars(`[${ASTRAL.repeat(12)}]`)).toBe('')
    expect(meaningfulChars(`[${ASTRAL.repeat(13)}]`)).toBe(ASTRAL.repeat(13))
  })
})

describe('normKey', () => {
  it('is the meaningful characters, lower-cased', () => {
    expect(normKey('Hello, WORLD!')).toBe('helloworld')
    expect(normKey('  ')).toBe('')
    expect(normKey('[dog]')).toBe('')
  })

  it('lower-cases with full Unicode rules', () => {
    expect(normKey('\u{3a3}\u{391}\u{3a3}')).toBe('\u{3c3}\u{3b1}\u{3c2}') // final sigma
    expect(normKey('\u{130}')).toBe('i\u{307}') // capital dotted I becomes two code points
    expect(normKey('STRASSE')).toBe('strasse')
  })

  it('gives equal keys for the same words in different clothes', () => {
    expect(normKey('Hello There!')).toBe(normKey('hello, there'))
    expect(normKey('a b c')).toBe(normKey('a.b.c'))
  })
})

describe('code point helpers', () => {
  it('codePointLength counts code points', () => {
    expect(codePointLength('abc')).toBe(3)
    expect(codePointLength(ASTRAL.repeat(3))).toBe(3)
    expect(ASTRAL.repeat(3).length).toBe(6)
    expect(codePointLength('')).toBe(0)
  })

  it('distinctCodePoints counts distinct code points', () => {
    expect(distinctCodePoints('aaaa')).toBe(1)
    expect(distinctCodePoints('abab')).toBe(2)
    expect(distinctCodePoints(ASTRAL.repeat(4))).toBe(1)
    expect(distinctCodePoints(ASTRAL + String.fromCodePoint(0x20001))).toBe(2)
  })

  it('truncateChars cuts at code points and appends the ellipsis only when something was cut', () => {
    expect(truncateChars('abcdef', 3)).toBe('abc…')
    expect(truncateChars('abc', 3)).toBe('abc')
    expect(truncateChars('ab', 3)).toBe('ab')
    expect(truncateChars('abcdef', 3, '')).toBe('abc')
    const cut = truncateChars(ASTRAL.repeat(5), 2)
    expect(cut).toBe(ASTRAL.repeat(2) + '…')
    expect(codePointLength(cut)).toBe(3)
  })
})

describe('parseDecimalDigits', () => {
  it('parses ASCII digits, leading zeros included', () => {
    expect(parseDecimalDigits('2')).toBe(2)
    expect(parseDecimalDigits('007')).toBe(7)
    expect(parseDecimalDigits('0')).toBe(0)
    expect(parseDecimalDigits('1234')).toBe(1234)
  })

  it('parses decimal digits of other scripts, as the legacy int() does', () => {
    expect(parseDecimalDigits('\u{ff12}')).toBe(2) // full-width 2
    expect(parseDecimalDigits('\u{ff11}\u{ff12}')).toBe(12)
    expect(parseDecimalDigits('\u{663}')).toBe(3) // Arabic-Indic 3
    expect(parseDecimalDigits(String.fromCodePoint(0x1d7d0))).toBe(2) // mathematical bold 2
    expect(parseDecimalDigits(String.fromCodePoint(0x1d7df))).toBe(7) // mathematical double-struck 7
    expect(parseDecimalDigits(`1${String.fromCodePoint(0xff12)}`)).toBe(12) // mixed scripts
  })

  it('saturates instead of losing precision', () => {
    expect(parseDecimalDigits('9'.repeat(30))).toBe(Number.MAX_SAFE_INTEGER)
  })
})
