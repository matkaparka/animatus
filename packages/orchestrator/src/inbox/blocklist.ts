/**
 * The sensitive-word list applied to viewer text before it reaches the brain.
 *
 * The list is data the operator maintains (one word per line, `#` starts a comment line); the repository
 * ships none. It is re-read when the file changes, checked at most every few seconds.
 */
import { readFileSync, statSync } from 'node:fs'
import { normKey, pyStrip } from './text.ts'
import type { InboxLogger } from './types.ts'

/** What the router needs from a blocklist. */
export interface BlockChecker {
  /**
   * The listed word that matches any of `texts` (tried in order), or null. A word matches by plain
   * substring of the lower-cased text, or by substring of the letters-and-digits form of the text, so that
   * spacing and punctuation tricks (`b a d`, `b.a.d`) do not get around a listed `bad`.
   */
  hit(...texts: string[]): string | null
}

/** A blocklist that never matches. */
export const emptyBlocklist: BlockChecker = { hit: () => null }

/** Where the words come from: the file's modification time and content, or null when there is no file. */
export type BlocklistSource = () => { mtimeMs: number; content: string } | null

export interface BlocklistOptions {
  /** Clock in milliseconds; defaults to `Date.now`. */
  now?: () => number
  log?: InboxLogger
  /** Minimum time between two looks at the source. */
  recheckMs?: number
}

const DEFAULT_RECHECK_MS = 5000

/** Python's `str.splitlines` line boundaries. */
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u{2028}\u{2029}]/u

interface Entry {
  word: string
  /** `normKey(word)`; empty for words made only of punctuation, which then match by substring only. */
  key: string
}

export class Blocklist implements BlockChecker {
  private entries: Entry[] = []
  private mtimeMs: number | null = null
  private checkedAt = -Infinity
  private readonly now: () => number
  private readonly log: InboxLogger
  private readonly recheckMs: number
  private readonly source: BlocklistSource

  constructor(source: BlocklistSource, options: BlocklistOptions = {}) {
    this.source = source
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    this.recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS
    this.reload()
  }

  /** A blocklist backed by a UTF-8 file. A missing file is an empty list; other read errors keep the last list. */
  static fromFile(path: string, options: BlocklistOptions = {}): Blocklist {
    let cached: { mtimeMs: number; content: string } | null = null
    return new Blocklist(() => {
      let mtimeMs: number
      try {
        mtimeMs = statSync(path).mtimeMs
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
      if (cached?.mtimeMs !== mtimeMs) cached = { mtimeMs, content: readFileSync(path, 'utf8') }
      return cached
    }, options)
  }

  /** Number of words currently loaded. */
  get size(): number {
    return this.entries.length
  }

  /**
   * Look at the source and reload when its modification time changed. A missing source empties the list
   * (and, as in the legacy bridge, leaves the remembered time alone: a file that comes back with exactly
   * the old modification time is not noticed). A source that throws keeps the previous list and warns.
   */
  reload(): void {
    let snapshot: ReturnType<BlocklistSource>
    try {
      snapshot = this.source()
    } catch (err) {
      this.log('warn', 'blocklist source could not be read; keeping the previous list', {
        error: err,
      })
      return
    }
    if (snapshot === null) {
      this.entries = []
      return
    }
    if (snapshot.mtimeMs === this.mtimeMs) return
    this.mtimeMs = snapshot.mtimeMs
    this.entries = parseWords(snapshot.content)
    this.log('info', 'blocklist loaded', { words: this.entries.length })
  }

  hit(...texts: string[]): string | null {
    const t = this.now()
    if (t - this.checkedAt > this.recheckMs) {
      this.checkedAt = t
      this.reload()
    }
    for (const text of texts) {
      const raw = text.toLowerCase()
      const squeezed = normKey(text)
      for (const { word, key } of this.entries) {
        if (raw.includes(word) || (key !== '' && squeezed.includes(key))) return word
      }
    }
    return null
  }
}

/** One word per line, lower-cased; blank lines and `#` comment lines are skipped; a leading BOM is ignored. */
function parseWords(content: string): Entry[] {
  const text = content.startsWith('\u{feff}') ? content.slice(1) : content
  const entries: Entry[] = []
  for (const line of text.split(LINE_BREAK)) {
    const trimmed = pyStrip(line)
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const word = trimmed.toLowerCase()
    entries.push({ word, key: normKey(word) })
  }
  return entries
}
