/**
 * Layer 1 of the draw mode: the keyword blocklist that a viewer's request goes through before any model is asked.
 *
 * The inbox has a blocklist of its own (`inbox/blocklist.ts`) that does not fit here: it matches every word as a
 * substring, which is right for Chinese but makes an English list unusable (`sex` would hit "Essex", `bra` "brave").
 * These are the same rules as the image service's list (plugins/forge/forge_service/blocklist.py), and
 * `plugins/forge/blocklist_cases.json` pins both to the same answers:
 *
 * - an entry of only ASCII letters and digits (and separators) matches whole words, case-insensitive, with
 *   punctuation, spaces and underscores counting as the same separator (`see-through` hits "see_through");
 * - any other entry (Chinese, or mixed like `触手play`) matches as a substring, also with the spaces and punctuation
 *   of the text taken out, so `色 情` and `色.情` hit `色情`;
 * - full-width letters are folded to plain ones first (NFKC).
 *
 * A list that cannot be read, or has no words, is an error, never an empty list: a safety layer must not switch itself
 * off because a file went missing.
 */
import { readFileSync, statSync } from 'node:fs'

export class BlocklistUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlocklistUnavailable'
  }
}

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u{2028}\u{2029}]/u
const WORD_SEPARATORS = /[^a-z0-9]+/g
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu

const fold = (text: string): string => text.normalize('NFKC').toLowerCase()
const squeeze = (text: string): string => text.replace(NOT_LETTER_OR_DIGIT, '')
const wordKey = (folded: string): string => ` ${folded.replace(WORD_SEPARATORS, ' ').trim()} `
const isAscii = (text: string): boolean => /^[\x00-\x7f]*$/.test(text)

interface Entry {
  word: string
  folded: string
  /** Set for an ASCII entry: matched as whole words. */
  wordKey: string | null
  /** Set for any other entry: matched as a substring, and with spacing taken out. */
  squeezed: string
}

function entryOf(word: string): Entry | null {
  const folded = fold(word)
  if (isAscii(folded)) {
    const key = wordKey(folded)
    return key.trim() === '' ? null : { word, folded, wordKey: key, squeezed: '' }
  }
  return folded.trim() === '' ? null : { word, folded, wordKey: null, squeezed: squeeze(folded) }
}

/** One word per line; blank lines and `#` comment lines are skipped; a leading BOM is ignored. */
export function parseWords(content: string): string[] {
  const text = content.startsWith('\u{feff}') ? content.slice(1) : content
  return text
    .split(LINE_BREAK)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
}

export class DrawBlocklist {
  private entries: Entry[] = []
  private stamps = new Map<string, number | null>()
  private checkedAt = -Infinity
  /** Why the list cannot be used right now, or null. */
  error: string | null = null

  constructor(
    private readonly paths: readonly string[],
    private readonly now: () => number = Date.now,
    private readonly recheckMs = 5000
  ) {
    this.reload()
  }

  get words(): number {
    return this.entries.length
  }

  private stamp(file: string): number | null {
    try {
      return statSync(file).mtimeMs
    } catch {
      return null
    }
  }

  /** Read every file again. On any problem `error` says what, and nothing may pass `check` until it is fixed. */
  reload(): void {
    this.checkedAt = this.now()
    this.stamps = new Map(this.paths.map((p) => [p, this.stamp(p)]))
    const entries: Entry[] = []
    let problem: string | null = null
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (const file of this.paths) {
      try {
        for (const word of parseWords(decoder.decode(readFileSync(file)))) {
          const entry = entryOf(word)
          if (entry) entries.push(entry)
        }
      } catch (e) {
        const why =
          (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message
        problem = `${file}: ${why.split(/\r?\n/, 1)[0]}`
        break
      }
    }
    if (problem === null && entries.length === 0)
      problem = `the blocklist has no words: ${this.paths.join(', ')}`
    if (problem !== null) {
      this.error = `the blocklist cannot be used (${problem})`
      this.entries = []
      return
    }
    this.error = null
    this.entries = entries
  }

  /** Throws BlocklistUnavailable unless the list is loaded. Looks at the files again when the last look is a few seconds old. */
  check(): void {
    if (this.now() - this.checkedAt >= this.recheckMs) {
      this.checkedAt = this.now()
      if (this.paths.some((p) => this.stamp(p) !== this.stamps.get(p))) this.reload()
    }
    if (this.error !== null) throw new BlocklistUnavailable(this.error)
  }

  /** The listed word that matches any of the texts (tried in order), or null. */
  hit(...texts: string[]): string | null {
    this.check()
    for (const text of texts) {
      const folded = fold(text)
      const key = wordKey(folded)
      const squeezed = squeeze(folded)
      for (const e of this.entries) {
        if (e.wordKey !== null) {
          if (key.includes(e.wordKey)) return e.word
        } else if (
          folded.includes(e.folded) ||
          (e.squeezed !== '' && squeezed.includes(e.squeezed))
        ) {
          return e.word
        }
      }
    }
    return null
  }
}
