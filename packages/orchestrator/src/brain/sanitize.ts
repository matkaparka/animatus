/*
 * Sanitising untrusted viewer text before it goes into a prompt line or onto the stage.
 *
 * This re-implements what the legacy live-chat bridge did to viewer text (its `clean()` helper and
 * the length cap in its router):
 *   1. It replaced the full-width lenticular brackets 【 】 by ASCII [ ]. The app that received
 *      the lines recognised its own system lines with a plain startsWith on prefixes such as
 *      the ones in PREFIXES, so a viewer must never be able to type those brackets.
 *   2. It replaced every run of whitespace (Python's \s, newlines included) by one space and
 *      stripped both ends, so viewer text is always one line and cannot start a fake line.
 *   3. It cut the text to a configured length (80 in its example configuration) and appended "…".
 *
 * Kept here: 1 and 2, with the same whitespace set. Also kept: 3, except that no "…" is appended.
 * The cap is hard, so callers can rely on at most `maxChars` code points and add their own
 * marker if they want to show a cut.
 *
 * Added here; the bridge did none of these:
 *   - The full-width square brackets ［ ］ are mapped to [ ] too (look-alikes of 【 】).
 *   - Control characters are removed (C0 except whitespace, DEL, C1 except NEL).
 *   - Invisible format characters are removed: zero-width space and joiners, word joiner, BOM,
 *     soft hyphen and every other Unicode "Cf" character, which includes all bidi controls
 *     (marks, embeddings, overrides, isolates). They can hide text from readers and filters or
 *     reorder what a reader sees. Side effect: joiners inside emoji sequences and Persian or
 *     Indic words are lost.
 *   - The Unicode tag block U+E0000..U+E007F is removed. It encodes invisible ASCII text, a known
 *     way to smuggle instructions to a model.
 *   - Lone surrogates are removed, so the result is always well-formed UTF-16 (safe to serialise).
 *
 * Deliberately not done:
 *   - ASCII brackets are left alone, as in the bridge. System prefixes use the full-width
 *     brackets; tags in model output are the segmenter's business, not viewer text's.
 *   - No Unicode normalisation: NFKC would rewrite legitimate Japanese text.
 *   - The bridge's other rules (drop emote-only, too short, repeated or blocklisted messages) are
 *     policy, not sanitising, and belong elsewhere.
 */

export const DEFAULT_MAX_CHARS = 200

/** A bracketed marker that starts a line the system itself wrote (never viewer text). */
export type SystemPrefix = {
  id: string
  /** The literal start of the line, brackets included. For a Super Chat only the fixed part. */
  text: string
  meaning: string
  /** Which legacy tool wrote it: the live-chat bridge, or the tool that reads a document aloud. */
  origin: 'bridge' | 'file_reader'
}

/**
 * The bracketed prefixes of the legacy bridge (and of its file reader), taken from the code that
 * builds those lines. The fixed text is Chinese because it is the wire format of that system.
 */
export const PREFIXES = [
  {
    id: 'chat',
    text: '【弹幕】',
    meaning: 'One chat line from a viewer: prefix, viewer name, a full-width colon, the text.',
    origin: 'bridge',
  },
  {
    id: 'super_chat',
    text: '【SC ¥',
    meaning:
      'A paid highlighted message: prefix, price, closing bracket, viewer name, a full-width colon, the text.',
    origin: 'bridge',
  },
  {
    id: 'guard',
    text: '【上舰】',
    meaning:
      'A membership purchase: prefix, viewer name, the tier and, for several months, their number.',
    origin: 'bridge',
  },
  {
    id: 'gift',
    text: '【礼物】',
    meaning: 'A gift: prefix, viewer name, count and gift name.',
    origin: 'bridge',
  },
  {
    id: 'dance_request',
    text: '【点舞】',
    meaning:
      'A gift that asks the streamer to dance: prefix, viewer name, count and gift name, then the request.',
    origin: 'bridge',
  },
  {
    id: 'song_request',
    text: '【点歌】',
    meaning:
      'Outcome of a song request (accepted, refused, cancelled, service down), for the streamer to react to. Not a viewer quote.',
    origin: 'bridge',
  },
  {
    id: 'song_queue',
    text: '【歌单】',
    meaning: 'Answer to a viewer asking what is in the song queue.',
    origin: 'bridge',
  },
  {
    id: 'idle',
    text: '【冷场】',
    meaning: 'Nobody has chatted for a while (opt-in).',
    origin: 'bridge',
  },
  {
    id: 'sleep_reply',
    text: '【助眠】',
    meaning:
      'A chat line picked while the sleep-aid mode runs, to be answered in a whisper. The bridge swaps the chat prefix for this one.',
    origin: 'bridge',
  },
  {
    id: 'paper_reading',
    text: '【读论文】',
    meaning:
      'One passage of a document that the operator-side file-reading tool asks the streamer to explain. Written by the operator, never by viewers.',
    origin: 'file_reader',
  },
] as const satisfies readonly SystemPrefix[]

