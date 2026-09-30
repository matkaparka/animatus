/**
 * Text helpers for viewer-supplied strings.
 *
 * They reproduce the legacy chat bridge's `clean`, `meaningful_chars` and `norm_key` together with the
 * two places where the original language differs from JavaScript in ways that change filtering
 * decisions: what counts as whitespace, and that string lengths and slices are counted in code points
 * (a JS `string.length` counts UTF-16 units, so an emoji would count twice and a slice could cut it in
 * half).
 */

/**
 * The whitespace set of Python's `str.isspace()`, which is what `\s` and `strip()` use there. JS `\s`
 * differs: it also matches U+FEFF and it lacks U+001C-U+001F and U+0085.
 */
export const PY_SPACE = String.raw`\t-\r\x1c-\x20\x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}`

const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, 'gu')
const EDGE_SPACE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu')

/** Trim the way Python's `str.strip()` does. */
export function pyStrip(s: string): string {
  return s.replace(EDGE_SPACE, '')
}

/**
 * Make viewer text safe to embed in a prompt line: the lenticular brackets that delimit the message
 * markers (`【SC ¥30】` and friends) become square brackets so a viewer cannot forge one, and every run of
 * whitespace (newlines included) collapses to one space so a viewer cannot start a line of their own.
 */
export function cleanViewerText(s: string): string {
  return pyStrip(s.replaceAll('【', '[').replaceAll('】', ']').replace(SPACE_RUN, ' '))
}

/** Emote codes such as `[dog]` or `[smile]`: a short bracketed run without nested brackets. */
const EMOTE_CODE = /\[[^[\]]{1,12}\]/gu
/** Anything that is not a letter or a number (emoji, symbols, punctuation, marks, format characters). */
const NOT_LETTER_OR_NUMBER = /[^\p{L}\p{N}]+/gu

/** What a viewer actually said: emote codes removed, only letters and numbers kept. */
export function meaningfulChars(s: string): string {
  return s.replace(EMOTE_CODE, '').replace(NOT_LETTER_OR_NUMBER, '')
}

/** Comparison key for "the same words": meaningful characters, lower-cased. */
export function normKey(s: string): string {
  return meaningfulChars(s).toLowerCase()
}

/** Length in code points, like Python's `len(str)`. */
export function codePointLength(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

/** Distinct code points, like Python's `len(set(s))`. */
export function distinctCodePoints(s: string): number {
  return new Set(s).size
}

/** Keep at most `max` code points; when something was cut, append `ellipsis`. */
export function truncateChars(text: string, max: number, ellipsis = '…'): string {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max).join('') + ellipsis : text
}

const DECIMAL_DIGIT = /^\p{Nd}$/u

/**
 * Value of a decimal digit from any script. Unicode encodes every `Nd` block as runs of ten in order 0-9,
 * so the value is the number of consecutive `Nd` code points before it, modulo ten.
 */
function decimalDigitValue(codePoint: number): number {
  let before = 0
  while (
    codePoint - 1 - before >= 0 &&
    DECIMAL_DIGIT.test(String.fromCodePoint(codePoint - 1 - before))
  ) {
    before++
  }
  return before % 10
}

/**
 * Parse a run of decimal digits of any script (full-width digits are common in Chinese chat), like
 * Python's `int()`. Saturates at `Number.MAX_SAFE_INTEGER`.
 */
export function parseDecimalDigits(s: string): number {
  let value = 0
  for (const ch of s) {
    value = value * 10 + decimalDigitValue(ch.codePointAt(0) ?? 0)
    if (value >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
  }
  return value
}
