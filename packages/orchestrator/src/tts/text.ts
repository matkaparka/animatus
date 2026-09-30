/**
 * Text preparation before speech synthesis: what may be read aloud and what must not.
 * The legacy speech bridge did the cleaning inside the TTS server; the sensitive-word filter lived in the
 * browser. Both are the orchestrator's job now, in one place, before any adapter sees the text.
 */

/** Leftover emotion tags such as `[happy]` (tags are normally consumed earlier by the segmenter). */
const LEFTOVER_TAG = /\[[A-Za-z_]+\]/g
const MARKDOWN = new Set('*#`~_|')
/** Symbols/emoji (So), format characters such as zero-width joiners (Cf), surrogates (Cs), private use (Co). */
const UNSPEAKABLE = /^[\p{So}\p{Cf}\p{Cs}\p{Co}]$/u

/**
 * Remove what a voice must not try to pronounce: leftover tags, emoji and other symbols, zero-width and
 * other format characters, private-use characters, variation selectors, Markdown punctuation.
 * Collapses whitespace.
 */
export function cleanSpeechText(text: string): string {
  const withoutTags = text.replace(LEFTOVER_TAG, '')
  let out = ''
  for (const ch of withoutTags) {
    if (MARKDOWN.has(ch) || ch === '︎' || ch === '️' || UNSPEAKABLE.test(ch)) continue
    out += ch
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** True when the text contains at least one letter or number, i.e. there is something to say. */
export function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

/**
 * Replaces listed words with a short bleep-like token before synthesis. The list is data (a file the
 * operator maintains); the repository ships none.
 */
export class SpeechFilter {
  private re: RegExp | null = null
  private test: RegExp | null = null
  /** Called with the matched word for each replacement (for the run log). */
  onReplace?: (word: string) => void

  constructor(
    words: readonly string[] = [],
    private readonly replacement = '哔'
  ) {
    this.setWords(words)
  }

  setWords(words: readonly string[]): void {
    const cleaned = words.map((w) => w.trim()).filter(Boolean)
    const source = cleaned.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    this.re = cleaned.length ? new RegExp(source, 'gi') : null
    this.test = cleaned.length ? new RegExp(source, 'i') : null
  }

  /** True when the text has a word of the list in it (nothing is replaced, nothing is reported). */
  contains(text: string): boolean {
    return this.test ? this.test.test(text) : false
  }

  get size(): number {
    return this.re ? this.re.source.split('|').length : 0
  }

  apply(text: string): string {
    if (!this.re) return text
    return text.replace(this.re, (m) => {
      this.onReplace?.(m)
      return this.replacement
    })
  }

  /** Parse a word list file's text: one word per line or comma separated; `#` starts a comment line. */
  static parseList(content: string): string[] {
    return content
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('#'))
      .flatMap((l) => l.split(/[,，]/))
      .map((w) => w.trim())
      .filter(Boolean)
  }
}
