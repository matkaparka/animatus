/**
 * The last check before a sentence is spoken and shown (the "safety observer").
 *
 * The persona already tells the character not to read out links, numbers or personal details, and the sensitive-word
 * list covers what the streamer named. This catches what slips past both, by shape: it does not know what is
 * sensitive, only what is not meant to be read aloud on a stream.
 *
 *  - Personal details and secrets are replaced by the same bleep the word list uses: a link, an email address, a long
 *    run of digits (a phone number, an ID, a QQ number), a file path, and anything that has the shape of an API key.
 *  - A model that has got stuck and says the same sentence again and again is not spoken past the second time.
 *
 * It never sees why a sentence was written and does not care: whatever the source, the same rules apply. It reports
 * what class of thing it replaced, never the thing.
 */

export type SafetyClass = 'link' | 'email' | 'secret' | 'path' | 'number'

export type SafetyEvent =
  { kind: 'replaced'; classes: SafetyClass[] } | { kind: 'loop_start' } | { kind: 'loop_end' }

export interface SafetyOptions {
  /** Replace personal details and secrets. Default true. */
  personalInfo?: boolean
  /** Do not speak a sentence again and again. Default true. */
  repetition?: boolean
  /** What stands in for a replaced piece. Default `哔`, the bleep the word list uses. */
  replacement?: string
  onEvent?: (e: SafetyEvent) => void
}

const CLASSES: readonly { name: SafetyClass; re: RegExp }[] = [
  // a scheme or a `www.` start, up to a space or the punctuation that ends a sentence in Chinese or English
  { name: 'link', re: /(?:https?:\/\/|www\.)[^\s，。！？、；：）)】》"'<>]+/gi },
  { name: 'email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  {
    name: 'secret',
    re: /\b(?:[spr]k-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|[A-Za-z0-9_-]{32,})\b/g,
  },
  {
    name: 'path',
    re: /\b[A-Za-z]:[\\/][^\s，。！？、；：）)】》"'<>]+|(?<![\w/])\/(?:home|Users|etc|var|usr|mnt)\/[^\s，。！？、；：）)】》"'<>]+/g,
  },
  // nine digits or more, with a single space or hyphen allowed between them: a phone number, an ID; a date has eight
  { name: 'number', re: /\d(?:[ -]?\d){8,}/g },
]

const LOOP_WINDOW = 8
const LOOP_LIMIT = 2
const LOOP_MIN_CHARS = 6

/** The words of a sentence for comparing: no punctuation, spacing or case. */
const normalise = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

export class SafetyObserver {
  private readonly personalInfo: boolean
  private readonly repetition: boolean
  private readonly replacement: string
  private readonly onEvent: (e: SafetyEvent) => void
  private readonly recent: string[] = []
  private looping = false

  constructor(opts: SafetyOptions = {}) {
    this.personalInfo = opts.personalInfo ?? true
    this.repetition = opts.repetition ?? true
    this.replacement = opts.replacement ?? '哔'
    this.onEvent = opts.onEvent ?? (() => {})
  }

  /**
   * The text with what must not be read out replaced. Stateless; used for the voice and, with `report` off, for the
   * words on screen (the same sentence is reported once).
   */
  sanitize(text: string, report = true): string {
    if (!this.personalInfo) return text
    let out = text
    const found = new Set<SafetyClass>()
    for (const c of CLASSES) {
      out = out.replace(c.re, () => {
        found.add(c.name)
        return this.replacement
      })
    }
    if (report && found.size > 0) this.onEvent({ kind: 'replaced', classes: [...found] })
    return out
  }

  /**
   * Whether the sentence may be spoken: false for the third time within the last few sentences that the same words come.
   * Call once per sentence, with the text that will be spoken.
   */
  admit(text: string): boolean {
    if (!this.repetition) return true
    const key = normalise(text)
    if (key.length < LOOP_MIN_CHARS) return true
    const same = this.recent.filter((r) => r === key).length
    this.recent.push(key)
    if (this.recent.length > LOOP_WINDOW) this.recent.shift()
    if (same >= LOOP_LIMIT) {
      if (!this.looping) {
        this.looping = true
        this.onEvent({ kind: 'loop_start' })
      }
      return false
    }
    if (this.looping) {
      this.looping = false
      this.onEvent({ kind: 'loop_end' })
    }
    return true
  }
}
