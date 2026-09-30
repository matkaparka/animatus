/**
 * Keyword search over the lines of the memory files: BM25 with a tokenizer that works for Chinese chat.
 *
 * Chinese has no spaces, so a run of Han (or kana, or hangul) characters is indexed twice over: as single
 * characters (except the most common function characters) and as overlapping pairs. "我养了一只猫" gives 养 只 猫
 * and 我养 养了 了一 一只 只猫, so "你养猫吗" (养 猫 and 你养 养猫 猫吗) still finds it through 养 and 猫, while a
 * rare pair counts for more than a common character. Latin words and numbers are lower-cased words. A query is cut
 * the same way. This is a first stage: an embedding can be added behind the same interface later.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
/** Characters so common in Chinese that alone they say nothing (they still count inside a pair). */
const COMMON = new Set([...'的了是我你他她它吗呢啊吧在有和就都也很不这那一个么'])
/** Words too common in English to say anything about a line ("the cat" should not find "the song"). */
const STOP_WORDS = new Set(
  'the is are was were be been an of to in on at as it its and or for with that this what who how why when where you your me my do does did have has had not no yes so if but from by about'.split(
    ' '
  )
)
const WORD = /[\p{L}\p{N}]/u

export function tokenize(text: string): string[] {
  const out: string[] = []
  let cjkRun: string[] = []
  let word = ''
  const flushCjk = () => {
    for (const c of cjkRun) if (cjkRun.length === 1 || !COMMON.has(c)) out.push(c)
    for (let i = 0; i + 1 < cjkRun.length; i++)
      out.push((cjkRun[i] as string) + (cjkRun[i + 1] as string))
    cjkRun = []
  }
  const flushWord = () => {
    if ((word.length >= 2 && !STOP_WORDS.has(word)) || /^\d$/.test(word)) out.push(word)
    word = ''
  }
  for (const ch of text.toLowerCase()) {
    if (CJK.test(ch)) {
      flushWord()
      cjkRun.push(ch)
    } else if (WORD.test(ch)) {
      flushCjk()
      word += ch
    } else {
      flushCjk()
      flushWord()
    }
  }
  flushCjk()
  flushWord()
  return out
}

export interface Doc<M> {
  id: string
  meta: M
  text: string
}

export interface Hit<M> {
  doc: Doc<M>
  score: number
  /** How many distinct words of the query the line has. */
  matched: number
}

/** An in-memory BM25 index. Documents are added and removed by id; lookups are synchronous. */
export class Bm25Index<M> {
  private readonly docs = new Map<string, { doc: Doc<M>; len: number; tf: Map<string, number> }>()
  private readonly postings = new Map<string, Set<string>>()
  private totalLen = 0

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75
  ) {}

  get size(): number {
    return this.docs.size
  }

  add(doc: Doc<M>): void {
    this.remove(doc.id)
    const tokens = tokenize(doc.text)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    this.docs.set(doc.id, { doc, len: tokens.length, tf })
    this.totalLen += tokens.length
    for (const t of tf.keys()) {
      let set = this.postings.get(t)
      if (!set) this.postings.set(t, (set = new Set()))
      set.add(doc.id)
    }
  }

  remove(id: string): void {
    const d = this.docs.get(id)
    if (!d) return
    this.docs.delete(id)
    this.totalLen -= d.len
    for (const t of d.tf.keys()) {
      const set = this.postings.get(t)
      set?.delete(id)
      if (set && set.size === 0) this.postings.delete(t)
    }
  }

  /** Remove every document whose id starts with `prefix`. */
  removePrefix(prefix: string): void {
    for (const id of [...this.docs.keys()]) if (id.startsWith(prefix)) this.remove(id)
  }

  /** Every document (for a caller that wants to walk them, in insertion order). */
  all(): Doc<M>[] {
    return [...this.docs.values()].map((d) => d.doc)
  }

  search(query: string, limit: number, accept?: (meta: M) => boolean): Hit<M>[] {
    const qTokens = [...new Set(tokenize(query))]
    if (qTokens.length === 0 || this.docs.size === 0) return []
    const n = this.docs.size
    const avg = this.totalLen / n || 1
    const scores = new Map<string, number>()
    const matched = new Map<string, number>()
    for (const t of qTokens) {
      const ids = this.postings.get(t)
      if (!ids) continue
      const idf = Math.log(1 + (n - ids.size + 0.5) / (ids.size + 0.5))
      for (const id of ids) {
        const d = this.docs.get(id)
        if (!d) continue
        if (accept && !accept(d.doc.meta)) continue
        const f = d.tf.get(t) ?? 0
        const s =
          idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / avg)))
        scores.set(id, (scores.get(id) ?? 0) + s)
        matched.set(id, (matched.get(id) ?? 0) + 1)
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => ({
        doc: (this.docs.get(id) as { doc: Doc<M> }).doc,
        score,
        matched: matched.get(id) ?? 0,
      }))
  }
}
