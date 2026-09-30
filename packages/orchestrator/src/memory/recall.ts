/**
 * Recall: which lines of memory go into the prompt of the next reply.
 *
 * A reply is about the people who just spoke and about what they said. So it gets, in this order: what is known
 * about each speaker (their newest lines), what the streamer and the program know that matches the words
 * (the streamer's lines first), and what is known about a viewer the message names. All of it is bounded in
 * lines and in characters, everything is labelled with its source, and nothing is ever an instruction: the prompt
 * builder puts it under a heading that says so.
 *
 * The lookup is synchronous and works on the index in memory, so it costs a fraction of a millisecond; the last
 * lookups' times are kept so the console can show them.
 */
import { TRUST } from './lines.ts'
import { tokenize } from './search.ts'
import type { FactLine, Source } from './lines.ts'
import type { LineMeta, MemoryStore } from './store.ts'

export interface RecallOptions {
  /** At most this many lines. Default 8. */
  maxLines?: number
  /** At most this many characters over all lines. Default 900. */
  maxChars?: number
  /** Newest lines of each speaker to include. Default 5. */
  perSpeaker?: number
  /** A match must score at least this share of the best one to count. Default 0.35. */
  minRelativeScore?: number
  /** Web search results older than this are not recalled. Default 7 days. */
  searchCacheDays?: number
  now?: () => number
}

export interface Speaker {
  uid: number
  name: string
}

export interface RecallResult {
  lines: string[]
  /** Time the lookup took, ms. */
  ms: number
}

const DAY = 86_400_000

function label(f: FactLine, section: LineMeta['section'], name: string | undefined): string {
  if (section === 'search-cache') return '[web, unverified]'
  if (f.source === 'viewer' && name) return `[viewer ${name}]`
  return `[${f.source}]`
}

export class Recall {
  private readonly o: Required<Omit<RecallOptions, 'now'>> & { now: () => number }
  private readonly times: number[] = []

  constructor(
    private readonly store: MemoryStore,
    opts: RecallOptions = {}
  ) {
    this.o = {
      maxLines: opts.maxLines ?? 8,
      maxChars: opts.maxChars ?? 900,
      perSpeaker: opts.perSpeaker ?? 5,
      minRelativeScore: opts.minRelativeScore ?? 0.35,
      searchCacheDays: opts.searchCacheDays ?? 7,
      now: opts.now ?? Date.now,
    }
  }

  /** Median and 95th percentile of the last lookups, ms; null before the first. */
  latency(): { p50: number; p95: number; n: number } | null {
    if (this.times.length === 0) return null
    const s = [...this.times].sort((a, b) => a - b)
    const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number
    return { p50: at(0.5), p95: at(0.95), n: s.length }
  }

  lookup(input: { text: string; speakers: readonly Speaker[] }): RecallResult {
    const t0 = performance.now()
    const picked: { text: string; key: string }[] = []
    const seen = new Set<string>()
    let chars = 0
    const push = (text: string, key: string): boolean => {
      if (picked.length >= this.o.maxLines || seen.has(key)) return false
      const t = text.length > 260 ? `${text.slice(0, 259)}…` : text
      if (chars + t.length > this.o.maxChars && picked.length > 0) return false
      seen.add(key)
      picked.push({ text: t, key })
      chars += t.length
      return true
    }

    // 1. what is known about the people who just spoke
    const speakerIds = new Set<number>()
    for (const s of input.speakers) {
      if (speakerIds.has(s.uid)) continue
      speakerIds.add(s.uid)
      const name = this.store.viewerName(s.uid) ?? s.name
      const facts = this.store
        .linesOf(`viewers/${s.uid}.md`)
        .filter((m): m is LineMeta & { line: FactLine } => m.line.kind === 'fact')
        .slice(-this.o.perSpeaker)
        .reverse()
      for (const m of facts)
        push(`${label(m.line, m.section, name)} ${m.line.text}`, `${m.file}#${m.lineNo}`)
    }

    // 2. what matches the words, the streamer's own lines first
    const words = input.text.replace(/【[^】]*】/g, ' ').trim()
    if (words !== '') {
      const cutoff = this.o.now() - this.o.searchCacheDays * DAY
      let hits = this.store.searchLines(words, this.o.maxLines * 4, (m) => {
        if (m.section === 'viewers') return false // viewers come in step 1 and 3
        if (m.section === 'search-cache' && m.line.kind === 'fact') {
          const t = Date.parse(m.line.date)
          if (Number.isFinite(t) && t < cutoff) return false
        }
        return true
      })
      // BM25 scores mean little on their own (they shrink with the size of the memory), so a hit is judged against
      // the best one, and a long message needs more than one word in common
      const need = tokenize(words).length >= 8 ? 2 : 1
      const top = hits[0]?.score ?? 0
      hits = hits.filter((h) => h.score >= top * this.o.minRelativeScore && h.matched >= need)
      const trust = (m: LineMeta): number =>
        m.line.kind === 'fact' ? TRUST[m.line.source] : TRUST.human
      hits.sort((a, b) => trust(b.doc.meta) - trust(a.doc.meta) || b.score - a.score)
      for (const h of hits) {
        const m = h.doc.meta
        const key = `${m.file}#${m.lineNo}`
        if (m.line.kind === 'fact')
          push(`${label(m.line, m.section, undefined)} ${m.line.text}`, key)
        else push(`[human] ${m.line.text}`, key)
      }

      // 3. a viewer the message names
      for (const uid of this.store.viewersNamedIn(words)) {
        if (speakerIds.has(uid)) continue
        const name = this.store.viewerName(uid)
        const facts = this.store
          .linesOf(`viewers/${uid}.md`)
          .filter((m): m is LineMeta & { line: FactLine } => m.line.kind === 'fact')
          .slice(-2)
          .reverse()
        for (const m of facts)
          push(`${label(m.line, m.section, name)} ${m.line.text}`, `${m.file}#${m.lineNo}`)
      }
    }

    const ms = performance.now() - t0
    this.times.push(ms)
    if (this.times.length > 200) this.times.shift()
    return { lines: picked.map((p) => p.text), ms }
  }
}

export type { Source }