/** ASCII replacements for the bracket characters (the bridge's two, plus the full-width square pair). */
const BRACKET_RE = /[【】［］]/g
const BRACKET_MAP: Readonly<Record<string, string>> = { '【': '[', '】': ']', '［': '[', '］': ']' }

/**
 * Removed outright. C0 controls except the whitespace ones (U+0009..U+000D, U+001C..U+001F),
 * DEL, C1 controls except NEL (U+0085), all "Cf" format characters (zero-width, bidi, soft
 * hyphen, ...), lone surrogates and the Unicode tag block. The whitespace controls are left for
 * WHITESPACE_RE, which is how the bridge treated them.
 */
const INVISIBLE_RE =
  /[\u0000-\u0008\u000e-\u001b\u007f-\u0084\u0086-\u009f\p{Cf}\p{Cs}\u{e0000}-\u{e007f}]/gu

/** JS whitespace plus the two groups Python's \s has and JS's does not (NEL and U+001C..U+001F). */
const WHITESPACE_RE = /[\s\u0085\u001c-\u001f]+/g

/** Whitespace, controls and invisible characters at the start of a string. */
const LEADING_SKIP_RE = /^[\s\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}\u{e0000}-\u{e007f}]+/u

/**
 * Makes viewer text safe to embed in a single prompt line.
 *
 * Steps, in this order: map 【】［］ to [], delete control, invisible and unpaired-surrogate
 * characters, turn every whitespace run (newlines and tabs included) into one space, trim, cut to
 * `maxChars` code points (never inside a surrogate pair) and trim again. The result contains no
 * character from those classes, is at most `maxChars` code points long, and sanitising it again
 * changes nothing.
 *
 * `maxChars` defaults to DEFAULT_MAX_CHARS. It is rounded down; negative values give '' and
 * `Infinity` disables the cut; NaN falls back to the default.
 */
export function sanitizeViewerText(text: string, opts: { maxChars?: number } = {}): string {
  const requested = opts.maxChars ?? DEFAULT_MAX_CHARS
  const limit = Number.isNaN(requested) ? DEFAULT_MAX_CHARS : Math.max(0, Math.floor(requested))
  const cleaned = text
    .replace(BRACKET_RE, (c) => BRACKET_MAP[c] ?? c)
    .replace(INVISIBLE_RE, '')
    .replace(WHITESPACE_RE, ' ')
    .trim()
  return truncateCodePoints(cleaned, limit).trimEnd()
}

/**
 * Whether the text starts with one of PREFIXES, that is, claims to be a line the system wrote.
 *
 * Leading whitespace, control and invisible characters are skipped first, so padding cannot hide
 * a prefix. The legacy consumers used a plain startsWith; this is a superset of it. Only the exact
 * full-width brackets count: sanitised viewer text never matches.
 */
export function startsWithSystemPrefix(text: string): boolean {
  const skipped = LEADING_SKIP_RE.exec(text)?.[0].length ?? 0
  const rest = skipped ? text.slice(skipped) : text
  return PREFIXES.some((prefix) => rest.startsWith(prefix.text))
}

/** The first `max` code points of `s`, so a surrogate pair is never cut in half. */
function truncateCodePoints(s: string, max: number): string {
  // A string of at most `max` UTF-16 units has at most `max` code points.
  if (s.length <= max) return s
  let units = 0
  let count = 0
  for (const ch of s) {
    if (count === max) break
    units += ch.length
    count++
  }
  return s.slice(0, units)
}
